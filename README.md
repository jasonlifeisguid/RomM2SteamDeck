# RomM2SteamDeck

A native desktop app for browsing and downloading games from your [RomM](https://github.com/rommapp/romm) library to your **Steam Deck**, **Windows PC**, **Linux**, or **macOS** machine. Browse your collection by platform, download on demand, auto-extract Windows games, and add them to Steam — including a one-click way to add RomM2SteamDeck itself to your Steam library for Game Mode.

Built with Electron. No Python, no browser, no local web server, and no system 7-Zip — everything is bundled.

> **Upgrading from the old (Python/Flask) version?** This is a full rewrite as a native app. Uninstall/ignore the old browser-based build; its data lived in `romm2steamdeck` — this app uses a separate `romm2steamdeck-app` folder, so nothing collides.

---

## Download & run

Grab the file for your system from the [**Releases**](https://github.com/jasonlifeisguid/RomM2SteamDeck/releases) page.

### Steam Deck / Linux — `RomM2SteamDeck.AppImage`

1. Download `RomM2SteamDeck.AppImage`.
2. Make it executable (once):
   ```bash
   chmod +x RomM2SteamDeck.AppImage
   ```
   (or right-click → Properties → Permissions → *Is executable*)
3. Run it — double-click, or:
   ```bash
   ./RomM2SteamDeck.AppImage
   ```

No dependencies to install. If your distro doesn't have FUSE, run it with `./RomM2SteamDeck.AppImage --appimage-extract-and-run`.

**Tip for updates:** keep the file named `RomM2SteamDeck.AppImage` (no version number) and just overwrite it — that way your Steam shortcut keeps working across updates.

### Windows — installer or portable

- **`RomM2SteamDeck Setup x.y.z.exe`** — standard installer (Start-menu shortcut, uninstaller).
- **`RomM2SteamDeck-x.y.z-portable.exe`** — single file, no install; just run it.

The builds are unsigned, so Windows SmartScreen may warn on first run — click **More info → Run anyway**.

### macOS

No pre-built DMG yet. Build it from source on a Mac (see [Building from source](#building-from-source)); the result is unsigned, so you'll right-click → **Open** the first time.

---

## First run — connect to RomM

1. Launch the app; it opens straight to **Settings** the first time.
2. Enter:
   - **RomM Server URL** — e.g. `https://romm.example.com` (just the server; `/api` is added for you)
   - **Username** and **Password** — your RomM account
3. Click **Test Connection**, then **Save**. Your library loads.

Your password is stored locally — encrypted via the OS keychain on Windows/macOS, and with a local obfuscation on Linux (the OS keyring isn't reliable in Steam Deck Game Mode).

---

## Steam Deck / Game Mode

RomM2SteamDeck runs great in Game Mode, and can add itself to your Steam library:

1. In **Desktop Mode**, run the AppImage and configure RomM (above).
2. **Fully exit Steam** (right-click the tray icon → Exit).
3. In the app, open **Settings → Add R2SD to Steam**.
4. Reopen Steam / switch to **Game Mode** — RomM2SteamDeck is now in your library under *Non-Steam*.

Adding it this way (with Steam closed) automatically **disables the Steam Overlay for this shortcut**, which is required: the overlay conflicts with Electron's startup and otherwise makes the app hang or take ~45s to appear in Game Mode. If you add it while Steam is running, do the Desktop-Mode step once afterward to apply the fix.

In Game Mode you can exit the app with the **power button** in the top-right of the toolbar (or Settings → Quit). Rename it and add artwork in Steam as usual (e.g. via Decky + SteamGridDB).

---

## Adding downloaded games to Steam

For Windows games (and any extracted game), open a downloaded game's **Add to Steam / Shortcut** dialog, pick the executable, and choose **Add to Steam**:

- Writes Steam's `shortcuts.vdf` safely — it re-serializes your existing file byte-for-byte first and aborts if it can't reproduce it exactly, backs it up, and appends (never regenerates). This is the operation that historically wiped non-Steam libraries; here it can't.
- On SteamOS with Steam running, it uses Valve's own `steam://addnonsteamgame` path so it works without closing Steam.
- Deleting a game from within the app also removes its Steam shortcut (when Steam is closed).

---

## Features

- **Fast library browsing** — full library with pagination (no 500-game cap), stale-while-revalidate caching with delta sync, lazy-loaded cover art. Search, genre filter, and sort (name / date added / size / year / rating) with ascending/descending toggle, plus grid and list views.
- **Downloads** — serial download queue with a progress bar, cancel, and streaming extract-while-downloading for zips; bundled 7-Zip for `.7z` (no system install needed).
- **Multiple install paths** per platform, with a prompt to choose the location when more than one is configured.
- **Add to Steam** (safe `shortcuts.vdf`) + desktop shortcuts (`.lnk` / `.desktop` / `.command`), set a default executable, and launch games directly.
- **10 themes** including Steam Deck OLED orange.
- **Cross-platform** — Steam Deck, Linux, Windows, macOS.

---

## Building from source

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/jasonlifeisguid/RomM2SteamDeck.git
cd RomM2SteamDeck
npm install
npm start                 # run in dev

npm run dist:win          # Windows: NSIS installer + portable exe
npm run dist:linux        # Linux/Steam Deck: AppImage (build on Linux)
npm run dist:mac          # macOS: dmg (build on a Mac)
```

Output lands in `release/`. Windows and Linux can both be built from a Windows box; the macOS DMG must be built on a Mac.

### Layout

```
src/           Electron main process (window, IPC, RomM client, config, downloads, Steam)
renderer/      UI — plain HTML/CSS/JS, no framework
scripts/       add-r2sd-to-steam.js — standalone "add R2SD to Steam" helper
build/         App icons + electron-builder afterPack hook
```

App data lives in `%APPDATA%\romm2steamdeck-app` (Windows) or `~/.config/romm2steamdeck-app` (Linux/macOS): `config.json`, cached library, and cover art.

---

## Acknowledgments

- **[RomM](https://github.com/rommapp/romm)** — the excellent ROM manager and API this app is built around.
- **[DeckRommSync-Standalone](https://github.com/PeriBluGaming/DeckRommSync-Standalone)** by PeriBluGaming — the original inspiration for this project.

## License

See [LICENSE.md](LICENSE.md).
