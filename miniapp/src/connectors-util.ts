import type { Connector, ConnectorCall, ConnectorTool } from './api/types';

export const CONNECTOR_STATUS: Record<Connector['status'], ['ok' | 'warn' | 'bad' | undefined, string]> = {
  ok: ['ok', 'Работает'],
  no_key: ['warn', 'Нужен ключ'],
  key_rejected: ['bad', 'Ключ не принят'],
  upstream_error: ['warn', 'Сервис недоступен'],
  disabled: [undefined, 'Выключен'],
};

export const CALL_DECISION: Record<ConnectorCall['decision'], ['ok' | 'warn' | 'bad' | undefined, string]> = {
  auto: ['ok', 'Без подтверждения'],
  approved: ['ok', 'Одобрено'],
  denied: ['bad', 'Отклонено'],
  expired: ['warn', 'Не дождались'],
  unavailable: ['warn', 'Подтверждение недоступно'],
  disconnected: ['warn', 'Разговор оборвался'],
  revoked: ['warn', 'Отозвано'],
  disabled: ['warn', 'Коннектор выключен'],
  pending: ['warn', 'Ждёт подтверждения'],
};

/** Outcome label for a call; null while it is still pending or never ran. */
export function callOutcome(c: ConnectorCall): string | null {
  switch (c.status) {
    case 'ok':
      return 'выполнен';
    case 'tool_error':
      return 'ошибка инструмента';
    case 'upstream_error':
      return 'сервис не ответил';
    case 'unknown':
      return 'результат неизвестен';
    default:
      return null;
  }
}

/** Default classification when there is no override (src: STAGE1-DESIGN §5): a tool asks unless it is read-only. */
export const defaultAsks = (t: Pick<ConnectorTool, 'readOnly'>): boolean => !t.readOnly;

/** Policy to send when the owner flips the "ask" switch: matching the default clears the override (null). */
export function policyForAsk(t: Pick<ConnectorTool, 'readOnly'>, ask: boolean): 'ask' | 'auto' | null {
  return ask === defaultAsks(t) ? null : ask ? 'ask' : 'auto';
}

/** Split into the two groups of the screen, keeping the server's order inside each. */
export function groupTools(tools: ConnectorTool[]): { ask: ConnectorTool[]; auto: ConnectorTool[] } {
  return { ask: tools.filter((t) => t.asks), auto: tools.filter((t) => !t.asks) };
}

export function keyLine(c: Connector): string {
  if (!c.key.set) return 'Ключ не задан';
  if (c.key.status === 'rejected') return 'Ключ сохранён, но сервис его не принял';
  if (c.key.status === 'unverified') return 'Ключ сохранён, проверить не удалось';
  return 'Ключ сохранён';
}
