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
| Signed macOS | ⏳ Local RC | Локальный release path готов; подписанный артефакт ещё не собран |
| Notarized macOS | ⏳ Credentials | Для публичного DMG всё ещё нужен matching Team API key Жени |
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
       ├─ первая глава: TTS-разметка в фоне
       ├─ cover
       └─ portraits главного героя и 2–3 основных персонажей

По требованию пользователя:
  ├─ portraits второстепенных персонажей
  ├─ progressive multi-voice TTS
  └─ video job с position / ETA / cancel
```

При импорте создаётся только сценарная разметка первой главы, но не аудио.
Озвучка всегда запускается по запросу пользователя. Не генерируем при импорте
всю аудиокнигу, портреты эпизодников или видео всех героев: это забивает
upstream, расходует квоты и превращает импорт в многочасовую операцию.

## Как ускоряем разметку главы для озвучки

### Почему сейчас медленно

Текущая реализация режет главу примерно по 1 500 символов, отправляет каждый
кусок в LLM строго последовательно и возвращает сценарий только после последнего
куска. Например, глава на 30 000 символов создаёт около 20 последовательных
LLM-запросов. TTS не может начать работу, пока не закончились все двадцать.

### Целевой алгоритм

1. После импорта и закрепления voice plan первая глава размечается в фоне.
2. Первый bootstrap-чанк намеренно маленький: 600–900 символов, но заканчивается
   только на границе предложения или реплики.
3. Из готового bootstrap-чанка первым синтезируется микро-сегмент на 150–300
   символов — обычно 1–2 предложения. Он начинает играть немедленно.
4. Остальная глава режется адаптивно по 3–5 тысяч символов с сохранением
   абзацев и границ прямой речи.
5. До трёх оставшихся чанков размечаются параллельно; результаты собираются в исходном
   порядке. Лимит остаётся server-side и не может занять все LLM slots.
6. Модель возвращает компактные метки по paragraph/sentence IDs:
   `narration|speech`, character ID и emotion — без повторной отправки полного
   текста главы в JSON-ответе.
7. Пока первый микро-сегмент играет, TTS готовит следующий сегмент. Начинаем с
   одного prefetch; достаточно ли его при реальной параллельной нагрузке,
   проверяет end-to-end benchmark по underrun rate и p95 buffer headroom.
8. При 70–80% чтения или прослушивания текущей главы в фоне размечается следующая.
9. Одновременные запросы одной и той же главы coalesce в одну job; если
   пользователь нажал «Слушать» во время background job, существующий
   bootstrap-чанк получает интерактивный приоритет без второго LLM-запроса.
10. Результат кэшируется по hash текста, markup version, model и voice-plan
   version; аудио — дополнительно по voice, sample rate и prosody version.

Закрытый event-контракт получает enum `origin=user|background`. Только
`origin=user` может создавать active day, reading session или Tools / DAU.
`origin=background` не считается пользовательским tool action.
Actor-linked диагностика фоновых jobs относится к Extended и исчезает при
opt-out; всегда включёнными остаются только безакторные operational aggregates
gateway — количество, длительность, ошибки и расход без installation ID.

Для условной главы на 30 000 символов это уменьшает количество волн с примерно
20 последовательных до 2–4 параллельных волн. Теоретически ожидание полной
разметки может сократиться в несколько раз, но честный ориентир — **2–4× до
benchmark**, потому что более крупные prompts, rate limits и повторная валидация
не дают линейного ускорения. Время до первого звука сокращается сильнее:
TTS ждёт первый готовый блок, а не всю главу.

Дополнительная оптимизация после baseline: локально выделять прямую речь
регулярными правилами, а LLM отправлять только определение говорящего и эмоции
для неоднозначных реплик. Это может убрать значительную часть LLM-вызовов, но
требует отдельного quality benchmark на разных стилях книг.

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

Для внешней beta простой `Railway → http://<video-origin>` неприемлем: по
незашифрованному каналу проходят credential, изображение и иногда аудио.

Railway может выдать новому proxy-service бесплатный HTTPS-домен
`*.up.railway.app`. Это защищает только участок `клиент/gateway → Railway`.
Если proxy затем обращается к `http://<video-origin>`, второй участок всё
равно идёт открытым по интернету. Такой relay полезен для единой авторизации,
лимитов и скрытия upstream URL, но **не закрывает transport risk** и годится
только как временный staging workaround.

То, что HTTP-запрос делает наш Railway server, лучше прямого доступа клиента:
upstream URL и master credentials не попадают в приложение. Но соединение
`Railway → <video-origin>` всё равно идёт через публичную сеть. Провайдеры сети
могут увидеть или изменить media body и перехватить повторно используемый
bearer. Поэтому plaintext разрешён только для внутреннего staging на
контролируемых тестовых данных. Открытая beta без приглашений ждёт HTTPS relay.

До появления TLS риск ограничиваем:

- отдельным video credential, не совпадающим ни с одним другим ключом;
- HMAC-подписью `timestamp + nonce + body hash`, если video server можно
  доработать: секрет не передаётся в каждом HTTP-запросе, replay блокируется;
- Railway static outbound IP и firewall allowlist на `:5051`, если это доступно;
- короткими timeout, body/concurrency limits и логами без media;
- запретом отправлять тексты книг: только необходимые image/audio артефакты;
- явным degraded readiness и отдельным бюджетным/queue circuit breaker.

Workaround без VPN/tunnel — **HTTPS edge relay на самом video host**:

```text
Railway Gateway
  → HTTPS + service token / optional mTLS
  → Caddy/Nginx relay на video host
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

### Поддомен MultiTool

Разделяем имена:

- `narra-staging.multitool.works` → изолированный Railway staging;
- `narra.multitool.works` → предполагаемое production-имя, но текущий target
  ещё не подтверждён как будущий Narra gateway.

Production-имя сейчас имеет `A 158.160.163.167`: HTTP отвечает Caddy `308`, а
HTTPS не проходит TLS handshake. Не считаем этот host готовым или
принадлежащим будущему production-контуру, пока владелец IP/маршрута не
подтверждён. К staging его не направляем. 23 июля записи staging уже добавлены
и видны в authoritative DNS:

| Type | Name | Value |
|---|---|---|
| CNAME | `narra-staging` | `eb0cgdqy.up.railway.app` |
| TXT | `_railway-verify.narra-staging` | `railway-verify=e50d4dec8125f3033c2140416ff008a5db67d600c8a3e1cff8c9bbc9b212b939` |

Custom-domain/TLS provisioning завершён: 23 июля
`https://narra-staging.multitool.works/health` ответил `200`, сертификат принят,
а health подтвердил SaluteSpeech, Kandinsky, video и все OpenRouter routes.
Прямой запрос к техническому CNAME target с его собственным Host возвращает
Railway fallback `Application not found` — это нормально: edge маршрутизирует
сервис по custom hostname.

Поддомен закрывает TLS только до gateway. Маршрут к video остаётся
server-to-server HTTP до установки TLS/HMAC/firewall-контролей выше.

---

## Какие ключи находятся в приложении

Provider credentials в Electron не передаются и не хранятся:

- OpenRouter/Giga/LiteLLM credentials — только Railway secrets;
- SaluteSpeech credential — только Railway secret;
- Kandinsky/video token — только Railway secret;
- Traction ingest token — только gateway.

В release-сборке находятся только публичные адреса:

- `NARRA_PROXY_URL`;
- `NARRA_UPDATE_BASE_URL`.

Сейчас есть одно временное исключение: общий
`NARRA_ACTIVATION_TOKEN` зашивается в beta-сборку и отправляется только на
registration endpoint при регистрации или перерегистрации установки — например, после истечения bearer,
смены gateway URL или ответа `401`. Он не отправляется в provider routes. Это не
provider API key, но это всё равно извлекаемый общий секрет. После регистрации
gateway выдаёт stateless installation bearer с текущим TTL по умолчанию 30 дней;
на macOS он хранится через Keychain-backed `safeStorage`, а не открытым текстом.

Принято целевое решение выпускать beta **без приглашений**, но безопасная
auto-enrollment модель ещё не реализована и остаётся P0 gate до внешней раздачи.
Provider keys в клиенте не появятся, а cohort token будет только мягким
distribution gate, не криптографической защитой.

### Как доступ устроен сейчас

Отдельных приглашений и UI для invite code в Narra сейчас нет:

- если на gateway задан `REGISTRATION_ACTIVATION_SECRET`, пользоваться может
  любая копия приложения, собранная с совпадающим общим activation token;
- фактически это означает «любой, у кого есть beta-сборка **или скопированный из
  неё общий token и совместимый клиент**» — сама раздача официальной сборки не
  является границей доступа;
- индивидуально отозвать одну такую установку нельзя;
- в production gateway отсутствие или длина activation secret меньше 32
  символов блокирует запуск; открытая регистрация без него возможна только в
  non-production режиме после осознанного изменения конфигурации.

Это текущее техническое состояние, но ещё не готовая открытая beta-модель.
Технически нельзя доказать, что запрос
пришёл именно из официального Electron binary: статический секрет можно
извлечь, User-Agent подделать. Поэтому безопасность строится не на скрытности
сборки, а на ограничении ущерба.

---

## Без приглашений: безопасная auto-enrollment модель

Сейчас закрытая сборка использует общий activation secret. Если положить его в публичное Electron-приложение, его можно извлечь и раздать; уже выданные stateless install tokens нельзя индивидуально отозвать.

В целевой реализации вместо invite entitlement используем автоматически
создаваемую запись установки:

```text
installation_id
status: active | revoked
plan / quotas
issued_at
last_seen_at
token_version
```

Поток:

1. Приложение генерирует installation identity; пользователь ничего не вводит.
2. Registration endpoint автоматически создаёт запись установки, но ограничен
   по IP, частоте и общему числу новых регистраций.
3. Cohort tokens версионируются server-side. Новая и предыдущая версии активны
   одновременно в grace window не короче максимального bearer TTL плюс окна
   обновления; старый token отключается только после adoption gate или
   emergency revoke. Gateway хранит несколько hashed active token versions, а
   не один секрет.
4. Gateway выдаёт короткий bearer; целевой TTL — часы, а не текущие 30 дней.
5. Refresh и дорогие запросы проверяют `status`, `token_version` и quota.
6. Конкретную установку можно отозвать; повторная массовая регистрация
   ограничивается IP/velocity controls.
7. Отдельные per-install daily quotas, global provider budget, concurrency
   fairness и emergency circuit breaker ограничивают стоимость даже при утечке
   cohort token.

После реализации P0 пользовательский UX будет полностью открытым: скачал
сборку — запустил — работает. Аккаунтов, invite codes и персональных данных для
этого не требуется. До этого внешняя beta не раздаётся.

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
Локальный release-скрипт уже принимает HTTPS URL через окружение
`NARRA_UPDATE_BASE_URL`; сам staging origin (например, отдельный bucket/domain)
ещё предстоит выбрать и предоставить. Hosted workflow остаётся только unsigned
preflight и намеренно не собирает публичный RC-feed.

---

## Готовность universal macOS build

### Уже подготовлено в Narra

- universal `arm64 + x86_64` DMG и ZIP;
- hardened runtime;
- Electron fuses;
- ручной hosted unsigned preflight без Apple secrets;
- локальный fail-closed `npm run release:local -- vX.Y.Z`;
- exact tag/version check;
- Developer ID signing из локального Keychain;
- notarization через локальный `APPLE_KEYCHAIN_PROFILE` либо локальный Team API key;
- stapling DMG;
- Gatekeeper/codesign/lipo verification;
- SHA-256, SHA-512 metadata и SBOM;
- загрузка только уже проверенных артефактов в draft GitHub Release;
- отсутствие legacy endpoint в новом клиенте.

### Что найдено и принято

- На текущем Mac есть валидная identity `Developer ID Application: Evgeny Tsapnikov (LTS79DWRGJ)`.
- Принято продуктовое решение пока собирать Narra с Developer ID Жени.
- Это решение само по себе не является разрешением владельца Apple Team на
  подпись `com.narra.app`; подтверждение остаётся release gate.
- Все signing/notarization credentials остаются только локально. В GitHub,
  Railway и репозиторий их не добавляем.
- Identity пригодна для локального signed QA, но notarization всё равно требует
  локальный Team API key или сохранённый `notarytool` profile той же Apple Team.
- Hosted workflow больше не подписывает и не notarize: он запускается только
  вручную, делает unsigned universal preflight и имеет `contents: read`.
- Локальный release script проверяет tag/version, тесты, Keychain identity,
  notarization, stapling, Gatekeeper, архитектуры, checksums и SBOM; только затем
  через локально авторизованный `gh` загружает готовые файлы в **draft** Release.
- Локальных `.p8`/`.p12` файлов GigaType не найдено.

### Что требуется только для локальной notarization

- App Store Connect **Team API key** `AuthKey_*.p8`, пригодный для `notarytool`;
- Key ID, Issuer ID и Team ID той же команды;
- разрешение владельца Team подписывать `com.narra.app`.

Эти значения вводятся только в локальный Keychain/notarytool profile и не
печатаются в логах. Для profile-варианта достаточно один раз выполнить локально
`xcrun notarytool store-credentials <profile>` и перед сборкой задать только имя
`APPLE_KEYCHAIN_PROFILE`; пароль и ключевой материал остаются в Keychain.
Matching profile/API key пока не найден, поэтому notarized public DMG
заблокирован. Наличие identity означает готовность пути, а не уже собранный
signed артефакт.

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
| `book_analysis_started` | Extended | analysis_version, chapter_count_bucket, `origin` |
| `book_analysis_completed` | Extended | duration_bucket, character_count_bucket, pov, confidence_bucket, `origin` |
| `book_analysis_failed` | Extended | stage, safe_error_code, `origin` |

### Media jobs

| Событие | Tier | Безопасные свойства |
|---|---|---|
| `media_job_enqueued` | Extended | job_type, provider, model, quality, queue_depth_bucket, `origin` |
| `media_job_started` | Extended | job_type, queue_wait_bucket, `origin` |
| `media_job_completed` | Extended | job_type, generation_time_bucket, cache_hit, result_size_bucket, `origin` |
| `media_job_failed` | Extended | job_type, stage, safe_error_code, retry_count_bucket, `origin` |
| `media_job_cancelled` | Extended | job_type, queue_or_running, `origin` |
| `tts_first_audio_ready` | Extended | voice_id, sample_rate, first_audio_latency_bucket, `origin` |
| `tts_playback_started` | Extended | source, cache_hit, `origin=user` |
| `tts_playback_abandoned` | Extended | source, listened_fraction_bucket, `origin=user` |

Все перечисленные import/media/playback события относятся к `Extended` и удаляются из локальной очереди при opt-out. Для incident response и защиты квот gateway независимо держит always-on агрегированные operational counters/logs без installation actor: общую глубину очереди, active jobs, provider error code, latency histogram и saturation. Они не отправляются как пользовательские Traction events.

Все строковые значения закрыты enum-списками, включая обязательный
`origin=user|background`. Background AI/media события всегда Extended и не
могут входить в actor activity, sessions или Tools; если Extended отключена,
для эксплуатации остаются только безакторные агрегаты. Foreground AI request
учитывается в Tools один раз по logical `request_id`, provider attempts — никогда.
Все размеры, длительности, retry count и глубина очереди передаются заранее
определёнными buckets, а не произвольными числами или строками.

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
joy → Erm_48000
```

Коды регистрозависимы: реальный AIWA-тест подтвердил, что `erm_24000` не
работает, а `Erm_24000` работает. Новый staging-тест подтвердил `Erm_48000`.

### 24 kHz против 48 kHz

23 июля 2026 на реальном staging key выполнено по пять последовательных
синтезов одинакового текста длиной 708 символов:

| Quality | Среднее | Медиана | Размер WAV |
|---|---:|---:|---:|
| `Erm_24000` | 2 023 мс | 1 960 мс | ~2,25 МБ |
| `Erm_48000` | 2 625 мс | 2 179 мс | ~4,43 МБ |

Raw latency rows, мс: `24 kHz = [2095, 1922, 2199, 1939, 1960]`;
`48 kHz = [2162, 2792, 2179, 3877, 2117]`.

48 kHz увеличил медианное время примерно на 11%, среднее — примерно на 30% из-за
одного медленного ответа, а размер ответа — почти ровно вдвое. Решение: **48 kHz
по умолчанию для нового voice registry**, без переключения качества посреди
главы. Удвоенный first-audio payload компенсируем микро-сегментом 150–300
символов; остальные сегменты синтезируются с одним prefetch.

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
- в целевом registry детским персонажам назначается Safronova по
  детерминированному правилу ниже;
- voice plan закрепляется на всю книгу;
- ручная смена инвалидирует только аудио этого героя.

Старые автоматические пулы `Bys/Tur/Pon` и `Ost/May/Nec` удаляются при
подключении нового registry. Для narrator/главного героя используются
ассистентские голоса Афина, Сбер и Джой. Остальные герои получают по полу только
библиотечные голоса Фокина, Стерлинга, Галустяна, Стремпаржевской, Цокаевой,
Безлепкина, Егорова, Чернышовой, Изволова, Сафроновой и Ковалева. Марков и Пират
не участвуют в автоназначении и остаются ручными пасхалками.

На staging key в 48 kHz успешно проверены exact-case base codes:
`Che`, `She`, `Erm`, `Gal`, `Ast`, `Ste`, `Tso`, `Bez`, `Ego`, `Izv`, `Chr`,
`Saf`, `Ksa`, `Bsa`, `Mar`, `Kas`.

Десять новых скриншотов voice picker вместе с ранее полученным скриншотом Джой
закрыли mapping целевого библиотечного пула. Все 11 файлов зафиксированы как
evidence; используем именно YourVoice-варианты там, где picker показывает
дубликаты:

| Продуктовый голос | Exact base code | Auto-assignment | Проверка на staging key |
|---|---|---|---|
| Джой | `Erm` | assistant / narrator / protagonist | `48000` — HTTP 200 |
| Фокин | `Efo` | library | picker подтверждён; `24000` — gateway HTTP 502, `48000` — HTTP 400 |
| Стерлинг | `Ast` | library | `48000` — HTTP 200; альтернативный `Gst` не используем |
| Галустян | `Gal` | library | `48000` — HTTP 200 |
| Стремпаржевская (в picker: «Стемпаржевская») | `Ste` | library | `48000` — HTTP 200 |
| Цокаева | `Tso` | library | `48000` — HTTP 200 |
| Безлепкин | `Bez` | library | `48000` — HTTP 200 |
| Егоров | `Ego` | library | `48000` — HTTP 200 |
| Чернышова | `Chr` | library | `48000` — HTTP 200 |
| Изволов | `Izv` | library | `48000` — HTTP 200 |
| Сафронова | `Saf` | child-role exception | `48000` — HTTP 200 |
| Ковалев | `Kov` | library | `24000` — HTTP 200; `48000` — HTTP 400 |
| Марков | `Mar` | manual-only | `48000` — HTTP 200 |
| Пират Касперович | `Kas` | manual-only | `48000` — HTTP 200 |

Имена файлов, SHA-256 скриншотов и сырые строки probe-результатов сохранены в
artifact/HTML как отдельные evidence datasets; таблица выше ссылается на них по
стабильным evidence ID.

В picker также видны `Gst→Стерлинг`, `Bsa→Сафронова сказки` и
`Ksa→kid Сафронов`. Это отдельные варианты, а не замены выбранным `Ast`, `Saf`
и детскому правилу Narra. `Pik/Boc/Kha/Kud` подтверждены как ПИК/Бочаров/
Хачатрян/Кудряшова, но в утверждённый автоматический пул Сони не входят.
Для `Ste` сохраняем продуктовое написание Сони «Стремпаржевская», а также
буквальное provider-display-name из picker «Стемпаржевская», чтобы различие не
выглядело ошибкой маппинга.

Старый код `Get` больше не считаем незакрытым mapping Фокина: picker однозначно
показывает `Efo→Фокин`. `Get_24000/Get_48000` и `Efo_48000` возвращают HTTP 400;
`Efo_24000` возвращает gateway HTTP 502, но причина этого ответа пока не
установлена. Владельцу SaluteSpeech нужно подтвердить доступность `Efo` на key
`gigacons` и включить требуемый `Efo_48000`. `Kov_24000` уже работает, но для
единого 48 kHz registry нужно отдельно включить `Kov_48000`.

### Детерминированное правило Safronova

- `child=true`, если подтверждённый возраст персонажа `≤12` **или** book-level
  анализ вернул закрытый `age_group=child` с confidence `≥0.8`;
- при неизвестном возрасте либо меньшей confidence используется обычный
  gender-compatible library pool, а не Safronova;
- Safronova — осознанное продуктовое исключение для child-role независимо от
  пола персонажа; ручное переопределение остаётся доступным;
- результат и `child_rule_version` фиксируются в voice plan на всю книгу, чтобы
  повторный импорт или новая модель не меняли голос без явной миграции.

Нерешённое правило: `Sber narrator + male third-person protagonist`. Среди оставшихся assistant voices нет мужского. Рекомендация — дать protagonist первому мужскому library voice, а не нарушать пол и не дублировать narrator.

Перед включением registry оставшаяся проверка:

- подтвердить technical codes Афины и Сбера: для `Che/She` API-probe успешен,
  но display-name mapping на присланных скриншотах отсутствует;
- provision `Efo_48000` для Фокина и `Kov_48000` для Ковалева;
- text и текущий SSML;
- HTTP status/content type;
- WAV sample rate/duration;
- audible sample для Сони.

---

## План реализации

### P0 — до внешней beta без приглашений

- [x] Gateway v2 и OpenRouter staging
- [x] Stats staging и production Traction module
- [x] Essential/extended telemetry split
- [x] Universal unsigned package
- [x] Local release path + manual unsigned hosted preflight
- [x] Local Developer ID identity для signed QA
- [ ] Local matching Apple Team API key/profile для notarization
- [x] Все шесть Traction slots видны постоянно
- [ ] Voice registry и исправленные cache keys
- [ ] Background-разметка первой главы после импорта
- [ ] Bounded parallel/streaming chapter markup
- [ ] Progressive TTS first-audio
- [ ] Durable media job API и queue UX
- [x] Внутренний staging-only degraded HTTP video gate с тестовыми данными
- [ ] HTTPS video relay до передачи media внешних beta-пользователей
- [ ] Auto-enrolled revocable installation registry без приглашений

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
- [ ] Account/subscription entitlement при появлении продуктовой потребности

---

## Что нужно решить владельцам

1. Подтвердить, какой из `Che/She` — Афина, а какой — Сбер. Библиотечный mapping
   уже закрыт скриншотами; у владельца SaluteSpeech нужно provision
   `Efo_48000` и `Kov_48000`.
2. Как назначать голос при `Sber narrator + male protagonist`? Рекомендация:
   первый мужской library voice.
3. Сколько портретов готовить автоматически? Рекомендация: главный герой плюс
   2–3 основных; остальные — при открытии карточки.
4. Может ли владелец video host установить Caddy/Nginx или `cloudflared` рядом
   с process? Без этого Railway proxy не шифрует второй участок.
5. Может ли Женя/владелец его Apple Team дать matching notarization `.p8`,
   Key ID, Issuer ID, Team ID и подтвердить `com.narra.app`?
6. Какой бюджет/лимит допустим для capacity benchmark `1 → 2 → 5 → 10`?
7. Под «APK» имеется в виду Android? Текущий Narra — Electron desktop;
    Android потребует отдельного клиентского проекта.
