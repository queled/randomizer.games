// Seed hash icons: shows the icons of a seed hash (HashGoldScale HashSlingshot...,
// (Shield/Map/Ice Rod/...)) in place of their names in a race info.
// The icons come from racetime.gg (scripts/sync-hash-icons.js).
(function () {
  const MANIFEST_URL = '/data/hash-icons.json';
  // Between the items of a hash: "A B", "(A/B)", "A - B", ["A", "B"]
  const SEPARATOR = '[\\s,/;|_\\-–\\[\\]"]+';
  // A hash shows several items: shorter runs are left as text. Emotes named
  // HashX / NoteX can't be anything else, plain names (Map, Bow) can.
  const MIN_RUN = 4;
  const MIN_RUN_PREFIXED = 3;

  let manifestPromise = null;
  const matchers = {};

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function load() {
    if (!manifestPromise) {
      manifestPromise = fetch(MANIFEST_URL)
        .then((res) => (res.ok ? res.json() : {}))
        .catch(() => ({}));
    }
    return manifestPromise;
  }

  function buildMatcher(gameId, entry) {
    // lower-cased name or alias -> emote name
    const lookup = {};
    for (const name of Object.keys(entry.icons || {})) lookup[name.toLowerCase()] = name;
    for (const [alias, name] of Object.entries(entry.aliases || {})) {
      if (entry.icons[name]) lookup[alias.toLowerCase()] = name;
    }
    const words = Object.keys(lookup)
      .sort((a, b) => b.length - a.length)
      .map((w) => escapeRegex(w).replace(/ /g, '\\s+'));
    if (!words.length) return null;
    const token = `(?:${words.join('|')})(?![A-Za-z0-9])`;
    return {
      gameId,
      icons: entry.icons,
      lookup,
      run: new RegExp(`(?<![A-Za-z0-9])${token}(?:${SEPARATOR}${token})+`, 'gi'),
      token: new RegExp(token, 'gi')
    };
  }

  // The manifest lists the icons by game id, each with its racetime.gg categories
  function getMatcher(manifest, category) {
    const slug = String(category || '').toLowerCase();
    const gameId = Object.keys(manifest).find((id) => (manifest[id].categories || []).includes(slug));
    if (!gameId) return null;
    if (!(gameId in matchers)) matchers[gameId] = buildMatcher(gameId, manifest[gameId]);
    return matchers[gameId];
  }

  function renderRun(matcher, text) {
    const names = (text.match(matcher.token) || [])
      .map((word) => matcher.lookup[word.toLowerCase().replace(/\s+/g, ' ')]);
    if (names.some((name) => !name)) return null;
    const prefixed = names.some((name) => /^(Hash|Note)[A-Z]/.test(name));
    if (names.length < (prefixed ? MIN_RUN_PREFIXED : MIN_RUN)) return null;
    const base = '/assets/hash/' + encodeURIComponent(matcher.gameId) + '/';
    const imgs = names.map((name) => {
      const label = escapeHtml(name.replace(/^(Hash|Note)(?=[A-Z])/, ''));
      return `<img class="hash-icon" src="${base}${encodeURIComponent(matcher.icons[name])}" alt="${label}" title="${label}" loading="lazy" decoding="async">`;
    });
    return `<span class="hash-icons" role="img" aria-label="${escapeHtml(names.join(' '))}">${imgs.join('')}</span>`;
  }

  // Escaped HTML of a plain text with its hash runs as icons. `manifest` is the
  // loaded manifest; without it, the text is only escaped.
  function toHtml(text, category, manifest) {
    const str = String(text || '');
    const matcher = manifest ? getMatcher(manifest, category) : null;
    if (!matcher) return escapeHtml(str);
    let html = '';
    let last = 0;
    matcher.run.lastIndex = 0;
    let m;
    while ((m = matcher.run.exec(str))) {
      const icons = renderRun(matcher, m[0]);
      if (!icons) continue;
      html += escapeHtml(str.slice(last, m.index)) + icons;
      last = m.index + m[0].length;
    }
    return html + escapeHtml(str.slice(last));
  }

  window.HashIcons = { load, toHtml };
})();
