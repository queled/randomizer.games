(function () {
  const SITE_URL = (window.location.origin && /^https?:\/\//.test(window.location.origin))
    ? window.location.origin
    : 'https://randomizer.games';

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

  function getCanonicalPath() {
    const path = window.location.pathname || '/';
    const params = new URLSearchParams(window.location.search || '');
    const id = params.get('id');
    if (id && /-(detail)?\.html$/.test(path)) {
      return `${path}?id=${encodeURIComponent(id)}`;
    }
    return path;
  }

  function applySeo() {
    const path = window.location.pathname || '/';
    const config = pageMeta[path] || pageMeta['/'];

    if (!document.title || document.title.trim() === '') {
      document.title = config.title;
    }

    const canonicalUrl = `${SITE_URL}${getCanonicalPath()}`;
    const description = config.description;

    ensureMetaByName('description', description);
    ensureMetaByName('robots', path === '/search.html' ? 'noindex,follow' : 'index,follow');
    ensureCanonical(canonicalUrl);

    ensureMetaByProperty('og:type', 'website');
    ensureMetaByProperty('og:site_name', 'Randomizer');
    ensureMetaByProperty('og:title', document.title || config.title);
    ensureMetaByProperty('og:description', description);
    ensureMetaByProperty('og:url', canonicalUrl);

    ensureMetaByName('twitter:card', 'summary');
    ensureMetaByName('twitter:title', document.title || config.title);
    ensureMetaByName('twitter:description', description);
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
})();