/**
 * Declarative UI behaviours driven by data-* attributes.
 *
 * The Content-Security-Policy forbids inline event handlers (onclick=,
 * onmouseover=, onerror=...), which blocks injected markup from running
 * scripts. The few behaviours the pages used inline handlers for are wired
 * here once, through event delegation on the document:
 *
 *   data-menu-toggle              click: toggle "open" on the button and on <nav>
 *   data-hover-style="p:v;p:v"    mouseover: set inline style properties
 *   data-rest-style="p:v;p:v"     mouseout: set inline style properties
 *   data-fallback-src="url"       <img> error: swap to this source (once)
 *   data-fallback="hide-show-next" <img> error: hide it, show next sibling as flex
 *   data-page="n"                 click: call window.goToPage(n)
 *   data-stop-propagation         click/auxclick: keep the event from parent handlers
 *
 * Loaded synchronously in <head> so listeners exist before any image loads.
 */
(function () {
  'use strict';

  /**
   * Escape a value for use inside HTML text or a quoted attribute.
   * Exposed globally as window.escHtml for the page scripts.
   */
  function escHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  window.escHtml = escHtml;

  function applyStyleList(el, list) {
    if (!el || !list) return;
    list.split(';').forEach(function (pair) {
      var idx = pair.indexOf(':');
      if (idx <= 0) return;
      var prop = pair.slice(0, idx).trim();
      var value = pair.slice(idx + 1).trim();
      if (prop) el.style[prop] = value;
    });
  }

  // Same semantics as inline handlers: every matching ancestor of the target
  // reacts, innermost first, on every mouseover/mouseout event.
  function forEachAncestorWith(target, attr, fn) {
    var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
    while (el && el !== document) {
      if (el.hasAttribute && el.hasAttribute(attr)) fn(el);
      el = el.parentElement;
    }
  }

  document.addEventListener('mouseover', function (e) {
    forEachAncestorWith(e.target, 'data-hover-style', function (el) {
      applyStyleList(el, el.getAttribute('data-hover-style'));
    });
  });

  document.addEventListener('mouseout', function (e) {
    forEachAncestorWith(e.target, 'data-rest-style', function (el) {
      applyStyleList(el, el.getAttribute('data-rest-style'));
    });
  });

  // Error events do not bubble, so listen during the capture phase.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG') return;

    var fallbackSrc = img.getAttribute('data-fallback-src');
    if (fallbackSrc) {
      img.removeAttribute('data-fallback-src'); // only once, like this.onerror=null
      img.src = fallbackSrc;
      return;
    }

    if (img.getAttribute('data-fallback') === 'hide-show-next') {
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
    }
  }, true);

  // Capture phase on window runs before any handler on parent elements, which
  // is what an inline event.stopPropagation() on the link achieved. The
  // default action (following the link) is kept.
  function stopIfMarked(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-stop-propagation]') : null;
    if (el) e.stopPropagation();
  }
  window.addEventListener('click', stopIfMarked, true);
  window.addEventListener('auxclick', stopIfMarked, true);

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var toggle = target.closest('[data-menu-toggle]');
    if (toggle) {
      toggle.classList.toggle('open');
      var nav = document.querySelector('nav');
      if (nav) nav.classList.toggle('open');
      return;
    }

    var pageBtn = target.closest('[data-page]');
    if (pageBtn && typeof window.goToPage === 'function') {
      var page = parseInt(pageBtn.getAttribute('data-page'), 10);
      if (Number.isFinite(page)) window.goToPage(page);
    }
  });
})();
