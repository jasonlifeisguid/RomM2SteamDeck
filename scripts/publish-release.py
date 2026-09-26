#!/usr/bin/env python3
"""Create the GitHub release for a version and upload the built artifacts.

    python scripts/publish-release.py 2.2.15 path/to/release-notes.md

Expects the artifacts in release/ (from scripts/build-release.sh).
Idempotent: re-running skips assets already uploaded. The GitHub token is
read from git's credential store for github.com and is never printed. Asset
names match earlier releases (installer gets dashes).
"""
import json, os, subprocess, sys, urllib.request, urllib.error

if len(sys.argv) < 3:
    sys.exit(__doc__)
VERSION, NOTES = sys.argv[1], sys.argv[2]
REPO = 'jasonlifeisguid/RomM2SteamDeck'
TAG = 'v' + VERSION
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = [  # (local file, asset name on GitHub)
    (os.path.join(ROOT, 'release', f'RomM2SteamDeck Setup {VERSION}.exe'), f'RomM2SteamDeck-Setup-{VERSION}.exe'),
    (os.path.join(ROOT, 'release', f'RomM2SteamDeck-{VERSION}-portable.exe'), f'RomM2SteamDeck-{VERSION}-portable.exe'),
    (os.path.join(ROOT, 'release', 'RomM2SteamDeck.AppImage'), 'RomM2SteamDeck.AppImage'),
]
for local, _ in ASSETS:
    if not os.path.exists(local):
        sys.exit(f'missing artifact: {local}')

out = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n', capture_output=True, text=True, cwd=ROOT).stdout
token = next((l.split('=', 1)[1].strip() for l in out.splitlines() if l.startswith('password=')), None)
if not token:
    sys.exit('no github.com credential in the git credential store')
H = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}

def api(method, url, data=None, ctype='application/json', raw=None):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(url, data=body, method=method, headers={**H, 'Content-Type': ctype})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')

st, rel = api('GET', f'https://api.github.com/repos/{REPO}/releases/tags/{TAG}')
if st == 404:
    st, rel = api('POST', f'https://api.github.com/repos/{REPO}/releases', {
        'tag_name': TAG, 'name': f'RomM2SteamDeck {VERSION}', 'body': open(NOTES, encoding='utf-8').read(),
        'draft': False, 'prerelease': False, 'make_latest': 'true',
    })
    print('create release ->', st, rel.get('html_url') or rel.get('message'))
else:
    print('release exists ->', st, rel.get('html_url'))
if st not in (200, 201):
    sys.exit(1)

existing = {a['name'] for a in rel.get('assets', [])}
upload_url = rel['upload_url'].split('{')[0]
for local, name in ASSETS:
    size = os.path.getsize(local)
    if name in existing:
        print(f'  {name}: already uploaded, skipping'); continue
    with open(local, 'rb') as f:
        data = f.read()
    st, res = api('POST', f'{upload_url}?name={urllib.request.quote(name)}', raw=data, ctype='application/octet-stream')
    print(f'  upload {name} ({size/1e6:.1f} MB) -> {st} {res.get("state") or res.get("message")}')

st, rel = api('GET', f'https://api.github.com/repos/{REPO}/releases/tags/{TAG}')
print('final assets:', [(a['name'], round(a['size']/1e6, 1)) for a in rel.get('assets', [])])
print('release url:', rel.get('html_url'))
