'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { safeJoin, sanitizeFolderName, sanitizeForMatch, isInsideFolder } = require('../dist/fsutil.js');

const root = path.resolve(process.platform === 'win32' ? 'C:\\Games\\install' : '/games/install');

test('safeJoin keeps normal entries inside the destination', () => {
  assert.equal(safeJoin(root, 'Game/data/file.bin'), path.join(root, 'Game', 'data', 'file.bin'));
  assert.equal(safeJoin(root, 'top.exe'), path.join(root, 'top.exe'));
});

test('safeJoin accepts backslash entries (Windows-made zips)', () => {
  assert.equal(safeJoin(root, 'Game\\bin\\x.exe'), path.join(root, 'Game', 'bin', 'x.exe'));
});

test('safeJoin rejects zip-slip traversal', () => {
  assert.equal(safeJoin(root, '../evil.exe'), null);
  assert.equal(safeJoin(root, 'a/../../evil.exe'), null);
  assert.equal(safeJoin(root, '..\\evil.exe'), null);
});

test('safeJoin rejects absolute entry paths that escape the root', () => {
  const abs = process.platform === 'win32' ? 'D:\\other\\x.exe' : '/etc/passwd';
  assert.equal(safeJoin(root, abs), null);
});

test('safeJoin rejects a sibling with a shared prefix (install vs install2)', () => {
  assert.equal(safeJoin(root, `../${path.basename(root)}2/x`), null);
});

test('sanitizeFolderName strips reserved characters and trailing dots', () => {
  assert.equal(sanitizeFolderName('Half-Life 2: Episode One'), 'Half-Life 2 Episode One');
  assert.equal(sanitizeFolderName('What?/Where*"<>|'), 'WhatWhere');
  assert.equal(sanitizeFolderName('Trailing dots...'), 'Trailing dots');
  assert.equal(sanitizeFolderName('  spaced   out  '), 'spaced out');
  assert.equal(sanitizeFolderName('???'), 'Game');
});

test('sanitizeForMatch normalizes to lowercase alphanumerics', () => {
  assert.equal(sanitizeForMatch('Sonic & Knuckles (USA)'), 'sonic  knuckles usa');
  assert.equal(sanitizeForMatch(sanitizeForMatch('X-Men')), sanitizeForMatch('X-Men'));
});

test('isInsideFolder', () => {
  assert.equal(isInsideFolder(root, root), true);
  assert.equal(isInsideFolder(root, path.join(root, 'a', 'b.exe')), true);
  assert.equal(isInsideFolder(root, path.join(root, '..', 'x.exe')), false);
  assert.equal(isInsideFolder(root, root + '2'), false);
});
