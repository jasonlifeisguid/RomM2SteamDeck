'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeBaseUrl, slimRom } = require('../dist/romm.js');

test('normalizeBaseUrl strips trailing slashes and /api', () => {
  assert.equal(normalizeBaseUrl('https://romm.example.com/'), 'https://romm.example.com');
  assert.equal(normalizeBaseUrl('https://romm.example.com/api'), 'https://romm.example.com');
  assert.equal(normalizeBaseUrl('  https://romm.example.com/api/  '), 'https://romm.example.com');
  assert.equal(normalizeBaseUrl('http://10.0.0.5:8998'), 'http://10.0.0.5:8998');
});

// A rom shaped like RomM's SimpleRomSchema, with the fat fields present.
function fatRom() {
  return {
    id: 42, igdb_id: 1, moby_id: 2, platform_id: 7, platform_slug: 'arcade',
    fs_name: 'daytona.zip', fs_name_no_ext: 'daytona', fs_path: 'roms/arcade', fs_size_bytes: 12345,
    name: 'Daytona USA', slug: 'daytona-usa', summary: 'Racing.',
    metadatum: { first_release_date: 763862400, genres: ['Racing'], average_rating: 88.2, companies: ['Sega'], player_count: '2', extra: 'x' },
    igdb_metadata: { total_rating: '88', huge: 'x'.repeat(2000) },
    moby_metadata: {}, ss_metadata: {}, files: [{ id: 1 }], siblings: [{ id: 43 }], rom_user: { note: 'y' },
    path_cover_small: '/assets/romm/resources/roms/7/42/cover/small.jpg',
    path_cover_large: '/assets/romm/resources/roms/7/42/cover/big.jpg',
    merged_screenshots: ['/assets/s1.jpg', '/assets/s2.jpg'],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    crc_hash: 'abc', md5_hash: 'def',
  };
}

test('slimRom keeps only the fields the app reads', () => {
  const slim = slimRom(fatRom());
  assert.deepEqual(slim, {
    id: 42, name: 'Daytona USA', platform_id: 7, fs_name: 'daytona.zip', fs_size_bytes: 12345,
    path_cover_small: '/assets/romm/resources/roms/7/42/cover/small.jpg',
    path_cover_large: '/assets/romm/resources/roms/7/42/cover/big.jpg',
    summary: 'Racing.',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    merged_screenshots: ['/assets/s1.jpg', '/assets/s2.jpg'],
    metadatum: { first_release_date: 763862400, genres: ['Racing'], average_rating: 88.2, companies: ['Sega'], player_count: '2' },
  });
  assert.equal('igdb_metadata' in slim, false);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(fatRom()).length / 2);
});

test('slimRom is idempotent (safe over already-slim cached data)', () => {
  const once = slimRom(fatRom());
  assert.deepEqual(slimRom(once), once);
});

test('slimRom tolerates missing/odd fields', () => {
  const slim = slimRom({ id: '9', platform_id: '3', fs_name: 'x.bin', fs_size_bytes: null, metadatum: null, merged_screenshots: 'nope' });
  assert.deepEqual(slim, { id: 9, name: '', platform_id: 3, fs_name: 'x.bin', fs_size_bytes: 0 });
});
