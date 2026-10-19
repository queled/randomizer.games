// Seed hash icons: shows the icons of a seed hash (HashGoldScale HashSlingshot...,
// (Shield/Map/Ice Rod/...), Hash: ATOMIC VIOLA YARD COVERN) in place of their
// names in a race info. The icons come from racetime.gg and data/hash-sets
// (scripts/sync-hash-icons.js); a hash word without an image stays as text.
(function () {
  const MANIFEST_URL = '/data/hash-icons.json';
  // Between the items of a hash: "A B", "(A/B)", "A - B", ["A", "B"], "(A) (B)", "{a}{b}"
  const SEPARATOR = '[\\s,/;|_\\-–\\[\\]"(){}]+';
  // A hash shows several items: shorter runs are left as text. Emotes named
  // HashX / NoteX can't be anything else, plain names (Map, Bow) can.
  const MIN_RUN = 4;
  const MIN_RUN_PREFIXED = 3;
  // Games whose hash is a few common words (names): only right after "Hash:"
  const AFTER_HASH = /hash(?:\s+(?:items?|is))?\s*[:=\-]*\s*[[("]*\s*$/i;

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
    // lower-cased name or alias -> hash word
    const lookup = {};
    for (const name of [...Object.keys(entry.icons || {}), ...(entry.words || [])]) lookup[name.toLowerCase()] = name;
    for (const [alias, name] of Object.entries(entry.aliases || {})) {
      if (lookup[name.toLowerCase()]) lookup[alias.toLowerCase()] = name;
    }
    // Names of several words also written in one (BigGreenRupee, RocsCape)
    for (const [key, name] of Object.entries(lookup)) {
      const joined = key.replace(/[\s'’.]+/g, '');
      if (joined !== key && !lookup[joined]) lookup[joined] = name;
    }
    const words = Object.keys(lookup)
      .sort((a, b) => b.length - a.length)
      .map((w) => escapeRegex(w).replace(/ /g, '\\s+'));
    if (!words.length) return null;
    const token = `(?:${words.join('|')})(?![A-Za-z0-9])`;
    return {
      gameId,
      icons: entry.icons || {},
      lookup,
      afterHash: !!entry.afterHash,
      minRun: entry.minRun || 0,
      sizes: entry.sizes || null,
      // Brackets and quotes around the run go with it: (A/B), ["A", "B"]
      run: new RegExp(`(?<![A-Za-z0-9])[([{"]*${token}(?:${SEPARATOR}${token})+[)\\]}"]*`, 'gi'),
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

  function renderRun(matcher, text, before) {
    const names = (text.match(matcher.token) || [])
      .map((word) => matcher.lookup[word.toLowerCase().replace(/\s+/g, ' ')]);
    if (names.some((name) => !name) || !names.some((name) => matcher.icons[name])) return null;
    if (matcher.afterHash && !AFTER_HASH.test(before)) return null;
    const prefixed = names.some((name) => /^(Hash|Note)[A-Z]/.test(name));
    if (names.length < (matcher.minRun || (prefixed ? MIN_RUN_PREFIXED : MIN_RUN))) return null;
    const base = '/assets/hash/' + encodeURIComponent(matcher.gameId) + '/';
    const icon = (name) => {
      const label = escapeHtml(name.replace(/^(Hash|Note)(?=[A-Z])/, ''));
      if (!matcher.icons[name]) return `<span class="hash-word">${label}</span>`;
      // "<game id>/<file>": an icon another game's list shares
      const file = matcher.icons[name];
      const src = file.includes('/') ? '/assets/hash/' + file.split('/').map(encodeURIComponent).join('/') : base + encodeURIComponent(file);
      return `<img class="hash-icon" src="${src}" alt="${label}" title="${label}" loading="lazy" decoding="async">`;
    };
    // Each word becomes its icon in place: every other character of the info stays
    let html = '';
    let last = 0;
    const re = new RegExp(matcher.token.source, 'gi');
    let m;
    while ((m = re.exec(text))) {
      html += escapeHtml(text.slice(last, m.index)) + icon(matcher.lookup[m[0].toLowerCase().replace(/\s+/g, ' ')]);
      last = m.index + m[0].length;
    }
    return `<span class="hash-icons">${html}${escapeHtml(text.slice(last))}</span>`;
  }

  // Escaped HTML of a plain text with its hash runs as icons. `manifest` is the
  // loaded manifest; without it, the text is only escaped.
  function toHtml(text, category, manifest) {
    const str = String(text || '');
    const matcher = manifest ? getMatcher(manifest, category) : null;
    if (!matcher) return escapeHtml(str);
    if (matcher.afterHash) {
      const html = hashSegmentsToHtml(matcher, str);
      return html.includes('class="hash-icons"') ? html : bareHashToHtml(matcher, str);
    }
    return runsToHtml(matcher, str, (run, before) => renderRun(matcher, run, before));
  }

  function runsToHtml(matcher, str, render) {
    let html = '';
    let last = 0;
    matcher.run.lastIndex = 0;
    let m;
    while ((m = matcher.run.exec(str))) {
      const icons = render(m[0], str.slice(0, m.index));
      if (!icons) continue;
      html += escapeHtml(str.slice(last, m.index)) + icons;
      last = m.index + m[0].length;
    }
    return html + escapeHtml(str.slice(last));
  }

  // Word hashes: every known word after "Hash:" (up to a | , a link or the line
  // end) becomes its icon, words the list doesn't know stay as they are
  function hashSegmentsToHtml(matcher, str) {
    const segment = /(hash(?:\s+(?:items?|is))?\s*[:=\-]*)([^|\n]*?)(?=\||\n|https?:\/\/|$)/gi;
    // Brackets around the words go with them: (X) (Bow) -> icons only
    const single = { ...matcher, run: new RegExp(`(?<![A-Za-z0-9])[([{"]*${matcher.token.source}(?:${SEPARATOR}${matcher.token.source})*[)\\]}"]*`, 'gi') };
    let html = '';
    let last = 0;
    let m;
    while ((m = segment.exec(str))) {
      if (!m[2].trim()) {
        if (m[0] === '') segment.lastIndex++;
        continue;
      }
      const start = m.index + m[1].length;
      const inner = runsToHtml(single, m[2], (run) => renderRun({ ...single, afterHash: false, minRun: 1 }, run, ''));
      html += escapeHtml(str.slice(last, start)) + inner;
      last = start + m[2].length;
    }
    return html + escapeHtml(str.slice(last));
  }

  // A hash written without "Hash:": a whole part of the info (between | or line
  // breaks, or after a ; or :) made only of the game's hash words, as many as a
  // hash has, at least two of them with an icon. Place names and sentences fail.
  function bareHashToHtml(matcher, str) {
    if (!matcher.sizes) return escapeHtml(str);
    const run = `[([{"]*${matcher.token.source}(?:${SEPARATOR}${matcher.token.source})*[)\\]}"]*`;
    const whole = new RegExp(`(^\\s*|[;:]\\s*)(${run})[\\s.,;]*$`, 'i');
    // A whole line first ("Map | Key | Earth..."), then each part between | of it
    return str.split(/(\n)/).map((line, i) => {
      if (i % 2) return escapeHtml(line);
      const all = renderBare(matcher, whole, line);
      return all !== null ? all : line.split(/(\|)/).map((part, j) => (j % 2 ? escapeHtml(part) : (renderBare(matcher, whole, part) ?? escapeHtml(part)))).join('');
    }).join('');
  }

  // HTML of a part that is a whole hash, else null
  function renderBare(matcher, whole, part) {
    {
      const m = whole.exec(part);
      if (!m) return null;
      const names = (m[2].match(matcher.token) || []).map((w) => matcher.lookup[w.toLowerCase().replace(/\s+/g, ' ')]);
      const icons = names.filter((n) => n && matcher.icons[n]).length;
      if (names.some((n) => !n) || !matcher.sizes.includes(names.length) || icons < 2) return null;
      const start = m.index + m[1].length;
      const rendered = renderRun({ ...matcher, afterHash: false, minRun: 1 }, m[2], '');
      return rendered ? escapeHtml(part.slice(0, start)) + rendered + escapeHtml(part.slice(start + m[2].length)) : null;
    }
  }

  window.HashIcons = { load, toHtml };
})();
