import { useEffect, useState } from 'preact/hooks';
import { GUEST_MAX_DEFAULT, type GuestContextX, type GuestPreview } from '../api/extra';
import { useApp, useApi, invalidate, useClosingConfirmation } from '../ctx';
import { ago, dateShort } from '../format';
import { interceptLinks, renderMarkdown } from '../markdown';
import * as tg from '../tg';
import { ActionBar, Btn, Chip, Loadable, Row, Screen, Section, Segmented, Switch, useAction } from '../ui';

export function Guest() {
  const { api, me, toast } = useApp();
  const res = useApi<GuestContextX>('/api/owner/guest');
  const act = useAction(toast);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (res.data && draft === null) setDraft(res.data.draft); }, [res.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const g = res.data;
  const MAX = g?.maxChars ?? GUEST_MAX_DEFAULT;
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const dirty = g != null && draft != null && draft !== g.draft;
  useClosingConfirmation(dirty);
  const refresh = () => { invalidate('/api/owner/guest'); res.reload(); };

  async function save() {
    if (draft == null || draft.length > MAX) return;
    const ok = await tg.confirm({ title: 'Сохранить черновик?', message: 'Бот начнёт использовать его только после публикации.', okText: 'Сохранить' });
    if (!ok) return;
    if (await act.run(() => api.put('/api/owner/guest/draft', { markdown: draft }), 'Черновик сохранён')) refresh();
  }
  async function publish() {
    const ok = await tg.confirm({ title: 'Опубликовать?', message: 'Бот будет говорить в чужих чатах от твоего имени по этому тексту.', okText: 'Опубликовать' });
    if (!ok) return;
    if (await act.run(() => api.post('/api/owner/guest/publish'), 'Опубликовано')) refresh();
  }
  async function check() {
    const q = question.trim() || `Расскажи о ${me.name}`;
    let r: GuestPreview | undefined;
    const ok = await act.run(async () => { r = await api.post<GuestPreview>('/api/owner/guest/preview', { question: q, useDraft: true }); });
    if (ok && r) setAnswer(r.answer);
  }
  async function toggle(enabled: boolean) {
    if (g) res.set({ ...g, enabled });
    if (!(await act.run(() => api.post('/api/owner/guest/enabled', { enabled })))) refresh();
  }

  return (
    <Screen title="Гость" sub="Что бот может сказать от моего имени" bar={dirty}>
      <Loadable res={res} rows={3}>
        {(d) => {
          const unpublished = !d.published || d.published.markdown !== d.draft;
          const text = draft ?? d.draft;
          return (
            <>
              <Section footer="Когда выключено, бот в чужих чатах молчит.">
                <Row title="Гость включён" right={<Switch label="Гость включён" checked={d.enabled} onChange={toggle} />} />
              </Section>

              <Section header="Контекст" footer={d.published ? `Опубликована версия ${d.published.version} · ${dateShort(d.published.publishedAt, me.tz)}` : 'Ещё ничего не опубликовано'}>
                <div class="pad-seg"><Segmented value={preview ? 'p' : 'e'} options={[{ value: 'e', label: 'Правка' }, { value: 'p', label: 'Просмотр' }]} onChange={(v) => setPreview(v === 'p')} /></div>
                {preview ? (
                  <div class="card pad md" style="border-top:0.5px solid var(--sep);border-radius:0" onClick={interceptLinks} dangerouslySetInnerHTML={{ __html: renderMarkdown(text || '*Пусто*') }} />
                ) : (
                  <>
                    <textarea class="field" style="border-top:0.5px solid var(--sep)" value={text} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} placeholder="Кто ты для гостей, что можно рассказывать, а что нет…" aria-label="Контекст для гостя" spellcheck={false} />
                    <div class={`counter${text.length > MAX ? ' over' : ''}`}>{text.length} / {MAX}</div>
                  </>
                )}
              </Section>

              <Section header="Проверить ответ" footer="Спросим бота так, как спросил бы чужой человек, по черновику. Считается в расход «гость».">
                <input class="field" value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} placeholder={`Расскажи о ${me.name}`} aria-label="Вопрос гостя" autocomplete="off" />
                <div class="card pad" style="border-radius:0;border-top:0.5px solid var(--sep)"><Btn kind="tint" onClick={check} disabled={act.busy || dirty}>Проверить ответ</Btn></div>
                {dirty && <div class="quote muted" style="padding-top:2px">Сначала сохрани черновик — проверка идёт по сохранённому тексту.</div>}
                {answer != null && <div class="card pad md" style="border-radius:0;border-top:0.5px solid var(--sep)" onClick={interceptLinks} dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }} />}
              </Section>

              <Section footer={dirty ? 'Сначала сохрани черновик.' : unpublished ? 'Есть изменения, которые бот ещё не использует.' : 'Бот использует актуальную версию.'}>
                <div class="card pad" style="border-radius:0;display:flex;align-items:center;justify-content:space-between;gap:12px">
                  <span>{unpublished ? <Chip kind="warn">Не опубликовано</Chip> : <Chip kind="ok">Опубликовано</Chip>}</span>
                  <Btn kind="tint" onClick={publish} disabled={dirty || !unpublished || act.busy}>Опубликовать</Btn>
                </div>
              </Section>

              <Section header="Недавние обращения">
                {d.recent.length === 0 ? <Row title={<span class="muted">Пока никто не обращался</span>} /> : d.recent.map((r, i) => (
                  <details class="layer" key={i}>
                    <summary class="row tap" style="min-height:56px">
                      <div class="body"><div class="t">{r.query}</div><div class="s">{r.chatTitle} · {ago(r.at, new Date(), me.tz)}</div></div>
                    </summary>
                    <div class="layer-body"><div class="s muted" style="font-size:13px;margin-top:10px">Ответ</div><div class="md" style="margin-top:4px">{r.answer}</div></div>
                  </details>
                ))}
              </Section>
            </>
          );
        }}
      </Loadable>
      <ActionBar main={{ text: 'Сохранить', visible: dirty && (draft?.length ?? 0) <= MAX, progress: act.busy, onClick: save }} />
    </Screen>
  );
}
