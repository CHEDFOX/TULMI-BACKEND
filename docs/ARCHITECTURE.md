# Tulmi — Architecture

> The backend is the brain. The frontend is a generic renderer.
> We change the entire app from the server, without shipping a build.

This document is the **contract** the whole project builds against. It captures
the product vision, the Server-Driven UI (SDUI) model, the keyboard model, the
backend decomposition, and the phased roadmap to a best-in-market smart keyboard.

The contract lives as code in:
- [`shared/types/api.ts`](../shared/types/api.ts) — the "brain" endpoints
- [`shared/types/sdui.ts`](../shared/types/sdui.ts) — the server-driven UI schema

---

## 1. Principles

1. **Server-driven everything.** Content, copy, styling, layout, navigation,
   flow, media, motion, haptics, and feature behavior come from the server. The
   client ships once and rarely changes.
2. **The client is dumb on purpose.** It renders a fixed set of primitive
   components and obeys a fixed set of declarative actions. No hardcoded screens.
3. **The brain is already server-side.** Transcription, cleanup, refine, tone,
   and personality are API calls. SDUI extends that same idea to the UI.
4. **Both platforms, one renderer.** A single React Native renderer drives iOS
   and Android. Only the keyboard is per-OS native (it has to be).
5. **Forward-compatible by default.** The client advertises its capabilities;
   the server never emits something the client can't draw; unknown nodes
   degrade gracefully.

---

## 2. System overview

```
            ┌───────────────────────── CLIENTS ─────────────────────────┐
            │                                                            │
            │   Main app (React Native, iOS + Android)                   │
            │   = GENERIC RENDERER                                       │
            │     • component registry (Stack, Text, Button, List…)      │
            │     • action interpreter (navigate, callEndpoint, haptic…) │
            │     • state engine + screen cache                          │
            │                                                            │
            │   Keyboard (native: Android IME / iOS extension)           │
            │   = THIN SHELL + cached config + live brain calls          │
            └───────────────┬───────────────────────┬───────────────────┘
                            │ SDUI (UI as JSON)      │ Brain (REST/WS)
            ┌───────────────▼───────────────────────▼───────────────────┐
            │                       BACKEND                              │
            │                                                            │
            │   Experience service  →  /v1/app/* (bootstrap, screens)    │
            │   Brain service       →  /v1/transcribe-clean, /refine,    │
            │                          /draft, /speak, /stream           │
            │   Config service      →  /v1/keyboard/config               │
            │   Personalization     →  user style profile (learns you)   │
            │   Identity / accounts →  auth, entitlements, metering      │
            └────────────────────────────────────────────────────────────┘
```

---

## 3. Server-Driven UI (the main app)

### How a screen renders

1. **Launch →** client POSTs `ClientCapabilities` to `POST /v1/app/bootstrap`.
   Server returns the global `ThemeTokens`, the `NavigationShell` (e.g. a tab
   bar), and `initialScreenId`.
2. **Each screen →** client calls `POST /v1/app/screen` with the `screenId`.
   Server returns a `ScreenResponse`: a `root` Node tree, initial `state`, and
   named `actions`.
3. **Render →** the renderer walks `root`, drawing each `Node.type` via its
   component registry and binding props to `state` via `Node.bind`.
4. **Interact →** an event (`on.onPress` → `ActionRef`) runs an `ActionSpec`:
   navigate, call a brain endpoint, mutate state, fire a haptic, play media…
5. **Update →** `setState`/`callEndpoint.assignTo` mutate state; bound nodes
   re-render. `refresh` re-fetches the screen.

### Why this is safe to ship daily

- **Capability negotiation:** the server only emits node `type`s and action
  `kind`s the client advertised, so a new server feature can't crash an old app.
- **Graceful fallback:** any unknown node renders its `Node.fallback` instead.
- **Caching + offline:** screens carry `cacheTtlSeconds`; the last good bootstrap
  and screens are cached so the app opens offline.

See [`shared/types/sdui.ts`](../shared/types/sdui.ts) for the full schema:
`BootstrapResponse`, `ScreenResponse`, `Node`, `ActionSpec`, `ThemeTokens`,
`MotionSpec`, `Condition`.

### Worked example — the Personality screen, server-driven

Today `App.tsx` hardcodes the Personality screen. Server-driven, the same screen
becomes JSON the backend owns end to end:

```jsonc
{
  "screenId": "personality",
  "title": "Your personality",
  "state": { "form": { "tone": "warm and concise", "formality": "neutral" } },
  "actions": {
    "save": {
      "kind": "sequence",
      "actions": [
        { "kind": "callEndpoint", "method": "PUT", "path": "/v1/personality",
          "body": { "personality": "$state.form" }, "onSuccess": "saved" }
      ]
    },
    "saved": { "kind": "toast", "message": "Saved.", "tone": "success" }
  },
  "root": {
    "type": "Screen",
    "children": [
      { "type": "Text", "props": { "content": "Tone", "variant": "label" } },
      { "type": "TextField", "bind": { "value": "form.tone" },
        "on": { "onChange": { "kind": "setState", "path": "form.tone", "value": "$event" } } },
      { "type": "Button", "props": { "label": "Save personality" },
        "on": { "onPress": "save" }, "motion": { "appear": "fadeInUp" } }
    ]
  }
}
```

Want a new field, different copy, a reordered layout, a new color, an A/B test?
Change the JSON. No rebuild.

---

## 4. The keyboard model (OS-legal "SDUI")

A keyboard is a **sandboxed OS extension**: it must draw a key the instant it's
tapped, work with no network, and sip battery. So it **cannot** round-trip to a
server per keystroke. Instead it gets the server-driven benefit in the form that
works:

| Layer | Server-controlled? | Mechanism |
|---|---|---|
| The brain (transcribe, clean, refine, tone, personality, models, prompts) | ✅ fully | live REST/WS |
| Config (theme, layouts, languages, copy, feature flags) | ✅ yes | `GET /v1/keyboard/config`, **cached + background-refreshed** |
| Per-keystroke key rendering | ❌ native | instant, offline |

Result: prompts, models, tone, theming, copy, languages, and which features are
on are all changeable from the server with no rebuild — see
`KeyboardConfigResponse` in [`sdui.ts`](../shared/types/sdui.ts). Voice runs
**inline** in the extension (Full Access required) on both platforms.

---

## 5. The smart stack (what makes it best-in-market)

The pipeline, in order, each layer server-owned and independently improvable:

1. **Transcription** — accurate multilingual STT (incl. Hinglish/code-switching).
2. **Cleanup** — remove fillers, fix grammar/punctuation, structure.
3. **Refine** — rewrite typed text into the best version.
4. **Tone / context** — match the target app (Slack vs. email vs. WhatsApp) and
   the user's chosen personality.
5. **Personalization** — a per-user **style profile** that learns vocabulary,
   names, and voice over time, so output sounds like *them*.

**Our competitive edges:** (a) server-driven intelligence ships **daily** with
no app-store wait — a structural advantage over Wispr/Gboard; (b) personality &
tone as first-class, learned features.

---

## 6. Backend decomposition

Built on the existing Fastify server (`tulmi/src/server.ts`). New surfaces:

- **Experience service** — `POST /v1/app/bootstrap`, `POST /v1/app/screen`.
  Owns the screen catalog, themes, flags, A/B assignment. Screens authored as
  data (DB/JSON), not code.
- **Brain service** — existing `/v1/transcribe-clean`, `/v1/refine`, `/v1/draft`,
  `/v1/speak`, `/v1/stream`, `/v1/personality`.
- **Config service** — `GET /v1/keyboard/config`.
- **Personalization** — style-profile store feeding the brain's prompts.
- **Identity / accounts** — auth (Supabase scaffolding exists), entitlements,
  usage metering (`tulmi/src/usage/metering.ts`).

---

## 7. Phased roadmap

Big vision, shipped in disciplined slices. Each phase is independently testable.

- **Phase 0 — Contract (this doc + `sdui.ts`).** ✅ done.
- **Phase 1 — SDUI renderer.** ✅ done. RN renderer: component registry, action
  interpreter, state engine, screen cache, capability handshake. Screens are
  rendered entirely from the server.
- **Phase 2 — Experience backend.** ✅ done. `/v1/app/bootstrap` +
  `/v1/app/screen`, screen catalog (Home, Reply, You, Settings, Onboarding),
  theme tokens, flags. App is fully server-driven.
- **Phase 3 — Keyboard config.** ✅ done. `/v1/keyboard/config`; both keyboards
  fetch + cache it and apply theme/labels/feature-flags. Inline voice + refine
  work on both OSes. (Per-keystroke layout stays native by design.)
- **Phase 4 — Smart depth.** ⏳ next. Live streaming dictation (`/v1/stream`
  exists; wire clients), deeper app-aware tone. Needs on-device tuning.
- **Phase 5 — Personalization.** ⏳ Per-user style profile that learns over time
  (needs persistence / accounts).
- **Phase 6 — Accounts, entitlements, polish.** ⏳ Supabase auth (scaffolded),
  paywall, metering, motion/haptic + visual pass, store submission. First-run
  onboarding routing is ✅ done.

---

## 8. Open decisions

Tracked here as we go:

- **State expression depth.** How rich should `Condition`/binding be before it
  becomes a mini-language? Keep minimal; push logic to the server.
- **Screen authoring.** Hand-written JSON vs. a small authoring UI for screens.
- **Offline brain.** Any on-device fallback for dictation when offline?
- **Auth & sync.** When accounts land, how personality/style sync across devices.
