/**
 * Early language bootstrap, loaded synchronously in <head> on every page.
 * Kept as an external file so the Content-Security-Policy can forbid inline scripts.
 */
(function() {
    try {
        // Get saved language or detect from browser
        let lang = localStorage.getItem('preferred-language');
        if (!lang) {
            const browserLang = (navigator.language || navigator.userLanguage || 'en').split('-')[0].toLowerCase();
            const supported = ['en', 'fr', 'es', 'de', 'it', 'pt'];
            lang = supported.includes(browserLang) ? browserLang : 'en';
        }
        // Apply language immediately to prevent flicker
        document.documentElement.lang = lang;

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
