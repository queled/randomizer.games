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

test('the history is written into the page in its language, English when it has none', () => {
  const { renderHistory } = require('../services/seo-pages');
  const history = {
    intro: { en: 'Shuffles <every> item.', fr: 'Mélange chaque objet.' },
    events: [{ date: '2001', title: { en: 'First release', fr: 'Première version' }, text: { en: 'It "ships".', fr: 'Elle sort.' } }],
    sources: [{ label: 'A & B', url: 'https://example.test/a?b=1&c=2' }, { label: 'Not a link', url: 'javascript:alert(1)' }]
  };
  const french = renderHistory(history, 'fr');
  assert.match(french, /<p class="history-intro">Mélange chaque objet\.<\/p>/);
  assert.match(french, /<h3 class="history-title">Première version<\/h3>/);
  assert.match(french, /<a href="https:\/\/example\.test\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">A &amp; B<\/a>/);
  assert.doesNotMatch(french, /javascript:/);

  const german = renderHistory(history, 'de');
  assert.match(german, /Shuffles &lt;every&gt; item\./);
  assert.match(german, /It &quot;ships&quot;\./);
  assert.match(german, /<h3 class="history-sources-title">Quellen<\/h3>/);

  assert.equal(renderHistory(null, 'en'), '');
  assert.doesNotMatch(renderHistory({ intro: 'Plain text', events: [] }, 'en'), /history-sources/);
});
