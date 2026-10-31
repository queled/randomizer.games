// Public page addresses: /games/hk instead of /game-detail.html?id=hk, with an
// optional language prefix (/fr/games/hk). English has no prefix.
// public/js/site-urls.js reads the same addresses in the browser.

const LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt'];
const PREFIXED_LANGUAGES = LANGUAGES.filter((lang) => lang !== 'en');

const LIST_PAGES = ['games', 'races', 'tournaments', 'players', 'streams', 'resources', 'about', 'terms', 'search', 'compare-players'];
// First path segment of a detail page, and its template
const DETAIL_PAGES = {
  games: 'game-detail',
  tournaments: 'tournament-detail',
  races: 'race-detail',
  players: 'player-detail'
};
const DETAIL_SEGMENT = Object.fromEntries(Object.entries(DETAIL_PAGES).map(([segment, file]) => [file, segment]));

const LANGUAGE_PREFIX = new RegExp(`^/(${PREFIXED_LANGUAGES.join('|')})(?=/|$)`);

// "/fr/games/hk" -> { lang: 'fr', path: '/games/hk' }
function splitLanguage(pathname) {
  const match = String(pathname || '/').match(LANGUAGE_PREFIX);
  if (!match) return { lang: 'en', path: pathname || '/' };
  return { lang: match[1], path: pathname.slice(match[0].length) || '/' };
}

// The address of a page in a language: "/games/hk" -> "/fr/games/hk", "/" -> "/fr/"
function localizedPath(lang, path) {
  if (!lang || lang === 'en') return path;
  return `/${lang}${path === '/' ? '/' : path}`;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The page behind a public address, or null when there is none:
 * { lang, file: '/game-detail.html', params: { id: 'hk' }, path: '/games/hk' }
 * `redirect` is set instead when the address has a single preferred spelling
 * (no trailing slash, "/fr/" for the French home page).
 */
function parseSitePath(pathname) {
  const { lang, path } = splitLanguage(pathname);
  if (path === '/') {
    // "/fr" -> "/fr/"
    if (lang !== 'en' && !String(pathname).endsWith('/')) return { redirect: localizedPath(lang, '/') };
    return { lang, file: '/index.html', params: {}, path: '/' };
  }
  // Only a site page loses its trailing slash: a real folder such as /admin/
  // is left to the static server, which redirects "/admin" to "/admin/"
  if (path.endsWith('/')) {
    const target = localizedPath(lang, path.replace(/\/+$/, ''));
    const route = parseSitePath(target);
    return route && !route.redirect ? { redirect: target } : null;
  }

  const segments = path.slice(1).split('/').map(decodeSegment);
  if (segments.some((segment) => !segment)) return null;
  const [first, second, third] = segments;

  if (segments.length === 1 && LIST_PAGES.includes(first)) {
    return { lang, file: `/${first}.html`, params: {}, path };
  }
  if (!DETAIL_PAGES[first]) return null;
  const file = `/${DETAIL_PAGES[first]}.html`;
  if (segments.length === 2) return { lang, file, params: { id: second }, path };
  // A player known by name only (no racetime account)
  if (first === 'players' && second === 'name' && segments.length === 3) {
    return { lang, file, params: { name: third }, path };
  }
  return null;
}

function withQuery(path, query, skip = []) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (skip.includes(key)) continue;
    for (const item of [].concat(value)) params.append(key, String(item));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Where an old address (/game-detail.html?id=hk, /games.html) now lives, or
 * null when it is not one. A race known by its racetime address needs a
 * database lookup: { raceUrl } is returned for the caller to resolve.
 */
function legacyTarget(pathname, query = {}) {
  const match = String(pathname || '').match(/^\/([a-z-]+)\.html$/);
  if (!match) return null;
  const page = match[1];
  if (page === 'index') return { path: withQuery('/', query) };
  if (LIST_PAGES.includes(page)) return { path: withQuery(`/${page}`, query) };

  const segment = DETAIL_SEGMENT[page];
  if (!segment) return null;
  const id = typeof query.id === 'string' ? query.id.trim() : '';
  const name = typeof query.name === 'string' ? query.name.trim() : '';
  if (id) return { path: withQuery(`/${segment}/${encodeURIComponent(id)}`, query, ['id', 'name', 'url']) };
  if (page === 'player-detail' && name) {
    return { path: withQuery(`/players/name/${encodeURIComponent(name)}`, query, ['id', 'name', 'url']) };
  }
  if (page === 'race-detail' && typeof query.url === 'string' && query.url.trim()) {
    return { raceUrl: query.url.trim(), rest: (racePath) => withQuery(racePath, query, ['id', 'name', 'url']) };
  }
  return { path: withQuery(`/${segment}`, query, ['id', 'name', 'url']) };
}

module.exports = {
  LANGUAGES,
  PREFIXED_LANGUAGES,
  LIST_PAGES,
  DETAIL_PAGES,
  splitLanguage,
  localizedPath,
  parseSitePath,
  legacyTarget
};
