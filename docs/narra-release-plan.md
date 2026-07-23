# Narra — release, media capacity и аналитика

> Обновлено 23 июля 2026
> Рабочая ветка: `feat/narra-release-foundation`
> Статус: foundation и staging готовы; Narra подключена к production Traction; публичный macOS-релиз ещё не выпущен.

## Коротко

| Контур | Статус | Что это означает |
|---|---|---|
| Gateway staging | ✅ Live | OpenRouter, SaluteSpeech, Kandinsky, video и analytics outbox проверены |
| Stats staging | ✅ Live | Отдельные token, database и Volume; restart/dedupe проверены |
| Traction production | ✅ Live | Narra активна, dashboard защищён, poller healthy |
| Шесть canonical-метрик | ✅ Контракт готов | При пустом DAU ratios показываются как `—`, а не исчезают и не превращаются в ложный `0` |
| Universal unsigned macOS | ✅ QA готов | arm64 + x64 упаковываются в один артефакт |
| Signed/notarized macOS | ⏳ Credentials | Workflow готов; Apple-секретов Narra пока нет |
| Giga через LiteLLM | ⏳ Transport | Адаптер сохранён; до защищённого relay используется OpenRouter |
| Video в public release | ⏳ Transport/capacity | В staging работает по явно разрешённому HTTP; для public нужен HTTPS edge relay и durable queue |
| Production gateway | ⏳ One-time cutover | Не миграция старых пользователей, а отдельная проверяемая публикация нового production-контура |

---

## Почему на карточке было четыре метрики, хотя контракт содержит шесть

Canonical Overview состоит ровно из:

1. `Ever used`
2. `DAU`
3. `WAU`
4. `MAU`
5. `Sessions / DAU`
6. `Tools / DAU`

Production Narra пока не получала пользовательских событий, поэтому `DAU = 0`. Делить sessions или tools на нулевой DAU нельзя. Stats-модуль корректно **опускает значения ratios**, но Traction до исправления полностью скрывал отсутствующие ключи.

Правильное отображение:

| Метрика | Значение до первого пользователя |
|---|---:|
| Ever used | `0` |
| DAU | `0` |
| WAU | `0` |
| MAU | `0` |
| Sessions / DAU | `—` |
| Tools / DAU | `—` |

`—` означает «пока невозможно вычислить». Это не ноль и не отсутствующая метрика.

---

## Как Narra сейчас обрабатывает книгу

```text
Импорт файла / URL
  → локальный parse глав
  → LLM-разметка персонажей по выборке
  → локальный CharactersFile
  → обложка генерируется при появлении карточки
  → портрет генерируется при открытии героя
  → video генерируется при оживлении
  → при «Слушать» сначала размечается вся глава
  → затем TTS начинает синтез сегментов
```

Проблемы этого подхода:

- пользователь ждёт разметку всей главы до первого звука;
- генерация обложек может стартовать сразу для нескольких видимых книг;
- media jobs держат длинные HTTP-соединения;
- очереди Kandinsky/video находятся в памяти и теряются при restart;
- video фактически обрабатывает один job одновременно;
- кэш существует только на текущем Mac;
- TTS cache key не содержит голос, sample rate и версию prosody;
- смена голоса может вернуть аудио старого голоса;
- главный герой определяется недостаточно надёжно для правил Сони.

## Целевой book preparation pipeline

```text
Импорт
  │
  ├─ книга сразу доступна для чтения
  │
  └─ durable book-analysis job
       ├─ aliases / mentions / direct speech / POV
       ├─ character profiles без спойлеров
       ├─ versioned voice plan
       ├─ cover
       └─ portrait главного героя

По требованию пользователя:
  ├─ остальные portraits
  ├─ progressive multi-voice TTS
  └─ video job с position / ETA / cancel
```

Не генерируем при импорте всю аудиокнигу и видео всех героев. Это забивает upstream, расходует квоты и превращает импорт в многочасовую операцию.

---

## Media capacity: что известно точно, а что пока оценка

### Факты из текущего кода

| Контур | Текущее ограничение | Уверенность |
|---|---:|---|
| Video | один job одновременно | Высокая: глобальная последовательная chain |
| Video queue | максимум четыре admitted jobs вместе с активным | Высокая: пятый запрос получает `429` |
| Kandinsky image | фактически один Kandinsky job одновременно | Высокая: отдельная последовательная chain |
| Client image timeout | 90 секунд | Высокая |
| Server Kandinsky deadline | до 120 секунд без учёта ожидания/retry | Высокая |
| Server video attempt | до 480 секунд на одну попытку | Высокая: возможно до трёх попыток плюс retry delays |
| Client video timeout | 540 секунд на весь запрос вместе с queue wait/retries | Высокая: клиент может отменить job раньше server retry chain |
| SaluteSpeech gateway | 5 concurrent + 16 queued | Высокая: default исправлен под используемый scope |
| SaluteSpeech upstream | не более 5 concurrent для `SALUTE_SPEECH_PERS` | Высокая для текущего scope; приватный ключ `gigacons` всё равно проверяем benchmark |

При десяти одновременных video-запросах текущий gateway примет четыре и отклонит шесть. Это не прогноз, а прямое следствие кода.

### Откуда взялась оценка jobs/hour

Формула для одного слота:

```text
throughput ≈ 60 минут / средняя длительность job
```

Ранее использовалась предпосылка 3–8 минут, поэтому получилось примерно 7–20 jobs/hour. Это была планировочная, а не измеренная оценка.

Если фактическое оживление занимает 10–15 минут, как описывает Соня:

```text
60 / 10 = 6 jobs/hour
60 / 15 = 4 jobs/hour
```

Тогда десятый одновременно пришедший пользователь при идеальной очереди дождётся результата приблизительно через 100–150 минут. Поэтому прежний диапазон следует считать оптимистичным до настоящего benchmark.

### Как получим реальные числа

На staging выполняется ступенчатый тест:

1. Один короткий baseline job каждого типа.
2. Две одновременные задачи.
3. Пять — только если предыдущая ступень стабильна.
4. Десять — только в пределах согласованного cost/quota.

Измеряем:

- upstream acceptance и `429`;
- queue wait;
- provider service time;
- end-to-end latency;
- p50/p95;
- timeout/cancel;
- cache hit;
- jobs/hour;
- restart recovery;
- fairness между установками.

До benchmark нельзя честно обещать, что десять пользователей получат video одновременно. Durable queue сделает ожидание управляемым, но увеличить GPU throughput сможет только владелец upstream: дополнительными слотами, worker или вторым провайдером.

---

## Workaround без HTTPS tunnel

### LiteLLM

Текущий безопасный workaround уже работает:

- public HTTP LiteLLM не получает пользовательские prompts и API key;
- все staging LLM purposes идут в OpenRouter по HTTPS;
- Giga adapter остаётся в коде;
- Giga возвращается в server-side routes после защищённого транспорта.

### Video

Для public release простой `Railway → http://87.242.117.37:5051` неприемлем: по незашифрованному каналу проходят bearer credential, изображение и иногда аудио.

Workaround без VPN/tunnel — **HTTPS edge relay на самом video host**:

```text
Railway Gateway
  → HTTPS + service token / optional mTLS
  → Caddy/Nginx relay на 87.242.117.37
  → http://127.0.0.1:5051
```

Это маленький TLS-терминатор, а не сетевой туннель. Незашифрованный участок остаётся только внутри того же сервера.

Минимальные требования:

- домен или управляемый TLS-сертификат;
- доступ поставить Caddy/Nginx рядом с video process;
- upstream слушает только loopback;
- отдельный Narra service token;
- body/time/concurrency limits;
- логирование без media bodies;
- по возможности Railway static outbound IP allowlist.

Если доступа к video host нет, безопасного удалённого workaround без изменения upstream нет. До relay video остаётся доступным только в закрытом staging с явным degraded-флагом; для публичных пользовательских данных gate остаётся закрытым.

Тот же edge relay можно поставить перед LiteLLM, если он находится на контролируемом сервере.

---

## Что такое server-side entitlement и что требуется от владельца

Сейчас закрытая сборка использует общий activation secret. Если положить его в публичное Electron-приложение, его можно извлечь и раздать; уже выданные stateless install tokens нельзя индивидуально отозвать.

Entitlement — простая серверная запись:

```text
installation_id
status: active | revoked
plan / quotas
issued_at
last_seen_at
token_version
```

Поток:

1. Пользователь вводит одноразовый invite code либо входит в аккаунт.
2. Gateway проверяет разрешение.
3. Gateway выдаёт короткоживущий install token.
4. Каждый дорогой запрос проверяет активность entitlement и quota.
5. Конкретную установку можно отозвать без перевыпуска приложения.

Для закрытой beta достаточно SQLite на Railway Volume и списка одноразовых invites. От тебя не нужен внешний ключ или сервис.

Нужно только продуктовое решение:

- **рекомендация:** invite-only beta;
- альтернатива: открытый anonymous launch с автоматическим entitlement и жёсткими квотами;
- позднее: привязка к полноценному аккаунту/подписке.

---

## Что такое HTTPS update-feed

Electron auto-updater не «обновляет приложение сам по GitHub». Ему нужен стабильный HTTPS-адрес с файлами:

| Файл | Назначение |
|---|---|
| `latest-mac.yml` | версия, имя ZIP, размер и SHA-512 |
| `Narra-<version>-universal.zip` | пакет автоматического обновления |
| `.blockmap` | поддержка differential download |
| universal DMG | ручная clean install |

Narra настроена на:

```text
https://github.com/sboo-create/narra/releases/latest/download/
```

После успешной подписи, notarization и release verification workflow:

1. создаёт **draft GitHub Release**;
2. загружает туда DMG, ZIP, `latest-mac.yml`, blockmaps, checksums и SBOM;
3. ничего публично не выкатывает автоматически;
4. draft позволяет скачать и проверить артефакты владельцам репозитория, но **не является доступным update-feed**;
5. публикация разрешена только после всех остальных release gates;
6. только после публикации `releases/latest/download` начинает отдавать новую версию приложениям.

Отдельный update-сервер и новый домен для первой версии не нужны.

Важно: настоящий in-app upgrade через GitHub draft проверить нельзя — draft assets не
доступны по публичному `releases/latest/download`. Для первого релиза Narra это
допустимое ограничение, потому что официальной предыдущей версии и внешних
установок ещё нет. Процесс первого релиза:

1. Проверить clean install и сохранение локальных данных при установке поверх
   внутренней lower-version RC.
2. Закрыть video transport, entitlement, production cutover и остальные gates.
3. Опубликовать release, но ещё не раздавать внешнюю ссылку.
4. Немедленно проверить public feed и реальный auto-update внутренней
   lower-version RC.
5. При ошибке снять release и вернуть previous deployment; при успехе начать
   внешнее распространение.

Начиная со второго публичного обновления до релиза нужен отдельный HTTPS RC-feed.
Workflow уже поддерживает его через repository variable
`NARRA_UPDATE_BASE_URL`; сам staging origin (например, отдельный bucket/domain)
ещё предстоит выбрать и предоставить.

---

## Готовность universal macOS build

### Уже подготовлено в Narra

- universal `arm64 + x86_64` DMG и ZIP;
- hardened runtime;
- Electron fuses;
- pinned release workflow;
- exact tag/version check;
- Developer ID signing inputs;
- App Store Connect API-key notarization;
- stapling DMG;
- Gatekeeper/codesign/lipo verification;
- SHA-256, SHA-512 metadata и SBOM;
- draft GitHub Release/update-feed;
- отсутствие legacy endpoint в новом клиенте.

### Что найдено

- На текущем Mac есть валидная identity `Developer ID Application: Evgeny Tsapnikov (LTS79DWRGJ)`.
- Она пригодна для локального signed QA только вместе с notarization credentials той же Apple Team.
- Это не подтверждённые креды Миши и не основание подписывать Narra от его имени.
- GigaType workflows ожидают Apple secrets, но через доступный GitHub API они отсутствуют в repo/environment secrets.
- Значения GitHub Actions secrets принципиально нельзя прочитать или скопировать из одного репозитория в другой.
- Локальных `.p8`/`.p12` файлов GigaType не найдено.

### Что должен добавить Миша или владелец Apple Team

В GitHub Environment `narra-production` репозитория Narra:

| Narra secret | Откуда взять в GigaType/Apple |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | содержимое Developer ID Application `.p12` в base64 |
| `MACOS_CERTIFICATE_PASSWORD` | пароль `.p12` |
| `APPLE_API_KEY_P8` | содержимое App Store Connect `AuthKey_*.p8` |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |
| `APPLE_TEAM_ID` | Team ID сертификата |
| `NARRA_PROXY_URL` | reviewed production gateway HTTPS origin |
| `NARRA_ACTIVATION_TOKEN` | временный beta activation secret, минимум 32 символа |

`NARRA_UPDATE_BASE_URL` теперь не secret: по умолчанию используется GitHub Releases. При переносе на object storage его можно задать repository variable.

Перед использованием нужно подтвердить, что Apple Team разрешает подписывать bundle ID `com.narra.app`.

---

## Инструментация import/media событий

«Инструментация» означает добавить безопасные события, чтобы отличать:

- пользователь не пользуется функцией;
- задача стоит в нашей очереди;
- upstream работает медленно;
- upstream возвращает ошибку;
- приложение повторно генерирует уже существующий asset;
- пользователь не дождался результата.

### Import и book analysis

| Событие | Tier | Безопасные свойства |
|---|---|---|
| `book_import_started` | Extended | format, source_class, size_bucket |
| `book_import_completed` | Extended | format, size_bucket, chapter_count_bucket, duration_bucket |
| `book_import_failed` | Extended | format, stage, safe_error_code |
| `book_analysis_started` | Extended | analysis_version, chapter_count_bucket |
| `book_analysis_completed` | Extended | duration_bucket, character_count_bucket, pov, confidence_bucket |
| `book_analysis_failed` | Extended | stage, safe_error_code |

### Media jobs

| Событие | Tier | Безопасные свойства |
|---|---|---|
| `media_job_enqueued` | Extended | job_type, provider, model, quality, queue_depth_bucket |
| `media_job_started` | Extended | job_type, queue_wait_bucket |
| `media_job_completed` | Extended | job_type, generation_time_bucket, cache_hit, result_size_bucket |
| `media_job_failed` | Extended | job_type, stage, safe_error_code, retry_count_bucket |
| `media_job_cancelled` | Extended | job_type, queue_or_running |
| `tts_first_audio_ready` | Extended | voice_id, sample_rate, first_audio_latency_bucket |
| `tts_playback_started` | Extended | source, cache_hit |
| `tts_playback_abandoned` | Extended | source, listened_fraction_bucket |

Все перечисленные import/media/playback события относятся к `Extended` и удаляются из локальной очереди при opt-out. Для incident response и защиты квот gateway независимо держит always-on агрегированные operational counters/logs без installation actor: общую глубину очереди, active jobs, provider error code, latency histogram и saturation. Они не отправляются как пользовательские Traction events.

Все строковые значения закрыты enum-списками: `job_type`, `provider`, `model`, `quality`, `stage`, `safe_error_code`, `voice_id`, `sample_rate` и `source`. Все размеры, длительности, retry count и глубина очереди передаются заранее определёнными buckets, а не произвольными числами или строками.

Никогда не отправляются:

- название/автор книги;
- URL или имя файла;
- book/character names;
- текст книги, prompt или response;
- transcript;
- image/audio/video;
- локальные пути;
- provider credentials.

Эти события нужны не для «слежки», а для capacity и UX решений: расширять GPU, чинить очередь, менять timeout, улучшать cache или сокращать подготовку главы.

Essential остаётся всегда включённой. Extended opt-out отключает import/book-analysis/media/playback/voice диагностику и очищает ещё не отправленные extended events; остаётся только уже зафиксированный canonical/security минимум и безакторные operational counters gateway.

---

## Что означает production gateway cutover

Старый production Railway service не менялся. Новый gateway v2 пока работает в staging.

Cutover — не сложная миграция и не поддержка legacy endpoint. Для ещё не выпущенной Narra это одноразовая проверяемая публикация:

1. Создать отдельный production service/Volume/secrets из reviewed commit.
2. Не копировать staging analytics database и test events.
3. Подключить production Traction ingest token.
4. Проверить `/health`, `/ready`, auth, quotas и provider routes.
5. Выполнить один synthetic production smoke с отдельным test installation.
6. Собрать подписанный клиент с production HTTPS URL.
7. Проверить clean install и upgrade.
8. Зафиксировать previous deployment как rollback.
9. Только после этого публиковать GitHub Release.

Почему не стоит просто оставить staging URL:

- staging допускает plaintext video degraded mode;
- там тестовые токены и данные;
- staging можно перезапускать и менять без release gate;
- невозможно честно отделить тестовую аналитику от пользовательской.

Для внутренней beta можно временно раздавать клиент со staging URL. Для публичного релиза отдельный production gateway рекомендуется оставить обязательным, даже если legacy пользователей нет.

---

## Voice plan

Клиент хранит стабильный `voice_id`, gateway хранит точный provider code:

```text
joy → Erm_24000
```

Коды регистрозависимы: реальный AIWA-тест подтвердил, что `erm_24000` не работает, а `Erm_24000` работает.

Реестр содержит:

- display name;
- exact provider code;
- gender;
- supported `24000/48000`;
- assistant/library/manual-only;
- child-compatible;
- auto-assign priority;
- prosody profiles.

Назначение:

- narrator выбирает пользователь;
- first-person protagonist использует голос narrator;
- third-person protagonist получает отдельный подходящий голос;
- остальные — по полу и приоритету;
- unnamed extras — narrator;
- Markov/Pirat — manual-only;
- voice plan закрепляется на всю книгу;
- ручная смена инвалидирует только аудио этого героя.

Нерешённое правило: `Sber narrator + male third-person protagonist`. Среди оставшихся assistant voices нет мужского. Рекомендация — дать protagonist первому мужскому library voice, а не нарушать пол и не дублировать narrator.

Каждый приватный голос тестируется на реальном ключе:

- exact case;
- `24000` и `48000`;
- text и текущий SSML;
- HTTP status/content type;
- WAV sample rate/duration;
- audible sample для Сони.

---

## План реализации

### P0 — до signed beta

- [x] Gateway v2 и OpenRouter staging
- [x] Stats staging и production Traction module
- [x] Essential/extended telemetry split
- [x] Universal unsigned package
- [x] Draft GitHub Release/update-feed workflow
- [ ] Apple secrets в `narra-production`
- [x] Все шесть Traction slots видны постоянно
- [ ] Voice registry и исправленные cache keys
- [ ] Progressive TTS first-audio
- [ ] Durable media job API и queue UX
- [ ] HTTPS edge relay для video либо явный closed-beta gate
- [ ] Minimal revocable invite entitlement

### P1 — перед public release

- [ ] Production gateway cutover
- [ ] Capacity benchmark `1 → 2 → 5 → 10`
- [ ] Import/media instrumentation
- [ ] Signed/notarized universal RC
- [ ] Clean install на Apple Silicon
- [ ] Intel install/launch verification
- [ ] First-release updater canary после публикации, но до внешней раздачи
- [ ] Отдельный HTTPS RC-feed до второго публичного обновления
- [ ] Upgrade test с сохранением книг, notes, cache policy и settings
- [ ] Rollback rehearsal
- [ ] Publish reviewed GitHub Release

### P2 — после первых пользователей

- [ ] Server-side object cache/coalescing при доказанной потребности
- [ ] Второй video worker/provider при недостаточном jobs/hour
- [ ] Полная offline chapter/book synthesis
- [ ] Account/subscription entitlement вместо invite beta

---

## Что нужно решить владельцам

1. Invite-only beta или open anonymous launch? Рекомендация: invite-only.
2. Как назначать голос при `Sber narrator + male protagonist`? Рекомендация: первый мужской library voice.
3. Safronova действительно подходит детям? До подтверждения не включать автоматически.
4. Может ли владелец video host поставить Caddy/Nginx relay рядом с `:5051`?
5. Может ли Миша добавить Apple credentials в `narra-production`?
6. Под «APK» имеется в виду Android? Текущий Narra — Electron desktop; Android потребует отдельного клиентского проекта.
