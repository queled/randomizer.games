// Keeps a page's open tab in its history entry, without touching the URL: a reload keeps it.
// A tab can also open as a step of the history, which Back undoes, back to where the visitor was.
// Returns { initial, select, open }: the tab this entry shows, and the two ways to switch.
window.tabHistory = function ({ current, show, isTab, saveSpot, restoreSpot }) {
  const spotKey = (step) => 'tab-spot:' + location.pathname + location.search + ':' + step;
  const newStep = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // A reload or a return from another page finds its tab in the history entry
  const saved = history.state && history.state.tab;
  const initial = saved && isTab(saved) ? saved : current();
  if (!saved) history.replaceState({ ...(history.state || {}), tab: initial, step: newStep() }, '');

  function rememberSpot() {
    const step = history.state && history.state.step;
    if (!step) return;
    try {
      sessionStorage.setItem(spotKey(step), JSON.stringify({ scrollY: window.scrollY, extra: saveSpot ? saveSpot() : null }));
    } catch (e) { /* storage unavailable: Back still returns to the tab */ }
  }

  window.addEventListener('popstate', (e) => {
    const tab = e.state && e.state.tab;
    if (!tab || !isTab(tab)) return;
    show(tab);
    let spot = null;
    try { spot = JSON.parse(sessionStorage.getItem(spotKey(e.state.step))); } catch (err) { spot = null; }
    if (!spot) return;
    requestAnimationFrame(() => {
      if (restoreSpot && spot.extra) restoreSpot(spot.extra);
      window.scrollTo(0, spot.scrollY);
    });
  });

  return {
    initial,
    select(tab) {
      history.replaceState({ ...(history.state || {}), tab }, '');
      show(tab);
    },
    // The entry left is never rewritten in the same click: browsers would skip it on Back
    open(tab) {
      if (tab === current()) return;
      rememberSpot();
      history.pushState({ tab, step: newStep() }, '');
      show(tab);
    }
  };
};
