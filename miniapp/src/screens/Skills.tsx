import { useApp, useApi } from '../ctx';
import type { Skill } from '../api/types';
import { Loadable, Row, Screen, Section, Svg, Switch, useAction } from '../ui';

export function Skills() {
  const { api, toast } = useApp();
  const res = useApi<Skill[]>('/api/skills');
  const act = useAction(toast);
  async function toggle(s: Skill, enabled: boolean) {
    const prev = res.data;
    if (!prev) return;
    res.set(prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    let out: Skill[] | undefined;
    const ok = await act.run(async () => {
      out = await api.put<Skill[]>(`/api/skills/${encodeURIComponent(s.id)}`, { enabled });
    });
    res.set(ok && out ? out : prev);
  }
  return (
    <Screen title="Навыки" sub="Что я умею">
      <Loadable res={res} rows={5}>
        {(list) => (
          <Section footer="Применится к новым и простаивающим разговорам. Новые навыки подключает владелец.">
            {list.map((s) => (
              <Row
                key={s.id}
                title={s.name}
                sub={s.description}
                right={
                  <>
                    {s.locked && <Svg name="lock" class="chev i" />}
                    <Switch
                      checked={s.enabled}
                      disabled={s.locked || act.busy}
                      label={s.name}
                      onChange={(v) => toggle(s, v)}
                    />
                  </>
                }
              />
            ))}
          </Section>
        )}
      </Loadable>
    </Screen>
  );
}
