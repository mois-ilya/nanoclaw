import { loadConfig } from './config.js';
import { startNanogate } from './server.js';

const configPath = process.env.NANOGATE_CONFIG;
if (!configPath) {
  process.stderr.write('NANOGATE_CONFIG is required\n');
  process.exit(2);
}

const gate = await startNanogate(loadConfig(configPath));

process.on('SIGHUP', () => {
  try {
    gate.reload(loadConfig(configPath));
  } catch (e) {
    gate.ctx.log({ msg: 'reload_failed', error: (e as Error).message }); // keep running with the old config
  }
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void gate.close().finally(() => process.exit(0)));
}
