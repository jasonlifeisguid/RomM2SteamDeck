/**
 * electron-builder afterPack hook.
 *
 * The bundled 7-Zip (vendor/7zip → resources/7zip, see its README) can lose
 * its execute bit on the way here (a Windows checkout, a tarball), and an
 * AppImage is a read-only squashfs — so the bit must be set now, in the packed
 * app dir, before the distributable is assembled. Windows doesn't use exec
 * bits, so it's skipped there. A build without the binary is a broken build:
 * fail loudly rather than ship an app that can't extract anything.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    const exe = path.join(context.appOutDir, 'resources', '7zip', '7za.exe');
    if (!fs.existsSync(exe)) throw new Error(`afterPack: bundled 7-Zip missing at ${exe}`);
    return;
  }
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const bin = path.join(resources, '7zip', '7zz');
  if (!fs.existsSync(bin)) throw new Error(`afterPack: bundled 7-Zip missing at ${bin}`);
  fs.chmodSync(bin, 0o755);
  console.log('  • afterPack: bundled 7-Zip marked executable');
};
