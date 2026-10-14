(function () {
  const SITE_URL = (window.location.origin && /^https?:\/\//.test(window.location.origin))
    ? window.location.origin
    : 'https://randomizer.games';
  const DEFAULT_SOCIAL_IMAGE = `${SITE_URL}/assets/icon-512.png`;

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

  function currentMetaContent(name) {
    const meta = document.querySelector(`meta[name="${name}"]`);
    return meta ? meta.getAttribute('content') : '';
  }

  function updatePage(options = {}) {
    const path = options.path || window.location.pathname || '/';
    const title = options.title || document.title;

    // The server rendered this entity's description, canonical, social and
    // JSON-LD tags (services/seo-pages.js): crawlers must see that single
    // version. Only the visible title follows the page language.
    if (document.documentElement.getAttribute('data-seo-ssr') === '1') {
      document.title = title;
      if (options.title) {
        const titleEl = document.querySelector('title[data-i18n-page-title]');
        if (titleEl) titleEl.removeAttribute('data-i18n-page-title');
      }
      return { title };
    }

    const description = normalizeDescription(options.description || currentMetaContent('description'));
    const canonicalUrl = options.canonicalUrl || buildCanonicalUrl({
      path,
      id: options.canonicalParams?.id,
      name: options.canonicalParams?.name,
      url: options.canonicalParams?.url
    });
    const image = buildAbsoluteUrl(options.image) || DEFAULT_SOCIAL_IMAGE;
    const robots = options.robots || currentMetaContent('robots') || 'index,follow';
    const ogType = options.ogType || 'website';
    // Images are small square artwork or the logo: a large card would crop them.
    const twitterCard = options.twitterCard || 'summary';

    document.title = title;
    // A page-specific title (player, race...) must not be replaced by the generic translated one
    if (options.title) {
      const titleEl = document.querySelector('title[data-i18n-page-title]');
      if (titleEl) titleEl.removeAttribute('data-i18n-page-title');
    }

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

  function refreshTitleMeta() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', document.title);

    const twTitle = document.querySelector('meta[name="twitter:title"]');
    if (twTitle) twTitle.setAttribute('content', document.title);
  }

  // The head tags come from the server; the social titles follow the translated title
  document.addEventListener('DOMContentLoaded', () => {
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