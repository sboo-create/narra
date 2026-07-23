# Narra — иммерсивная читалка

Книги «оживают»: с героями можно разговаривать (они знают сюжет только до твоей главы), текст озвучивается по ролям с эмоциями, сцены иллюстрируются, портреты героев анимируются. Свои книги загружаются в форматах txt / fb2 / epub / pdf / zip.

## Архитектура

```
Electron (main / preload / renderer React+Vite+TS)
        │  все запросы к нейросетям
        ▼
Прокси server/index.mjs (Express, деплой на Railway) — ключи ТОЛЬКО здесь
        ├─ GigaChat-3-Ultra  — чаты, разметка, саммари (LiteLLM-шлюз, SSE-стриминг)
        ├─ OpenRouter        — server-side маршрут/fallback по назначению запроса
        ├─ gigachat-image    — портреты героев
        ├─ Kandinsky 6.0     — обложки и сцены (очередь + ретраи + обход цензора)
        ├─ k5-i2v-lite/hd    — оживление портретов (image-to-video)
        └─ SaluteSpeech      — TTS (6 голосов, SSML-эмоции) и ASR
                          │
                          └─ bounded audit/outbox → stats-narra → Traction
```

- Текущий Railway URL владельца: `https://narra-proxy-production.up.railway.app` (`/health`); перед релизом проверяется через отдельный staging.
- Автообновление: только `latest-mac.yml` + universal ZIP по HTTPS; notarized DMG публикуется как отдельный installer. Legacy `/app/latest` и `latest.json` не поддерживаются.
- Контент: `content/*.json` (книга) + `content/*-characters.json` (герои с паспортами внешности)
- Паспорта внешности — канон: вшиваются дословно в каждый промпт картинок (`src/renderer/lib/passport.ts`)

## Запуск для разработки

```bash
npm install
npm install --prefix server
npm run fetch-content   # докачивает книги, которых нет в публичном репо (фанфик и др.)
# ключи (только для локального сервера; в проде они в Railway Variables):
cp server/.env.example server/.env   # и заполнить
npm run proxy                                  # прокси на :8787
npm run dev                                     # Electron + Vite HMR
```

Без Electron (быстрая проверка UI в браузере): открыть `http://localhost:5173` — dev-shim
подменяет IPC (картинки — плейсхолдеры, текст — через реальный прокси).

## Ключевые места в коде

| Что | Где |
|---|---|
| Промпты всех LLM-задач | `src/renderer/lib/prompts.ts` |
| Конструктор промптов картинок (паспорта) | `src/renderer/lib/passport.ts` |
| Разметка главы на блоки/сноски | `src/renderer/lib/blocks.ts`, `rich.tsx` |
| Озвучка: сценарий и плеер | `src/renderer/lib/scenario.ts`, `ttsController.ts` |
| Фоновое оживление портретов | `src/renderer/lib/idleManager.ts` |
| Импорт книг (fb2/epub/pdf/txt) | `src/main/importer.ts` |
| Прокси и все интеграции | `server/index.mjs` |

## Релиз

```bash
# Локальная unsigned universal-проверка arm64 + x86_64
npm run dist:unsigned
npm run smoke:pdf-worker

# Production-сборка fail-closed: требует HTTPS gateway/update-feed,
# Developer ID и Apple notarization credentials.
npm run dist
bash scripts/notarize-dmg.sh
npm run release:verify
```

Canonical release запускается workflow `Signed macOS release`: tag обязан совпадать с
`package.json`, GitHub Environment `narra-production` должен иметь required reviewers,
а App Store Connect `.p8` материализуется как временный файл. Артефакты update-feed
публикуются только после подписи, notarization, stapling, smoke и checksum/SBOM checks.

## Известные грабли

- Кандинский обрезает промпт на **950 символах** — стиль всегда в начале промпта
- У Кандинского два цензора: входной (`bad_*_lemmas`) и выходной (смотрит на готовый кадр);
  выходной лечится ретраем — сервер делает это сам
- GigaChat отказывается от «чувствительных» тем (даже Чехова) — нужен фолбэк
- `/gigachat/complete` — `max_tokens: 6000`: разметка озвучки дублирует текст главы в JSON
- Видео-API: максимум 3 задачи на токен, 5 сек между запросами — на сервере очередь
- macOS: без Developer ID, notarization и HTTPS update-feed production-релиз намеренно не собирается
