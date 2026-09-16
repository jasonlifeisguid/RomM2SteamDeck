# RomM2SteamDeck

A native desktop app for browsing and downloading games from your [RomM](https://github.com/rommapp/romm) library to your **Steam Deck**, **Windows PC**, **Linux**, or **macOS** machine. Browse your collection by platform, download on demand, auto-extract Windows games, and play them — directly through [Faugus Launcher](https://github.com/Faugus/faugus-launcher) on Linux, or by adding them to Steam. It can also add itself to your Steam library for Game Mode.

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

No dependencies to install. The AppImage uses the static runtime, so it runs on both FUSE 2 systems (SteamOS) and FUSE 3-only distros (Arch, Omarchy, CachyOS, Ubuntu 24.04+) without installing `libfuse2`. If your system has no FUSE at all, run it with `./RomM2SteamDeck.AppImage --appimage-extract-and-run`.

**Tip for updates:** keep the file named `RomM2SteamDeck.AppImage` (no version number) and just overwrite it — that way your Steam shortcut keeps working across updates.

### Windows — installer or portable

- **`RomM2SteamDeck-Setup-x.y.z.exe`** — standard installer (Start-menu shortcut, uninstaller).
- **`RomM2SteamDeck-x.y.z-portable.exe`** — single file, no install; just run it.

The builds are unsigned, so Windows SmartScreen may warn on first run — click **More info → Run anyway**.

### macOS

No pre-built DMG yet. Build it from source on a Mac (see [Building from source](#building-from-source)); the result is unsigned, so you'll right-click → **Open** the first time.

---

## First run

### 1. Connect to RomM

1. Launch the app; it opens straight to **Settings** the first time.
2. Enter:
   - **RomM Server URL** — e.g. `https://romm.example.com` (just the server; `/api` is added for you)
   - **Username** and **Password** — your RomM account
3. Click **Test Connection**, then **Save**. Your library loads.

Your password is stored locally — encrypted via the OS keychain on Windows/macOS, and with a local obfuscation on Linux (the OS keyring isn't reliable in Steam Deck Game Mode).

### 2. Set up download folders

Downloads need somewhere to go. Open **Settings → Platform Folders…** and, per platform, choose one of two modes:

- **Plain download** (most consoles): set a **Download folder**. The ROM file lands there as-is — point it at the folder your emulator or frontend already scans (e.g. `/home/deck/retrodeck/roms/snes`).
- **Extract** (Windows games, or anything shipped as an archive): tick **Extract** and set one or more **Install paths**. Archives are unpacked there, one folder per game, and the archive is removed afterwards. With more than one install path (say, internal storage and an SD card) you're asked where each game goes when you download it.

Two helpers at the top of the dialog:

- **Base folder for auto-fill** + **Auto-fill empty** — fills every empty Download folder with `<base>/<platform slug>`, which matches how RomM (and most frontends) lay out a ROM tree.
- **Staging folder for archives** — where archives download *before* extraction. Leave it empty to stage inside each install path, or set it to fast storage if your install path is on a slow SD card.

Any configured folder is protected: the app will refuse to delete it even if a game record points at it.

---

## Browsing and downloading

- **Sidebar** lists every platform that has games. Click the ☆ to pin favourites to the top.
- **Search**, **genre filter**, and **sort** (name / date added / size / release year / rating / installed first, ascending or descending) at the top; toggle between grid and list views.
- The **✓ Installed** toolbar button filters to games you have on disk — it stacks with search, genre and sort, and while it's on the sidebar counts show installed games per platform (platforms with none fade). The choice is remembered, so on the Deck it makes a handy "what can I play" view.
- Click a game for details, cover, screenshots and the download button. Right-click (or the hover buttons on a tile) for quick actions.
- Downloads run one at a time through a queue; the bar at the bottom shows progress and lets you cancel or drop queued items. Interrupted downloads **resume** where they stopped, even after restarting the app.
- The library is cached locally and refreshed in the background, so opening a platform is instant after the first load. If a background refresh fails (bad login, server down) the sidebar tells you instead of spinning forever.

### Controller navigation

Works with any gamepad, including the Deck's built-in controls: **D-pad / left stick** moves between games, **A** opens a game (or downloads it from the detail view), **B** closes dialogs. **Escape** closes dialogs on a keyboard.

---

## Playing Windows games

Windows games (RomM's *Windows* platform, or any platform you've set to **Extract**) get a **▶ Play** button once they're installed. The first press asks you to pick the game's executable; that becomes the default and later presses launch straight away. The **Add to Steam / Shortcut…** dialog is where you change the default (**★ Set Default**).

- **On Windows**, Play runs the executable directly.
- **On Linux / Steam Deck**, a Windows `.exe` needs Proton. You have two routes:

### Route A — Faugus Launcher (recommended: install once, then just press Play)

Install [Faugus Launcher](https://github.com/Faugus/faugus-launcher) as a system package, as an AppImage in `~/Applications`, or as the Flatpak. When it's present, **▶ Play** hands the `.exe` to Faugus, which runs it through UMU/Proton with your Faugus default runner. No Steam step, no per-game setup.

- **Each game gets its own prefix.** On first Play, R2SD adds the game to Faugus's library exactly as Faugus's own *Add game* dialog would — title, executable, its own prefix under `~/Faugus/<game>/`, your Faugus default runner, and the RomM cover as artwork — then launches that entry. Saves and configs stay isolated per game (see *Finding your saves* below), and the game shows up in Faugus too. Games you had already added in Faugus are reused, matched by executable. Prefer one shared prefix for everything? **Settings → Display → Prefix → Shared**.
- R2SD only adds entries while Faugus's window is closed (Faugus keeps its list in memory and would overwrite the addition on its next save). If it's open, Play runs the game in the shared prefix once and tells you.
- Turn Faugus routing off in **Settings → Display → Faugus** if you'd rather always go through Steam.

### Route B — Add to Steam (Proton via Steam)

Open the game's **Add to Steam / Shortcut…** dialog, pick the executable, and choose **Add to Steam**. Then launch it from Steam.

- **With Steam running** on SteamOS, the shortcut is added live through Valve's own `steam://addnonsteamgame` mechanism, so it works in Game Mode.
- **With Decky Loader installed**, R2SD also configures the new shortcut live through Steam's own client API: it sets the real game name, uploads the RomM cover as the library artwork, and — if you leave **Run with Proton Experimental** ticked — forces Proton for it. The confirmation toast tells you what was applied.
- **Without Decky**, Steam names the entry after the `.exe` and you set Proton by hand: select the game in Steam → **Properties → Compatibility** → **Force the use of a specific Steam Play compatibility tool** → **Proton Experimental**. The dropdown sometimes snaps back to "Steam Linux Runtime" — pick Proton again and it sticks.
- **With Steam closed**, the shortcut is written to `shortcuts.vdf` directly. This path is byte-safe: the app re-serializes your existing file, aborts if it can't reproduce it exactly, backs it up, and appends (it never regenerates the file). Deleting a game from within the app also removes its shortcut this way.
- The first launch through Proton often fails while Steam fetches the Proton runtime ("downloading content"); the second or third attempt works. That's a one-time setup per Proton version.

### Finding your saves and configs

A Windows game under Proton keeps its Documents, Saved Games and AppData inside a Wine prefix, which is hard to locate by hand. Open a downloaded game's **Folders…** (detail view or right-click) and R2SD lists the install folder plus every prefix the game can run in — Faugus's per-game prefix, Faugus's default prefix, and Steam's `compatdata` prefix — with one-click buttons for **User profile, Documents, Saved Games, AppData\Roaming, AppData\Local, AppData\LocalLow** and **Drive C:**. Only folders that exist are shown, so a game that hasn't been run yet simply says so. On Windows the same dialog opens the real user folders.

**Cloud saves through RomM.** RomM keeps saves per user and per game, versioned, and R2SD can use it as the transport between your devices. Each Linux prefix in the Folders dialog shows its RomM status (in sync, local newer, RomM newer, or both changed) with **Upload to RomM** and **Download from RomM**. Turn on **Settings → Display → Cloud saves → Auto** and R2SD does it around Play: restores a newer save from RomM before launching (or seeds a brand-new prefix from it), and uploads after the game exits if anything changed. RomM keeps the last 5 versions. If both sides changed since this device last synced, nothing is overwritten — the dialog lets you choose. Auto sync only touches a game's own prefix, never Faugus's shared `default`.

**Saves vs. settings.** Games mix per-device settings (resolution, graphics quality) into the same folders as progress, and syncing those between a Deck and a desktop breaks both — Steam Cloud has the same problem. R2SD keeps settings out by default: Unreal's `Saved/Config/` folder and `.ini` / `.cfg` files are excluded from backups and cloud sync (registry-backed settings never leave the prefix anyway). **What syncs…** on each prefix lists exactly what will be included and what was excluded and why; there's a per-game switch to include config files for the rare game that keeps progress in them, and the patterns are editable.

**Moving saves by hand.** Each Linux prefix in that dialog also has **Back up saves…** and **Restore saves…**. Back up zips the prefix's Documents, Saved Games and AppData (minus Windows temp and shell folders) into `<game> saves <date>.zip` in a folder you pick — an SD card, a NAS share, a synced folder. Restore extracts such a zip into the prefix, overwriting same-named files and leaving everything else alone. The zip only ever contains those save folders, so restoring a backup made from Faugus's shared `default` prefix into a game's own prefix is also how you migrate saves after switching to per-game prefixes.

### Desktop shortcuts

The same dialog can create a desktop shortcut for any executable (`.lnk` on Windows, `.desktop` on Linux, `.command` on macOS) if you'd rather launch from the desktop.

---

## Steam Deck / Game Mode

RomM2SteamDeck runs in Game Mode and can add itself to your Steam library:

1. In **Desktop Mode**, run the AppImage and configure RomM (above).
2. Open **Settings → Add R2SD to Steam** (works whether Steam is open or closed).
3. **Apply the overlay fix** (below) unless the app reports it did so automatically.
4. Switch to **Game Mode** — RomM2SteamDeck is in your library under *Non-Steam*.

### The Steam Overlay fix (required for Game Mode)

The Steam Overlay conflicts with Electron's startup: with it enabled, the app either hangs or takes ~45 seconds to appear in Game Mode. The fix is to stop Steam from injecting the overlay into this one shortcut, by setting its **Launch Options** to:

```
env LD_PRELOAD= %command%
```

- **With Decky Loader installed**, R2SD sets this automatically when you click **Add R2SD to Steam** and confirms with *"applied the Game Mode fix automatically"*. Nothing else to do.
- **Otherwise**, set it in Steam: select **RomM2SteamDeck** → **Properties** (the ⚙ gear) → **Launch Options**. Do it here rather than editing files — Steam owns this setting and syncs it across your devices, and it can revert direct edits to `shortcuts.vdf` (especially with the same account on more than one device). The app writes it into the file when it adds the shortcut with Steam closed, but the Properties field is the sure fix.

Once set, the app launches quickly and exits cleanly. Exit it in Game Mode with the **power button** in the top-right of the toolbar (or **Settings → Quit**). Rename it and add artwork in Steam as usual (e.g. via Decky + SteamGridDB).

### UI scale

The interface zooms to **140%** automatically on a Steam Deck — its 7" 1280×800 panel otherwise renders everything tiny. Pick any size from 100–200% in **Settings → Display → UI scale**, or use **Ctrl +** / **Ctrl −** / **Ctrl 0** (back to Auto). Desktop monitors stay at 100%.

---

## Features at a glance

- **Fast library browsing** — full library with pagination (no 500-game cap), stale-while-revalidate caching with delta sync, lazy-loaded cover art, search, genre filter, five sort orders, grid and list views, pinned platforms.
- **Downloads** — serial queue with progress, cancel, resume after interruptions, and streaming extract-while-downloading for zips; bundled 7-Zip for `.7z`. Every extracted game gets exactly one folder under the install path.
- **Multiple install paths** per platform, with a prompt to choose when more than one is configured.
- **Play** — direct on Windows; through **Faugus Launcher** on Linux; or via **Add to Steam** with live name / cover art / Proton configuration when Decky is present.
- **Folders…** — one click to a game's install folder or its Proton-side saves and configs.
- **Add to Steam** with a byte-safe `shortcuts.vdf` writer (covered by tests against a real Steam file) + desktop shortcuts.
- **Controller navigation**, **10 themes** including Steam Deck OLED orange, and **UI scaling** for the Deck's screen.
- **Cross-platform** — Steam Deck, Linux, Windows, macOS.

---

## Building from source

Requires [Node.js](https://nodejs.org/) 20+ (the test suite uses `node:test` and the built-in `fetch`/`Response`).

```bash
git clone https://github.com/jasonlifeisguid/RomM2SteamDeck.git
cd RomM2SteamDeck
npm install
npm start                 # run in dev
npm test                  # unit + integration tests (VDF parser, extraction pipeline, Faugus/prefix resolution, helpers)

npm run dist:win          # Windows: NSIS installer + portable exe (run on Windows)
npm run dist:linux        # Linux/Steam Deck: AppImage (run on Linux)
npm run dist:mac          # macOS: dmg (run on a Mac)
```

Output lands in `release/`. Each target must be built on its own OS. If you only have a Windows box, the AppImage builds fine in a Linux container:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/work/.home -v "$PWD":/work -w /work node:22-bookworm bash -c "npm ci && npm run dist:linux"
```

`scripts/publish-release.py <version> <notes.md>` creates the GitHub release and uploads the three artifacts (uses the `github.com` entry in your git credential store).

### Layout

```
src/           Electron main process — window, IPC, RomM client, config, downloads, Steam (shortcuts.vdf + live SteamClient bridge), Faugus launcher, prefix resolution, Deck detection
renderer/      UI — plain HTML/CSS/JS, no framework
scripts/       add-r2sd-to-steam.js (standalone "add R2SD to Steam" helper), publish-release.py
test/          node:test suites (run against the compiled dist/)
build/         App icons + electron-builder afterPack hook
```

App data lives in `%APPDATA%\romm2steamdeck-app` (Windows) or `~/.config/romm2steamdeck-app` (Linux/macOS): `config.json`, `downloads.json` (what's installed where), the cached library, and cover art. **Settings → Clear Cache** removes the cached library and covers; it never touches your games.

---

## Acknowledgments

- **[RomM](https://github.com/rommapp/romm)** — the excellent ROM manager and API this app is built around.
- **[Faugus Launcher](https://github.com/Faugus/faugus-launcher)** — the easy way to run Windows games on Linux; R2SD's Play button leans on it.
- **[DeckRommSync-Standalone](https://github.com/PeriBluGaming/DeckRommSync-Standalone)** by PeriBluGaming — the original inspiration for this project.

## License

RomM2SteamDeck is **source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md)**. Copyright (c) 2026 jasonlifeisguid.

- **You may** use, copy, modify, build, and share it — including your own forks — for any **noncommercial** purpose: personal use, hobby projects, education, research, nonprofits, and the like.
- **You may not** sell it, charge for it, bundle it into a paid product or service, or otherwise use it for commercial advantage. That applies to modified versions too.
- Every copy or fork must keep the `Required Notice` line from [LICENSE.md](LICENSE.md).

**Name policy.** The license covers the code only. The name **RomM2SteamDeck** and the **R2SD** mark are not licensed: forks and redistributions must use a different name and must not state or imply that they are endorsed by, affiliated with, or supported by the original author. If you find this software being sold, it is doing so without permission and without any involvement of the author — please report it.

This is not an OSI-approved open-source license (it restricts commercial use), which is why GitHub shows "Other" in the sidebar.
