# Narra — иммерсивная читалка

Книги «оживают»: с героями можно разговаривать (они знают сюжет только до твоей главы), текст озвучивается по ролям с эмоциями, сцены иллюстрируются, портреты героев анимируются. Свои книги загружаются в форматах txt / fb2 / epub / pdf / zip.

## Архитектура

```
Electron (main / preload / renderer React+Vite+TS)
        │  все запросы к нейросетям
        ▼
Прокси server/index.mjs (Express, деплой на Railway) — ключи ТОЛЬКО здесь
        ├─ GigaChat-3-Ultra  — чаты, разметка, саммари (LiteLLM-шлюз, SSE-стриминг)
        ├─ gigachat-image    — портреты героев
        ├─ Kandinsky 6.0     — обложки и сцены (очередь + ретраи + обход цензора)
        ├─ k5-i2v-lite/hd    — оживление портретов (image-to-video)
        └─ SaluteSpeech      — TTS (6 голосов, SSML-эмоции) и ASR
```

- Прод-прокси: `https://narra-proxy-production.up.railway.app` (`/health` — статус)
- Автообновление: приложение сверяется с `/app/latest`; dmg лежит в `server/updates/`
- Контент: `content/*.json` (книга) + `content/*-characters.json` (герои с паспортами внешности)
- Паспорта внешности — канон: вшиваются дословно в каждый промпт картинок (`src/renderer/lib/passport.ts`)

## Запуск для разработки

```bash
npm install
npm run fetch-content   # докачивает книги, которых нет в публичном репо (фанфик и др.)
# ключи (только для локального сервера; в проде они в Railway Variables):
cp server/.env.example server/.env   # и заполнить
node --env-file=server/.env server/index.mjs   # прокси на :8787
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
# 1) поднять version в package.json
NARRA_PROXY_URL=https://narra-proxy-production.up.railway.app npm run dist
cp release/Narra-arm64.dmg server/updates/
# 2) обновить server/updates/latest.json (version + url)
cd server && npx @railway/cli up --detach --service narra-proxy
```

У всех установленных приложений при запуске появится баннер «Доступна новая версия».

## Известные грабли

- Кандинский обрезает промпт на **950 символах** — стиль всегда в начале промпта
- У Кандинского два цензора: входной (`bad_*_lemmas`) и выходной (смотрит на готовый кадр);
  выходной лечится ретраем — сервер делает это сам
- GigaChat отказывается от «чувствительных» тем (даже Чехова) — нужен фолбэк
- `/gigachat/complete` — `max_tokens: 6000`: разметка озвучки дублирует текст главы в JSON
- Видео-API: максимум 3 задачи на токен, 5 сек между запросами — на сервере очередь
- macOS: без платной подписи Apple настоящий silent-автоапдейт невозможен (поэтому баннер)
