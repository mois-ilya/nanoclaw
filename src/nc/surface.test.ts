import { afterEach, beforeEach, expect, it } from 'vitest';

import { botProfileTexts, syncBotProfile } from './surface.js';
import { OWNER, installFakeAdapter } from './test-helpers.js';

let fake: ReturnType<typeof installFakeAdapter>;

beforeEach(() => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  process.env.NC_BOT_NAME = 'Пульс';
  process.env.NC_OWNER_NAME = 'Пётр';
  process.env.NC_OWNER_NAME_GEN = 'Петра';
  fake = installFakeAdapter();
});
afterEach(() => {
  for (const k of ['NC_BOT_NAME', 'NC_OWNER_NAME', 'NC_OWNER_NAME_GEN']) delete process.env[k];
});

it('builds Russian description and short description from the bot and owner names, within Telegram limits', () => {
  const t = botProfileTexts();
  expect(t.description).toContain('Пульс — личный ассистент Петра');
  expect(t.description).toContain('Пётр');
  expect(t.description.length).toBeLessThanOrEqual(512);
  expect(t.short.length).toBeLessThanOrEqual(120);
});

it('sets description, short description and default-scope commands; a second run with nothing changed writes nothing', async () => {
  await syncBotProfile();
  const { description, short } = botProfileTexts();
  expect(fake.api.setMyDescription).toHaveBeenCalledWith({ description });
  expect(fake.api.setMyShortDescription).toHaveBeenCalledWith({ short_description: short });
  const [cmds, extra] = fake.api.setMyCommands.mock.calls[0];
  expect(extra).toEqual({ scope: { type: 'default' } });
  expect((cmds as Array<{ command: string }>).map((c) => c.command)).toContain('help');

  fake.api.getMyDescription.mockResolvedValue({ description });
  fake.api.getMyShortDescription.mockResolvedValue({ short_description: short });
  fake.api.getMyCommands.mockResolvedValue(cmds);
  fake.api.setMyDescription.mockClear();
  fake.api.setMyShortDescription.mockClear();
  fake.api.setMyCommands.mockClear();
  await syncBotProfile();
  expect(fake.api.setMyDescription).not.toHaveBeenCalled();
  expect(fake.api.setMyShortDescription).not.toHaveBeenCalled();
  expect(fake.api.setMyCommands).not.toHaveBeenCalled();
});
