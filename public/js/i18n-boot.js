/**
 * Early language bootstrap, loaded synchronously in <head> on every page.
 * Kept as an external file so the Content-Security-Policy can forbid inline scripts.
 */
(function() {
    function supportedLanguage(lang) {
        return ['en', 'fr', 'es', 'de', 'it', 'pt'].indexOf(lang) !== -1;
    }
    try {
        // The language of the address (/fr/...), else the saved one, else the browser's
        const urls = window.SiteUrls;
        let lang = urls && urls.lang;
        if (!lang) lang = localStorage.getItem('preferred-language');
        if (!supportedLanguage(lang)) {
            const browserLang = (navigator.language || navigator.userLanguage || 'en').split('-')[0].toLowerCase();
            lang = supportedLanguage(browserLang) ? browserLang : 'en';
        }
        // A page shown in French has the French address, to share or bookmark
        // (crawlers have no saved language: they stay on the English address)
        if (urls && !urls.lang && lang !== 'en') urls.setLanguage(lang);
        // Apply language immediately to prevent flicker
        document.documentElement.lang = lang;

        // Pages load English (the fallback); the visitor's language is added here,
        // so a visit downloads two translation files instead of six
        if (lang !== 'en' && supportedLanguage(lang)) {
            var script = document.createElement('script');
            script.src = '/js/i18n/' + lang + '.js';
            script.async = true;
            script.setAttribute('data-i18n-lang', lang);
            document.head.appendChild(script);
        }

        // Avatars used to be kept here as data URLs (megabytes); the browser cache does it now
        localStorage.removeItem('randomizer_avatar_cache');

        // Fallback: show page shortly if i18n hasn't marked it ready yet
        // This prevents blocking on slow connections while preventing flicker on fast ones
        window.__i18nShowTimeout = setTimeout(() => {
            if (document.body && !document.body.classList.contains('i18n-ready')) {
                document.body.classList.add('i18n-ready');
            }
        }, 50);
    } catch (e) {
        // Fallback to English if anything fails
        document.documentElement.lang = 'en';
        if (document.body) document.body.classList.add('i18n-ready');
    }
})();
