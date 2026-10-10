/**
 * Podman driver — behavioral tests (nanoclaw-fork).
 *
 * Adapted from docker-driver.test.ts: a real spec goes through the real
 * realization path against a FakeCli, and assertions are on the commands the
 * driver issued. The upstream conformance suite also runs against this driver
 * (conformance.test.ts, `podmanHarness`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeCli } from './fake-cli.js';
import {
  PodmanSessionDriver,
  allocateSubnet,
  assertPodmanHostConfig,
  podmanEventToSessionEvent,
  podmanRemoteArgs,
  prefixedCli,
} from './podman-driver.js';
import { FIXTURE_POLICY, fixtureSpec, fixtureSpecWithAux } from './spec-fixture.js';
import { LABELS } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { default: { constants: actual.constants, existsSync: vi.fn(() => true) } };
});

import { log } from '../log.js';

let cli: FakeCli;

const AGENT = 'ncl-spike-s1';
const AUX = 'ncl-spike-s1-egress-proxy';
const NET = 'ncl-spike-s1-private';

function driver(extra: Partial<ConstructorParameters<typeof PodmanSessionDriver>[0]> = {}): PodmanSessionDriver {
  return new PodmanSessionDriver({ ...FIXTURE_POLICY, cli, ...extra });
}

/** inspect docs for a healthy gated topology. */
function healthyInspect(overrides: { agentNets?: string[]; auxNets?: string[]; alias?: boolean } = {}): void {
  const nets = (names: string[], aliases: string[] = []) =>
    Object.fromEntries(names.map((n) => [n, { Aliases: n === NET ? aliases : [] }]));
  const agentDoc = [
    { NetworkSettings: { Networks: nets(overrides.agentNets ?? [NET]) }, HostConfig: { NetworkMode: NET } },
  ];
  const auxDoc = [
    {
      NetworkSettings: {
        Networks: nets(overrides.auxNets ?? [NET, 'nanogate-svc'], overrides.alias === false ? [] : ['egress-proxy']),
      },
      HostConfig: { NetworkMode: 'nanogate-svc', ExtraHosts: null, Privileged: false, CapAdd: null },
    },
  ];
  cli.responses = [
    // new-session path: the existence probe fails; verification inspects succeed
    { match: /^inspect --format .*ncl-spike-s1$/, throws: new Error('No such object') },
    { match: /^inspect --type container ncl-spike-s1-egress-proxy$/, output: JSON.stringify(auxDoc) },
    { match: /^inspect --type container ncl-spike-s1$/, output: JSON.stringify(agentDoc) },
    {
      match: /^network inspect ncl-spike-s1-private$/,
      output: JSON.stringify([{ internal: true, options: { isolate: 'true' } }]),
    },
    { match: /^network exists /, throws: new Error('exit status 1') },
    { match: /^network ls --format/, output: 'podman\n' },
    { match: /^network inspect podman$/, output: JSON.stringify([{ subnets: [{ subnet: '10.88.0.0/16' }] }]) },
  ];
}

function gatedFixture(overrides: Parameters<typeof fixtureSpecWithAux>[0] = {}) {
  return fixtureSpecWithAux(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  cli = new FakeCli('podman');
  healthyInspect();
});

describe('session network and topology', () => {
  it('creates an internal, isolated /28 session network from the pool, with install labels', async () => {
    await driver().prepare(gatedFixture());
    const create = cli.callMatching(/^network create /)!.args;
    expect(create.slice(0, 6)).toEqual(['network', 'create', '--internal', '--opt', 'isolate=true', '--subnet']);
    expect(create[6]).toBe('10.90.0.0/28');
    expect(create).toContain(`${LABELS.install}=spike`);
    expect(create.at(-1)).toBe(NET);
  });

  it('skips subnets held by any existing network and honours NANOCLAW_SESSION_POOL', async () => {
    cli.responses.unshift(
      { match: /^network ls --format/, output: 'podman\nother\n' },
      {
        match: /^network inspect podman other$/,
        output: JSON.stringify([{ subnets: [{ subnet: '10.88.0.0/16' }] }, { subnets: [{ subnet: '10.92.0.0/27' }] }]),
      },
    );
    await driver({ sessionPool: '10.92.0.0/24' }).prepare(gatedFixture());
    expect(cli.callMatching(/^network create /)!.args).toContain('10.92.0.32/28');
  });

  it('retries on a subnet create conflict with a fresh allocation', async () => {
    let attempts = 0;
    const original = cli.run.bind(cli);
    cli.run = (args, opts) => {
      if (args[0] === 'network' && args[1] === 'create') {
        attempts += 1;
        if (attempts === 1)
          throw new Error('Error: subnet 10.90.0.0/28 is already used on the host or by another config');
      }
      return original(args, opts);
    };
    await driver().prepare(gatedFixture());
    expect(attempts).toBe(2);
  });

  it('fails with resources-exhausted when the pool is full', () => {
    const used = Array.from({ length: 16 }, (_, i) => `10.90.0.${i * 16}/28`);
    expect(() => allocateSubnet('10.90.0.0/24', used)).toThrowError(/resources-exhausted|session realization failed/);
    expect(allocateSubnet('10.90.0.0/24', used.slice(1))).toBe('10.90.0.0/28');
  });

  it('realizes the auxiliary on the uplink (no bridge, no host-gateway), then connects the alias', async () => {
    await driver().prepare(gatedFixture());
    const creates = cli.calls.filter((c) => c.args[0] === 'create').map((c) => c.args);
    const aux = creates.find((a) => a.includes(AUX))!;
    expect(aux.join(' ')).toContain('--network nanogate-svc');
    expect(aux.join(' ')).not.toContain('host-gateway');
    expect(aux.join(' ')).not.toContain('--network bridge');
    expect(cli.joined()).toContain(`network connect --alias egress-proxy ${NET} ${AUX}`);
  });

  it('gives auxiliaries their own limits and a read-only rootfs, never the agent session resources', async () => {
    await driver().prepare(
      gatedFixture({ resources: { memoryMb: 8192, cpus: '4', pidsLimit: 2048, shmSizeMb: 1024 } }),
    );
    const creates = cli.calls.filter((c) => c.args[0] === 'create').map((c) => c.args.join(' '));
    const aux = creates.find((a) => a.includes(AUX))!;
    expect(aux).toContain('--read-only');
    expect(aux).toContain('--tmpfs /tmp:rw,size=16m,mode=1777');
    expect(aux).toContain('--memory 64m');
    expect(aux).toContain('--cpus 0.25');
    expect(aux).toContain('--pids-limit 64');
    expect(aux).not.toContain('--shm-size');
    expect(aux).not.toContain('8192m');
  });

  it('uses the aux spec resources when given', async () => {
    const spec = gatedFixture();
    spec.containers[1].resources = { memoryMb: 32, cpus: '0.5', pidsLimit: 32 };
    await driver().prepare(spec);
    const aux = cli.calls
      .filter((c) => c.args[0] === 'create')
      .map((c) => c.args.join(' '))
      .find((a) => a.includes(AUX))!;
    expect(aux).toContain('--memory 32m');
    expect(aux).toContain('--cpus 0.5');
  });

  it('puts the agent only on the session network, with the session resources, shm and a capped /tmp', async () => {
    await driver({ tmpfsMb: 256 }).prepare(gatedFixture({ resources: { memoryMb: 2048, shmSizeMb: 512 } }));
    const agent = cli.calls
      .filter((c) => c.args[0] === 'create')
      .map((c) => c.args.join(' '))
      .find((a) => a.includes(`--name ${AGENT} `))!;
    expect(agent).toContain(`--network ${NET}`);
    expect(agent).not.toContain('nanogate-svc');
    expect(agent).toContain('--memory 2048m');
    expect(agent).toContain('--shm-size=512m');
    expect(agent).toContain('--tmpfs /tmp:rw,size=256m,mode=1777');
    expect(agent).toContain('--cap-drop=ALL');
    expect(agent).toContain('--init');
    expect(agent).not.toContain('--read-only');
  });

  it('passes --cgroup-parent to the agent and aux containers when configured, and always --no-hosts', async () => {
    await driver({ cgroupParent: 'nanoclaw.slice' }).prepare(gatedFixture());
    const creates = cli.calls.filter((c) => c.args[0] === 'create').map((c) => c.args.join(' '));
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const c of creates) {
      expect(c).toContain('--cgroup-parent nanoclaw.slice');
      expect(c).toContain('--no-hosts');
    }
  });

  it('omits --cgroup-parent when unset and rejects a malformed value', async () => {
    await driver({ cgroupParent: '' }).prepare(gatedFixture());
    for (const c of cli.calls.filter((x) => x.args[0] === 'create'))
      expect(c.args.join(' ')).not.toContain('--cgroup-parent');
    expect(() => driver({ cgroupParent: 'nanoclaw.slice --privileged' })).toThrow(/systemd slice/);
  });

  it('passes --log-driver none only when NANOCLAW_LOG_CONTENT=0', async () => {
    const prev = process.env.NANOCLAW_LOG_CONTENT;
    try {
      process.env.NANOCLAW_LOG_CONTENT = '0';
      await driver({}).prepare(gatedFixture());
      const hidden = cli.calls.filter((c) => c.args[0] === 'create').map((c) => c.args.join(' '));
      expect(hidden.length).toBeGreaterThanOrEqual(2);
      for (const c of hidden) expect(c).toContain('--log-driver none');
      cli.calls.length = 0;
      delete process.env.NANOCLAW_LOG_CONTENT;
      await driver({}).prepare(gatedFixture());
      for (const c of cli.calls.filter((x) => x.args[0] === 'create'))
        expect(c.args.join(' ')).not.toContain('--log-driver');
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_LOG_CONTENT;
      else process.env.NANOCLAW_LOG_CONTENT = prev;
    }
  });

  it('verifies the topology after create and keeps the session when it matches', async () => {
    const handle = await driver().prepare(gatedFixture());
    expect(handle.name).toBe(AGENT);
    expect(cli.callMatching(/^inspect --type container ncl-spike-s1$/)).toBeDefined();
    expect(cli.callMatching(/^rm --force/)).toBeUndefined();
  });

  it.each([
    ['agent on an extra network', () => healthyInspect({ agentNets: [NET, 'podman'] })],
    ['aux missing the uplink', () => healthyInspect({ auxNets: [NET] })],
    ['aux on the default bridge', () => healthyInspect({ auxNets: [NET, 'nanogate-svc', 'podman'] })],
    ['endpoint alias missing', () => healthyInspect({ alias: false })],
  ])('tears the session down and fails closed on a mismatch: %s', async (_name, arrange) => {
    arrange();
    await expect(driver().prepare(gatedFixture())).rejects.toMatchObject({
      kind: 'spec-invalid',
      detail: 'topology_mismatch',
    });
    const issued = cli.joined();
    expect(issued).toContain(`rm --force ${AGENT}`);
    expect(issued).toContain(`rm --force ${AUX}`);
    expect(issued).toContain(`network rm ${NET}`);
    expect(log.error).toHaveBeenCalledWith('Session topology mismatch — failing closed', expect.anything());
  });

  it('fails closed when a container carries host-gateway extra hosts, added caps or host networking', async () => {
    const bad = [
      {
        NetworkSettings: { Networks: { [NET]: { Aliases: ['egress-proxy'] }, 'nanogate-svc': {} } },
        HostConfig: { NetworkMode: 'bridge', ExtraHosts: ['h:host-gateway'], Privileged: true, CapAdd: ['NET_ADMIN'] },
      },
    ];
    healthyInspect();
    cli.responses.unshift({
      match: /^inspect --type container ncl-spike-s1-egress-proxy$/,
      output: JSON.stringify(bad),
    });
    await expect(driver().prepare(gatedFixture())).rejects.toMatchObject({ detail: 'topology_mismatch' });
    const problems = (log.error as ReturnType<typeof vi.fn>).mock.calls[0][1].problems as string[];
    expect(problems.join(' ')).toMatch(/network_mode.*host_gateway.*privileged.*cap_add/);
  });

  it('fails closed when the network is not internal/isolated', async () => {
    healthyInspect();
    cli.responses.unshift({
      match: /^network inspect ncl-spike-s1-private$/,
      output: JSON.stringify([{ internal: false, options: {} }]),
    });
    await expect(driver().prepare(gatedFixture())).rejects.toMatchObject({ detail: 'topology_mismatch' });
  });

  it('fails closed when a container cannot be inspected', async () => {
    healthyInspect();
    cli.responses.unshift({ match: /^inspect --type container ncl-spike-s1$/, throws: new Error('boom') });
    await expect(driver().prepare(gatedFixture())).rejects.toMatchObject({ detail: 'topology_mismatch' });
  });
});

describe('adoption', () => {
  it('verifies the topology of an adopted session before handing the handle back', async () => {
    healthyInspect();
    cli.responses.unshift({ match: /^inspect --format .*ncl-spike-s1$/, output: 'spike|g1|s1\n' });
    const handle = await driver().prepare(gatedFixture());
    expect(handle.name).toBe(AGENT);
    expect(cli.calls.some((c) => c.args[0] === 'create')).toBe(false);
    expect(cli.callMatching(/^inspect --type container ncl-spike-s1$/)).toBeDefined();
  });

  it('tears down an adopted session whose topology drifted', async () => {
    healthyInspect({ agentNets: [NET, 'podman'] });
    cli.responses.unshift({ match: /^inspect --format .*ncl-spike-s1$/, output: 'spike|g1|s1\n' });
    await expect(driver().prepare(gatedFixture())).rejects.toMatchObject({ detail: 'topology_mismatch' });
    expect(cli.joined()).toContain(`rm --force ${AGENT}`);
  });
});

describe('fail-closed spec gate', () => {
  it('rejects a non session-container target', async () => {
    cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({
      kind: 'spec-invalid',
      detail: 'ungated_network_access',
    });
    expect(cli.calls.some((c) => c.args[0] === 'create')).toBe(false);
  });

  it('realizes it only when explicitly allowed (dev)', async () => {
    cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
    await expect(driver({ allowUngated: true }).prepare(fixtureSpec())).resolves.toBeDefined();
  });
});

describe('capabilities and cli', () => {
  it('declares no image build and auxiliary container support', () => {
    expect(driver().capabilities()).toMatchObject({
      imageBuild: false,
      auxiliaryContainers: true,
      networkPolicy: 'topology',
    });
  });

  it('prefixes every invocation with --remote --url and exposes it in execSpec', async () => {
    const inner = new FakeCli('podman');
    const wrapped = prefixedCli(inner, podmanRemoteArgs('unix:///run/podman/podman.sock'));
    wrapped.run(['info']);
    expect(inner.calls[0].args).toEqual(['--remote', '--url', 'unix:///run/podman/podman.sock', 'info']);

    const handle = await driver({ url: 'unix:///x.sock', allowUngated: true }).prepare(fixtureSpec());
    expect(handle.execSpec(['sh']).argsPlain).toEqual([
      '--remote',
      '--url',
      'unix:///x.sock',
      'exec',
      '-i',
      AGENT,
      'sh',
    ]);
  });
});

describe('podman dialect', () => {
  it('maps podman event verbs and both label layouts', () => {
    const labels = { [LABELS.group]: 'g1', [LABELS.session]: 's1' };
    expect(podmanEventToSessionEvent({ Status: 'died', Attributes: labels }, 'spike')).toEqual({
      key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
      kind: 'terminal',
    });
    expect(podmanEventToSessionEvent({ Action: 'start', Actor: { Attributes: labels } }, 'spike')?.kind).toBe('phase');
    expect(podmanEventToSessionEvent({ Status: 'remove', Attributes: labels }, 'spike')?.kind).toBe('terminal');
    expect(podmanEventToSessionEvent({ Status: 'died' }, 'spike')).toBeNull();
  });

  it('lists with the podman label template', async () => {
    cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\n' }];
    await driver().listSessions('spike');
    expect(cli.callMatching(/^ps -a/)!.args.join(' ')).toContain('{{index .Labels "nanoclaw-group"}}');
  });
});

describe('startup assertion', () => {
  it('refuses egress lockdown with the podman driver', async () => {
    await expect(
      assertPodmanHostConfig({ allowUngated: true, env: { NANOCLAW_EGRESS_LOCKDOWN: 'true' } }),
    ).rejects.toThrow(/NANOCLAW_EGRESS_LOCKDOWN/);
    await expect(
      assertPodmanHostConfig({ allowUngated: true, env: { NANOCLAW_EGRESS_LOCKDOWN: 'false' } }),
    ).resolves.toBeUndefined();
  });

  it('refuses a gateway other than nanogate', async () => {
    await expect(assertPodmanHostConfig({ env: { NANOCLAW_GATEWAY_PROVIDER: 'onecli' } })).rejects.toThrow(
      /requires 'nanogate'/,
    );
    await expect(assertPodmanHostConfig({ env: { NANOCLAW_GATEWAY_PROVIDER: 'nanogate' } })).resolves.toBeUndefined();
  });
});
