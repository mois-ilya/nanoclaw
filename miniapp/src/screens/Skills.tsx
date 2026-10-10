import type { Skill } from '../api/types';
import { useApi } from '../ctx';
import { Chip, Loadable, Row, Screen, Section, Svg } from '../ui';

export function Skills() {
  const res = useApi<Skill[]>('/api/skills');
  return (
    <Screen title="Навыки" sub="Что я умею">
      <Loadable res={res} rows={5}>
        {(list) => (
          <Section footer="Новые навыки подключает владелец. Попросить можно в чате.">
            {list.map((s) => (
              <Row
                key={s.id}
                title={s.name}
                sub={s.description}
                right={s.locked ? <Svg name="lock" class="chev i" /> : <Chip kind={s.enabled ? 'ok' : undefined}>{s.enabled ? 'Включён' : 'Выключен'}</Chip>}
              />
            ))}
          </Section>
        )}
      </Loadable>
    </Screen>
  );
}
