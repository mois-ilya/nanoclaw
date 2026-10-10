/** Russian product copy (UX spec §2.7-2.10, plan §13). All strings are plain markdown. */
import { nc } from './config.js';
import { escapeMd, fmtUsd } from './util.js';

export const copy = {
  pendingFirst: (): string =>
    `Привет! Я личный ассистент ${nc.ownerNameGen()}. Доступ даёт он лично — я уже передал ему твой запрос.\nКак только он ответит, я напишу сюда.`,
  pendingWaiting: (): string => `Жду ответа ${nc.ownerNameGen()}.`,
  denied: (): string => `${nc.ownerName()} пока не может дать тебе доступ. Если это ошибка — напиши ему напрямую.`,
  paused: (): string =>
    `Доступ к ассистенту сейчас приостановлен. Данные сохранены — если ${nc.ownerName()} вернёт доступ, всё продолжится с того же места.`,
  closed: (): string => 'Доступ закрыт.',
  provisioning: (): string => 'Готовлю пространство… Твоё сообщение сохранено, отвечу, как только всё будет готово.',
  provisioningFailed: (): string =>
    `Не получилось подготовить пространство. ${nc.ownerName()} уже знает; сообщение сохранено, отвечу, когда всё заработает.`,
  unknownCommand: (): string => 'Такой команды нет. /help — что я умею.',
  serviceDown: (): string => 'Сервис временно недоступен — сообщение сохранено, отвечу, как только всё поднимется.',
  budgetExhausted: (limitMicros: number, resetsOn: string): string =>
    `Лимит на этот месяц исчерпан (${fmtUsd(limitMicros)}). Новые запросы я пока не выполняю; уже запущенное досчитаю.\nОбновится ${resetsOn}. Можно попросить ${nc.ownerNameGen()} поднять лимит.`,
  budgetNote80: (usedMicros: number, limitMicros: number): string =>
    `💡 Использовано 80 % месячного лимита (${fmtUsd(usedMicros)} из ${fmtUsd(limitMicros)}).`,
  raiseAsked: (): string => `Передал ${nc.ownerNameGen()}. Напишу, когда он ответит.`,
  raiseGranted: (newLimitMicros: number): string =>
    `${nc.ownerName()} поднял лимит: теперь ${fmtUsd(newLimitMicros)} в месяц. Можно продолжать.`,
  raiseDenied: (): string => `${nc.ownerName()} пока не может поднять лимит.`,
  welcome: (name: string): string =>
    `Привет, ${escapeMd(name)}! Я — ассистент, которого тебе подключил ${nc.ownerName()}. Говорю по-русски, умею искать в интернете, работать с файлами, помнить важное и ставить напоминания.\n` +
    'Попробуй прямо сейчас: «найди три идеи, что подарить маме на ДР» — или пришли голосовое.\n' +
    // Plan §13.1: true for the product surface only (no host content logs, no transcript browser).
    `Твои диалоги видишь только ты и бот; ${nc.ownerName()} их не читает через бота.`,
  help: (owner = false): string =>
    'Я личный ассистент. Просто пиши или присылай голосовые.\n\n' +
    '• «найди три идеи, что подарить маме на ДР»\n' +
    '• «напомни завтра в десять позвонить Диме»\n' +
    '• «запомни, что я не ем орехи»\n' +
    '• пришли файл или фото и скажи, что с ним сделать\n\n' +
    'Команды: /new — новый разговор, /stop — остановить задачу, /tasks — напоминания, /menu — кабинет.' +
    (owner ? '\nТолько для тебя: /friends — друзья, /guest — гостевой контекст, /health — состояние сервера.' : ''),
  notReady: (): string => 'Эта команда пока недоступна.',
  newConversation: (): string => 'Начинаю новый разговор. Память и файлы остаются.',
  nothingToStop: (): string => 'Сейчас нечего останавливать.',
  voiceTooLong: (): string => 'Это слишком длинная запись для меня. Пришли частями или текстом.',
  voiceEmpty: (): string => 'Не расслышал. Повтори или напиши текстом.',
  voiceFailed: (): string => 'Не получилось разобрать голосовое. Напиши текстом, пожалуйста.',
  voiceBudget: (): string => 'Лимит исчерпан, голосовые пока не разбираю. Напиши текстом.',
  guestOff: (chat: string, disabled: boolean): string =>
    `Меня позвали в «${escapeMd(chat, 80)}», но ${disabled ? 'гостевой режим выключен' : 'гостевой контекст не опубликован'}. В чужом чате я ничего не отвечал.`,
  guestFailed: (): string => 'Не удалось подготовить ответ.',
  provisionFailedOwner: (name: string, reason: string): string =>
    `⚠️ Не удалось создать пространство ${escapeMd(name)}: ${escapeMd(reason, 200)}`,
};
