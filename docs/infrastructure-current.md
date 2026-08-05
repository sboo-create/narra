# Текущее состояние инфраструктуры Narra

> Обновлено 5 августа 2026 года. Этот документ заменяет инфраструктурный статус
> из `narra-release-plan.md`. Канонический код production-сервисов и runbook
> находятся в репозитории
> [`mishanaer/ReadAny`](https://github.com/mishanaer/ReadAny).

## Что работает

| Контур | Состояние |
| --- | --- |
| Production gateway | Контейнер `narra-gateway-1` версии `c8e38887efe7` работает на `i167`, локальный порт `8788` |
| Production analytics | `stats-narra.service` версии `472c1b8dfd28` работает на `i167`, локальный порт `9905` |
| Публичная аналитика | `https://stats.multitool.works/p/narra/health` отвечает `200` |
| Публичный gateway | `https://narra.multitool.works` намеренно отвечает `503 not_ready` до отдельного cutover |
| Railway staging | Gateway и stats остановлены, домены отвечают `404`, тома оставлены для отката |
| Railway production | Деплой остановлен и crashed, томов и custom domain нет; удаление передано владельцу Railway |

Gateway и analytics уже влиты в `ReadAny/main`:

- gateway и i167 deploy/backup —
  [`mishanaer/ReadAny#3`](https://github.com/mishanaer/ReadAny/pull/3), merge
  `c8e38887efe7`;
- актуальная аналитика —
  [`mishanaer/ReadAny#6`](https://github.com/mishanaer/ReadAny/pull/6), commit
  `472c1b8dfd28`.

Историческую копию `server/` в этом репозитории нельзя использовать для нового
production-деплоя. Канонические пути:

- `ReadAny/services/narra-gateway`;
- `ReadAny/stats/narra`;
- `ReadAny/docs/narra-infrastructure.md`.

## Данные и откат Railway

Перед остановкой Railway сохранён операторский архив gateway и staging
analytics. SQLite прошёл `PRAGMA integrity_check`. SHA-256 архива:

```text
f3217ce03f973271ded4ef696a82111bdc6b679e448a6e5ed2a08f665d013ab1
```

Архив содержит служебные staging-данные и не публикуется в Git. Том Railway
удаляется только после контрольного окна и подтверждения владельца аккаунта.

## Staging

Новый staging на `i167` пока не поднимается. Если он понадобится, ему нужны
отдельные credentials, Docker volume, база аналитики, backup и Caddy route.
Предварительно зарезервированы локальные порты `8789` для gateway и `9911` для
stats. Старую тестовую базу по умолчанию восстанавливать не нужно.

Нельзя возвращать plaintext video upstream. LLM staging должен ходить к
провайдеру по HTTPS. Sber Speech и Kandinsky credentials, совпадавшие у Railway
staging и production, нужно перевыпустить через кабинеты провайдеров: сначала
обновить `i167` и проверить функции, затем отозвать старые значения.

## Операционная граница

Перенос на `i167` не означает публичный запуск. Caddy по-прежнему закрывает
production gateway ответом `503`. Отдельный cutover требует проверки
`/health`, `/ready`, installation auth, quotas, LLM/TTS/image, доставки
аналитики, backup и rollback. После cutover клиент должен собираться только с
`https://narra.multitool.works`.
