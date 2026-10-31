// Global search handler - include this in all pages
(function() {
  function setupGlobalSearch() {
    const searchInput = document.getElementById('search');
    if (!searchInput) return;

    // Don't override if we're on the search page (it has its own handler)
    if (window.SiteUrls && window.SiteUrls.path === '/search') return;

    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (query && query.length >= 2) {
          window.location.href = `/search?q=${encodeURIComponent(query)}`;
        }
      }
    });
  }

  // Run on DOMContentLoaded or immediately if DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupGlobalSearch);
  } else {
    setupGlobalSearch();
  }
})();
