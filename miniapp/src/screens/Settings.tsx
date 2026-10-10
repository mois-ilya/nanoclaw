import { useEffect, useState } from 'preact/hooks';
import type { Settings as S } from '../api/types';
import { useApp, useApi, invalidate } from '../ctx';
import { Loadable, Row, Screen, Section, Segmented, Switch } from '../ui';
import * as tg from '../tg';

const ZONES = ['Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka',
  'Europe/Kyiv', 'Europe/Minsk', 'Europe/London', 'Europe/Lisbon', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Istanbul', 'Europe/Helsinki', 'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku', 'Asia/Almaty', 'Asia/Tashkent', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];
const zoneLabel = (z: string) => z.split('/').pop()!.replace(/_/g, ' ');

const PRESETS: { value: S['preset']; label: string; cap: string }[] = [
  { value: 'fast', label: 'Быстро', cap: 'Отвечаю быстрее и дешевле — для простых вопросов.' },
  { value: 'normal', label: 'Обычно', cap: 'Золотая середина для большинства дел.' },
  { value: 'deep', label: 'Вдумчиво', cap: 'Думаю дольше и глубже — для сложного. Расходует больше.' },
];

export function Settings() {
  const { api, me, setMe, toast } = useApp();
  const res = useApi<S>('/api/settings');
  const [local, setLocal] = useState<S | null>(null);
  useEffect(() => { if (res.data) setLocal(res.data); }, [res.data]);

  async function patch(p: Partial<S>) {
    if (!local) return;
    const prev = local;
    setLocal({ ...local, ...p }); // instant apply, rolled back on failure
    try {
      const next = await api.patch<S>('/api/settings', p);
      setLocal(next); res.set(next); tg.haptic.success();
      if (next.tz !== me.tz || next.lang !== me.lang) { setMe({ ...me, tz: next.tz, lang: next.lang }); invalidate(); }
    } catch {
      setLocal(prev); tg.haptic.error(); toast('Не удалось сохранить', 'err');
    }
  }

  return (
    <Screen title="Настройки" sub="Как мне удобнее">
      <Loadable res={{ ...res, data: local ?? undefined }} rows={5}>
        {(s) => {
          const zones = ZONES.includes(s.tz) ? ZONES : [s.tz, ...ZONES];
          const preset = PRESETS.find((p) => p.value === s.preset)!;
          return (
            <>
              <Section header="Ответы" footer="Лимиты и бюджет меняет владелец.">
                <div class="pad-seg">
                  <Segmented value={s.preset} options={PRESETS} onChange={(v) => patch({ preset: v })} />
                  <div class="cap">{preset.cap}</div>
                </div>
                <Row title="Показывать «Что я сделал»" sub="Короткий список шагов под длинными ответами" right={<Switch label="Показывать шаги" checked={s.showSteps} onChange={(v) => patch({ showSteps: v })} />} />
              </Section>

              <Section header="Язык и время">
                <div class="pad-seg"><Segmented value={s.lang} options={[{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }]} onChange={(v) => patch({ lang: v })} /><div class="cap">Язык, на котором я отвечаю</div></div>
                <label class="row" style="cursor:pointer">
                  <div class="body"><div class="t">Часовой пояс</div></div>
                  <select class="v" style="border:0;background:transparent;text-align:right;max-width:55%;outline:none;font-size:16px;color:var(--link)" value={s.tz} onChange={(e) => patch({ tz: (e.target as HTMLSelectElement).value })} aria-label="Часовой пояс">
                    {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
                  </select>
                </label>
              </Section>

              <Section header="Уведомления" footer="Напоминания и сводки в тихие часы приходят без звука.">
                <Row title="Ночью не беспокоить" sub={s.quietHours ? `${s.quietHours.from} – ${s.quietHours.to}` : 'Выключено'} right={<Switch label="Тихие часы" checked={!!s.quietHours} onChange={(v) => patch({ quietHours: v ? { from: '23:00', to: '08:00' } : null })} />} />
                {s.quietHours && (
                  <div class="row" style="gap:10px">
                    <div class="body"><div class="t">С</div></div>
                    <input class="time" type="time" aria-label="С" value={s.quietHours.from} onChange={(e) => patch({ quietHours: { from: (e.target as HTMLInputElement).value || '23:00', to: s.quietHours!.to } })} />
                    <span class="muted">до</span>
                    <input class="time" type="time" aria-label="До" value={s.quietHours.to} onChange={(e) => patch({ quietHours: { from: s.quietHours!.from, to: (e.target as HTMLInputElement).value || '08:00' } })} />
                  </div>
                )}
              </Section>
            </>
          );
        }}
      </Loadable>
    </Screen>
  );
}
