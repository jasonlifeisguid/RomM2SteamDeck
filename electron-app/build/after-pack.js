/**
 * electron-builder afterPack hook.
 *
 * The bundled 7za binaries ship without the execute bit on some systems, and
 * an AppImage is a read-only squashfs — so the exec bit must be set now, in
 * the packed app dir, before the distributable is assembled. Windows doesn't
 * use exec bits, so it's skipped there.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return;

  const base = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '7zip-bin'
  );
  if (!fs.existsSync(base)) return;

  const markExecutable = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) markExecutable(p);
      else if (entry.name === '7za' || entry.name === '7zz') fs.chmodSync(p, 0o755);
    }
  };
  markExecutable(base);
  console.log('  • afterPack: marked bundled 7za binaries executable');
};
