# RomM2SteamDeck — Electron app (Stage 2)

Native desktop rewrite of the Flask/browser app in the parent folder. The
Python app remains untouched and working; this is built alongside it.

## Stage 2.5: desktop shortcuts for PC games

- On an installed (extracted) PC game's detail dialog, **Create Shortcut…**
  scans the game folder for `.exe` files and lets you pick one (launcher
  listed first). Creates a desktop shortcut: `.lnk` on Windows, `.desktop`
  on Linux/Steam Deck, `.command` on macOS.
- On Steam Deck the dialog shows the tip: right-click the shortcut →
  **Add to Steam**. This is the *safe* path — Steam does its own
  shortcuts.vdf write, so it can't corrupt the library.
- Windows `.lnk` creation passes paths via environment variables, never
  interpolated into the PowerShell command (no injection).
- Direct programmatic "Add to Steam" (writing shortcuts.vdf) is deliberately
  NOT here — deferred pending the library-wipe test.

## Stage 2: downloads & extraction

- **Streaming downloads** with real-time progress on the card and in the
  detail dialog, plus cancel (partial files cleaned up)
- **Extract-while-downloading** for zips on auto-extract platforms: each
  network chunk is written to the archive AND fed to a streaming extractor,
  so the game is installed the moment the download finishes. Falls back to
  the bundled 7za automatically if a zip can't be streamed.
- **Bundled 7za** (7zip-bin) for .7z and fallback extraction — no system
  7-Zip install needed on any OS. Extraction progress parsed from 7za.
- **Platform Folders** settings (Settings → Platform Folders): per-platform
  download folder, auto-extract toggle, install path, native folder picker,
  auto-fill from RomM fs_slug, optional archive staging folder
- **Download tracking**: green badge on downloaded games, delete-from-disk
  with confirmation, guard that refuses to delete configured root folders
- **Filesystem sync** on platform open: adopts files/folders already on disk
  that match library games, drops records for files deleted externally
- Clear error for zero-byte roms (the server library has a few)

## Stage 1: library browser

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
