// Dev-only mock backend (imported dynamically under import.meta.env.DEV — never in the production bundle).
// `?role=owner|friend` picks the role; `?empty=1` returns a brand-new account; `?fail=1` makes reads fail once.
import type {
  AccessRequest,
  Budget,
  Connection,
  EgressView,
  Friend,
  GuestContext,
  HomeView,
  Me,
  MemoryFile,
  MemoryTree,
  PromptView,
  Settings,
  Skill,
  CatalogItem,
  Connector,
  ConnectorCall,
  ConnectorTool,
  TaskDetail,
  TaskSummary,
  UsageView,
} from './types';
import type { SttView, SystemViewX } from './extra';
import type { FetchLike } from './client';

const M = (usd: number) => ({ micros: Math.round(usd * 1_000_000) });
const H = 3600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

export function createMockFetch(search: string): FetchLike {
  const q = new URLSearchParams(search);
  const role = q.get('role') === 'owner' ? 'owner' : 'friend';
  const empty = q.get('empty') === '1';
  let failOnce = q.get('fail') === '1';
  const now = Date.now();
  const nowD = new Date(now);
  const periodStart = iso(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1));
  const periodEnd = iso(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() + 1, 1));

  const me: Me = {
    userId: role === 'owner' ? '42582289' : '77100200',
    name: role === 'owner' ? 'Илья' : 'Маша',
    role,
    state: 'ready',
    lang: 'ru',
    tz: 'Europe/Moscow',
  };
  const budget = (used: number, limit: number | null, reserved = 0): Budget => ({
    limit: limit == null ? null : M(limit),
    used: M(used),
    reserved: M(reserved),
    periodStart,
    periodEnd,
    status: limit && used >= limit ? 'exhausted' : limit && used / limit >= 0.8 ? 'warn' : 'ok',
  });
  const myBudget = empty
    ? budget(0, role === 'owner' ? null : 10)
    : role === 'owner'
      ? budget(18.47, null, 0.3)
      : budget(3.1, 10, 0.12);

  let tasks: TaskDetail[] = empty
    ? []
    : [
        {
          id: 't1',
          name: 'Утренняя сводка',
          scheduleHuman: 'каждый день в 08:30',
          nextRunAt: iso(now + 15 * H),
          status: 'active',
          lastResult: 'ok',
          prompt: 'Каждое утро присылай коротко: погода в Москве, встречи на сегодня и три главных дела.',
          runs: [0, 1, 2, 3, 4].map((i) => ({
            at: iso(now - (9 + i * 24) * H),
            result: 'ok' as const,
            note: i === 2 ? 'Встреч нет — отправил только погоду' : undefined,
          })),
        },
        {
          id: 't2',
          name: 'Отчёт по пятницам',
          scheduleHuman: 'каждую пятницу в 18:00',
          nextRunAt: iso(now + 3 * D),
          status: 'active',
          lastResult: 'error',
          prompt: 'Напомни про недельный отчёт и собери набросок из заметок за неделю.',
          runs: [
            { at: iso(now - 4 * D), result: 'error', note: 'Не удалось открыть заметки — повторю в следующий раз' },
            { at: iso(now - 11 * D), result: 'ok' },
            { at: iso(now - 18 * D), result: 'ok' },
          ],
        },
        {
          id: 't3',
          name: 'Проверка цены на билеты',
          scheduleHuman: 'каждые 6 часов',
          nextRunAt: iso(now + 2 * H),
          status: 'active',
          lastResult: 'silent',
          prompt: 'Проверяй цену на билеты Москва — Тбилиси на 14 ноября. Пиши, только если дешевле 150 €.',
          runs: [
            { at: iso(now - 4 * H), result: 'silent' },
            { at: iso(now - 10 * H), result: 'silent' },
            { at: iso(now - 16 * H), result: 'silent' },
          ],
        },
        {
          id: 't4',
          name: 'Полив цветов',
          scheduleHuman: 'по средам в 20:00',
          nextRunAt: null,
          status: 'paused',
          lastResult: 'ok',
          prompt: 'Напоминай про полив цветов.',
          runs: [{ at: iso(now - 20 * D), result: 'ok' }],
        },
      ];
  const sum = (t: TaskDetail): TaskSummary => ({
    id: t.id,
    name: t.name,
    scheduleHuman: t.scheduleHuman,
    nextRunAt: t.nextRunAt,
    status: t.status,
    lastResult: t.lastResult,
  });

  const memFiles: Record<string, string> = {
    'index.md':
      '# Что я помню\n\nКоротко о тебе и о том, как с тобой лучше работать.\n\n- Живёшь в **Москве**, работаешь удалённо\n- Любишь чай без сахара, кофе — только утром\n- Пишешь коротко, ответы тоже лучше короткие\n\nПодробности — в разделах ниже.',
    'preferences/food.md':
      '# Еда\n\n- Чай без сахара\n- Не ест грибы\n- Любимая кухня — грузинская\n\n> Обновлено после разговора про ужин в пятницу.',
    'preferences/work.md':
      '# Работа\n\nПишешь на TypeScript и Python. Созвоны не любишь — лучше текстом.\n\n1. Утром — глубокая работа\n2. После обеда — встречи\n3. Вечером — почта',
    'people/anya.md':
      '# Аня\n\nСестра. День рождения **14 марта**. Живёт в Тбилиси.\n\nПодарок в прошлом году: [книга](https://example.com/book).',
    'projects/trip.md': '# Поездка в Тбилиси\n\nЛетим 14 ноября. Нужны: билеты, жильё у Сололаки, страховка.',
  };
  const memEntries: MemoryTree['entries'] = empty
    ? []
    : [
        { path: 'index.md', title: 'Что я помню', size: 412, updatedAt: iso(now - 3 * H), kind: 'file' },
        { path: 'preferences', title: 'Предпочтения', size: 0, updatedAt: iso(now - 1 * D), kind: 'dir' },
        { path: 'preferences/food.md', title: 'Еда', size: 190, updatedAt: iso(now - 1 * D), kind: 'file' },
        { path: 'preferences/work.md', title: 'Работа', size: 244, updatedAt: iso(now - 6 * D), kind: 'file' },
        { path: 'people', title: 'Люди', size: 0, updatedAt: iso(now - 9 * D), kind: 'dir' },
        { path: 'people/anya.md', title: 'Аня', size: 160, updatedAt: iso(now - 9 * D), kind: 'file' },
        { path: 'projects', title: 'Проекты', size: 0, updatedAt: iso(now - 2 * D), kind: 'dir' },
        { path: 'projects/trip.md', title: 'Поездка в Тбилиси', size: 118, updatedAt: iso(now - 2 * D), kind: 'file' },
      ];

  let skills: Skill[] = [
    {
      id: 'web',
      name: 'Поиск в интернете',
      description: 'Находит свежую информацию и сверяет источники',
      enabled: true,
      locked: true,
    },
    {
      id: 'files',
      name: 'Работа с файлами',
      description: 'Читает документы, таблицы и фото, которые ты присылаешь',
      enabled: true,
      locked: true,
    },
    {
      id: 'voice',
      name: 'Голосовые сообщения',
      description: 'Понимает голос и отвечает на него текстом',
      enabled: true,
      locked: false,
    },
    {
      id: 'tasks',
      name: 'Напоминания и задачи',
      description: 'Запускает дела по расписанию',
      enabled: true,
      locked: false,
    },
    {
      id: 'calc',
      name: 'Расчёты и таблицы',
      description: 'Считает, строит таблицы и графики',
      enabled: role === 'owner',
      locked: false,
    },
  ];

  const catalog: CatalogItem[] = [
    {
      id: 'github',
      title: 'GitHub',
      description: 'Репозитории, issues и pull requests от вашего имени.',
      keyLabel: 'Personal access token',
      keyHelp:
        'Лучше fine-grained: выберите репозитории и права (Contents, Issues, Pull requests). Классический токен: repo, read:org.',
      keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    },
  ];
  const T = (name: string, readOnly: boolean, title?: string): ConnectorTool => ({
    name,
    title,
    readOnly,
    policy: null,
    asks: !readOnly,
  });
  const ghTools = (): ConnectorTool[] => [
    T('get_me', true, 'Мой профиль'),
    T('list_issues', true, 'Список issues'),
    T('get_file_contents', true, 'Содержимое файла'),
    T('search_repositories', true),
    T('create_issue', false, 'Создать issue'),
    T('add_issue_comment', false, 'Комментарий к issue'),
    T('create_pull_request', false),
    T('merge_pull_request', false, 'Влить pull request'),
    T('push_files', false),
  ];
  let connectors: Connector[] =
    empty || role !== 'owner'
      ? []
      : [
          {
            id: 'github-3f9a1c2e',
            catalogId: 'github',
            title: 'GitHub',
            enabled: true,
            readOnly: false,
            key: { set: true, savedAt: iso(now - 3 * D), status: 'ok' },
            status: 'ok',
            applying: false,
            tools: ghTools(),
          },
        ];
  const reclass = (c: Connector): Connector => ({
    ...c,
    tools: c.tools.map((t) => ({ ...t, asks: t.policy ? t.policy === 'ask' : !t.readOnly })),
  });
  const connStatus = (c: Connector): Connector['status'] =>
    !c.key.set ? 'no_key' : c.key.status === 'rejected' ? 'key_rejected' : !c.enabled ? 'disabled' : 'ok';
  const calls: ConnectorCall[] = [
    {
      at: iso(now - 20 * 60_000),
      tool: 'list_issues',
      dangerous: false,
      decision: 'auto',
      status: 'ok',
      durationMs: 640,
    },
    {
      at: iso(now - 3 * H),
      tool: 'create_issue',
      dangerous: true,
      decision: 'approved',
      status: 'ok',
      durationMs: 1200,
    },
    { at: iso(now - 5 * H), tool: 'merge_pull_request', dangerous: true, decision: 'denied', status: null },
    { at: iso(now - 1 * D), tool: 'push_files', dangerous: true, decision: 'expired', status: null },
    {
      at: iso(now - 2 * D),
      tool: 'get_file_contents',
      dangerous: false,
      decision: 'auto',
      status: 'upstream_error',
      durationMs: 60000,
    },
  ];
  let stt: SttView = {
    provider: 'groq',
    groqKey: { source: role === 'owner' ? 'miniapp' : 'server', savedAt: iso(now - 9 * D) },
    mine: { own: false, sharedAvailable: true },
  };

  const prompt: PromptView = {
    composedAt: iso(now - 2 * H),
    layers: [
      {
        id: 'platform',
        title: 'Системные правила',
        locked: true,
        source: 'Задано владельцем',
        markdown:
          '# Основа\n\n- Отвечай по-русски, если не просят иначе\n- Не выдумывай факты — лучше скажи, что не знаешь\n- Не раскрывай чужие данные',
      },
      {
        id: 'personal',
        title: 'Твои правила',
        locked: false,
        source: 'Из чата с тобой',
        markdown: empty ? '' : '- Отвечай коротко, без вступлений\n- Называй меня на «ты»\n- Время — по Москве',
      },
      {
        id: 'skills',
        title: 'Навыки',
        locked: false,
        source: 'Из набора навыков',
        markdown: '**Поиск**, **файлы**, **голос**, **задачи** — подключены.',
      },
    ],
  };

  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now - (29 - i) * D);
    const v = empty
      ? 0
      : [0.12, 0.4, 0.05, 0.9, 0.22, 0.31, 0, 0.6, 0.18, 0.27, 1.1, 0.08, 0.33, 0.14][i % 14] *
        (role === 'owner' ? 2.4 : 1);
    return { day: d.toISOString().slice(0, 10), cost: M(v) };
  });
  const usage = (n: number): UsageView => ({
    budget: myBudget,
    daily: days.slice(-n),
    byModel: empty
      ? []
      : [
          { model: 'claude-sonnet-4-5', cost: M(2.1) },
          { model: 'claude-opus-4-1', cost: M(0.82) },
          { model: 'claude-haiku-4-5', cost: M(0.18) },
        ],
    byPurpose: empty
      ? []
      : [
          { purpose: 'chat', cost: M(2.2) },
          { purpose: 'task', cost: M(0.65) },
          { purpose: 'voice', cost: M(0.25) },
        ],
    topTurns: empty
      ? []
      : [
          { title: 'Сравни тарифы на интернет и выбери', at: iso(now - 2 * D), cost: M(0.54) },
          { title: 'Разбор договора аренды (PDF)', at: iso(now - 5 * D), cost: M(0.41) },
          { title: 'Отчёт по пятницам', at: iso(now - 4 * D), cost: M(0.22) },
          { title: 'План поездки в Тбилиси', at: iso(now - 1 * D), cost: M(0.19) },
          { title: 'Утренняя сводка', at: iso(now - 9 * H), cost: M(0.04) },
        ],
    pending: M(empty ? 0 : 0.12),
    priceVersion: '2026-09',
  });

  let tailscale: Connection = empty
    ? { id: 'tailscale', status: 'not_connected' }
    : {
        id: 'tailscale',
        status: 'connected',
        node: 'nanoclaw-masha',
        exitNode: 'home-moscow',
        exitNodeOnline: true,
        routes: ['192.168.1.0/24'],
        lastCheckAt: iso(now - 12 * 60_000),
        keySavedAt: iso(now - 24 * D),
        keyExpiresAt: iso(now + 66 * D),
      };
  if (q.get('ts'))
    tailscale = {
      id: 'tailscale',
      status: q.get('ts') as Connection['status'],
      message:
        q.get('ts') === 'expired'
          ? 'Срок действия ключа истёк. Вставь новый.'
          : 'Не удаётся достучаться до выходного узла.',
      keySavedAt: iso(now - 80 * D),
    };
  let egress: EgressView = { route: 'direct', residentialAvailable: role === 'owner' || q.get('res') === '1' };

  let settings: Settings = {
    lang: 'ru',
    tz: 'Europe/Moscow',
    preset: role === 'owner' ? 'deep' : 'normal',
    quietHours: { from: '23:00', to: '08:00' },
    showSteps: true,
  };

  let requests: AccessRequest[] = [
    {
      id: 'r1',
      userId: '901',
      name: 'Дима Орлов',
      username: 'dorlov',
      firstMessage: 'Привет! Илья сказал, что у тебя есть ассистент. Можно мне тоже попробовать?',
      createdAt: iso(now - 40 * 60_000),
    },
    {
      id: 'r2',
      userId: '902',
      name: 'Катя',
      firstMessage: 'Здравствуйте, мне Аня дала ссылку',
      createdAt: iso(now - 5 * H),
    },
  ];
  const fb = (used: number, limit: number): Budget => budget(used, limit);
  let friends: Friend[] = [
    {
      userId: '77100200',
      name: 'Маша',
      username: 'masha_k',
      state: 'ready',
      budget: fb(3.1, 10),
      lastActiveAt: iso(now - 25 * 60_000),
      container: 'running',
      egress: 'direct',
    },
    {
      userId: '77100201',
      name: 'Аня',
      username: 'anya_t',
      state: 'ready',
      budget: fb(9.2, 10),
      lastActiveAt: iso(now - 3 * H),
      container: 'idle',
      egress: 'residential',
    },
    {
      userId: '77100202',
      name: 'Паша',
      state: 'paused',
      budget: fb(10, 10),
      lastActiveAt: iso(now - 6 * D),
      container: 'idle',
      egress: 'direct',
    },
    {
      userId: '77100203',
      name: 'Серёжа',
      username: 'sergey',
      state: 'ready',
      budget: fb(0.4, 5),
      lastActiveAt: iso(now - 2 * D),
      container: 'idle',
      egress: 'direct',
    },
  ];
  let guest: GuestContext = {
    published: {
      version: 4,
      markdown:
        '# Кто я\n\nЯ — помощник Ильи. Могу ответить, когда он занят.\n\n- Расписание: звонки с 12:00 до 17:00\n- Срочное — писать в личку',
      publishedAt: iso(now - 6 * D),
    },
    draft:
      '# Кто я\n\nЯ — помощник Ильи. Могу ответить, когда он занят.\n\n- Расписание: звонки с 12:00 до 17:00\n- Срочное — писать в личку\n- Про цены — только через Илью',
    enabled: true,
    recent: [
      {
        at: iso(now - 3 * H),
        chatTitle: 'Соседи дома 14',
        query: 'Когда Илья вернётся?',
        answer: 'Не знаю точно — спрошу у него и вернусь с ответом.',
      },
      {
        at: iso(now - 2 * D),
        chatTitle: 'Команда запуска',
        query: 'Какое расписание звонков?',
        answer: 'Звонки с 12:00 до 17:00, срочное — в личку.',
      },
    ],
  };
  const system: SystemViewX = {
    version: '2026.10.0',
    uptimeS: 9 * 86400 + 4 * 3600,
    slice: { memUsed: 1.7 * 1024 ** 3, memMax: 3 * 1024 ** 3 },
    containers: { running: 2, max: 4 },
    gateway: 'ok',
    connectors: [
      { tenant: 'Telegram', status: 'ok' },
      { tenant: 'Tailscale · Маша', status: 'ok' },
      { tenant: 'Tailscale · Аня', status: 'expired' },
    ],
    spendByUser: [
      { name: 'Илья', cost: M(18.47) },
      { name: 'Аня', cost: M(9.2) },
      { name: 'Паша', cost: M(10) },
      { name: 'Маша', cost: M(3.1) },
      { name: 'Серёжа', cost: M(0.4) },
    ],
    globalCap: M(100),
    errors7d: 3,
    buildId: '3f9a1c07d2e84b56',
    deployedAt: iso(now - 2 * D),
    grafanaUrl: 'https://grafana.example.com/d/nanoclaw',
    recentAudit: [
      { at: iso(now - 3 * H), actor: 'Илья', action: 'Приостановил друга', target: 'Паша' },
      { at: iso(now - 1 * D), actor: 'Илья', action: 'Опубликовал контекст гостя', target: 'версия 4' },
    ],
  };

  const home = (): HomeView => ({
    me,
    assistant: q.get('busy') ? { status: 'busy', currentTask: 'собираю сравнение тарифов' } : { status: 'ready' },
    budget: myBudget,
    nextTasks: tasks
      .filter((t) => t.status === 'active')
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
      .slice(0, 3)
      .map(sum),
    recentMemory: empty
      ? []
      : [
          { title: 'Любимая еда: чай без сахара', path: 'preferences/food.md', updatedAt: iso(now - 3 * H) },
          { title: 'Поездка в Тбилиси, 14 ноября', path: 'projects/trip.md', updatedAt: iso(now - 2 * D) },
          { title: 'День рождения Ани — 14 марта', path: 'people/anya.md', updatedAt: iso(now - 9 * D) },
        ],
    attention:
      role === 'owner' ? { pendingRequests: requests.length, friendsOverBudget: 1, connectorIssues: 1 } : undefined,
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return async (input, init) => {
    await sleep(Number(q.get('delay') ?? 250));
    const method = init?.method ?? 'GET';
    const u = new URL(input, 'http://mock');
    const p = u.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (p === '/api/session') return json({ token: 'mock-token', expiresAt: iso(now + 15 * 60_000), me });
    if (method === 'GET' && failOnce) {
      failOnce = false;
      return err(500, 'internal', 'Тестовая ошибка');
    }
    const m = (re: RegExp) => p.match(re);
    let mm: RegExpMatchArray | null;
    if (p.startsWith('/api/owner/') && role !== 'owner') return err(403, 'forbidden', 'Только для владельца');

    if (p === '/api/home') return json(home());
    if (p === '/api/prompt') return json(prompt);
    if (p === '/api/memory') return json({ entries: memEntries, truncated: false } satisfies MemoryTree);
    if (p === '/api/memory/file') {
      const path = u.searchParams.get('path') ?? '';
      const md = memFiles[path];
      return md
        ? json({
            path,
            markdown: md,
            truncated: false,
            updatedAt: memEntries.find((e) => e.path === path)?.updatedAt ?? iso(now),
          } satisfies MemoryFile)
        : err(404, 'not_found', 'Файл не найден');
    }
    if (p === '/api/memory/forget') return new Response(null, { status: 202 });
    if (p === '/api/skills') return json(skills);
    mm = m(/^\/api\/skills\/([^/]+)$/);
    if (mm && method === 'PUT') {
      const sk = skills.find((x) => x.id === mm![1]);
      if (!sk) return err(404, 'not_found', 'Навык не найден');
      if (sk.locked) return err(403, 'forbidden', 'Этот навык нельзя отключить');
      skills = skills.map((x) => (x === sk ? { ...x, enabled: !!body.enabled } : x));
      return json(skills);
    }
    if (p === '/api/tasks') return json(tasks.map(sum));
    mm = m(/^\/api\/tasks\/([^/]+)(?:\/(pause|resume))?$/);
    if (mm) {
      const t = tasks.find((x) => x.id === mm![1]);
      if (!t) return err(404, 'not_found', 'Задача не найдена');
      if (method === 'GET') return json(t);
      if (method === 'DELETE') {
        tasks = tasks.filter((x) => x !== t);
        return new Response(null, { status: 204 });
      }
      if (mm[2] === 'pause') {
        t.status = 'paused';
        t.nextRunAt = null;
      }
      if (mm[2] === 'resume') {
        t.status = 'active';
        t.nextRunAt = iso(now + 5 * H);
      }
      return new Response(null, { status: 204 });
    }
    if (p === '/api/usage') return json(usage(u.searchParams.get('days') === '30' ? 30 : 14));
    if (p === '/api/connections') return json({ connections: [tailscale], egress, stt });
    if (p === '/api/secrets/groq-key') {
      if (method === 'PUT') {
        if (!/^gsk_[A-Za-z0-9]{20,}$/.test(String(body.value))) return err(400, 'invalid', 'Groq не принял ключ');
        stt = {
          ...stt,
          groqKey: { source: 'own', savedAt: iso(Date.now()) },
          mine: { own: true, sharedAvailable: stt.mine?.sharedAvailable ?? false },
        };
      } else {
        stt = {
          ...stt,
          groqKey: { source: role === 'owner' ? 'miniapp' : 'server', savedAt: iso(now - 9 * D) },
          mine: { own: false, sharedAvailable: stt.mine?.sharedAvailable ?? false },
        };
      }
      return json(stt);
    }
    if (p === '/api/connections/tailscale/reconnect') {
      tailscale = { ...tailscale, status: 'connected', lastCheckAt: iso(Date.now()), message: undefined };
      return new Response(null, { status: 204 });
    }
    if (p === '/api/connections/tailscale' && method === 'DELETE') {
      tailscale = { id: 'tailscale', status: 'not_connected' };
      return new Response(null, { status: 204 });
    }
    if (p === '/api/egress') {
      egress = { ...egress, route: body.route };
      return json(egress);
    }
    if (p === '/api/settings') {
      if (method === 'PATCH') settings = { ...settings, ...body };
      return json(settings);
    }

    if (p.startsWith('/api/connectors') && role !== 'owner') return err(403, 'forbidden', 'Только для владельца');
    if (p === '/api/connectors' && method === 'GET') return json({ catalog, connectors });
    if (p === '/api/connectors' && method === 'POST') {
      if (connectors.some((c) => c.catalogId === body.catalogId)) return err(409, 'conflict', 'Уже подключено');
      const item = catalog.find((i) => i.id === body.catalogId);
      if (!item) return err(404, 'not_found', 'Нет такого коннектора');
      const c: Connector = {
        id: `${item.id}-${Math.random().toString(16).slice(2, 10)}`,
        catalogId: item.id,
        title: item.title,
        enabled: false,
        readOnly: false,
        key: { set: false, status: null },
        status: 'no_key',
        applying: false,
        tools: [],
      };
      connectors = [...connectors, c];
      return json(c);
    }
    mm = m(/^\/api\/connectors\/([^/]+)(?:\/(key|calls))?$/);
    if (mm) {
      const c = connectors.find((x) => x.id === mm![1]);
      if (!c) return err(404, 'not_found', 'Коннектор не найден');
      const upd = (n: Connector) => {
        n = reclass({ ...n, status: connStatus(n), applying: true });
        connectors = connectors.map((x) => (x === c ? n : x));
        return json(n);
      };
      if (mm[2] === 'calls') return json(calls);
      if (mm[2] === 'key') {
        if (method === 'PUT') {
          const v = String(body.value ?? '');
          if (!/^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,255})$/.test(v))
            return err(400, 'invalid', v.startsWith('bad') ? 'GitHub не принял ключ' : 'Не похоже на токен GitHub');
          return upd({
            ...c,
            key: { set: true, savedAt: iso(Date.now()), status: 'ok' },
            enabled: c.key.set ? c.enabled : true,
            tools: c.tools.length ? c.tools : ghTools(),
          });
        }
        return upd({ ...c, key: { set: false, status: null }, enabled: false });
      }
      if (method === 'DELETE') {
        connectors = connectors.filter((x) => x !== c);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        if (body.enabled === true && !c.key.set) return err(409, 'conflict', 'Сначала добавьте ключ');
        const policy = Object.fromEntries(c.tools.map((t) => [t.name, t.policy])) as Record<
          string,
          'ask' | 'auto' | null
        >;
        for (const [k, v] of Object.entries((body.toolPolicy ?? {}) as Record<string, 'ask' | 'auto' | null>))
          policy[k] = v;
        return upd({
          ...c,
          enabled: body.enabled ?? c.enabled,
          readOnly: body.readOnly ?? c.readOnly,
          tools: c.tools.map((t) => ({ ...t, policy: policy[t.name] ?? null })),
        });
      }
    }

    if (p === '/api/owner/requests') return json(requests);
    mm = m(/^\/api\/owner\/requests\/([^/]+)\/(approve|deny)$/);
    if (mm) {
      requests = requests.filter((r) => r.id !== mm![1]);
      return new Response(null, { status: 204 });
    }
    if (p === '/api/owner/friends') return json(friends);
    mm = m(/^\/api\/owner\/friends\/([^/]+)(?:\/(pause|resume))?$/);
    if (mm) {
      const f = friends.find((x) => x.userId === mm![1]);
      if (!f) return err(404, 'not_found', 'Не найден');
      if (method === 'DELETE') {
        friends = friends.filter((x) => x !== f);
        return new Response(null, { status: 204 });
      }
      if (mm[2]) f.state = mm[2] === 'pause' ? 'paused' : 'ready';
      if (method === 'PATCH') {
        if (body.limitUsd != null) f.budget = { ...f.budget, limit: M(body.limitUsd) };
        if (body.egress) f.egress = body.egress;
      }
      return json(f);
    }
    if (p === '/api/owner/guest') return json(guest);
    if (p === '/api/owner/guest/draft') {
      guest = { ...guest, draft: body.markdown };
      return new Response(null, { status: 204 });
    }
    if (p === '/api/owner/guest/publish') {
      guest = {
        ...guest,
        published: {
          version: (guest.published?.version ?? 0) + 1,
          markdown: guest.draft,
          publishedAt: iso(Date.now()),
        },
      };
      return new Response(null, { status: 204 });
    }
    if (p === '/api/owner/guest/enabled') {
      guest = { ...guest, enabled: body.enabled };
      return new Response(null, { status: 204 });
    }
    if (p === '/api/owner/guest/preview')
      return json({
        answer: `Я — помощник Ильи. ${String(body.question).slice(0, 60)}: могу ответить, когда он занят.`,
      });
    if (p === '/api/owner/system') return json(system);
    return err(404, 'not_found', `Нет такого метода: ${p}`);
  };
}
