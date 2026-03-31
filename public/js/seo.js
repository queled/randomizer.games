(function () {
  const SITE_URL = (window.location.origin && /^https?:\/\//.test(window.location.origin))
    ? window.location.origin
    : 'https://randomizer.games';
  const DEFAULT_SOCIAL_IMAGE = `${SITE_URL}/assets/favicon.png`;

  const pageMeta = {
    '/': {
      title: 'Randomizer',
      description: 'Randomizer games, races, tournaments and players in one place.'
    },
    '/index.html': {
      title: 'Randomizer',
      description: 'Randomizer games, races, tournaments and players in one place.'
    },
    '/games.html': {
      title: 'Games - Randomizer',
      description: 'Browse randomizer games and explore related race activity.'
    },
    '/game-detail.html': {
      title: 'Game - Randomizer',
      description: 'Game details, linked races and tournament context.'
    },
    '/races.html': {
      title: 'Races - Randomizer',
      description: 'Explore recent and historical randomizer races.'
    },
    '/race-detail.html': {
      title: 'Race - Randomizer',
      description: 'Race details, standings and related tournament information.'
    },
    '/tournaments.html': {
      title: 'Tournaments - Randomizer',
      description: 'Browse randomizer tournaments and connected events.'
    },
    '/tournament-detail.html': {
      title: 'Tournament - Randomizer',
      description: 'Tournament details, brackets and linked races.'
    },
    '/players.html': {
      title: 'Players - Randomizer',
      description: 'Discover players, aliases and race participation history.'
    },
    '/player-detail.html': {
      title: 'Player Profile - Randomizer',
      description: 'Player profile with results, aliases and game activity.'
    },
    '/compare-players.html': {
      title: 'Compare Players - Randomizer',
      description: 'Compare head-to-head randomizer player results and shared race history.'
    },
    '/streams.html': {
      title: 'Streams - Randomizer',
      description: 'Live and recent randomizer streams by game and category.'
    },
    '/search.html': {
      title: 'Search - Randomizer',
      description: 'Search games, races, tournaments and players.'
    },
    '/resources.html': {
      title: 'Related Sites - Randomizer',
      description: 'Useful links and community resources for randomizer players.'
    },
    '/about.html': {
      title: 'About - Randomizer',
      description: 'About Randomizer and how the data is collected and displayed.'
    },
    '/terms.html': {
      title: 'Terms of Use - Randomizer',
      description: 'Terms of use and legal information for the Randomizer website.'
    }
  };

  function ensureMetaByName(name, content) {
    if (!content) return;
    let meta = document.querySelector(`meta[name="${name}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', name);
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', content);
  }

  function ensureMetaByProperty(property, content) {
    if (!content) return;
    let meta = document.querySelector(`meta[property="${property}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('property', property);
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', content);
  }

  function ensureCanonical(href) {
    if (!href) return;
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('rel', 'canonical');
      document.head.appendChild(link);
    }
    link.setAttribute('href', href);
  }

  function ensureStructuredData(data) {
    let script = document.getElementById('seo-structured-data');

    if (!data || (Array.isArray(data) && data.length === 0)) {
      if (script) script.remove();
      return;
    }

    if (!script) {
      script = document.createElement('script');
      script.id = 'seo-structured-data';
      script.type = 'application/ld+json';
      document.head.appendChild(script);
    }

    script.textContent = JSON.stringify(data);
  }

  function normalizeDescription(text, maxLength = 160) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;

    const clipped = normalized.slice(0, maxLength - 1);
    const boundary = clipped.lastIndexOf(' ');
    const safeClip = boundary > 100 ? clipped.slice(0, boundary) : clipped;
    return `${safeClip.trim()}...`;
  }

  function buildAbsoluteUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';

    try {
      const resolved = new URL(raw, SITE_URL);
      if (!/^https?:$/i.test(resolved.protocol)) return '';
      return resolved.href;
    } catch {
      return '';
    }
  }

  function buildCanonicalUrl({ path, id, name, url } = {}) {
    const pathname = path || window.location.pathname || '/';
    const params = new URLSearchParams();

    if (/\/game-detail\.html$/.test(pathname) || /\/tournament-detail\.html$/.test(pathname)) {
      if (id) params.set('id', id);
    } else if (/\/player-detail\.html$/.test(pathname)) {
      if (id) params.set('id', id);
      else if (name) params.set('name', name);
    } else if (/\/race-detail\.html$/.test(pathname)) {
      if (id) params.set('id', id);
      else if (url) params.set('url', url);
    }

    const query = params.toString();
    return `${SITE_URL}${pathname}${query ? `?${query}` : ''}`;
  }

  function buildBreadcrumbList(items) {
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: (items || []).map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: buildAbsoluteUrl(item.url || item.item)
      }))
    };
  }

  function buildWebsiteSchema() {
    return {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Randomizer',
      url: SITE_URL,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${SITE_URL}/search.html?q={search_term_string}`,
        'query-input': 'required name=search_term_string'
      }
    };
  }

  function getCanonicalPath() {
    const path = window.location.pathname || '/';
    const params = new URLSearchParams(window.location.search || '');
    const id = params.get('id');
    const name = params.get('name');
    const url = params.get('url');

    if (/\/game-detail\.html$/.test(path) || /\/tournament-detail\.html$/.test(path)) {
      if (id) return `${path}?id=${encodeURIComponent(id)}`;
    }

    if (/\/player-detail\.html$/.test(path)) {
      if (id) return `${path}?id=${encodeURIComponent(id)}`;
      if (name) return `${path}?name=${encodeURIComponent(name)}`;
    }

    if (/\/race-detail\.html$/.test(path)) {
      if (id) return `${path}?id=${encodeURIComponent(id)}`;
      if (url) return `${path}?url=${encodeURIComponent(url)}`;
    }

    return path;
  }

  function updatePage(options = {}) {
    const path = options.path || window.location.pathname || '/';
    const config = pageMeta[path] || pageMeta['/'];
    const title = options.title || document.title || config.title;
    const description = normalizeDescription(options.description || config.description);
    const canonicalUrl = options.canonicalUrl || buildCanonicalUrl({
      path,
      id: options.canonicalParams?.id,
      name: options.canonicalParams?.name,
      url: options.canonicalParams?.url
    });
    const image = buildAbsoluteUrl(options.image) || DEFAULT_SOCIAL_IMAGE;
    const robots = options.robots || ((path === '/search.html' || path === '/compare-players.html') ? 'noindex,follow' : 'index,follow');
    const ogType = options.ogType || 'website';
    const twitterCard = options.twitterCard || 'summary_large_image';

    document.title = title;

    ensureMetaByName('description', description);
    ensureMetaByName('robots', robots);
    ensureCanonical(canonicalUrl);

    ensureMetaByProperty('og:type', ogType);
    ensureMetaByProperty('og:site_name', 'Randomizer');
    ensureMetaByProperty('og:title', title);
    ensureMetaByProperty('og:description', description);
    ensureMetaByProperty('og:url', canonicalUrl);
    ensureMetaByProperty('og:image', image);
    ensureMetaByProperty('og:image:alt', title);

    ensureMetaByName('twitter:card', twitterCard);
    ensureMetaByName('twitter:title', title);
    ensureMetaByName('twitter:description', description);
    ensureMetaByName('twitter:image', image);

    if (Object.prototype.hasOwnProperty.call(options, 'jsonLd')) {
      ensureStructuredData(options.jsonLd);
    }

    return { canonicalUrl, image, description, title };
  }

  function applySeo() {
    const path = window.location.pathname || '/';
    const config = pageMeta[path] || pageMeta['/'];

    updatePage({
      path,
      title: (!document.title || document.title.trim() === '') ? config.title : document.title,
      description: config.description,
      canonicalUrl: `${SITE_URL}${getCanonicalPath()}`,
      image: DEFAULT_SOCIAL_IMAGE,
      jsonLd: (path === '/' || path === '/index.html') ? buildWebsiteSchema() : null
    });
  }

  function refreshTitleMeta() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', document.title);

    const twTitle = document.querySelector('meta[name="twitter:title"]');
    if (twTitle) twTitle.setAttribute('content', document.title);
  }

  applySeo();
  document.addEventListener('DOMContentLoaded', () => {
    applySeo();
    setTimeout(refreshTitleMeta, 300);
  });

  window.RandomizerSEO = {
    siteUrl: SITE_URL,
    defaultImage: DEFAULT_SOCIAL_IMAGE,
    buildAbsoluteUrl,
    buildBreadcrumbList,
    updatePage
  };
})();