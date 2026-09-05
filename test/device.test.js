'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { isSteamDeck, zoomForScale, stepScale, normalizeUiScale, DECK_AUTO_ZOOM } = require('../dist/device.js');

test('isSteamDeck recognizes both Deck models from DMI', () => {
  assert.equal(isSteamDeck(() => 'Jupiter\n', 'linux'), true);
  assert.equal(isSteamDeck(() => 'Galileo', 'linux'), true);
  assert.equal(isSteamDeck(() => 'galileo', 'linux'), true);
});

test('isSteamDeck is false for other Linux boxes, unreadable DMI, and other OSes', () => {
  assert.equal(isSteamDeck(() => 'Standard PC (Q35 + ICH9, 2009)', 'linux'), false);
  assert.equal(isSteamDeck(() => { throw new Error('ENOENT'); }, 'linux'), false);
  assert.equal(isSteamDeck(() => 'Jupiter', 'win32'), false);
  assert.equal(isSteamDeck(() => 'Jupiter', 'darwin'), false);
});

test('zoomForScale: auto is 1.0 on desktops and the Deck default on a Deck', () => {
  assert.equal(zoomForScale('auto', false), 1);
  assert.equal(zoomForScale('auto', true), DECK_AUTO_ZOOM);
  assert.equal(zoomForScale('150', true), 1.5);
  assert.equal(zoomForScale('100', true), 1);
});

test('normalizeUiScale falls back to auto for junk', () => {
  assert.equal(normalizeUiScale('150'), '150');
  assert.equal(normalizeUiScale('999'), 'auto');
  assert.equal(normalizeUiScale(undefined), 'auto');
});

test('stepScale moves to the next explicit step and clamps at the ends', () => {
  assert.equal(stepScale(1.0, 1), '125');
  assert.equal(stepScale(1.4, 1), '150');   // from the Deck auto zoom
  assert.equal(stepScale(1.4, -1), '125');
  assert.equal(stepScale(2.0, 1), '200');
  assert.equal(stepScale(1.0, -1), '100');
  assert.equal(stepScale(1.25, -1), '100');
});
