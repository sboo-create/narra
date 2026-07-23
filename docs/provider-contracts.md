# Narra provider contracts

Проверено 23 июля 2026 по переданным командой примерам и живым upstream
контрактам. Секреты и пользовательский контент в этот документ не входят.

## Kandinsky 6 image

- Base URL: `https://studio.kandinskylab.ai/api`
- Auth: `Authorization: Bearer <token>`
- Text-to-image: `POST /tasks/k6-image-t2i`
- Image-to-image: `POST /tasks/k6-i2i`
- Status: `GET /tasks/{task_id}`
- Result: `GET /tasks/{task_id}/result`
- Terminal success: `status=done`; terminal provider failures include
  `failed`/`error`; result `422` is a terminal censorship decision.

The supplied image-to-image REST example names `k6-image-t2i`, while its
Python example and the live API contract name `k6-i2i`. Narra uses the latter
if/when an image-to-image feature is added.

TLS verification remains enabled. The sample clients set `ssl_verify=False`,
but that diagnostic shortcut is not carried into Narra production.

## SaluteSpeech TLS

Sber OAuth/Speech endpoints use the Russian Trusted Root CA chain, which is
not part of Node's bundled Mozilla roots. Narra adds the Минцифры root and
current 2024 issuing certificate only for Sber requests, while preserving all
standard Node roots. Both bundled certificates are accepted only when their
SHA-256 fingerprints match the values already reviewed in MultiTool. TLS
signature, expiry and hostname checks remain enabled; `ALLOW_INSECURE_TLS`
stays forbidden in production.

## Kandinsky video

- Current temporary Base URL: `http://87.242.117.37:5051`
- Health: `GET /health`
- OpenAPI: `GET /openapi.json`
- Create: `POST /tasks/{task_type}`
- Status: `GET /tasks/{task_id}`
- Result: `GET /tasks/{task_id}/result`
- Narra task types currently used: `giga_avatar`, `k5-i2v-lite`,
  `k5-i2v-hd`
- Request censorship is always enabled with `censor: true`.

The server answers over HTTP, but its HTTPS endpoint fails TLS negotiation.
Using it therefore requires the explicit server-side
`ALLOW_INSECURE_VIDEO_HTTP=true` risk acceptance plus an exact
`VIDEO_INSECURE_HTTP_HOSTS=87.242.117.37` allowlist. The exception is accepted
only when `ANALYTICS_ENV=staging` (or local development/test); production
startup rejects it. The gateway readiness response marks staging as degraded
with `VIDEO_PLAINTEXT_HTTP`. This blocks a public release until HTTPS or a
private encrypted tunnel is available: the bearer token, source image/audio
and result video are otherwise sent without transport encryption.

## LLM routing

The client sends only the task `purpose`. Provider, model, retries and fallback
are selected by the Narra gateway.

- `giga` uses the team LiteLLM/OpenAI-compatible endpoint.
- `openrouter` uses its server-side API key and sends
  `provider.zdr=true` plus `provider.data_collection=deny`.
- One logical user request keeps one `request_id`.
- Every configured provider attempt emits `provider_attempt_started`, then
  exactly one terminal event with its own attempt event ID and `retry_index`.
  HTTP 200 is not success by itself: `completed` is emitted only after the
  complete SSE/body has been consumed and parsed. Broken, malformed or
  oversized bodies, in-band errors, content-filter finishes and SSE streams
  without a terminal `[DONE]` produce `failed`. The desktop parser enforces
  the same framing and never promotes partial text to a successful result.
- Giga/LiteLLM streaming requests explicitly set
  `stream_options.include_usage=true`.
- Input/output/total token usage and exact provider cost are recorded only
  when returned by the upstream; missing data is reported as missing coverage,
  never fabricated as zero.
- OpenRouter exact cost comes from final `usage.cost`; LiteLLM exact cost comes
  from `usage.cost` or the `x-litellm-response-cost` response header. Every
  accepted value is tagged with its source and `USD` currency. A number without
  an accepted source/currency is excluded from aggregates.

The current team LiteLLM endpoint is public plaintext HTTP and has no working
TLS listener. Narra does not send book text, chat content or bearer credentials
to it from production/staging until HTTPS or a private encrypted tunnel is
available. Staging therefore exercises the same purpose routing through
OpenRouter over HTTPS; Giga remains a required follow-up rather than a hidden
TLS downgrade.

## Staging policy

Sony confirmed that separate provider staging keys will not be issued. Railway
staging therefore copies only the required credential values without exposing
them; it does not copy unsafe provider URLs or route flags wholesale. Until
LiteLLM has HTTPS/private transport, staging must omit `LLM_BASE_URL`, set every
purpose-specific `LLM_ROUTE_*` to `openrouter`, and clear every Giga fallback.
It also uses distinct Narra gateway, activation, analytics-HMAC and Traction
ingest secrets, a separate `ANALYTICS_ENV=staging`, and a separate persistent
Volume. No production analytics database is reused.
