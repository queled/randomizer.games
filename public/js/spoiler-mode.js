// Spoiler Mode - Hides race winners, tournament results, and player rankings
// State is stored in sessionStorage (persists during session, resets on browser close)

(function() {
  const STORAGE_KEY = 'spoilerModeEnabled';

  // Check if spoiler mode is enabled
  function isSpoilerModeEnabled() {
    return sessionStorage.getItem(STORAGE_KEY) === 'true';
  }

  // Set spoiler mode state
  function setSpoilerMode(enabled) {
    sessionStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    applySpoilerMode();
    updateToggleUI();
    
    // Dispatch custom event so pages can react to spoiler mode changes
    window.dispatchEvent(new CustomEvent('spoilerModeChanged', { 
      detail: { enabled: enabled } 
    }));
  }

  // Toggle spoiler mode
  function toggleSpoilerMode() {
    setSpoilerMode(!isSpoilerModeEnabled());
  }

  // Apply or remove spoiler class on body
  function applySpoilerMode() {
    if (isSpoilerModeEnabled()) {
      document.body.classList.add('spoiler-mode');
    } else {
      document.body.classList.remove('spoiler-mode');
    }
  }

  // Update toggle button UI
  function updateToggleUI() {
    const toggle = document.getElementById('spoiler-toggle');
    if (!toggle) return;
    
    const isEnabled = isSpoilerModeEnabled();
    const getText = window.i18n ? window.i18n.t : (key) => {
      // Fallback titles in English
      return isEnabled ? 'Anti-Spoiler Mode enabled - Click to disable' : 'Anti-Spoiler Mode disabled - Click to enable';
    };
    
    toggle.classList.toggle('active', isEnabled);
    toggle.setAttribute('aria-checked', isEnabled ? 'true' : 'false');
    
    if (window.i18n) {
      toggle.title = isEnabled 
        ? window.i18n.t('tooltips.spoilerEnabled', {}, 'Anti-Spoiler Mode enabled - Click to disable')
        : window.i18n.t('tooltips.spoilerDisabled', {}, 'Anti-Spoiler Mode disabled - Click to enable');
    } else {
      toggle.title = isEnabled ? 'Anti-Spoiler Mode enabled - Click to disable' : 'Anti-Spoiler Mode disabled - Click to enable';
    }
  }

  // Create and inject the toggle button
  function createToggleButton() {
    // Find the search input
    const searchInput = document.getElementById('search');
    if (!searchInput) return;

    // Check if button already exists
    if (document.getElementById('spoiler-toggle')) return;

    // Create toggle container
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'spoiler-toggle-container';
    toggleContainer.innerHTML = `
      <button id="spoiler-toggle" class="spoiler-toggle" role="switch" aria-checked="false" title="Mode Anti-Spoiler désactivé - Cliquez pour activer">
        <span class="spoiler-toggle-label">Spoiler</span>
        <span class="spoiler-toggle-knob"></span>
      </button>
    `;

    // Insert before search input
    searchInput.parentNode.insertBefore(toggleContainer, searchInput);

    // Add click handler
    const toggle = document.getElementById('spoiler-toggle');
    toggle.addEventListener('click', toggleSpoilerMode);
  }

  // Initialize
  function init() {
    createToggleButton();
    applySpoilerMode();
    updateToggleUI();
  }

  // Expose for dynamic content updates
  window.applySpoilerMode = applySpoilerMode;
  window.isSpoilerModeEnabled = isSpoilerModeEnabled;

  // Run on DOMContentLoaded or immediately if DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
