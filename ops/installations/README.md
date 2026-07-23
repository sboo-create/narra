# Управление установками Narra

Приглашений и общего секрета в приложении нет. Первый запуск отправляет
случайный installation UUID, gateway создаёт server-side запись и выдаёт
подписанный bearer на 15 минут. Refresh и каждый защищённый запрос сверяют:

- подпись и срок bearer;
- `status=active`;
- текущую `token_version`;
- минутный лимит;
- persistent per-install и global UTC-day budget.

`INSTALLATION_OPERATOR_TOKEN` существует только в Railway Variables и локальном
окружении оператора. Его нельзя добавлять в Electron, GitHub Actions, документы
или команды, попадающие в shell history.

`INSTALLATION_SECRET_PEPPER` — другой независимый Railway secret. Он нужен
только gateway для HMAC per-install proof и не должен совпадать с
`GATEWAY_TOKEN_SECRET`, `ANALYTICS_HMAC_SECRET` или operator token. Его ротация
инвалидирует refresh proof всех уже зарегистрированных установок, поэтому
менять его можно только как управляемую миграцию.

## Посмотреть или отозвать установку

В локальном терминале получить token из password manager через его CLI либо
ввести скрыто. Значение не должно присутствовать в строке команды:

```bash
read -r -s -p "Installation operator token: " INSTALLATION_OPERATOR_TOKEN
export INSTALLATION_OPERATOR_TOKEN
export NARRA_OPERATOR_GATEWAY_URL=https://narra-staging.multitool.works

node scripts/manage-installation.mjs get 123e4567-e89b-42d3-a456-426614174000

node scripts/manage-installation.mjs revoke \
  123e4567-e89b-42d3-a456-426614174000 "abuse"

unset INSTALLATION_OPERATOR_TOKEN
```

Отзыв немедленно инвалидирует уже выданный bearer и сохраняется на Railway
Volume. Повторная регистрация того же UUID получает `403`. Полное удаление
локальных данных создаст новый UUID, поэтому защиту дополняют IP velocity,
глобальная регистрационная квота, per-install budgets, global budgets и
ограничения конкурентности.

## Данные на Volume

- `installations-<environment>.json` — атомарный snapshot active/revoked записей;
- `installation-budgets-<environment>-YYYY-MM-DD.jsonl` — append-only расход за
  текущие сутки; старые journals автоматически удаляются после двух суток.

Повреждённый registry или journal блокирует запуск gateway. Он не сбрасывается
молча: иначе после аварии могли бы ожить отозванные установки или обнулиться
бюджеты.

## Railway deployment contract

- к service подключён настоящий Volume, а `DATA_DIR` совпадает с
  автоматически выданным `RAILWAY_VOLUME_MOUNT_PATH`;
- service имеет ровно одну реплику;
- `INSTALLATION_SINGLE_REPLICA_ACK=true`;
- `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0`, чтобы старый и новый deploy не писали
  один lock-free registry одновременно;
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` или больше, чтобы SIGTERM успел
  сбросить touch snapshot и analytics outbox.

После каждого изменения инфраструктуры это проверяется в Railway UI и
restart/revoke smoke, а не только значениями Variables.
