# Bundled 7-Zip

R2SD unpacks game archives and save backups with 7-Zip. These are the
official binaries, unmodified, from Igor Pavlov's release on GitHub:
https://github.com/ip7z/7zip/releases/tag/26.03 (published 2026-09-04).

| File | From release asset | Asset SHA-256 (as published by GitHub) |
|---|---|---|
| `win-x64/7za.exe` | `7z2603-extra.7z` → `x64/7za.exe` | `191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f` |
| `linux-x64/7zz` | `7z2603-linux-x64.tar.xz` → `7zzs` (the static build, so it runs regardless of the distro's glibc) | `dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695` |
| `mac/7zz` | `7z2603-mac.tar.xz` → `7zz` (universal) | `5ca87677072c59f5602e5c49baa27d4694bacd2259b4e507f0094249d4281480` |

SHA-256 of the files as committed here:

```
edbee35370e14030e4c785cf88200f42dc651c1eb4217c1e3963c38a12f099b0  win-x64/7za.exe
eab4c8d7f193e3d6d3237370bbcaa879a160a3f1dc82202207e27baeab79b6ac  linux-x64/7zz
74b0910e50ea44d9760a57fada2192cfd530ba8bffbe7b47c412a464b796cabf  mac/7zz
```

Each platform build ships only its own binary (`extraResources` in
package.json → `resources/7zip/`). `src/sevenzip.ts` finds it there, or here
when running from source. `test/sevenzip.test.js` checks the binary for the
current platform runs and reports the expected version.

License: `License.txt` (GNU LGPL, plus the unRAR restriction for the RAR
decoder in the Linux/macOS `7zz` builds). Source: https://7-zip.org

## Updating

1. Download the three assets above for the new version from
   https://github.com/ip7z/7zip/releases and check each file's SHA-256 against
   the `digest` GitHub publishes for it
   (`curl -s https://api.github.com/repos/ip7z/7zip/releases/latest`).
2. Replace the binaries and `License.txt`, and update the tables here and
   `EXPECTED_VERSION` in `test/sevenzip.test.js`.
3. `npm test` on Windows and in the Linux build container.
