import { describe, expect, it } from 'vitest';
import type { Connector, ConnectorTool } from './api/types';
import { callOutcome, groupTools, keyLine, policyForAsk } from './connectors-util';

const tool = (
  name: string,
  readOnly: boolean,
  asks: boolean,
  policy: ConnectorTool['policy'] = null,
): ConnectorTool => ({ name, readOnly, asks, policy });

describe('connectors util', () => {
  it('flipping to the default clears the override', () => {
    expect(policyForAsk({ readOnly: true }, true)).toBe('ask');
    expect(policyForAsk({ readOnly: true }, false)).toBeNull();
    expect(policyForAsk({ readOnly: false }, false)).toBe('auto');
    expect(policyForAsk({ readOnly: false }, true)).toBeNull();
  });
  it('groups tools by the server-computed asks flag', () => {
    const g = groupTools([tool('a', true, false), tool('b', false, true), tool('c', true, true, 'ask')]);
    expect(g.ask.map((t) => t.name)).toEqual(['b', 'c']);
    expect(g.auto.map((t) => t.name)).toEqual(['a']);
  });
  it('key line never reveals more than state', () => {
    const base = { key: { set: false, status: null } } as Connector;
    expect(keyLine(base)).toBe('Ключ не задан');
    expect(keyLine({ ...base, key: { set: true, status: 'ok' } })).toBe('Ключ сохранён');
    expect(keyLine({ ...base, key: { set: true, status: 'rejected' } })).toContain('не принял');
  });
  it('call outcome', () => {
    expect(callOutcome({ at: '', tool: 't', dangerous: false, decision: 'auto', status: 'ok' })).toBe('выполнен');
    expect(callOutcome({ at: '', tool: 't', dangerous: true, decision: 'denied', status: null })).toBeNull();
  });
});
