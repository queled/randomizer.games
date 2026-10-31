/**
 * Page addresses in the browser, as helpers/site-routes.js serves them:
 * /games/hk, /players/name/<name>, with an optional language prefix (/fr/games/hk).
 * Loaded in <head> before the page scripts, which read their id with SiteUrls.param().
 */
(function () {
  var PREFIX = /^\/(fr|es|de|it|pt)(?=\/|$)/;
  var DETAIL = ['games', 'tournaments', 'races', 'players'];

  var pathname = window.location.pathname || '/';
  var match = pathname.match(PREFIX);
  var lang = match ? match[1] : null;
  var path = match ? (pathname.slice(match[0].length) || '/') : pathname;

  var params = {};
  var segments = path.split('/').filter(Boolean).map(function (segment) {
    try { return decodeURIComponent(segment); } catch (e) { return segment; }
  });
  if (segments.length === 2 && DETAIL.indexOf(segments[0]) !== -1) params.id = segments[1];
  if (segments.length === 3 && segments[0] === 'players' && segments[1] === 'name') params.name = segments[2];

  // A value from the address: the path first (/games/hk), then the query string (?tab=...)
  function param(name) {
    if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
    return new URLSearchParams(window.location.search).get(name);
  }

  // The address of a page in a language: localize('/games/hk', 'fr') -> '/fr/games/hk'
  function localize(target, language) {
    var bare = String(target || '/').replace(PREFIX, '') || '/';
    if (!language || language === 'en') return bare;
    return '/' + language + (bare === '/' ? '/' : bare);
  }

  var api = { lang: lang, path: path, param: param, localize: localize, setLanguage: setLanguage };

  // Internal links of a page in another language than English keep its prefix,
  // so visitors and crawlers stay in that language
  var PAGE_LINK = /^\/(games|races|tournaments|players|streams|resources|about|terms|search|compare-players)(?=[/?#]|$)|^\/(?=[?#]|$)/;
  function prefixLink(link) {
    var href = link.getAttribute('href');
    if (!api.lang || !href || !PAGE_LINK.test(href)) return;
    link.setAttribute('href', localize(href, api.lang));
  }
  function prefixLinks(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'A') prefixLink(root);
    var links = root.querySelectorAll ? root.querySelectorAll('a[href^="/"]') : [];
    for (var i = 0; i < links.length; i++) prefixLink(links[i]);
  }
  var observer = null;
  function watchLinks() {
    if (observer || !api.lang || typeof MutationObserver === 'undefined') return;
    prefixLinks(document.documentElement);
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.type === 'attributes') prefixLinks(mutation.target);
        for (var j = 0; j < mutation.addedNodes.length; j++) prefixLinks(mutation.addedNodes[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }

  // The page shows another language: its address follows, without reloading
  function setLanguage(language) {
    api.lang = language === 'en' ? null : language;
    var target = localize(path, language) + window.location.search + window.location.hash;
    if (target !== window.location.pathname + window.location.search + window.location.hash) {
      try { window.history.replaceState(window.history.state, '', target); } catch (e) { /* file:// */ }
    }
    watchLinks();
  }

  watchLinks();
  window.SiteUrls = api;
})();
