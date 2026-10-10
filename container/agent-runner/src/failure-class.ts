// nanoclaw-fork: failure taxonomy for user-facing error notices (ux §2.9).
//
// The runner never forwards raw SDK/proxy error text to a chat. A failure is
// classified into one of a few classes; the chat row carries `failureClass`
// (so the host adapter can attach buttons and overwrite the copy) plus a fixed
// Russian text as a fallback for hosts that only know `failureNotice`.

export type FailureClass = 'budget' | 'busy' | 'turn_cap' | 'global_cap' | 'overload' | 'timeout' | 'internal';

/** Fixed user-visible copy per class. Never includes raw error text. */
export const FAILURE_COPY: Record<FailureClass, string> = {
  internal: 'Что-то сломалось у меня внутри. Я уже попробовал ещё раз — не вышло.',
  overload: 'Модель сейчас перегружена, я попробовал несколько раз — не вышло. Попробуй ещё раз чуть позже.',
  budget: 'Лимит на этот месяц исчерпан. Новые запросы я пока не выполняю. Можно попросить владельца поднять лимит.',
  busy: 'Подожди немного: у тебя ещё считается параллельный запрос. Сейчас попробую снова — или повтори через минуту.',
  turn_cap: 'Слишком дорогой запрос подряд — я остановился. Можно начать заново и разбить задачу на части.',
  global_cap: 'Сервис сейчас достиг общего лимита расходов. Попробуй чуть позже.',
  timeout: 'Задача шла слишком долго, я остановился.',
};

/** Shown as a progress step while the SDK retries an overloaded/rate-limited API call. */
export const OVERLOAD_PROGRESS_LABEL = 'Модель сейчас перегружена, пробую снова…';

/**
 * Classify a failure from any text the SDK / nanogate left behind (errors[],
 * result echo, thrown message). nanogate's budget denials use fixed tokens
 * (`budget_exhausted`, `budget_insufficient_now`, `turn_cap_exceeded`,
 * `global_cap_exceeded`; the `x-nanogate-budget` header is exhausted | busy |
 * turn_cap) inside a 429, so they are checked before the generic overload patterns.
 * `busy` is transient (parallel in-flight requests reserve the remaining budget).
 */
export function classifyFailure(...texts: Array<string | null | undefined>): FailureClass {
  const t = texts.filter(Boolean).join('\n');
  if (/global_cap_exceeded/i.test(t)) return 'global_cap';
  if (/turn_cap_exceeded|x-nanogate-budget:\s*turn_cap/i.test(t)) return 'turn_cap';
  if (/budget_insufficient_now|x-nanogate-budget:\s*busy/i.test(t)) return 'busy';
  if (/budget_exhausted|x-nanogate-budget:\s*exhausted/i.test(t)) return 'budget';
  if (/overloaded|\b529\b|\b429\b|rate_limit|rate limit|\b503\b/i.test(t)) return 'overload';
  return 'internal';
}

/** HTTP statuses on which the SDK's api_retry means "model is busy". */
export function isOverloadStatus(status: number | null | undefined): boolean {
  return status === 429 || status === 529 || status === 503;
}
