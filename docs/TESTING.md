# Testing Tulmi (end-stage checklist)

This is the hands-on test pass for the v1 feature-complete build. Work top to
bottom; note anything to tweak and batch it back in one go.

## 0. Sync + install

```bash
git pull origin claude/dreamy-franklin-rFLIX
cd app && npm install
```

## 1. Backend up

Create `tulmi/.env` (see `.env.example`). Minimum to boot + serve UI:

```
DEV_SKIP_AUTH=true
PORT=8770
OPENROUTER_API_KEY=<real key for ✨ Refine / 💬 Reply>
OPENAI_API_KEY=<real key for 🎙️ voice / STT>
```

```bash
cd tulmi
npm install
npm run dev          # → listening on 8770
```

Sanity (optional, second terminal):
```bash
curl http://localhost:8770/healthz
curl -X POST http://localhost:8770/v1/app/bootstrap -d "{}" -H "Content-Type: application/json"
curl http://localhost:8770/v1/keyboard/config
```

## 2. The app (Expo Go)

```bash
cd app
npx expo start
```
Open in Expo Go / emulator. Tap **⚙ Connection** → set URL:
- Android emulator → `http://10.0.2.2:8770`
- Physical phone → `http://<PC-LAN-IP>:8770`

**Check:**
- [ ] First launch shows **Onboarding** (Welcome). "Get started" → Home. Re-open app → goes straight to Home.
- [ ] 4 tabs render from the server: **Home, Reply, You, Settings**.
- [ ] **Home:** type → ✨ Refine → polished text appears. 🎙️ Record → speak → text fills the box.
- [ ] **Reply:** paste a message + intent → Draft reply → personalized reply appears.
- [ ] **You:** set tone/formality/emoji → Save → reopen app → values persisted.
- [ ] **Settings:** "Open project on GitHub" opens the browser; "Reload from server" re-fetches.
- [ ] **Server-driven proof:** edit a label/color in `tulmi/src/experience/catalog.ts`, save, switch tabs → UI changes with **no rebuild**.

## 3. The keyboards (needs a dev build, not Expo Go)

Android (fastest for you):
```bash
cd app
npx eas-cli build --profile preview --platform android   # → APK
```
Install the APK on the emulator/phone, then:
**Settings → System → Languages & input → On-screen keyboards → enable Tulmi**, switch to it.

iOS (needs a Mac or EAS + Apple account):
```bash
npx eas-cli build --profile development --platform ios
```
**Settings → General → Keyboard → Keyboards → Add Tulmi → Allow Full Access.**

**Check (both):**
- [ ] Typing works (QWERTY).
- [ ] ✨ Refine rewrites the field.
- [ ] 🎙️ Voice records → inserts cleaned text (grant mic; iOS needs Full Access).
- [ ] Theme/labels match the server config (`/v1/keyboard/config`).
- [ ] Flip a flag in `buildKeyboardConfig()` (e.g. `refine: false`) → keyboard honors it after its cache refreshes.

> Keyboard backend URL is currently a constant (`Net.kt` / `TulmiBackend.swift`).
> If testing on a device, point it at your PC's LAN IP or VPS.

## 4. Known not-yet-built (by design, for after this pass)

- Live streaming dictation wired into the keyboards (backend `/v1/stream` exists).
- Accounts/login (Supabase scaffolded; needs your project keys).
- "Learns your style" personalization (needs persistence/accounts).
- Visual polish: app icon/splash, final spacing/animation pass.

Collect everything you want changed and hand it over in one batch.
