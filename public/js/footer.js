// Footer component - Dynamically inject the footer into all pages
function createFooter() {
    // Wait for i18n to be ready
    const lang = window.i18n ? window.i18n.getLanguage() : 'en';
    const getText = window.i18n ? window.i18n.t : (key, opts, fallback) => (typeof fallback !== 'undefined' ? fallback : key);
    
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `
        <div class="footer-container">
            <div class="footer-language">
                <span class="footer-language-label" data-i18n="footer.language">🌐 ${getText('footer.language', {}, 'Language')}</span>
                <select class="language-select" id="language-selector">
                    <option value="en">🇬🇧 English</option>
                    <option value="fr">🇫🇷 Français</option>
                    <option value="es">🇪🇸 Español</option>
                    <option value="de">🇩🇪 Deutsch</option>
                    <option value="it">🇮🇹 Italiano</option>
                    <option value="pt">🇧🇷 Português</option>
                </select>
            </div>
            
            <div class="footer-sections">
                <div class="footer-section">
                    <span class="footer-section-title" data-i18n="footer.explore">${getText('footer.explore', {}, 'Explore')}</span>
                    <a href="/streams.html" data-i18n="footer.liveStreams">${getText('footer.liveStreams', {}, '📺 Live Streams')}</a>
                    <a href="/games.html" data-i18n="footer.games">${getText('footer.games', {}, '🎮 Games')}</a>
                </div>
                
                <div class="footer-section">
                    <span class="footer-section-title" data-i18n="footer.information">${getText('footer.information', {}, 'Information')}</span>
                    <a href="/about.html" data-i18n="footer.about">${getText('footer.about', {}, 'ℹ️ About')}</a>
                    <a href="/resources.html" data-i18n="footer.relatedSites">${getText('footer.relatedSites', {}, '🔗 Related Sites')}</a>
                    <a href="/terms.html" data-i18n="footer.termsOfUse">${getText('footer.termsOfUse', {}, '📜 Terms of Use')}</a>
                </div>
                
                <div class="footer-section">
                    <span class="footer-section-title" data-i18n="footer.socialNetwork">${getText('footer.socialNetwork', {}, 'Social Network')}</span>
                    <a href="https://discord.gg/AyaZTFUAGe" target="_blank" rel="noopener noreferrer" class="footer-discord" title="${getText('footer.discord', {}, 'Discord')}" aria-label="${getText('footer.discord', {}, 'Discord')}" style="display:inline-flex;align-items:center;gap:0.35rem;text-decoration:none;">
                        <img src="/assets/discord.svg" alt="${getText('footer.discord', {}, 'Discord')}" class="social-icon" style="width:1em;height:1em;vertical-align:middle;display:inline-block;">
                        <span class="social-label">${getText('footer.discord', {}, 'Discord')}</span>
                    </a>
                </div>
            </div>
        </div>
        
        <div class="footer-bottom">
            <span class="footer-copyright" data-i18n="footer.copyright">${getText('footer.copyright', { year: new Date().getFullYear() }, `© ${new Date().getFullYear()} Randomizer. All rights reserved.`)}</span>
            <div class="footer-actions">
                <a href="https://ko-fi.com/randomizergames" target="_blank" rel="noopener noreferrer" class="footer-kofi-btn" data-i18n-title="tooltips.kofi" title="Support us on Ko-fi">
                    <svg class="kofi-icon" width="20" height="20" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298"/>
                    </svg>
                    <span class="kofi-label">Ko-fi</span>
                </a>
                <div class="footer-social">
                    <a href="https://github.com/queled/randomizer.games" target="_blank" rel="noopener noreferrer" title="GitHub">
                        <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                        </svg>
                    </a>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(footer);
    
    // Initialize language selector
    initLanguageSelector();
}

// Language selector functionality
function initLanguageSelector() {
    const selector = document.getElementById('language-selector');
    if (!selector) return;
    
    // i18n.js loads async: before it is ready, <html lang> already holds the language
    // picked by i18n-boot.js (saved choice or browser language)
    const savedLang = window.i18n ? window.i18n.getLanguage() : (document.documentElement.lang || 'en');
    selector.value = savedLang;
    
    // Handle language change
    selector.addEventListener('change', (e) => {
        const lang = e.target.value;
        
        // Use i18n system if available
        if (window.i18n) {
            window.i18n.setLanguage(lang);
            // Reload page to apply all translations
            window.location.reload();
        } else {
            localStorage.setItem('preferred-language', lang);
            window.location.reload();
        }
    });
}

// Listen for language changes to update footer
window.addEventListener('languageChanged', () => {
    // Update footer text when language changes
    if (window.i18n) {
        const selector = document.getElementById('language-selector');
        if (selector) selector.value = window.i18n.getLanguage();

        const copyrightEl = document.querySelector('.footer-copyright');
        if (copyrightEl) {
            copyrightEl.textContent = window.i18n.t('footer.copyright', { year: new Date().getFullYear() });
        }
        
        // Update Ko-fi button tooltip
        const kofiBtn = document.querySelector('.footer-kofi-btn');
        if (kofiBtn) {
            const title = window.i18n.t('tooltips.kofi', {}, 'Support us on Ko-fi');
            kofiBtn.title = title;
        }
        
        // Update Discord label/icon titles
        const discordAnchor = document.querySelector('.footer-discord');
        if (discordAnchor) {
            const label = discordAnchor.querySelector('.social-label');
            const img = discordAnchor.querySelector('img');
            const text = window.i18n.t('footer.discord', {}, 'Discord');
            if (label) label.textContent = text;
            if (img) img.alt = text;
            discordAnchor.title = text;
            discordAnchor.setAttribute('aria-label', text);
        }
    }
});

// Initialize Ko-fi button title when i18n is ready
function initKofiTitle() {
    const kofiBtn = document.querySelector('.footer-kofi-btn');
    if (!kofiBtn) return;
    
    // Try to get translation immediately
    if (window.i18n && typeof window.i18n.t === 'function') {
        try {
            const title = window.i18n.t('tooltips.kofi', {}, 'Support us on Ko-fi');
            kofiBtn.title = title;
        } catch (e) {
            kofiBtn.title = 'Support us on Ko-fi';
        }
    } else {
        kofiBtn.title = 'Support us on Ko-fi';
    }
}

// Call immediately and also wait for DOMContentLoaded to ensure everything is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Wait a tick to ensure i18n is initialized
        setTimeout(initKofiTitle, 100);
    });
} else {
    // Wait a tick to ensure i18n is initialized
    setTimeout(initKofiTitle, 100);
}

// Auto-inject footer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createFooter);
} else {
    createFooter();
}
