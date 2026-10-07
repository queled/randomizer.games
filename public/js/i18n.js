/**
 * i18n - Internationalization system for Randomizer
 * Provides multi-language support with dynamic text replacement
 */

// Available languages
const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt'];
const DEFAULT_LANGUAGE = 'en';

// Translation data storage
let translations = {};
let currentLanguage = DEFAULT_LANGUAGE;

/**
 * Initialize the i18n system
 * Loads the saved language preference and translations
 */
async function initI18n() {
    // Get saved language or detect from browser
    currentLanguage = getSavedLanguage() || detectBrowserLanguage() || DEFAULT_LANGUAGE;
    
    // Load all translations. The language files are async scripts, so this
    // file can run before they do: wait briefly for the ones we need.
    await loadAllTranslations();
    await waitForTranslations([currentLanguage, DEFAULT_LANGUAGE]);

    // Apply translations to the page
    applyTranslations();
    
    // Update HTML lang attribute
    document.documentElement.lang = currentLanguage;
    
    // Mark i18n as ready - this will fade in the page with CSS transition
    showPage();
    
    // Dispatch event for other scripts to react
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: currentLanguage } }));
}

/**
 * Show the page (fade in)
 */
function showPage() {
    // Cancel the timeout if it's still pending
    if (window.__i18nShowTimeout) {
        clearTimeout(window.__i18nShowTimeout);
        window.__i18nShowTimeout = null;
    }
    // Add the ready class to fade in the page
    document.body.classList.add('i18n-ready');
}

/**
 * Load all translation files
 */
async function loadAllTranslations() {
    // Since we're loading via script tags, translations are already in global scope
    // We just need to organize them
    translations = {
        en: typeof en !== 'undefined' ? en : {},
        fr: typeof fr !== 'undefined' ? fr : {},
        es: typeof es !== 'undefined' ? es : {},
        de: typeof de !== 'undefined' ? de : {},
        it: typeof it !== 'undefined' ? it : {},
        pt: typeof pt !== 'undefined' ? pt : {}
    };
}

/**
 * Wait until the given languages are loaded (polls, gives up after ~5s)
 */
async function waitForTranslations(langs) {
    const isLoaded = () => langs.every(lang => Object.keys(translations[lang] || {}).length > 0);
    for (let elapsed = 0; !isLoaded() && elapsed < 5000; elapsed += 25) {
        await new Promise(resolve => setTimeout(resolve, 25));
        await loadAllTranslations();
    }
}

/**
 * Get saved language from localStorage
 */
function getSavedLanguage() {
    try {
        const saved = localStorage.getItem('preferred-language');
        if (saved && SUPPORTED_LANGUAGES.includes(saved)) {
            return saved;
        }
    } catch (e) {
        console.warn('Could not read language preference:', e);
    }
    return null;
}

/**
 * Detect browser language
 */
function detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang) {
        const shortLang = browserLang.split('-')[0].toLowerCase();
        if (SUPPORTED_LANGUAGES.includes(shortLang)) {
            return shortLang;
        }
    }
    return null;
}

/**
 * Save language preference
 */
function saveLanguage(lang) {
    try {
        localStorage.setItem('preferred-language', lang);
    } catch (e) {
        console.warn('Could not save language preference:', e);
    }
}

/**
 * Change the current language
 */
function setLanguage(lang) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) {
        console.warn(`Language '${lang}' is not supported`);
        return;
    }
    
    currentLanguage = lang;
    saveLanguage(lang);
    
    // Update HTML lang attribute
    document.documentElement.lang = lang;
    
    // Apply translations
    applyTranslations();
    
    // Update language selector if exists
    const selector = document.getElementById('language-selector');
    if (selector) {
        selector.value = lang;
    }
    
    // Dispatch event for other scripts to react
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: lang } }));
}

/**
 * Get the current language
 */
function getLanguage() {
    return currentLanguage;
}

/**
 * Get a translation by key path (e.g., 'nav.games')
 * @param {string} key - Dot-separated key path
 * @param {object} params - Optional parameters for interpolation
 * @param {string} fallback - Optional fallback value
 */
function t(key, params = {}, fallback = null) {
    const keys = key.split('.');
    let value = translations[currentLanguage];
    
    // Navigate to the value
    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            // Try fallback to English
            value = translations[DEFAULT_LANGUAGE];
            for (const k2 of keys) {
                if (value && typeof value === 'object' && k2 in value) {
                    value = value[k2];
                } else {
                    return fallback !== null ? fallback : key;
                }
            }
            break;
        }
    }
    
    // If value is not a string, return the key
    if (typeof value !== 'string') {
        return fallback !== null ? fallback : key;
    }
    
    // Interpolate parameters
    return interpolate(value, params);
}

/**
 * Interpolate parameters into a string
 * Supports {key} and {n} for pluralization
 */
function interpolate(str, params) {
    return str.replace(/\{(\w+)\}/g, (match, key) => {
        return key in params ? params[key] : match;
    });
}

/**
 * Handle pluralization
 * Format: "singular | plural" or "{n} item | {n} items"
 */
function plural(key, count, params = {}) {
    const value = t(key, { ...params, n: count });
    
    if (value.includes('|')) {
        const parts = value.split('|').map(s => s.trim());
        const form = count === 1 ? parts[0] : (parts[1] || parts[0]);
        return interpolate(form, { ...params, n: count });
    }
    
    return value;
}

/**
 * Apply translations to all elements with data-i18n attribute
 */
function applyTranslations() {
    // Translate elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = t(key);
        
        // Check if we should set innerHTML or textContent
        if (el.hasAttribute('data-i18n-html')) {
            el.innerHTML = translation;
        } else {
            el.textContent = translation;
        }
    });
    
    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
    });
    
    // Translate titles
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.title = t(key);
    });
    
    // Translate document title if needed
    const titleEl = document.querySelector('[data-i18n-page-title]');
    if (titleEl) {
        document.title = t(titleEl.getAttribute('data-i18n-page-title'));
    }
}

/**
 * Format a date according to the current language
 */
function formatDate(date, options = {}) {
    const d = date instanceof Date ? date : new Date(date);
    const defaultOptions = {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    };
    return d.toLocaleDateString(currentLanguage, { ...defaultOptions, ...options });
}

/**
 * Format a relative time (e.g., "2 days ago")
 */
function formatRelativeTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    const now = new Date();
    const diffMs = now - d;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    
    if (diffSec < 60) {
        return t('dateTime.justNow');
    } else if (diffMin < 60) {
        return plural('dateTime.minutesAgo', diffMin);
    } else if (diffHour < 24) {
        return plural('dateTime.hoursAgo', diffHour);
    } else if (diffDay === 1) {
        return t('dateTime.yesterday');
    } else {
        return plural('dateTime.daysAgo', diffDay);
    }
}

/**
 * Get language display name
 */
function getLanguageName(code) {
    const names = {
        en: 'English',
        fr: 'Français',
        es: 'Español',
        de: 'Deutsch',
        it: 'Italiano',
        pt: 'Português'
    };
    return names[code] || code;
}

/**
 * Get language flag emoji
 */
function getLanguageFlag(code) {
    const flags = {
        en: '🇬🇧',
        fr: '🇫🇷',
        es: '🇪🇸',
        de: '🇩🇪',
        it: '🇮🇹',
        pt: '🇧🇷'
    };
    return flags[code] || '🌐';
}

// Export functions for global use
window.i18n = {
    init: initI18n,
    t,
    plural,
    setLanguage,
    getLanguage,
    formatDate,
    formatRelativeTime,
    getLanguageName,
    getLanguageFlag,
    SUPPORTED_LANGUAGES,
    DEFAULT_LANGUAGE
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n);
} else {
    initI18n();
}
