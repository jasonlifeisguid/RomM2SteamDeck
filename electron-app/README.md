# RomM2SteamDeck — Electron app (Stage 1)

Native desktop rewrite of the Flask/browser app in the parent folder. The
Python app remains untouched and working; this is built alongside it.

## Current state (Stage 1: read-only library browser)

- Native window, clean exit (close the window = app exits), single instance
- Settings with **Test Connection**; RomM password encrypted at rest via OS
  keystore (DPAPI / Keychain / libsecret) — not plaintext
- Full library fetch with pagination (no 500-game cap) and progressive
  rendering — pages appear in the grid as they arrive from the server
- **Stale-while-revalidate caching with delta sync**: game lists render
  instantly from the on-disk cache; the background refresh uses the RomM
  `updated_after` filter (~1s) instead of a full refetch, falling back to a
  full fetch only when the server rom_count says something was deleted.
  Cover art is cached on disk and lazy-loaded as you scroll.
  Measured on a 5,177-game platform: cold load 65s (server-bound, first 500
  games visible in 6s, once ever) → warm load 1.7s including delta sync.
- Search + sort, store-style dark grid UI (OLED orange)

Not yet ported (next stages): downloads with progress, zip/7z extraction
(bundled 7za — no system 7-Zip dependency), download tracking, desktop
shortcuts, packaging (installer / dmg / AppImage), gamepad navigation,
add-to-Steam.

## Development

Node.js is installed portably at `C:\Users\Jason\Documents\Claude\tools\nodejs`
(not on the system PATH). Either use `start.cmd`, or add that folder to PATH
and run:

```cmd
npm install   # first time only
npm start     # compiles TypeScript, launches the app
```

## Layout

```
src/main.ts      Electron main process: window, IPC, stale-while-revalidate
src/romm.ts      RomM API client (Basic auth, pagination)
src/config.ts    Settings storage, password encryption (safeStorage)
src/cache.ts     JSON list cache + cover art cache
src/preload.ts   contextBridge — the only API the renderer can touch
renderer/        Plain HTML/CSS/JS UI (no framework, no build step)
```

Data lives in `%APPDATA%\romm2steamdeck-app` (config.json, cache\, covers\).
