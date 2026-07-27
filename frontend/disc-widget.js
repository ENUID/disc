/**
 * Disc — Intent Search Widget
 * https://enuidlabs.com/disc
 *
 * Drop-in script that upgrades a Shopify theme's native search input into
 * an AI-powered semantic intent engine. It never renders a second visible
 * search box: it finds the theme's existing input, hijacks its events, and
 * renders results in a Shadow DOM overlay positioned beneath it.
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
      }, 200);
    }

    isOpen() {
      return this.style.display !== "none";
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
      this._panel.innerHTML = rows;
      this.open();
    }

    showEmpty(query) {
      this._panel.innerHTML =
        '<div class="disc-empty">No matches for "' +
        escapeHtml(query) +
        '". Try describing what you’re looking for.</div>';
      this.open();
    }

    showError() {
      this._panel.innerHTML =
        '<div class="disc-empty">Disc search is temporarily unavailable.</div>';
      this.open();
    }

    renderResults(results, query) {
      this._results = results;
      this._activeIndex = -1;

      if (!results.length) {
        this.showEmpty(query);
        return;
      }

      var html = results
        .map(function (item, index) {
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
            '<span class="disc-item-price">$' +
            Number(item.price).toFixed(2) +
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

      html +=
        '<div class="disc-footer">Search by <span class="disc-brand">Disc</span></div>';

      this._panel.innerHTML = html;
      this.open();
    }

    moveActive(delta) {
      var items = this._panel.querySelectorAll(".disc-item");
      if (!items.length) return;
      this._activeIndex =
        (this._activeIndex + delta + items.length) % items.length;
      items.forEach(function (el, i) {
        el.classList.toggle("disc-item--active", i === this._activeIndex);
      }, this);
      items[this._activeIndex].scrollIntoView({ block: "nearest" });
    }

    activeHref() {
      if (this._activeIndex < 0) return null;
      var items = this._panel.querySelectorAll(".disc-item");
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

  // ---------------------------------------------------------------------
  // Premium monochrome fashion-OS design system, scoped entirely to the
  // Shadow DOM — none of this leaks into (or is affected by) the host
  // Shopify theme's stylesheet.
  // ---------------------------------------------------------------------
  var DISC_STYLES =
    ":host{all:initial;}" +
    "*{box-sizing:border-box;margin:0;padding:0;}" +
    ".disc-panel{" +
    'font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;' +
    "background:rgba(255,255,255,0.85);" +
    "backdrop-filter:blur(12px);" +
    "-webkit-backdrop-filter:blur(12px);" +
    "border:1px solid rgba(0,0,0,0.08);" +
    "border-radius:14px;" +
    "box-shadow:0 20px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);" +
    "max-height:420px;overflow-y:auto;overflow-x:hidden;" +
    "opacity:0;transform:translateY(-4px);" +
    "transition:opacity 0.2s ease, transform 0.2s ease;" +
    "}" +
    ".disc-panel--visible{opacity:1;transform:translateY(0);}" +
    "@media (prefers-color-scheme:dark){" +
    ".disc-panel{background:rgba(20,20,20,0.85);border-color:rgba(255,255,255,0.1);" +
    "box-shadow:0 20px 40px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3);}" +
    "}" +
    ".disc-item{display:flex;gap:12px;align-items:center;padding:10px 14px;" +
    "text-decoration:none;color:#111;border-bottom:1px solid rgba(0,0,0,0.06);" +
    "transition:background-color 0.15s ease;}" +
    ".disc-item:last-of-type{border-bottom:none;}" +
    ".disc-item:hover,.disc-item--active{background-color:rgba(0,0,0,0.05);}" +
    "@media (prefers-color-scheme:dark){" +
    ".disc-item{color:#f2f2f2;border-bottom-color:rgba(255,255,255,0.08);}" +
    ".disc-item:hover,.disc-item--active{background-color:rgba(255,255,255,0.08);}" +
    "}" +
    ".disc-item-thumb{width:48px;height:48px;border-radius:8px;flex-shrink:0;" +
    "background-size:cover;background-position:center;background-color:rgba(0,0,0,0.06);" +
    "border:1px solid rgba(0,0,0,0.08);}" +
    ".disc-item-body{flex:1;min-width:0;}" +
    ".disc-item-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}" +
    ".disc-item-title{font-size:13.5px;font-weight:600;letter-spacing:-0.01em;" +
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
    ".disc-item-price{font-size:12.5px;font-weight:500;color:#555;flex-shrink:0;}" +
    "@media (prefers-color-scheme:dark){.disc-item-price{color:#aaa;}}" +
    ".disc-item-reason{font-size:12px;color:#777;margin-top:3px;line-height:1.35;" +
    "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}" +
    "@media (prefers-color-scheme:dark){.disc-item-reason{color:#999;}}" +
    ".disc-empty{padding:20px 16px;font-size:13px;color:#777;text-align:center;}" +
    ".disc-footer{padding:8px 14px;font-size:10.5px;color:#999;text-align:right;" +
    "letter-spacing:0.02em;border-top:1px solid rgba(0,0,0,0.06);}" +
    "@media (prefers-color-scheme:dark){.disc-footer{border-top-color:rgba(255,255,255,0.08);}}" +
    ".disc-brand{font-weight:700;color:#111;}" +
    "@media (prefers-color-scheme:dark){.disc-brand{color:#fff;}}" +
    ".disc-skeleton-row{display:flex;gap:12px;align-items:center;padding:10px 14px;}" +
    ".disc-skeleton-thumb{width:48px;height:48px;border-radius:8px;flex-shrink:0;" +
    "background:linear-gradient(90deg,rgba(0,0,0,0.06) 25%,rgba(0,0,0,0.1) 37%,rgba(0,0,0,0.06) 63%);" +
    "background-size:400% 100%;animation:disc-shimmer 1.4s ease infinite;}" +
    ".disc-skeleton-lines{flex:1;display:flex;flex-direction:column;gap:6px;}" +
    ".disc-skeleton-line{height:9px;border-radius:4px;" +
    "background:linear-gradient(90deg,rgba(0,0,0,0.06) 25%,rgba(0,0,0,0.1) 37%,rgba(0,0,0,0.06) 63%);" +
    "background-size:400% 100%;animation:disc-shimmer 1.4s ease infinite;}" +
    ".disc-skeleton-line--wide{width:70%;}" +
    ".disc-skeleton-line--narrow{width:40%;}" +
    "@keyframes disc-shimmer{0%{background-position:100% 0;}100%{background-position:-100% 0;}}" +
    ".disc-panel::-webkit-scrollbar{width:6px;}" +
    ".disc-panel::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:3px;}";

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
