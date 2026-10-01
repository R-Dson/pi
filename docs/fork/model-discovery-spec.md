# Model Discovery for models.json Custom Providers

Spec synthesized 2026-09-22 from the planning session. Intended tracker: fork issues (gh token was expired at synthesis time; publish and link from here if filed).

## Problem Statement

Pointing pi at a local or custom OpenAI-compatible server (llama.cpp, vLLM, Ollama, LM Studio, private gateways) requires hand-maintaining model entries in `~/.pi/agent/models.json`: ids, context windows, thinking configuration. The servers already expose this data over HTTP (`/v1/models` listings, vLLM's `max_model_len`, Ollama's `/api/tags` + `/api/show`, llama.cpp's `/props`). Users must copy metadata by hand and it drifts when the server's model set changes.

## Solution

A models.json provider can declare `discover` to have pi fetch its model catalog from the server automatically. Discovered models form the provider's baseline layer; models.json keeps its existing override role unchanged in precedence (explicit `models[]` entries upsert-replace same-id discovered models; `modelOverrides` still apply last). Discovery is opt-in per provider, fetches on every networked catalog refresh (interactive startup, opening `/model`, `pi update --models`; non-interactive sessions restore the persisted catalog at startup and fetch on their next refresh), respects `PI_OFFLINE` and the existing refresh timeout, and persists results in the model store so previously discovered models survive restarts and offline sessions.

## User Stories

1. As a pi user running a local llama.cpp server, I want to point pi at it with a minimal provider entry (`baseUrl` + `discover`) and see its models in `/model` without editing model lists, so that setup is one-time.
2. As a pi user running vLLM, I want discovered models to carry the context window the server reports (`max_model_len`), so that token accounting and compaction work without manual metadata.
3. As an Ollama user, I want discovery to use Ollama's native endpoints (`/api/tags` plus `/api/show`), so that context length, vision capability, and thinking-template metadata are picked up.
4. As a pi user serving a reasoning model (Qwen3-style `enable_thinking` chat template), I want discovery to mark the model as reasoning-capable and install the chat-template thinking-level map, so that thinking levels work out of the box.
5. As a pi user, I want `modelOverrides` in models.json to keep applying over discovered metadata, so that wrong or missing server data stays fixable by config.
6. As a pi user, I want an explicit models.json `models[]` entry with the same id as a discovered model to replace it, so that full manual control remains possible per model.
7. As a pi user, I want provider-level `compat` in models.json to merge over the conservative compat block discovery installs, so that server quirks stay configurable.
8. As a pi user with auth on my endpoint, I want discovery to reuse the provider's resolved credential (`apiKey`, `$ENV` interpolation, custom headers), so that protected gateways work without a second auth config.
9. As an offline pi user (`PI_OFFLINE`), I want previously discovered models restored from the local store, so that the picker is populated without any network.
10. As a pi user whose server is temporarily down, I want discovery failures to keep the last-discovered list and surface the error, so that a refresh never wipes a working catalog.
11. As a pi user, I want the `/model` picker, `--list-models`, and model resolution to treat discovered models like any other, so that selection and `--model provider/id` work unchanged.
12. As a pi user, I want `pi update --models` to force a live re-discovery, so that adding a model server-side and running one command refreshes pi.
13. As a privacy-conscious pi user without any `discover` providers, I want zero new network traffic, so that the default session stays fetch-free (no-tracking guarantee unaffected).
14. As a pi user, I want discovery fetches bounded by the existing refresh timeout and abort signal, so that a hung server cannot stall startup or the picker beyond the documented bound.
15. As a pi user restarting pi, I want discovered catalogs persisted in the model store (`models-store.json`), so that models appear instantly on the next start and refresh only updates them.
16. As a pi user editing models.json mid-session, I want hot reload to keep working, so that adding an override takes effect on the next `/model` open without a restart.
17. As a pi user behind an OpenAI-compatible gateway returning a bare array from `/models`, I want discovery to tolerate both `{data: [...]}` and array responses, so that gateway quirks don't break listing.
18. As a fork maintainer, I want the placement and traffic-policy decisions recorded in the integration ledger, so that syncs and audits keep the rationale.
19. As a fork maintainer, I want zero changes to builtin provider behavior and the llama.cpp `/login` builtin, so that the feature is purely additive to the models.json path.

## Implementation Decisions

- Schema: `discover` on a models.json provider, `boolean | "openai" | "ollama"`; `true` means `"openai"`. Validation lives in the existing models.json schema; a discovery provider still requires `baseUrl` (and provider `api` defaults to `openai-completions` for discovered models when unset).
- Layering: discovered models are injected as additional baseline models beneath the existing composition order — generated/builtin base, discovered list, models.json `models[]` upserts, extension models, `modelOverrides` last. Ids the base catalog already carries stay authoritative: a discovered id never replaces a builtin entry (discovered copies are dropped on collision).
- Refresh wiring: a composed provider whose config has `discover` gets a `refreshModels` that (1) restores from the persisted store entry when present, publishing update-only; (2) when network is allowed, the signal is not aborted, and auth resolves, fetches the endpoint and publishes with persistence. Errors restore nothing new; the previous list stands and the error propagates to the refresh orchestration.
- Protocols: `"openai"` fetches `GET {baseUrl}/models` (baseUrl conventionally ends in `/v1`), reading `id` plus optional `max_model_len`/`context_length`; one opportunistic server-level `/props` probe (llama.cpp chat template) that is silently skipped when the endpoint 404s. `"ollama"` fetches `GET {root}/api/tags` (root = baseUrl with trailing `/v1` stripped) and probes `POST {root}/api/show` per model.
- Metadata mapping: context window from server data with 128000 fallback; `maxTokens` mirrors the context window (local-server precedent); `enable_thinking` in a chat template yields `reasoning: true` plus the qwen-chat-template thinking-level map and compat `thinkingFormat`; vision capability yields `input: ["text", "image"]`; cost is zero; a conservative compat block (no store, no developer role, no reasoning-effort parameter, no strict mode, `max_tokens` field) merges beneath user compat — installed only for the `openai-completions` api, the only wire api local servers realistically serve (other apis get no compat block; user compat still applies).
- Auth for discovery fetches reuses the resolved api-key credential or the provider config's `apiKey`/`headers` with existing `$ENV` value resolution.
- Placement: core (fork-owned discovery module plus a small extension of the existing composer seam); the models.json composition path is unreachable from the extension API. Recorded in the integration ledger.
- Traffic policy: opt-in per provider via config; fetches only during catalog refresh; `PI_OFFLINE` respected through the existing model-network gate (the `pi update --models` command passes an explicit network flag, so it re-derives it from `PI_OFFLINE`); each request additionally carries a 10-second timeout on top of the refresh abort controller, so one hung endpoint cannot consume an unbounded window when a caller supplies no overall deadline. The `pi update --models` message reports what ran: live discovery, or local restore under `PI_OFFLINE`.
- models.json itself is never written by discovery; persistence goes to the existing model store keyed by provider id.

## Testing Decisions

- Tests verify behavior at public seams only: the discovery module's fetch-and-normalize function (models out, given a server), the composed provider's `getModels`/`refreshModels` (precedence and restore), and one no-network regression. No private-method or mock-internal tests.
- Hermetic HTTP: ephemeral `node:http` servers on 127.0.0.1 with per-flavor handlers (OpenAI-shaped, Ollama-shaped, llama.cpp `/props`), following the existing llama-extension test pattern; assertions include request headers (auth) and error paths (non-200, invalid JSON).
- Prior art in the codebase: the llama.cpp extension tests (ephemeral servers, fake `publish`), the model registry/composer merge tests, and the models.json hot-reload regression test.
- Gates: full typecheck/lint check, targeted vitest files during the loop, full suite once at the end.

## Out of Scope

- Google `ListModels` (no custom-endpoint use case; the builtin google provider stands).
- Auto-detection of running local servers (config-first: the provider entry is the opt-in).
- Writing discovered models into models.json.
- Any change to builtin providers or the llama.cpp `/login` builtin flow.
- Discovery for extension-registered providers (they already have `refreshModels`).

## Further Notes

- The approved planning session fixed two choices: fetch on every refresh (not command-only), and listing + per-model probes (not listing-only).
- Story 1's "minimal entry" presumes auth resolves (the implementation decision above): a keyless local server keeps the dummy-`apiKey` convention, `/login`, or `--api-key` — the network refresh phase runs only for configured providers.
- Accepted edges, recorded by the 2026-10-01 deep review: (1) discovery resolves header `$VAR`s from the credential env and process env, but not a custom AuthContext's injected env (streaming does); fixing it needs an env hook on the pi-ai refresh context — revisit if an embedder hits it. (2) Recomposing a provider (models.json hot reload) starts with an empty discovered list until the restore phase republishes within the same refresh; the final availability snapshot is taken after refresh completes, and the picker renders the prior snapshot first, so no user-visible flicker. (3) Ollama probes run sequentially under the per-request and refresh timeouts; an abort keeps the last persisted catalog (a partial probe loop is never published).
- Sync awareness: the composer and models.json schema files are upstream-owned surfaces; conflicts on future syncs resolve by re-porting the discovery baseline injection and the `discover` field.
