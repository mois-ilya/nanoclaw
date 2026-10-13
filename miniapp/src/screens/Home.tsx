import type { HomeView } from '../api/types';
import { useApp, useApi } from '../ctx';
import { budgetFraction, count, dateLong, money, whenHuman, ago } from '../format';
import { Hint, Loadable, Ring, Row, Section, Svg, type IconName } from '../ui';
import type { RouteName } from '../router';

const STATUS: Record<HomeView['assistant']['status'], [string, string]> = {
  ready: ['ok', 'Ассистент готов'],
  busy: ['busy', 'Занят'],
  paused: ['warn', 'Приостановлен'],
  error: ['bad', 'Что-то пошло не так'],
};

const NAV: { name: RouteName; title: string; sub: string; icon: IconName; color: string }[] = [
  { name: 'memory', title: 'Память', sub: 'Что обо мне известно', icon: 'memory', color: 'indigo' },
  { name: 'prompt', title: 'Инструкции', sub: 'Как я себя веду', icon: 'prompt', color: 'blue' },
  { name: 'skills', title: 'Навыки', sub: 'Что я умею', icon: 'skills', color: 'orange' },
  { name: 'tasks', title: 'Задачи', sub: 'Что запланировано', icon: 'tasks', color: 'green' },
  { name: 'usage', title: 'Расход', sub: 'Куда ушли деньги', icon: 'usage', color: 'pink' },
  { name: 'connections', title: 'Подключения', sub: 'Ключи и доступ', icon: 'connections', color: 'teal' },
  { name: 'settings', title: 'Настройки', sub: 'Как мне удобнее', icon: 'settings', color: 'gray' },
];

export function Home() {
  const { me, go } = useApp();
  const res = useApi<HomeView>('/api/home');
  const owner = me.role === 'owner';
  return (
    <main class="screen">
      <header class="hello">
        <h1>Привет, {me.name}</h1>
        {res.data &&
          (() => {
            const [kind, label] =
              STATUS[
                res.data.assistant.status === 'ready' && me.state === 'paused' ? 'paused' : res.data.assistant.status
              ];
            const detail =
              res.data.assistant.status === 'busy' && res.data.assistant.currentTask
                ? `: ${res.data.assistant.currentTask}`
                : '';
            return (
              <div class="status">
                <span class={`dot ${kind}`} />
                {label}
                {detail}
              </div>
            );
          })()}
      </header>
      <Loadable res={res} rows={3} hero>
        {(h) => {
          const tz = me.tz;
          const frac = budgetFraction(h.budget);
          const brandNew = h.nextTasks.length === 0 && h.recentMemory.length === 0 && h.budget.used.micros === 0;
          const a = h.attention;
          return (
            <>
              {owner && a && (a.pendingRequests > 0 || a.friendsOverBudget > 0 || a.connectorIssues > 0) && (
                <div class="attn card">
                  {a.pendingRequests > 0 && (
                    <Row
                      icon={{ name: 'requests', color: 'orange' }}
                      title={`${count(a.pendingRequests, 'запрос ждёт', 'запроса ждут', 'запросов ждут')} решения`}
                      chevron
                      onClick={() => go({ name: 'requests' })}
                    />
                  )}
                  {a.friendsOverBudget > 0 && (
                    <Row
                      icon={{ name: 'friends', color: 'red' }}
                      title={`${count(a.friendsOverBudget, 'друг', 'друга', 'друзей')} у лимита`}
                      sub="Бюджет почти или полностью исчерпан"
                      chevron
                      onClick={() => go({ name: 'friends' })}
                    />
                  )}
                  {a.connectorIssues > 0 && (
                    <Row
                      icon={{ name: 'alert', color: 'red' }}
                      title={`${count(a.connectorIssues, 'подключение требует', 'подключения требуют', 'подключений требуют')} внимания`}
                      chevron
                      onClick={() => go({ name: 'connections' })}
                    />
                  )}
                </div>
              )}

              <div style="margin-bottom:22px">
                <button class="budget" onClick={() => go({ name: 'usage' })} aria-label="Расход">
                  <Ring
                    fraction={frac}
                    status={h.budget.status}
                    label={frac == null ? 'Без лимита' : `Потрачено ${Math.round(frac * 100)}%`}
                  />
                  <div style="flex:1;min-width:0">
                    <div class="big">
                      {money(h.budget.used)}
                      {h.budget.limit && (
                        <span class="muted" style="font-weight:500">
                          {' '}
                          из {money(h.budget.limit, { compact: true })}
                        </span>
                      )}
                    </div>
                    <div class="small">
                      {h.budget.limit ? (
                        <>сбросится {dateLong(h.budget.periodEnd, tz)}</>
                      ) : (
                        'за этот месяц · без лимита'
                      )}
                      {h.budget.status === 'exhausted' && <> · лимит исчерпан</>}
                    </div>
                  </div>
                  <Svg name="chev" class="chev i" />
                </button>
              </div>

              {brandNew && (
                <div style="margin-bottom:22px">
                  <Hint emoji="👋">
                    Пока пусто. Напиши мне в чат: <q>запомни, что я люблю чай без сахара</q> — и это появится здесь.
                  </Hint>
                </div>
              )}

              {!brandNew && (
                <Section header="Дальше по плану" action={{ text: 'Все', onClick: () => go({ name: 'tasks' }) }}>
                  {h.nextTasks.length === 0 ? (
                    <Row
                      title={<span class="muted">Задач нет</span>}
                      sub={
                        <>
                          Скажи в чате: <q>напоминай по пятницам в 18:00 про отчёт</q>
                        </>
                      }
                    />
                  ) : (
                    h.nextTasks.map((t) => (
                      <Row
                        key={t.id}
                        icon={{ name: 'tasks', color: 'green' }}
                        title={t.name}
                        sub={t.nextRunAt ? whenHuman(t.nextRunAt, tz) : t.scheduleHuman}
                        chevron
                        onClick={() => go({ name: 'task', arg: t.id })}
                      />
                    ))
                  )}
                </Section>
              )}

              {!brandNew && (
                <Section header="Запомнил" action={{ text: 'Вся память', onClick: () => go({ name: 'memory' }) }}>
                  {h.recentMemory.length === 0 ? (
                    <Row title={<span class="muted">Ещё ничего не запомнил</span>} />
                  ) : (
                    h.recentMemory
                      .slice(0, 3)
                      .map((m) => (
                        <Row
                          key={m.path}
                          icon={{ name: 'memory', color: 'indigo' }}
                          title={m.title}
                          sub={ago(m.updatedAt, new Date(), tz)}
                          chevron
                          onClick={() => go({ name: 'memoryFile', arg: m.path })}
                        />
                      ))
                  )}
                </Section>
              )}

              <Section header="Разделы">
                {NAV.map((n) => (
                  <Row
                    key={n.name}
                    icon={{ name: n.icon, color: n.color }}
                    title={n.title}
                    sub={n.sub}
                    chevron
                    onClick={() => go({ name: n.name })}
                  />
                ))}
              </Section>

              {owner && (
                <Section header="Владелец">
                  <Row
                    icon={{ name: 'requests', color: 'orange' }}
                    title="Запросы"
                    sub="Кто ждёт решения"
                    right={a && a.pendingRequests > 0 ? <span class="badge">{a.pendingRequests}</span> : undefined}
                    chevron
                    onClick={() => go({ name: 'requests' })}
                  />
                  <Row
                    icon={{ name: 'connections', color: 'purple' }}
                    title="Коннекторы"
                    sub="GitHub и другие сервисы"
                    chevron
                    onClick={() => go({ name: 'connectors' })}
                  />
                  <Row
                    icon={{ name: 'friends', color: 'blue' }}
                    title="Друзья"
                    sub="Кто чем пользуется"
                    chevron
                    onClick={() => go({ name: 'friends' })}
                  />
                  <Row
                    icon={{ name: 'guest', color: 'purple' }}
                    title="Гость"
                    sub="Что бот скажет от моего имени"
                    chevron
                    onClick={() => go({ name: 'guest' })}
                  />
                  <Row
                    icon={{ name: 'system', color: 'gray' }}
                    title="Система"
                    sub="Сервер и расходы"
                    chevron
                    onClick={() => go({ name: 'system' })}
                  />
                </Section>
              )}
            </>
          );
        }}
      </Loadable>
    </main>
  );
}
