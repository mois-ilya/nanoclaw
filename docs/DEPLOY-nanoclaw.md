# Деплой NanoClaw на nuremberg: пошаговый ранбук владельца

Форк: ветка `v2-rebuild`, NixOS-модуль `services.nanoclaw` (`nix/module.nix`). Архитектура и список опций: `nix/README.md`. Все изменения на сервере делаются только через Nix-конфиг и `nix run .#deploy nuremberg`; вручную ничего не правим.

Порядок: секреты, роутер, BotFather, конфиг nixserver, предпусковые проверки, переключение, чек-лист первого запуска.

## 1. Секреты (sops, `secrets/secrets.yaml` в nixserver)

| Ключ sops | Что это | Как получить |
| --- | --- | --- |
| `nanoclaw/telegram_bot_token` | токен бота | BotFather, `/token`. На время проверок бери токен тестового бота, прод-токен только на переключении |
| `nanoclaw/anthropic_api_key` | ключ Anthropic API, который nanogate подставляет в запросы агентов | console.anthropic.com. Контейнеры агентов ключа не видят |
| `nanoclaw/tailscale_owner_authkey` | auth key узла-коннектора владельца | Tailscale admin, Settings, Keys: reusable, ephemeral, теги по вашей ACL. Нужен только при `tailscale.owner.enable = true` |
| `nanoclaw/nanogate_key` | 32 случайных байта (hex или base64): AES-256-GCM для токенов и секретов в БД nanogate | `openssl rand -hex 32` |

Редактирование без интерактива (как в CLAUDE.md nixserver):

```bash
nix-shell -p sops --run "sops -d secrets/secrets.yaml" > /tmp/secrets.yaml
# добавить четыре ключа в блок nanoclaw:
cp /tmp/secrets.yaml secrets/secrets.yaml && nix-shell -p sops --run "sops -e -i secrets/secrets.yaml"
```

Файлы читаются systemd через `LoadCredential`, поэтому подходят права root `0400`. Ключ `nanogate_key` после запуска не менять: сохранённые токены перестанут расшифровываться.

## 2. Роутер и tailnet (домашний выход)

Выполняется, если включён `tailscale.owner` (домашний выход владельца через `gl-mt3000-beryl`).

1. Зайти на роутер GL.iNet MT3000 (Tailscale в его админке) и обновить узел: выйти из tailnet и войти заново, чтобы получить новый node key. Сообщение «node key expired» значит, что ключ истёк.
2. В Tailscale admin, Machines, `gl-mt3000-beryl`: меню узла, Disable key expiry.
3. На роутере включить Exit node (Allow remote access to LAN по желанию; нужен только если агент должен ходить в домашнюю сеть). В admin: меню узла, Edit route settings, галочка Use as exit node, Approve.
4. ACL. Узел сервера (`nanoclaw-owner`) должен иметь право пользоваться exit node и ходить в разрешённые адреса. Минимальный фрагмент (теги подстрой под свои):

   ```json
   {
     "tagOwners": { "tag:nanoclaw": ["autogroup:admin"] },
     "acls": [
       { "action": "accept", "src": ["tag:nanoclaw"], "dst": ["autogroup:internet:*"] },
       { "action": "accept", "src": ["tag:nanoclaw"], "dst": ["192.168.8.1:80", "192.168.8.0/24:8123"] }
     ]
   }
   ```

   Auth key из раздела 1 нужно выпускать с тегом `tag:nanoclaw`. Текущий ключ в sops выпущен **без тегов**: тогда узел `nanoclaw-owner` принадлежит твоему пользователю, и при ACL по умолчанию (allow all) всё заработает без правок. С тегами и строгой ACL ключ надо перевыпустить. Разрешённые домашние адреса ограничиваются дважды: ACL и опцией `tailscale.owner.tailnetAllow` (nanogate пропускает только их).
5. Проверить, что узел роутера онлайн, а `exitNode` в модуле совпадает с его именем (по умолчанию `gl-mt3000-beryl`; стабильный node id надёжнее имени).

## 2a. DNS для Mini App

Домен `miniapp.domain` (в nixserver: `claw.mois.pro`) должен смотреть на сервер: в Cloudflare добавить A-запись `claw` → `46.224.210.43` (DNS only, без оранжевого облака: TLS терминирует Caddy через Layer4 на :443 → :8443, сертификат выпускается DNS-челленджем Cloudflare). Без записи Mini App не откроется, остальное работает.

## 3. BotFather

1. Bot Settings, Configure Mini App (Main Mini App): URL `https://<miniapp.domain>`, короткое имя, например `cabinet`. Это же имя пойдёт в `miniapp.shortName`. Без него бот использует нативные кнопки `web_app`, которые работают только в личных чатах, а модуль при сборке выдаст предупреждение.
2. Меню-кнопку (`/setmenubutton`) руками не ставить: хост выставляет «Кабинет» для каждого пользователя из `NC_MINIAPP_URL`.
3. Команды: `/setcommands` для бота оставить пустым. Хост сам задаёт команды per-chat (`/new`, `/stop`, `/tasks`, `/menu`, `/help`, у владельца ещё `/friends`, `/guest`, `/health`).
4. Guest mode / inline: включить Guest queries (иначе не заработает гостевой контекст) и, если нужен inline, `/setinline`.
5. Для личного бота: `/setdescription`, `/setabouttext` на русском, `/setuserpic`. Привязку к группам (`/setjoingroups`) оставить по вкусу.

## 4. Конфиг nixserver (потребитель)

В `flake.nix` nixserver:

```nix
inputs.nanoclaw.url = "github:mois-ilya/nanoclaw/v2-rebuild";
inputs.nanoclaw.inputs.nixpkgs.follows = "nixpkgs";
# в modules для nuremberg: inputs.nanoclaw.nixosModules.nanoclaw
```

Старые модули (`nixosModules.{default,onecli}`, `services.onecli`) этим модулем заменяются; убрать их из импортов.

Сам сервис:

```nix
services.nanoclaw = {
  enable = true;
  installId = "nuremberg-prod";
  ownerTelegramId = 42582289;
  ownerName = "Илья"; ownerNameGen = "Ильи";     # по умолчанию уже так
  telegram.tokenFile = config.sops.secrets."nanoclaw/telegram_bot_token".path;
  anthropicKeyFile   = config.sops.secrets."nanoclaw/anthropic_api_key".path;
  nanogate = {
    encryptionKeyFile = config.sops.secrets."nanoclaw/nanogate_key".path;
    # По умолчанию берётся nix/default-prices.json: ЦЕНЫ ТАМ ЗАГЛУШКИ.
    # Сверь с anthropic.com/pricing и подставь свой файл:
    pricesFile = ./nanoclaw-prices.json;
    globalCapUsd = 100;
    hostAddresses = [ "46.224.210.43" ];
    denyCidrs = [ "10.201.0.0/20" ];          # AWG
  };
  firewall.vpnSubnets = [ "10.201.0.0/20" ];  # проверь значения по умолчанию в nix/module.nix
  miniapp = { enable = true; domain = "claw.mois.pro"; shortName = "cabinet"; };
  stt.enable = true;                          # whisper.cpp, голос
  tailscale.owner = {
    enable = true;
    authKeyFile = config.sops.secrets."nanoclaw/tailscale_owner_authkey".path;
    exitNode = "gl-mt3000-beryl";             # значение по умолчанию; null = без домашнего выхода
    tailnetAllow = [ "192.168.8.1:80" ];      # host:port, cidr:port, *.ts.net:port; пусто = tailnet закрыт
  };
  alertCommand = null;                        # либо путь к исполняемому файлу вроде pulse-notify (получает текст алерта аргументом)
};
```

Что важно:

- Цены. Файл по умолчанию покрывает `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `web_search`, `web_fetch`, но значения непроверенные (`version` начинается с `UNVERIFIED`). Модель, которой нет в таблице, в бюджете стоит 0 и лимит друзей не сработает, поэтому каждая модель из `models.*` должна быть в таблице.
- Caddy: `services.caddy.enable = true` (на nuremberg уже включён). Модуль добавляет vhost для `miniapp.domain` в `services.caddy.virtualHosts`, но он работает только со стандартным конфигом Caddy. Если потребитель задаёт свой `services.caddy.configFile` (как nixserver на nuremberg: layer4 SNI-роутер на :443 и внутренний listener :8443), vhost игнорируется и Mini App не откроется (TLS handshake падает). Тогда перенеси `config.services.caddy.virtualHosts.${miniapp.domain}.extraConfig` в свой Caddyfile (см. `modules/services/caddy.nix` в nixserver); DNS-запись `claw.mois.pro` должна указывать на сервер. Домен доступен всем, ограничение доступа делает проверка `initData` в Mini App.
- Podman и AWG: Podman в nixserver остаётся с `firewall_driver` по умолчанию (nftables). Старая настройка `firewall_driver = "none"` из `containers.nix` несовместима: модуль на неё не соберётся (assertion), а изоляция `--internal` сетей без правил netavark не работает. Из-за смены правил файрвола после деплоя прогнать `/test-vpn`.
- `alertCommand` необязателен; Telegram-алерты владельцу идут в любом случае.
- Деплой всегда из корня репозитория nixserver: `nix run .#deploy nuremberg`. Сборка идёт на удалённом aarch64 билдере, то есть на продакшн-сервере, поэтому лишние сборки не запускать.

## 5. Проверки до переключения (spikes)

Делать на тестовом боте и тестовом `installId`, пока старый NanoClaw работает.

1. **Podman-топология**: `scripts/podman-smoke.sh --host-ip 46.224.210.43` на сервере (нужна группа `podman` или root; образы `busybox`, `alpine`, `docker.io/library/node:22-alpine`). Скрипт проверяет: агент видит только relay-alias и не видит интернет, хост и AWG-шлюз; cgroup агента под `nanoclaw.slice`; в `/etc/hosts` есть localhost и нет `host.containers.internal`; alias relay резолвится на `--internal` сети; `node fetch https://example.com` работает через `HTTPS_PROXY` с `NODE_USE_ENV_PROXY=1`. Ожидается `failed=0`. Любой FAIL блокирует переключение. После скрипта проверить VPN: `/test-vpn` и `/debug-vpn` (живые пиры AWG не должны пострадать от сетей и правил netavark).
2. **Производительность whisper**: отправить боту 3-4 голосовых (10 с, 1 мин, 3 мин, шумное) и смотреть время расшифровки и RAM (`systemctl status nanoclaw-stt`, `/health`). Потолок слайса 4 GiB делится между хостом, STT и агентами; если STT душит остальное, уменьшить `stt.threads` или взять модель поменьше (`stt.model`).
3. **Telegram rich/draft на реальных клиентах**: iOS, Android, Desktop. Проверить длинный ответ с таблицей и кодом, стриминг черновика (`NC_STOP_ENABLED`, кнопка Стоп), реакцию 👀, русскую кириллицу на лимите 32768 (байты против символов), гостевой запрос. Если на каком-то клиенте rich-сообщение ломается, зафиксировать и решить, что делать до переключения.
4. **Домашний выход** (если включён): из чата владельца попросить агента открыть `https://ifconfig.me` через браузер и убедиться, что адрес домашний; выключить роутер и убедиться, что ошибка видна владельцу (`/health`, алерт), а не молча идёт прямой выход.

## 6. Переключение и откат

Переключение:

1. Сделать бэкап старого NanoClaw (БД, `groups/`) и записать текущее поколение: `nixos-rebuild list-generations` на сервере.
2. Остановить старый NanoClaw и OneCLI (только с явного согласия владельца, это продакшн). У бота может быть только один poller.
3. Подставить прод-токен в `nanoclaw/telegram_bot_token`, смержить конфиг nixserver, затем `nix run .#deploy nuremberg` из корня репозитория.
4. Дождаться уведомления `pulse-notify` об активации. Проверить: `systemctl status nanoclaw nanogate nanoclaw-stt`, `journalctl -u nanoclaw -n 100`, `/health` в боте.
5. Выполнить `/test-vpn`: AWG и VLESS не должны пострадать.

Откат:

1. `nixos-rebuild switch --rollback` на сервере (или деплой предыдущего коммита nixserver). Откат Nix не откатывает БД.
2. Если схема БД уже мигрировала, восстановить предпусковой снимок: он лежит в `/var/backups/nanoclaw` и делается автоматически при смене build id. Снимок и код должны соответствовать друг другу. Токены сессий после восстановления отзываются.
3. Вернуть токен старого бота в sops, запустить старый NanoClaw, убедиться, что бот отвечает.
4. Если дело в сетевых правилах (VPN упал), см. `/debug-vpn`; цепочки `nanoclaw-in` и `nanoclaw-fwd` исчезают при снятии модуля и перезагрузке файрвола.

## 7. Чек-лист первого запуска

- [ ] Владелец отправляет `/start`: приходит приветствие, появляются кнопка «Кабинет» и команды владельца (`/friends`, `/guest`, `/health`).
- [ ] Обычное текстовое сообщение: 👀, затем ответ; `/health` показывает зелёные nanogate, STT, слайс, коннектор.
- [ ] Голосовое сообщение расшифровывается и получает ответ (при сбое STT бот говорит об этом, а не молчит).
- [ ] Кнопка «Кабинет» открывает Mini App (данные грузятся, нет белого экрана). Если `shortName` задан, ссылка `t.me/<бот>/<shortName>` тоже открывается.
- [ ] Напоминание: «напомни через 2 минуты …» приходит вовремя; `/tasks` его показывает.
- [ ] Файл: отправить документ или фото, получить файл обратно от агента.
- [ ] Друг пишет боту: он получает «Доступ даёт он лично», владельцу приходит запрос на одобрение; после одобрения друг получает ответ, а в `/friends` у него виден расход и лимит.
- [ ] Лимит: временно задать маленький лимит другу. Пока остаток покрывает хотя бы короткий ответ, nanogate урезает `max_tokens` под остаток (ответы становятся короче, но приходят). Когда не помещается даже минимальный ответ (`anthropicLimits.minOutputTokens`, 1024 токена) и других запросов друга в полёте нет, фиксируется исчерпание: агент не запускается, другу приходит сообщение про лимит, владельцу — уведомление.
- [ ] Бэкап: `systemctl start nanoclaw-backup` создаёт файл в `/var/backups/nanoclaw`.
- [ ] Старые сервисы удалены из конфигурации, VPN работает (`/test-vpn`).

## 8. Известные ограничения на момент деплоя

- Цены по умолчанию непроверенные (раздел 4).
- `idle.*Minutes` и `resources.maxConcurrent` хост применяет (`src/lifecycle-policy.ts`, `src/spawn-admission.ts`). Лимит считает и тёплые простаивающие контейнеры: сообщение сверх лимита ждёт в очереди (владелец первым), а хост останавливает простаивающий контейнер (сначала друга, затем самый давно молчащий), чтобы освободить слот. Вложения `/workspace/inbox` чистятся по `inbox.retentionDays` (30) и `inbox.quotaMb` (500).
- Телеграм-журнал входящих и повторы после падения контейнера описаны в отдельных пунктах аудита; читать `docs`/план перед выходом в продакшн.
- Бэкапы (`/var/backups/nanoclaw`, ночные и перед обновлением) лежат на том же диске сервера и не шифруются. При потере диска или пересборке сервера (история nixos-infect) они пропадают вместе с данными. Отправка во внешнее хранилище (restic/rclone в R2 с шифрованием, как offsiteBackup у diwy-split) пока не сделана: настрой её на стороне nixserver до выхода в продакшн.
- Память: `maxConcurrent × agentMemory` (по умолчанию 2 × 1536m) плюс whisper (`stt.memoryMax`, 1G) и хост (~0,3G) в сумме превышают `sliceMemoryHigh` (3500M). Лимиты контейнеров потолки, а не расход, но два браузерных агента плюс голосовое могут упереться в slice. При OOM ядро выбирает агента или whisper, а не хост (`OOMScoreAdjust = -500` у `nanoclaw.service`). Если упираетесь, подними `sliceMemoryHigh`/`sliceMemoryMax` или снизь `agentMemory`.
- Токен бота и ключ Anthropic: файлы со старым форматом `TELEGRAM_BOT_TOKEN=...` / `ANTHROPIC_API_KEY=...` принимаются, но лучше переписать секреты в «сырой» вид.
- Перед переключением на существующий `v2.db` старая привязка владельца к чужой группе агентов снимается при старте (`ensureDmWiring`); задачи в сессиях старых групп надо проверить вручную (`ncl tasks`).
