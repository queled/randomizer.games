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
                <a href="https://patreon.com" target="_blank" rel="noopener noreferrer" class="footer-patreon-btn" data-i18n-title="tooltips.patreon" title="Support us on Patreon">
                    <img src="/assets/patreon.png" alt="Patreon" class="patreon-icon">
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
    
    // Load saved language preference
    const savedLang = window.i18n ? window.i18n.getLanguage() : (localStorage.getItem('preferred-language') || 'en');
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
        const copyrightEl = document.querySelector('.footer-copyright');
        if (copyrightEl) {
            copyrightEl.textContent = window.i18n.t('footer.copyright', { year: new Date().getFullYear() });
        }
        
        // Update Patreon button tooltip
        const patreonBtn = document.querySelector('.footer-patreon-btn');
        if (patreonBtn) {
            const title = window.i18n.t('tooltips.patreon', {}, 'Support us on Patreon');
            patreonBtn.title = title;
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

// Initialize Patreon button title when i18n is ready
function initPatreonTitle() {
    const patreonBtn = document.querySelector('.footer-patreon-btn');
    if (!patreonBtn) return;
    
    // Try to get translation immediately
    if (window.i18n && typeof window.i18n.t === 'function') {
        try {
            const title = window.i18n.t('tooltips.patreon', {}, 'Support us on Patreon');
            patreonBtn.title = title;
        } catch (e) {
            patreonBtn.title = 'Support us on Patreon';
        }
    } else {
        patreonBtn.title = 'Support us on Patreon';
    }
}

// Call immediately and also wait for DOMContentLoaded to ensure everything is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Wait a tick to ensure i18n is initialized
        setTimeout(initPatreonTitle, 100);
    });
} else {
    // Wait a tick to ensure i18n is initialized
    setTimeout(initPatreonTitle, 100);
}

// Auto-inject footer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createFooter);
} else {
    createFooter();
}
