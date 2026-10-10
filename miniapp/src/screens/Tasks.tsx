import type { TaskDetail, TaskSummary } from '../api/types';
import { useApp, useApi, invalidate } from '../ctx';
import { timeOfDay, whenHuman, dateShort } from '../format';
import * as tg from '../tg';
import { Btn, Chip, Empty, ErrorBanner, Hint, Loadable, Row, Screen, Section, Skeleton, Svg, useAction } from '../ui';

const RESULT = { ok: ['ok', 'Выполнено'], error: ['bad', 'Ошибка'], silent: [undefined, 'Без сообщения'] } as const;

export function Tasks() {
  const { go, me } = useApp();
  const res = useApi<TaskSummary[]>('/api/tasks');
  return (
    <Screen title="Задачи" sub="Что запланировано">
      <Loadable res={res} rows={4}>
        {(list) => list.length === 0 ? (
          <Empty emoji="🗓️" title="Задач нет">Скажи в чате: <q>напоминай по пятницам в 18:00 про отчёт</q></Empty>
        ) : (
          <Section>
            {list.map((t) => (
              <Row
                key={t.id}
                title={t.name}
                sub={<>{t.scheduleHuman}{t.status === 'active' && t.nextRunAt ? <> · {whenHuman(t.nextRunAt, me.tz)}</> : null}</>}
                right={<>
                  {t.status === 'paused' ? <Chip>Пауза</Chip> : t.lastResult === 'error' ? <Chip kind="bad">Ошибка</Chip> : t.lastResult === 'ok' ? <Svg name="check" class="i" /> : null}
                </>}
                chevron
                onClick={() => go({ name: 'task', arg: t.id })}
              />
            ))}
          </Section>
        )}
      </Loadable>
      {res.data && res.data.length > 0 && <Hint>Новую задачу можно поставить в чате: <q>напоминай каждый день в 9 утра</q></Hint>}
    </Screen>
  );
}

export function TaskView({ id }: { id: string }) {
  const { api, me, back, toast } = useApp();
  const res = useApi<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
  const act = useAction(toast);
  const t = res.data;
  async function toggle() {
    if (!t) return;
    const verb = t.status === 'active' ? 'pause' : 'resume';
    const ok = await act.run(() => api.post(`/api/tasks/${encodeURIComponent(id)}/${verb}`), verb === 'pause' ? 'Задача на паузе' : 'Задача снова работает');
    if (ok) { invalidate('/api/tasks'); invalidate('/api/home'); res.reload(); }
  }
  async function remove() {
    if (!t) return;
    const sure = await tg.confirm({ title: 'Удалить задачу?', message: `«${t.name}» больше не будет срабатывать. Это нельзя отменить.`, okText: 'Удалить', destructive: true });
    if (!sure) return;
    const done = await act.run(() => api.del(`/api/tasks/${encodeURIComponent(id)}`), 'Задача удалена');
    if (done) { invalidate('/api/tasks'); invalidate('/api/home'); back(); }
  }
  return (
    <Screen title={t?.name ?? 'Задача'} sub={t?.scheduleHuman}>
      {res.error && <ErrorBanner error={res.error} onRetry={res.reload} />}
      {!t && !res.error && <Skeleton rows={3} />}
      {t && (
        <>
          <Section header="Когда">
            <Row title={t.status === 'paused' ? 'На паузе' : 'Следующий запуск'} value={t.status === 'paused' ? undefined : t.nextRunAt ? whenHuman(t.nextRunAt, me.tz) : '—'} />
            <Row title="Расписание" value={t.scheduleHuman} />
          </Section>
          <Section header="Что делает"><div class="quote">{t.prompt}</div></Section>
          <Section header="Последние запуски">
            {t.runs.length === 0 ? <Row title={<span class="muted">Ещё не запускалась</span>} /> : t.runs.slice(0, 5).map((r, i) => {
              const [kind, label] = RESULT[r.result];
              return <Row key={i} title={`${dateShort(r.at, me.tz)}, ${timeOfDay(r.at, me.tz)}`} sub={r.note} right={<Chip kind={kind}>{label}</Chip>} />;
            })}
          </Section>
          <div class="btns" style="margin-bottom:12px">
            <Btn kind="tint" onClick={toggle} disabled={act.busy}>{t.status === 'active' ? 'Пауза' : 'Возобновить'}</Btn>
            <Btn kind="danger" onClick={remove} disabled={act.busy}>Удалить</Btn>
          </div>
        </>
      )}
    </Screen>
  );
}


