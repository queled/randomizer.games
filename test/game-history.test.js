const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHistory } = require('../helpers/game-history');

test('normalizeHistory keeps the layout of the hand-written files', () => {
  const history = normalizeHistory({
    intro: { en: ' An intro ', fr: 'Une intro', de: '' },
    events: [
      { date: '2005', title: { fr: 'Le jeu', en: 'The game' }, text: { fr: 'Texte', en: 'Text' } },
      { date: { en: 'May 2026', fr: 'Mai 2026', it: 'Maggio 2026' }, title: { en: 'Mod' }, text: {} }
    ],
    sources: [{ label: 'Repo', url: 'https://example.com/repo' }]
  });
  assert.deepEqual(Object.keys(history), ['intro', 'events', 'sources']);
  assert.deepEqual(history.intro, { fr: 'Une intro', en: 'An intro' });
  assert.equal(history.events[0].date, '2005');
  assert.deepEqual(Object.keys(history.events[1].date), ['fr', 'en', 'it']);
  assert.equal(history.events[1].text, undefined);
});

test('normalizeHistory drops empty events and sources', () => {
  const history = normalizeHistory({
    events: [{ date: '2001', title: {}, text: {} }, { title: { en: 'Kept' } }],
    sources: [{ label: '', url: 'https://example.com' }, { label: 'No url' }]
  });
  assert.equal(history.events.length, 1);
  assert.deepEqual(history.sources, []);
});

test('normalizeHistory refuses a history without events or with a non-web source', () => {
  assert.throws(() => normalizeHistory({ events: [] }), /at least one event/);
  assert.throws(() => normalizeHistory({
    events: [{ title: { en: 'A' } }],
    sources: [{ label: 'Bad', url: 'javascript:alert(1)' }]
  }), /Invalid source URL/);
});
