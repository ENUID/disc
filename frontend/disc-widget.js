/**
 * Disc — Intent Search Widget
 * https://enuidlabs.com/disc
 *
 * Drop-in script that upgrades a Shopify theme's native search input into
 * an AI-powered semantic intent engine. It never renders a second visible
 * search box: it finds the theme's existing input, hijacks its events, and
 * renders results in a Shadow DOM overlay positioned beneath it.
 *
 * The overlay's material is a CSS approximation of Apple's Liquid Glass:
 * live backdrop blur+saturation (real pixels behind it, not a screenshot),
 * a pointer-tracked specular highlight, a light-catching gradient rim,
 * layered ambient/contact shadows, and spring-eased motion. True optical
 * refraction (geometric lensing of the background) isn't reproducible in
 * CSS without a noisy, unreliable SVG turbulence filter, so it's
 * deliberately left out in favor of effects that render correctly on
 * every browser a merchant's storefront actually runs in.
 *
 * Usage:
 *   <script src="disc-widget.js" data-api-url="https://your-disc-api.example.com"></script>
 */
(function () {
  "use strict";

  var CURRENT_SCRIPT = document.currentScript;

  var CONFIG = {
    apiUrl:
      (CURRENT_SCRIPT && CURRENT_SCRIPT.dataset.apiUrl) ||
      (window.DiscConfig && window.DiscConfig.apiUrl) ||
      "http://localhost:8000",
    searchSelectors: 'input[name="q"], input[type="search"]',
    scanIntervalMs: 500,
    debounceMs: 300,
    resultLimit: 5,
  };

  // ---------------------------------------------------------------------
  // <disc-search-overlay> — the entire rendered UI lives in its Shadow DOM.
  // ---------------------------------------------------------------------
  class DiscSearchOverlay extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: "open" });
      this._activeIndex = -1;
      this._results = [];
      this._buildDom();
    }

    _buildDom() {
      var style = document.createElement("style");
      style.textContent = DISC_STYLES;

      this._panel = document.createElement("div");
      this._panel.className = "disc-panel";
      this._panel.setAttribute("role", "listbox");
      this._panel.style.setProperty("--disc-mx", "30%");
      this._panel.style.setProperty("--disc-my", "0%");
      this._panel.style.setProperty("--disc-rim-angle", "135deg");

      this._list = document.createElement("div");
      this._list.className = "disc-list";

      this._footer = document.createElement("div");
      this._footer.className = "disc-footer";
      this._footer.hidden = true;
      this._footer.innerHTML = DISC_FOOTER_HTML;

      this._panel.appendChild(this._list);
      this._panel.appendChild(this._footer);

      this._root.appendChild(style);
      this._root.appendChild(this._panel);
    }

    connectedCallback() {
      // Host element attributes must not be touched inside the
      // constructor (the Custom Elements spec forbids it) — this is the
      // first safe place to size and position the host itself.
      this.style.position = "fixed";
      this.style.zIndex = "2147483647";
      this.style.display = "none";
      this._bindPointerTracking();
    }

    _bindPointerTracking() {
      var panel = this._panel;
      var canTrack = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      if (!canTrack) return; // touch devices keep the fixed default highlight position

      var raf = null;
      panel.addEventListener("pointermove", function (e) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = null;
          var rect = panel.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          var px = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
          var py = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
          var angle = (Math.atan2(py - 50, px - 50) * 180) / Math.PI + 90;
          panel.style.setProperty("--disc-mx", px.toFixed(1) + "%");
          panel.style.setProperty("--disc-my", py.toFixed(1) + "%");
          panel.style.setProperty("--disc-rim-angle", angle.toFixed(1) + "deg");
        });
      });
      panel.addEventListener("pointerleave", function () {
        panel.style.setProperty("--disc-mx", "30%");
        panel.style.setProperty("--disc-my", "0%");
        panel.style.setProperty("--disc-rim-angle", "135deg");
      });
    }

    positionUnder(inputEl) {
      var rect = inputEl.getBoundingClientRect();
      this.style.left = rect.left + "px";
      this.style.top = rect.bottom + 8 + "px";
      this.style.width = rect.width + "px";
    }

    open() {
      this.style.display = "block";
      requestAnimationFrame(
        function () {
          this._panel.classList.add("disc-panel--visible");
        }.bind(this)
      );
    }

    close() {
      this._panel.classList.remove("disc-panel--visible");
      this._activeIndex = -1;
      var self = this;
      setTimeout(function () {
        self.style.display = "none";
      }, 220);
    }

    isOpen() {
      return this.style.display !== "none";
    }

    // Swaps the scrollable content. If the panel is already visible, the
    // old content fades out before the new content fades in so a
    // skeleton -> results transition never feels like a jump-cut. If the
    // panel isn't visible yet there's nothing on screen to crossfade from,
    // so the content is set immediately and open() handles the entrance.
    _setContent(html, footerVisible) {
      var list = this._list;
      var footer = this._footer;
      if (!this.isOpen()) {
        list.innerHTML = html;
        footer.hidden = !footerVisible;
        return;
      }
      list.classList.add("disc-list--fading");
      setTimeout(function () {
        list.innerHTML = html;
        footer.hidden = !footerVisible;
        list.classList.remove("disc-list--fading");
      }, 120);
    }

    showSkeleton() {
      this._results = [];
      this._activeIndex = -1;
      var rows = "";
      for (var i = 0; i < 3; i++) {
        rows +=
          '<div class="disc-skeleton-row">' +
          '<div class="disc-skeleton-thumb"></div>' +
          '<div class="disc-skeleton-lines">' +
          '<div class="disc-skeleton-line disc-skeleton-line--wide"></div>' +
          '<div class="disc-skeleton-line disc-skeleton-line--narrow"></div>' +
          "</div></div>";
      }
      this._setContent(rows, false);
      this.open();
    }

    showEmpty(query) {
      this._setContent(
        '<div class="disc-empty">No matches for “' +
          escapeHtml(query) +
          '”. Try describing what you’re looking for.</div>',
        true
      );
      this.open();
    }

    showError() {
      this._setContent(
        '<div class="disc-empty">Disc search is temporarily unavailable.</div>',
        true
      );
      this.open();
    }

    renderResults(results, query) {
      this._results = results;
      this._activeIndex = -1;

      if (!results.length) {
        this.showEmpty(query);
        return;
      }

      // Signal bars are relative to the strongest match in this batch (not
      // the raw cosine/L2-derived score) so the top result always reads as
      // full confidence and the rest scale visibly beneath it.
      var maxScore = results.reduce(function (max, r) {
        return Math.max(max, r.score);
      }, 0.0001);

      var html = results
        .map(function (item, index) {
          var activeBars = Math.max(1, Math.round((item.score / maxScore) * 4));
          return (
            '<a class="disc-item" data-index="' +
            index +
            '" href="/products/' +
            encodeURIComponent(item.id) +
            '" role="option">' +
            '<div class="disc-item-thumb" style="background-image:url(\'' +
            escapeAttr(item.image_url) +
            "')\"></div>" +
            '<div class="disc-item-body">' +
            '<div class="disc-item-top">' +
            '<span class="disc-item-title">' +
            escapeHtml(item.title) +
            "</span>" +
            '<span class="disc-item-meta">' +
            signalBarsHtml(activeBars) +
            '<span class="disc-item-price">$' +
            Number(item.price).toFixed(2) +
            "</span>" +
            "</span>" +
            "</div>" +
            '<p class="disc-item-reason">' +
            escapeHtml(item.reasoning) +
            "</p>" +
            "</div>" +
            "</a>"
          );
        })
        .join("");

      this._setContent(html, true);
      this.open();
    }

    moveActive(delta) {
      var items = this._list.querySelectorAll(".disc-item");
      if (!items.length) return;
      this._activeIndex = (this._activeIndex + delta + items.length) % items.length;
      items.forEach(function (el, i) {
        el.classList.toggle("disc-item--active", i === this._activeIndex);
      }, this);
      items[this._activeIndex].scrollIntoView({ block: "nearest" });
    }

    activeHref() {
      if (this._activeIndex < 0) return null;
      var items = this._list.querySelectorAll(".disc-item");
      var el = items[this._activeIndex];
      return el ? el.getAttribute("href") : null;
    }
  }

  customElements.define("disc-search-overlay", DiscSearchOverlay);

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str == null ? "" : str).replace(/'/g, "%27");
  }

  var SIGNAL_BAR_HEIGHTS = [40, 60, 80, 100];

  function signalBarsHtml(activeCount) {
    return (
      '<span class="disc-item-signal">' +
      SIGNAL_BAR_HEIGHTS.map(function (height, i) {
        var lit = i < activeCount ? "disc-bar--lit" : "disc-bar--dim";
        return '<span class="disc-bar ' + lit + '" style="height:' + height + '%"></span>';
      }).join("") +
      "</span>"
    );
  }

  var DISC_FOOTER_HTML =
    '<svg class="disc-footer-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/>' +
    '<circle cx="12" cy="12" r="3" fill="currentColor"/>' +
    "</svg>" +
    "<span>Search by <span class=\"disc-brand\">Disc</span></span>";

  // ---------------------------------------------------------------------
  // Liquid Glass design system, scoped entirely to the Shadow DOM — none
  // of this leaks into (or is affected by) the host Shopify theme's
  // stylesheet. Monochrome, adaptive to light/dark, spring-eased motion.
  // ---------------------------------------------------------------------
  var DISC_STYLES = `
    @property --disc-mx {
      syntax: '<percentage>';
      inherits: false;
      initial-value: 30%;
    }
    @property --disc-my {
      syntax: '<percentage>';
      inherits: false;
      initial-value: 0%;
    }
    @property --disc-rim-angle {
      syntax: '<angle>';
      inherits: false;
      initial-value: 135deg;
    }

    :host {
      all: initial;
      --disc-glass-top: rgba(255,255,255,0.5);
      --disc-glass-bottom: rgba(255,255,255,0.26);
      --disc-rim-1: rgba(255,255,255,0.95);
      --disc-rim-2: rgba(255,255,255,0.08);
      --disc-text: #1d1d1f;
      --disc-text-secondary: #6e6e73;
      --disc-hover: rgba(0,0,0,0.06);
      --disc-shadow-ambient: rgba(0,0,0,0.3);
      --disc-shadow-contact: rgba(0,0,0,0.16);
      --disc-scrollbar: rgba(0,0,0,0.18);
      --disc-divider: rgba(0,0,0,0.07);
      --disc-specular: rgba(255,255,255,0.85);
      --disc-specular-opacity: 0.4;
      --disc-text-shadow: rgba(255,255,255,0.55);
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --disc-glass-top: rgba(50,50,53,0.5);
        --disc-glass-bottom: rgba(14,14,16,0.4);
        --disc-rim-1: rgba(255,255,255,0.4);
        --disc-rim-2: rgba(255,255,255,0.03);
        --disc-text: #f5f5f7;
        --disc-text-secondary: #98989d;
        --disc-hover: rgba(255,255,255,0.1);
        --disc-shadow-ambient: rgba(0,0,0,0.6);
        --disc-shadow-contact: rgba(0,0,0,0.42);
        --disc-scrollbar: rgba(255,255,255,0.22);
        --disc-divider: rgba(255,255,255,0.09);
        --disc-specular: rgba(255,255,255,0.4);
        --disc-specular-opacity: 0.3;
        --disc-text-shadow: rgba(0,0,0,0.45);
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    .disc-panel {
      position: relative;
      isolation: isolate;
      font-family: -apple-system, "SF Pro Text", Inter, system-ui, "Segoe UI", sans-serif;
      color: var(--disc-text);
      /* A translucent panel has no guaranteed contrast against whatever
         backdrop happens to blur through it, so text carries its own
         subtle shadow for edge contrast, inherited by every descendant. */
      text-shadow: 0 1px 2px var(--disc-text-shadow);
      border-radius: 26px;
      border: 1px solid transparent;
      background-image:
        linear-gradient(180deg, var(--disc-glass-top), var(--disc-glass-bottom)),
        linear-gradient(var(--disc-rim-angle), var(--disc-rim-1), var(--disc-rim-2) 35%, var(--disc-rim-2) 65%, var(--disc-rim-1));
      background-origin: padding-box, border-box;
      background-clip: padding-box, border-box;
      backdrop-filter: blur(30px) saturate(200%);
      -webkit-backdrop-filter: blur(30px) saturate(200%);
      box-shadow:
        0 0 0 1px rgba(0,0,0,0.05),
        0 34px 64px -16px var(--disc-shadow-ambient),
        0 10px 22px -8px var(--disc-shadow-contact),
        inset 0 1px 0 rgba(255,255,255,0.65),
        inset 0 -1px 0 rgba(0,0,0,0.05);
      max-height: 420px;
      overflow-y: auto;
      overflow-x: hidden;
      opacity: 0;
      transform: translateY(-8px) scale(0.97);
      transform-origin: top center;
      transition:
        opacity 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
        transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1);
      scrollbar-width: thin;
      scrollbar-color: var(--disc-scrollbar) transparent;
    }

    .disc-panel--visible { opacity: 1; transform: translateY(0) scale(1); }

    .disc-panel::-webkit-scrollbar { width: 6px; }
    .disc-panel::-webkit-scrollbar-track { background: transparent; }
    .disc-panel::-webkit-scrollbar-thumb { background: var(--disc-scrollbar); border-radius: 3px; }

    /* Pointer-tracked specular highlight — the "light hitting glass" cue.
       Plain alpha compositing (no mix-blend-mode) so it stays visible
       regardless of what's behind the glass: overlay/soft-light both go
       nearly invisible against an already-light base, which is exactly
       the surface color this widget uses in light mode. */
    .disc-panel::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: radial-gradient(circle at var(--disc-mx) var(--disc-my), var(--disc-specular), transparent 45%);
      opacity: var(--disc-specular-opacity);
      pointer-events: none;
      transition: --disc-mx 0.45s ease, --disc-my 0.45s ease, --disc-rim-angle 0.45s ease;
    }

    /* One-shot diagonal sheen that sweeps across the panel on open. */
    .disc-panel::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(115deg, transparent 30%, var(--disc-specular) 45%, transparent 70%);
      opacity: 0.5;
      transform: translateX(-120%);
      pointer-events: none;
    }
    .disc-panel--visible::after {
      animation: disc-sheen 0.9s cubic-bezier(0.22, 1, 0.36, 1) 0.05s 1;
    }
    @keyframes disc-sheen {
      from { transform: translateX(-120%); }
      to { transform: translateX(120%); }
    }

    .disc-list { padding: 6px; display: flex; flex-direction: column; gap: 2px; opacity: 1; transition: opacity 0.16s ease; }
    .disc-list--fading { opacity: 0; }

    .disc-item {
      position: relative;
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 16px;
      text-decoration: none;
      color: var(--disc-text);
      transition: background-color 0.18s ease, transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .disc-item:hover, .disc-item--active { background-color: var(--disc-hover); }
    .disc-item:active { transform: scale(0.985); }
    .disc-item:focus-visible { outline: 2px solid var(--disc-text); outline-offset: 2px; }

    /* Thumbnail radius follows the panel's radius minus its inset, so the
       corners read as concentric rather than mismatched curvature. */
    .disc-item-thumb {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      flex-shrink: 0;
      background-size: cover;
      background-position: center;
      background-color: rgba(120,120,128,0.16);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.08);
    }

    .disc-item-body { flex: 1; min-width: 0; }
    .disc-item-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .disc-item-title {
      font-size: 14px;
      font-weight: 590;
      letter-spacing: -0.012em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .disc-item-meta { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
    .disc-item-price {
      font-size: 12.5px;
      font-weight: 590;
      color: var(--disc-text-secondary);
      font-variant-numeric: tabular-nums;
    }
    .disc-item-reason {
      font-size: 12px;
      color: var(--disc-text-secondary);
      margin-top: 3px;
      line-height: 1.36;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* Match-confidence indicator, styled like a signal-strength glyph
       rather than a loading-bar-style meter. */
    .disc-item-signal { display: flex; align-items: flex-end; gap: 2px; height: 11px; }
    .disc-bar { width: 2.5px; border-radius: 1px; background: var(--disc-text); }
    .disc-bar--lit { opacity: 0.75; }
    .disc-bar--dim { opacity: 0.2; }

    .disc-empty { padding: 30px 18px; font-size: 13px; color: var(--disc-text-secondary); text-align: center; line-height: 1.4; }

    .disc-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding: 9px 16px;
      font-size: 10.5px;
      letter-spacing: 0.02em;
      color: var(--disc-text-secondary);
      border-top: 1px solid var(--disc-divider);
    }
    .disc-footer-icon { width: 11px; height: 11px; opacity: 0.85; }
    .disc-brand { font-weight: 700; color: var(--disc-text); }

    .disc-skeleton-row { display: flex; gap: 12px; align-items: center; padding: 10px 12px; }
    .disc-skeleton-thumb, .disc-skeleton-line {
      border-radius: 8px;
      background: linear-gradient(100deg, rgba(120,120,128,0.14) 20%, rgba(120,120,128,0.3) 40%, rgba(120,120,128,0.14) 60%);
      background-size: 200% 100%;
      animation: disc-shimmer 1.6s ease-in-out infinite;
    }
    .disc-skeleton-thumb { width: 46px; height: 46px; border-radius: 14px; flex-shrink: 0; }
    .disc-skeleton-lines { flex: 1; display: flex; flex-direction: column; gap: 7px; }
    .disc-skeleton-line { height: 9px; }
    .disc-skeleton-line--wide { width: 72%; }
    .disc-skeleton-line--narrow { width: 42%; }
    @keyframes disc-shimmer {
      0% { background-position: 160% 0; }
      100% { background-position: -60% 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .disc-panel, .disc-panel--visible {
        transition: opacity 0.15s ease;
        transform: none;
      }
      .disc-panel--visible::after { animation: none; }
      .disc-item, .disc-item:active { transition: background-color 0.15s ease; transform: none; }
      .disc-skeleton-thumb, .disc-skeleton-line { animation: none; }
    }
  `;

  // ---------------------------------------------------------------------
  // Debounce helper.
  // ---------------------------------------------------------------------
  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(self, args);
      }, wait);
    };
  }

  // ---------------------------------------------------------------------
  // Networking.
  // ---------------------------------------------------------------------
  function fetchResults(query) {
    return fetch(CONFIG.apiUrl + "/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, limit: CONFIG.resultLimit }),
    }).then(function (res) {
      if (!res.ok) throw new Error("Disc search request failed: " + res.status);
      return res.json();
    });
  }

  // ---------------------------------------------------------------------
  // Hijack: attach to the native input without ever rendering a second one.
  // ---------------------------------------------------------------------
  function hijackInput(input) {
    if (input.dataset.discHijacked) return;
    input.dataset.discHijacked = "true";

    var overlay = document.createElement("disc-search-overlay");
    document.body.appendChild(overlay);

    var reposition = function () {
      if (overlay.isOpen()) overlay.positionUnder(input);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    var runSearch = function () {
      var query = input.value.trim();
      if (query.length < 2) {
        overlay.close();
        return;
      }
      overlay.positionUnder(input);
      overlay.showSkeleton();
      fetchResults(query)
        .then(function (data) {
          if (input.value.trim() !== query) return; // stale response, a newer query is in flight
          overlay.renderResults(data.results, query);
        })
        .catch(function () {
          overlay.showError();
        });
    };

    var debouncedSearch = debounce(runSearch, CONFIG.debounceMs);

    input.addEventListener("input", debouncedSearch);

    input.addEventListener("focus", function () {
      if (input.value.trim().length >= 2) {
        overlay.positionUnder(input);
        overlay.open();
      }
    });

    input.addEventListener("keydown", function (e) {
      if (!overlay.isOpen()) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        overlay.moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        overlay.moveActive(-1);
      } else if (e.key === "Enter") {
        var href = overlay.activeHref();
        if (href) {
          e.preventDefault();
          window.location.href = href;
        }
        // If nothing is highlighted, Enter is prevented by the form
        // submit handler below and the top result stands as the answer.
      } else if (e.key === "Escape") {
        overlay.close();
      }
    });

    // The critical hijack: stop the native Shopify search page navigation.
    var form = input.closest("form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var href = overlay.activeHref();
        if (href) {
          window.location.href = href;
        }
      });
    }

    document.addEventListener("click", function (e) {
      if (e.target !== input && !overlay.contains(e.target)) {
        overlay.close();
      }
    });
  }

  // ---------------------------------------------------------------------
  // DOMScanner — polls for the native search input until it appears, then
  // stops. Handles themes that render search chrome after Disc loads.
  // ---------------------------------------------------------------------
  function scanForSearchInput() {
    var interval = setInterval(function () {
      var input = document.querySelector(CONFIG.searchSelectors);
      if (input) {
        clearInterval(interval);
        hijackInput(input);
      }
    }, CONFIG.scanIntervalMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanForSearchInput);
  } else {
    scanForSearchInput();
  }
})();
