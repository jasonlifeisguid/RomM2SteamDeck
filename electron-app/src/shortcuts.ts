/**
 * Desktop shortcut creation for extracted PC games.
 *
 * This is the SAFE half of the old "Add to Steam" feature: it scans an
 * installed game folder for .exe files and writes a desktop shortcut the user
 * picks. It never touches Steam's shortcuts.vdf (that's the part that wiped
 * libraries) — on Steam Deck the user right-clicks the created shortcut and
 * chooses "Add to Steam", letting Steam do its own safe VDF write.
 *
 * No electron imports here so the module is unit-testable standalone.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ExeFile {
  name: string;
  path: string;
  relativePath: string;
}

const IGNORE_DIRS = new Set(['__macosx', '.git', 'node_modules', '$recycle.bin']);

/** Recursively list .exe files under an installed game folder (or a single file). */
export function listExes(gameFolder: string): ExeFile[] {
  if (!gameFolder || !fs.existsSync(gameFolder)) return [];

  let root = gameFolder;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (root.toLowerCase().endsWith('.exe')) {
      return [{ name: path.basename(root), path: root, relativePath: path.basename(root) }];
    }
    root = path.dirname(root); // record points at a non-exe file — scan its folder
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  }

  const exes: ExeFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name.toLowerCase())) walk(path.join(dir, entry.name));
      } else if (entry.name.toLowerCase().endsWith('.exe')) {
        const full = path.join(dir, entry.name);
        exes.push({ name: entry.name, path: full, relativePath: path.relative(root, full) });
      }
    }
  };
  walk(root);

  // Shallowest first — the launcher exe is usually near the top
  exes.sort(
    (a, b) =>
      a.relativePath.split(path.sep).length - b.relativePath.split(path.sep).length ||
      a.relativePath.localeCompare(b.relativePath)
  );
  return exes;
}

export interface ShortcutResult {
  path?: string;
  error?: string;
}

function sanitizeName(name: string): string {
  return (name.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, ' ').trim()) || 'Game';
}

/** Create a desktop shortcut to an exe. Type depends on the host OS. */
export function createShortcut(exePath: string, gameName: string): ShortcutResult {
  if (!exePath || !fs.existsSync(exePath)) return { error: 'Executable not found' };
  const desktop = path.join(os.homedir(), 'Desktop');
  fs.mkdirSync(desktop, { recursive: true });
  const safeName = sanitizeName(gameName);

  try {
    if (process.platform === 'win32') {
      const shortcutPath = path.join(desktop, `${safeName}.lnk`);
      const workingDir = path.dirname(exePath);
      // Paths are passed via environment variables, never interpolated into
      // the command string — so a path containing $(...) can't execute.
      const ps =
        '$ws = New-Object -ComObject WScript.Shell;' +
        '$s = $ws.CreateShortcut($env:R2SD_SHORTCUT);' +
        '$s.TargetPath = $env:R2SD_TARGET;' +
        '$s.WorkingDirectory = $env:R2SD_WORKDIR;' +
        '$s.Save()';
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        env: { ...process.env, R2SD_SHORTCUT: shortcutPath, R2SD_TARGET: exePath, R2SD_WORKDIR: workingDir },
        windowsHide: true,
      });
      if (result.status !== 0) {
        return { error: `Shortcut creation failed: ${result.stderr?.toString().slice(0, 200) || 'unknown error'}` };
      }
      return { path: shortcutPath };
    }

    if (process.platform === 'linux') {
      const shortcutPath = path.join(desktop, `${safeName}.desktop`);
      const content =
        '[Desktop Entry]\n' +
        'Type=Application\n' +
        `Name=${gameName.replace(/\n/g, ' ')}\n` +
        `Exec="${exePath}"\n` +
        `Path=${path.dirname(exePath)}\n` +
        'Icon=application-x-executable\n' +
        'Terminal=false\n';
      fs.writeFileSync(shortcutPath, content);
      fs.chmodSync(shortcutPath, 0o755);
      return { path: shortcutPath };
    }

    if (process.platform === 'darwin') {
      const shortcutPath = path.join(desktop, `${safeName}.command`);
      fs.writeFileSync(shortcutPath, `#!/bin/bash\nopen "${exePath}"\n`);
      fs.chmodSync(shortcutPath, 0o755);
      return { path: shortcutPath };
    }

    return { error: `Unsupported platform: ${process.platform}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
