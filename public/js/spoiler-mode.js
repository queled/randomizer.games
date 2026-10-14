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

  // i18n.js loads async: English until it is ready
  function tr(key, fallback) {
    return window.i18n ? window.i18n.t(key, {}, fallback) : fallback;
  }

  // Update toggle button UI
  function updateToggleUI() {
    const toggle = document.getElementById('spoiler-toggle');
    if (!toggle) return;

    const isEnabled = isSpoilerModeEnabled();
    toggle.classList.toggle('active', isEnabled);
    toggle.setAttribute('aria-checked', isEnabled ? 'true' : 'false');

    // 👁 results visible, 🙈 results hidden
    toggle.querySelector('.spoiler-toggle-icon').textContent = isEnabled ? '🙈' : '👁';
    const label = tr('spoiler.toggleLabel', 'No spoilers');
    toggle.querySelector('.spoiler-toggle-text').textContent = label;
    toggle.setAttribute('aria-label', label);
    toggle.title = isEnabled
      ? tr('tooltips.spoilerEnabled', 'No spoilers on: results are hidden. Click to show them')
      : tr('tooltips.spoilerDisabled', 'No spoilers off: results are visible. Click to hide them, handy before watching a VOD');
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
      <button id="spoiler-toggle" class="spoiler-toggle" role="switch" aria-checked="false">
        <span class="spoiler-toggle-label"><span class="spoiler-toggle-icon" aria-hidden="true">👁</span><span class="spoiler-toggle-text">No spoilers</span></span>
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

  // Label and tooltip arrive with the translations
  window.addEventListener('languageChanged', updateToggleUI);

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
