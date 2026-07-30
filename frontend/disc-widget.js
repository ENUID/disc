/**
 * Disc — AI Boutique Widget
 * https://enuidlabs.com/disc
 *
 * One <script> tag turns a Shopify storefront's search into a full
 * conversational boutique experience:
 *
 *   bar (always docked)  ->  loading canvas  ->  results canvas  ->  product
 *                                                                    detail
 *                                                                    + look
 *
 * The bar floats fixed above the store. Searching opens a full-screen
 * takeover canvas rendered entirely inside this element's Shadow DOM —
 * the merchant's page is never navigated away or mutated, so closing the
 * canvas returns the shopper exactly where they were.
 *
 * The glass material is a CSS approximation of Apple's Liquid Glass: live
 * backdrop blur+saturation (real pixels behind it, not a screenshot), a
 * pointer-tracked specular highlight, a light-catching gradient rim,
 * layered ambient/contact shadows, and spring-eased motion. True optical
 * refraction is deliberately not attempted — the only CSS route there is
 * a noisy SVG turbulence filter that silently fails on browsers without
 * support for filters inside backdrop-filter, which isn't acceptable for
 * a widget embedded on arbitrary merchant storefronts.
 *
 * Every brand-facing token (canvas colour, serif stack, headline copy,
 * loading illustration) is themeable per merchant — see DISC_THEME. Disc
 * is sold to many stores, so nothing here may be hardcoded to one brand's
 * identity.
 *
 * Usage:
 *   <script src="disc-widget.js" data-api-url="https://your-disc-api.example.com"></script>
 */
(function () {
  "use strict";

  var CURRENT_SCRIPT = document.currentScript;
  var USER_CONFIG = window.DiscConfig || {};

  var CONFIG = {
    apiUrl:
      (CURRENT_SCRIPT && CURRENT_SCRIPT.dataset.apiUrl) ||
      USER_CONFIG.apiUrl ||
      "http://localhost:8000",
    searchSelectors: 'input[name="q"], input[type="search"]',
    scanIntervalMs: 500,
    debounceMs: 300,
    resultLimit: 12,
  };

  // ---------------------------------------------------------------------
  // Per-merchant theming. Disc is a product many stores install, so the
  // brand layer is data, not code: a merchant overrides any of these via
  // window.DiscConfig.theme without touching the widget.
  // ---------------------------------------------------------------------
  var DISC_THEME = Object.assign(
    {
      canvas: "#F4EEE9",
      ink: "#1D1D1F",
      serif: "'Canela', 'Didot', Georgia, 'Times New Roman', serif",
      greeting: "Welcome to the AI Boutique",
      resultsHeading: "Get inspired by these creations",
      loadingMessages: ["Gathering inspiration", "Crafting your experience"],
      // A single continuous line drawn stroke-by-stroke while results are
      // generated. Merchants can supply their own path (a storefront, a
      // skyline, a monogram) to make the wait feel like their brand.
      loadingPath:
        "M20,150 C60,150 70,120 90,120 L110,60 L130,120 L150,120 L150,80 L175,60 L200,80 L200,120 " +
        "L230,120 L230,95 L250,80 L270,95 L270,120 L300,120 C320,120 330,150 380,150",
    },
    USER_CONFIG.theme || {}
  );

  // ---------------------------------------------------------------------
  // <disc-search-bar> — bar + full-screen canvas, all in one Shadow DOM.
  // ---------------------------------------------------------------------
  class DiscSearchBar extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: "open" });
      this._results = [];
      this._lastQuery = "";
      this._detailProduct = null;
      this._selectedVariantId = null;
      this._loadingTimer = null;
      this._wishlist = loadWishlist();
      this._buildDom();
    }

    _buildDom() {
      var style = document.createElement("style");
      style.textContent = DISC_STYLES;

      var wrap = document.createElement("div");
      wrap.className = "disc-root";

      // --- full-screen takeover canvas -------------------------------
      this._canvas = document.createElement("div");
      this._canvas.className = "disc-canvas";

      this._canvasNav = document.createElement("div");
      this._canvasNav.className = "disc-canvas-nav";

      this._backBtn = document.createElement("button");
      this._backBtn.type = "button";
      this._backBtn.className = "disc-nav-btn disc-back";
      this._backBtn.innerHTML = DISC_CHEVRON_LEFT + "<span>Back</span>";
      this._backBtn.hidden = true;

      this._closeBtn = document.createElement("button");
      this._closeBtn.type = "button";
      this._closeBtn.className = "disc-nav-btn disc-close-canvas";
      this._closeBtn.setAttribute("aria-label", "Close");
      this._closeBtn.innerHTML = DISC_CLOSE_ICON;

      this._canvasNav.appendChild(this._backBtn);
      this._canvasNav.appendChild(this._closeBtn);

      this._body = document.createElement("div");
      this._body.className = "disc-body";

      // The detail view's glass card lives outside the scrolling body so
      // it stays pinned above the bar while the imagery scrolls behind
      // it — sticky positioning can't do that, since a sticky element
      // stops as soon as its own parent's content ends.
      this._overlay = document.createElement("div");
      this._overlay.className = "disc-overlay";
      this._overlay.hidden = true;

      this._canvas.appendChild(this._canvasNav);
      this._canvas.appendChild(this._body);
      this._canvas.appendChild(this._overlay);

      // --- the docked bar --------------------------------------------
      this._bar = document.createElement("div");
      this._bar.className = "disc-bar";

      var inputRow = document.createElement("div");
      inputRow.className = "disc-bar-row disc-bar-row--input";

      this._input = document.createElement("textarea");
      this._input.className = "disc-input";
      this._input.rows = 1;
      this._input.placeholder = "What are you looking for?";
      this._input.setAttribute("aria-label", "Search products");
      inputRow.appendChild(this._input);

      var controlsRow = document.createElement("div");
      controlsRow.className = "disc-bar-row disc-bar-row--controls";

      this._clearBtn = document.createElement("button");
      this._clearBtn.type = "button";
      this._clearBtn.className = "disc-clear";
      this._clearBtn.setAttribute("aria-label", "Clear");
      this._clearBtn.innerHTML = DISC_CLOSE_ICON;
      this._clearBtn.hidden = true;

      this._sendBtn = document.createElement("button");
      this._sendBtn.type = "button";
      this._sendBtn.className = "disc-send";
      this._sendBtn.disabled = true;
      this._sendBtn.setAttribute("aria-label", "Search");
      this._sendBtn.innerHTML = DISC_SEND_ICON;

      controlsRow.appendChild(this._clearBtn);
      controlsRow.appendChild(this._sendBtn);

      this._bar.appendChild(inputRow);
      this._bar.appendChild(controlsRow);

      wrap.appendChild(this._canvas);
      wrap.appendChild(this._bar);

      this._root.appendChild(style);
      this._root.appendChild(wrap);
    }

    connectedCallback() {
      // Host attributes must not be touched in the constructor (the
      // Custom Elements spec forbids it) — this is the first safe place.
      this.style.position = "fixed";
      this.style.inset = "0";
      this.style.zIndex = "2147483647";
      // The host covers the viewport so the canvas can fill it, but must
      // not swallow clicks on the merchant's page while Disc is idle —
      // only the bar and (when open) the canvas are interactive.
      this.style.pointerEvents = "none";

      this._keyboardOffset = 0;
      this._updateBarOffset();
      this._bindKeyboardOffset();

      bindPointerTracking(this._bar);
      bindPressSpring(this._bar, 0.985, 260, 28, "center bottom");
      bindPressSpring(this._sendBtn, 0.84, 380, 24, "center center");
      this._bindEvents();
    }

    // On-screen-keyboard avoidance (iOS/Android): visualViewport shrinks
    // when the keyboard opens, so lift the bar by that exact delta.
    // focusout is a fallback resync since visualViewport's resize event
    // doesn't reliably fire on iPad after the keyboard closes.
    _bindKeyboardOffset() {
      var vv = window.visualViewport;
      if (!vv) return;
      var self = this;
      var check = function () {
        var kb = window.innerHeight - vv.height - vv.offsetTop;
        self._keyboardOffset = kb > 150 ? Math.round(kb) : 0;
        self._updateBarOffset();
      };
      vv.addEventListener("resize", check);
      vv.addEventListener("scroll", check);
      document.addEventListener("focusout", function () {
        setTimeout(check, 150);
      });
    }

    _updateBarOffset() {
      var base = "max(20px, env(safe-area-inset-bottom, 20px))";
      this._bar.style.bottom = this._keyboardOffset
        ? "calc(" + base + " + " + this._keyboardOffset + "px)"
        : base;
    }

    _bindEvents() {
      var self = this;
      var debounced = debounce(function () {
        self._runSearch();
      }, CONFIG.debounceMs);

      this._input.addEventListener("input", function () {
        self._autoGrow();
        self._syncBarState();
        // Type-ahead only refines an already-open canvas; it shouldn't
        // yank a shopper out of a product they're reading.
        if (self.isOpen() && self._view !== "detail") debounced();
      });

      this._input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          // Shift+Enter falls through to the textarea's own newline.
          e.preventDefault();
          self._runSearch();
        } else if (e.key === "Escape") {
          self.closeCanvas();
          self._input.blur();
        }
      });

      this._sendBtn.addEventListener("click", function () {
        self._runSearch();
      });

      this._clearBtn.addEventListener("click", function () {
        self._input.value = "";
        self._autoGrow();
        self._syncBarState();
        self._input.focus();
      });

      this._closeBtn.addEventListener("click", function () {
        self.closeCanvas();
      });

      this._backBtn.addEventListener("click", function () {
        self.renderResults(self._results, self._lastQuery);
      });

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && self.isOpen()) self.closeCanvas();
      });

      // One delegated listener for everything inside the canvas, since
      // its contents are re-rendered wholesale on every view change.
      this._canvas.addEventListener("click", function (e) {
        var heart = e.target.closest("[data-wish]");
        if (heart) {
          e.preventDefault();
          e.stopPropagation();
          self.toggleWishlist(heart.getAttribute("data-wish"), heart);
          return;
        }
        var card = e.target.closest("[data-product]");
        if (card) {
          e.preventDefault();
          self.openDetail(card.getAttribute("data-product"));
          return;
        }
        var chip = e.target.closest("[data-chip]");
        if (chip) {
          var panel = self._canvas.querySelector(
            '[data-chip-panel="' + chip.getAttribute("data-chip") + '"]'
          );
          if (panel) {
            var open = panel.hasAttribute("hidden");
            panel.toggleAttribute("hidden", !open);
            chip.classList.toggle("disc-chip--open", open);
          }
          return;
        }
        var size = e.target.closest("[data-variant]");
        if (size) {
          self._selectVariant(size.getAttribute("data-variant"), size);
          return;
        }
        if (e.target.closest("[data-add-to-cart]")) {
          self._addToCart();
        }
      });
    }

    // Grows the textarea up to 120px as content wraps, then it scrolls
    // internally (native <textarea> behaviour, nothing disabled).
    _autoGrow() {
      this._input.style.height = "auto";
      this._input.style.height = Math.min(this._input.scrollHeight, 120) + "px";
    }

    _syncBarState() {
      var hasText = this._input.value.trim().length > 0;
      this._sendBtn.disabled = this._input.value.trim().length < 2;
      this._clearBtn.hidden = !hasText;
    }

    _setLoading(isLoading) {
      this._sendBtn.dataset.loading = isLoading ? "true" : "false";
      this._sendBtn.innerHTML = isLoading ? DISC_BUSY_ICON : DISC_SEND_ICON;
      this._sendBtn.setAttribute("aria-label", isLoading ? "Working" : "Search");
    }

    // -----------------------------------------------------------------
    // Canvas open/close
    // -----------------------------------------------------------------
    openCanvas() {
      this._canvas.classList.add("disc-canvas--visible");
      this.style.pointerEvents = "auto";
      // The store shouldn't scroll behind a full takeover.
      document.documentElement.style.overflow = "hidden";
    }

    closeCanvas() {
      this._clearOverlay();
      this._canvas.classList.remove("disc-canvas--visible");
      this.style.pointerEvents = "none";
      document.documentElement.style.overflow = "";
      this._stopLoadingRotation();
      this._view = null;
      this._backBtn.hidden = true;
    }

    isOpen() {
      return this._canvas.classList.contains("disc-canvas--visible");
    }

    _clearOverlay() {
      this._overlay.hidden = true;
      this._overlay.innerHTML = "";
      this._body.classList.remove("disc-body--detail");
    }

    // -----------------------------------------------------------------
    // Search
    // -----------------------------------------------------------------
    _runSearch() {
      var query = this._input.value.trim();
      if (query.length < 2) return;
      this._lastQuery = query;
      this.showLoading();
      this._setLoading(true);

      fetchResults(query)
        .then(
          function (data) {
            if (this._input.value.trim() !== query) return; // superseded
            if (data.status === "syncing") {
              this.showMessage(
                "Still learning this store’s catalog",
                "Disc is indexing the collection. Check back in a few minutes."
              );
            } else {
              this.renderResults(data.results, query);
            }
          }.bind(this)
        )
        .catch(
          function () {
            if (this._input.value.trim() !== query) return;
            this.showMessage(
              "Something went wrong",
              "Disc couldn’t reach the boutique just now. Please try again."
            );
          }.bind(this)
        )
        .then(
          function () {
            this._setLoading(false);
          }.bind(this)
        );
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------
    showLoading() {
      this._view = "loading";
      this._clearOverlay();
      this._backBtn.hidden = true;
      this._body.innerHTML =
        '<div class="disc-loading">' +
        DISC_ORNAMENT +
        '<h2 class="disc-loading-title">' +
        escapeHtml(DISC_THEME.loadingMessages[0]) +
        "</h2>" +
        '<svg class="disc-line-art" viewBox="0 0 400 200" fill="none" aria-hidden="true">' +
        '<path d="' +
        DISC_THEME.loadingPath +
        '" stroke="currentColor" stroke-width="1.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>' +
        "</svg>" +
        "</div>";
      this.openCanvas();
      this._startLoadingRotation();
    }

    // The headline cycles while the shopper waits — the wait becomes part
    // of the experience rather than a spinner.
    _startLoadingRotation() {
      this._stopLoadingRotation();
      var msgs = DISC_THEME.loadingMessages;
      if (msgs.length < 2) return;
      var i = 0;
      var self = this;
      this._loadingTimer = setInterval(function () {
        var el = self._body.querySelector(".disc-loading-title");
        if (!el) return self._stopLoadingRotation();
        i = (i + 1) % msgs.length;
        el.classList.add("disc-fade-out");
        setTimeout(function () {
          el.textContent = msgs[i];
          el.classList.remove("disc-fade-out");
        }, 300);
      }, 2200);
    }

    _stopLoadingRotation() {
      if (this._loadingTimer) clearInterval(this._loadingTimer);
      this._loadingTimer = null;
    }

    showMessage(title, body) {
      this._view = "message";
      this._clearOverlay();
      this._stopLoadingRotation();
      this._backBtn.hidden = true;
      this._body.innerHTML =
        '<div class="disc-loading">' +
        DISC_ORNAMENT +
        '<h2 class="disc-loading-title">' +
        escapeHtml(title) +
        "</h2>" +
        '<p class="disc-message-body">' +
        escapeHtml(body) +
        "</p></div>";
      this.openCanvas();
    }

    renderResults(results, query) {
      this._view = "results";
      this._clearOverlay();
      this._stopLoadingRotation();
      this._results = results || [];
      this._backBtn.hidden = true;

      if (!this._results.length) {
        this.showMessage(
          "Nothing quite matches yet",
          "Try describing the occasion, the fabric, or the feeling you’re after."
        );
        return;
      }

      var html =
        '<div class="disc-results">' +
        '<header class="disc-results-head">' +
        DISC_ORNAMENT +
        '<h2 class="disc-heading">' +
        escapeHtml(DISC_THEME.resultsHeading) +
        "</h2>" +
        '<p class="disc-subhead">for “' +
        escapeHtml(query) +
        "”</p>" +
        "</header>" +
        '<div class="disc-grid">' +
        this._results.map(this._cardHtml.bind(this)).join("") +
        "</div></div>";

      this._body.innerHTML = html;
      this._body.scrollTop = 0;
      this.openCanvas();
    }

    _cardHtml(item) {
      var wished = this._wishlist.indexOf(item.id) !== -1;
      return (
        '<article class="disc-card" data-product="' +
        escapeAttr(item.id) +
        '">' +
        '<div class="disc-card-media">' +
        '<img src="' +
        escapeAttr(absoluteUrl(item.image_url)) +
        '" alt="" loading="lazy">' +
        '<button class="disc-heart' +
        (wished ? " disc-heart--on" : "") +
        '" data-wish="' +
        escapeAttr(item.id) +
        '" aria-label="Save">' +
        DISC_HEART_ICON +
        "</button>" +
        "</div>" +
        '<div class="disc-card-foot">' +
        '<span class="disc-card-title">' +
        escapeHtml(item.title) +
        "</span>" +
        '<span class="disc-card-chevron">' +
        DISC_CHEVRON_RIGHT +
        "</span>" +
        "</div>" +
        (item.reasoning
          ? '<p class="disc-card-note">' + escapeHtml(item.reasoning) + "</p>"
          : "") +
        "</article>"
      );
    }

    // -----------------------------------------------------------------
    // Product detail
    // -----------------------------------------------------------------
    openDetail(productId) {
      var self = this;
      this._view = "detail";
      this._selectedVariantId = null;
      this._backBtn.hidden = false;
      fetchProduct(productId)
        .then(function (product) {
          self._detailProduct = product;
          self.renderDetail(product);
          return fetchLook(productId);
        })
        .then(function (look) {
          self._renderLook(look.results || []);
        })
        .catch(function () {
          self.showMessage(
            "Couldn’t open this piece",
            "Please try again in a moment."
          );
        });
    }

    renderDetail(p) {
      var wished = this._wishlist.indexOf(p.id) !== -1;
      var images = (p.images && p.images.length ? p.images : [p.image_url])
        .map(function (src) {
          return (
            '<div class="disc-shot"><img src="' +
            escapeAttr(absoluteUrl(src)) +
            '" alt="" loading="lazy"></div>'
          );
        })
        .join("");

      var sizes = (p.variants || [])
        .map(function (v) {
          return (
            '<button class="disc-size' +
            (v.available ? "" : " disc-size--out") +
            '" data-variant="' +
            escapeAttr(v.id) +
            '"' +
            (v.available ? "" : " disabled") +
            ">" +
            escapeHtml(v.title) +
            "</button>"
          );
        })
        .join("");

      this._body.innerHTML = '<div class="disc-shots">' + images + "</div>";
      this._body.classList.add("disc-body--detail");

      this._overlay.hidden = false;
      this._overlay.innerHTML =
        '<div class="disc-detail-ui">' +
        '<div class="disc-detail-secondary">' +
        '<div class="disc-chips">' +
        '<button class="disc-chip" data-chip="materials">MATERIALS <i>+</i></button>' +
        '<button class="disc-chip" data-chip="style">HOW TO STYLE <i>+</i></button>' +
        "</div>" +
        '<div class="disc-chip-panel" data-chip-panel="materials" hidden>' +
        escapeHtml(p.description || "") +
        "</div>" +
        '<div class="disc-chip-panel" data-chip-panel="style" hidden>' +
        escapeHtml(p.reasoning || "") +
        "</div>" +
        '<div class="disc-look" hidden></div>' +
        "</div>" +
        '<div class="disc-buy">' +
        '<div class="disc-buy-head">' +
        '<img class="disc-buy-thumb" src="' +
        escapeAttr(absoluteUrl(p.image_url)) +
        '" alt="">' +
        '<div class="disc-buy-meta">' +
        '<div class="disc-buy-title">' +
        escapeHtml(p.title) +
        "</div>" +
        '<div class="disc-buy-price">' +
        formatPrice(p.price, p.currency) +
        "</div>" +
        (p.colour
          ? '<div class="disc-buy-colour">' + escapeHtml(p.colour) + "</div>"
          : "") +
        "</div>" +
        '<button class="disc-heart disc-heart--lg' +
        (wished ? " disc-heart--on" : "") +
        '" data-wish="' +
        escapeAttr(p.id) +
        '" aria-label="Save">' +
        DISC_HEART_ICON +
        "</button>" +
        "</div>" +
        (sizes ? '<div class="disc-sizes">' + sizes + "</div>" : "") +
        '<div class="disc-buy-actions">' +
        '<button class="disc-btn disc-btn--primary" data-add-to-cart>Add to cart</button>' +
        '<span class="disc-buy-hint"></span>' +
        "</div>" +
        "</div></div>";

      this.openCanvas();
      this._body.scrollTop = 0;
    }

    _renderLook(items) {
      var host = this._overlay.querySelector(".disc-look");
      if (!host || !items.length) return;
      host.hidden = false;
      host.innerHTML =
        '<div class="disc-look-title">Complete the look</div>' +
        '<div class="disc-look-row">' +
        items
          .map(
            function (it) {
              var wished = this._wishlist.indexOf(it.id) !== -1;
              return (
                '<div class="disc-look-item" data-product="' +
                escapeAttr(it.id) +
                '">' +
                '<img src="' +
                escapeAttr(absoluteUrl(it.image_url)) +
                '" alt="" loading="lazy">' +
                '<button class="disc-heart disc-heart--sm' +
                (wished ? " disc-heart--on" : "") +
                '" data-wish="' +
                escapeAttr(it.id) +
                '" aria-label="Save">' +
                DISC_HEART_ICON +
                "</button>" +
                '<span class="disc-look-name">' +
                escapeHtml(it.title) +
                "</span>" +
                "</div>"
              );
            }.bind(this)
          )
          .join("") +
        "</div>";
    }

    _selectVariant(variantId, el) {
      this._selectedVariantId = variantId;
      var all = this._overlay.querySelectorAll("[data-variant]");
      all.forEach(function (b) {
        b.classList.toggle("disc-size--on", b === el);
      });
      var hint = this._overlay.querySelector(".disc-buy-hint");
      if (hint) hint.textContent = "";
    }

    _addToCart() {
      var p = this._detailProduct;
      if (!p) return;
      var hint = this._overlay.querySelector(".disc-buy-hint");
      var variants = p.variants || [];

      // Mirrors how real storefronts behave: a multi-size product can't
      // be added until a size is chosen.
      if (variants.length > 1 && !this._selectedVariantId) {
        if (hint) hint.textContent = "Select a size first";
        return;
      }
      var variantId = this._selectedVariantId || (variants[0] && variants[0].id);

      addToCart(variantId)
        .then(function (mode) {
          if (!hint) return;
          hint.textContent =
            mode === "demo" ? "Added (demo — no cart on this page)" : "Added to cart";
        })
        .catch(function () {
          if (hint) hint.textContent = "Couldn’t add to cart";
        });
    }

    // -----------------------------------------------------------------
    // Wishlist — persisted locally; no account, no PII, nothing sent.
    // -----------------------------------------------------------------
    toggleWishlist(id, el) {
      var i = this._wishlist.indexOf(id);
      if (i === -1) this._wishlist.push(id);
      else this._wishlist.splice(i, 1);
      saveWishlist(this._wishlist);
      // Every heart for this product, wherever it appears on screen.
      this._canvas.querySelectorAll('[data-wish="' + cssEscape(id) + '"]').forEach(
        function (node) {
          node.classList.toggle("disc-heart--on", i === -1);
        }
      );
      if (el) el.classList.toggle("disc-heart--on", i === -1);
    }
  }

  customElements.define("disc-search-bar", DiscSearchBar);

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }

  function cssEscape(str) {
    return String(str).replace(/["\\]/g, "\\$&");
  }

  // Backend-relative paths (the generated demo placeholders) need the API
  // origin prepended; a merchant's real CDN URLs are already absolute.
  function absoluteUrl(src) {
    if (!src) return "";
    if (/^(https?:)?\/\//.test(src) || src.indexOf("data:") === 0) return src;
    return CONFIG.apiUrl.replace(/\/$/, "") + src;
  }

  function formatPrice(value, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format(value);
    } catch (e) {
      return (currency || "$") + Number(value).toFixed(2);
    }
  }

  function loadWishlist() {
    try {
      return JSON.parse(localStorage.getItem("disc:wishlist") || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveWishlist(list) {
    try {
      localStorage.setItem("disc:wishlist", JSON.stringify(list));
    } catch (e) {
      /* private mode — the session still works, it just won't persist */
    }
  }

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
  // Networking
  // ---------------------------------------------------------------------
  function detectShop() {
    // Every Shopify storefront injects this global, which is what makes
    // multi-tenancy zero-config: nothing to paste into the script tag.
    if (window.Shopify && window.Shopify.shop) return window.Shopify.shop;
    return null;
  }

  function shopParam() {
    var shop = detectShop();
    return shop ? "?shop=" + encodeURIComponent(shop) : "";
  }

  function fetchResults(query) {
    return fetch(CONFIG.apiUrl + "/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query,
        limit: CONFIG.resultLimit,
        shop: detectShop(),
      }),
    }).then(function (res) {
      if (!res.ok) throw new Error("Disc search failed: " + res.status);
      return res.json();
    });
  }

  function fetchProduct(id) {
    return fetch(CONFIG.apiUrl + "/product/" + encodeURIComponent(id) + shopParam()).then(
      function (res) {
        if (!res.ok) throw new Error("Disc product failed: " + res.status);
        return res.json();
      }
    );
  }

  function fetchLook(id) {
    return fetch(CONFIG.apiUrl + "/look/" + encodeURIComponent(id) + shopParam()).then(
      function (res) {
        if (!res.ok) throw new Error("Disc look failed: " + res.status);
        return res.json();
      }
    );
  }

  // Real add-to-cart goes through Shopify's own AJAX Cart API on the
  // merchant's domain — Disc never proxies commerce. On a page that isn't
  // a Shopify storefront (this repo's test.html) there is no cart to add
  // to, so it resolves as "demo" and the UI says so rather than pretending.
  function addToCart(variantId) {
    if (!detectShop()) return Promise.resolve("demo");
    return fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
    }).then(function (res) {
      if (!res.ok) throw new Error("cart add failed");
      return "live";
    });
  }

  // ---------------------------------------------------------------------
  // Pointer-tracked specular highlight. Plain alpha compositing (no
  // mix-blend-mode) so it stays visible regardless of what's behind the
  // glass: overlay/soft-light both go nearly invisible against an
  // already-light base, which is exactly this widget's light surface.
  // ---------------------------------------------------------------------
  function bindPointerTracking(el) {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    var raf = null;
    el.addEventListener("pointermove", function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var px = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
        var py = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
        var angle = (Math.atan2(py - 50, px - 50) * 180) / Math.PI + 90;
        el.style.setProperty("--disc-mx", px.toFixed(1) + "%");
        el.style.setProperty("--disc-my", py.toFixed(1) + "%");
        el.style.setProperty("--disc-rim-angle", angle.toFixed(1) + "deg");
      });
    });
    el.addEventListener("pointerleave", function () {
      el.style.setProperty("--disc-mx", "30%");
      el.style.setProperty("--disc-my", "0%");
      el.style.setProperty("--disc-rim-angle", "135deg");
    });
  }

  // ---------------------------------------------------------------------
  // Spring-physics press "squish": a real per-frame spring integration
  // (stepped at a fixed 1/60s, kept numerically identical to the
  // reference implementation rather than made frame-rate-independent),
  // not a CSS transition. Anything driven by this must not also list
  // `transform` in its CSS transition — they'd fight each other.
  // ---------------------------------------------------------------------
  function bindPressSpring(el, pressedScale, stiffness, damping, origin) {
    el.style.transformOrigin = origin;
    el.style.willChange = "transform";
    var target = 1,
      pos = 1,
      vel = 0,
      raf = null;

    function tick() {
      var disp = pos - target;
      vel += (-stiffness * disp - damping * vel) / 60;
      pos += vel / 60;
      el.style.transform = "scale(" + pos + ")";
      if (Math.abs(disp) > 5e-4 || Math.abs(vel) > 5e-4) raf = requestAnimationFrame(tick);
      else raf = null;
    }
    function setTarget(v) {
      target = v;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    el.addEventListener("pointerdown", function () {
      setTarget(pressedScale);
    });
    el.addEventListener("pointerup", function () {
      setTarget(1);
    });
    el.addEventListener("pointerleave", function () {
      setTarget(1);
    });
  }

  // ---------------------------------------------------------------------
  // Icons
  // ---------------------------------------------------------------------
  var DISC_SEND_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 19V5M12 5L6 11M12 5L18 11" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var DISC_BUSY_ICON = '<span class="disc-busy-square" aria-hidden="true"></span>';

  var DISC_CLOSE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round"/></svg>';

  var DISC_CHEVRON_LEFT =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M15 5L8 12L15 19" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var DISC_CHEVRON_RIGHT =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 5L16 12L9 19" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var DISC_HEART_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 20.5S3.5 15 3.5 9.2A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.5 2.6c0 5.8-8.5 11.3-8.5 11.3Z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

  // A small typographic flourish above headings — the editorial cue that
  // separates a boutique from a search results page.
  var DISC_ORNAMENT =
    '<svg class="disc-ornament" viewBox="0 0 80 12" fill="none" aria-hidden="true">' +
    '<path d="M2 6h22M56 6h22M32 6c0-3 3-4 5-2s3 4 5 2 3-4 5-2" stroke="currentColor" ' +
    'stroke-width="0.9" stroke-linecap="round"/></svg>';

  // ---------------------------------------------------------------------
  // Styles — entirely scoped to the Shadow DOM. Nothing here leaks into
  // (or is affected by) the merchant's theme stylesheet.
  // ---------------------------------------------------------------------
  var DISC_STYLES = `
    @property --disc-mx { syntax: '<percentage>'; inherits: false; initial-value: 30%; }
    @property --disc-my { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
    @property --disc-rim-angle { syntax: '<angle>'; inherits: false; initial-value: 135deg; }

    :host {
      all: initial;
      --disc-canvas: ${DISC_THEME.canvas};
      --disc-ink: ${DISC_THEME.ink};
      --disc-serif: ${DISC_THEME.serif};
      --disc-sans: -apple-system, "SF Pro Text", Inter, system-ui, "Segoe UI", sans-serif;
      --disc-glass-top: rgba(255,255,255,0.5);
      --disc-glass-bottom: rgba(255,255,255,0.26);
      --disc-rim-1: rgba(255,255,255,0.95);
      --disc-rim-2: rgba(255,255,255,0.08);
      --disc-text: #1d1d1f;
      --disc-text-secondary: #6e6e73;
      --disc-hover: rgba(0,0,0,0.06);
      --disc-shadow-ambient: rgba(0,0,0,0.3);
      --disc-shadow-contact: rgba(0,0,0,0.16);
      --disc-divider: rgba(0,0,0,0.09);
      --disc-specular: rgba(255,255,255,0.85);
      --disc-specular-opacity: 0.4;
      --disc-text-shadow: rgba(255,255,255,0.55);
      --disc-accent-contrast: #ffffff;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* Beats the display rules below; without this, the hidden attribute is
       a no-op on anything given an explicit display value. */
    [hidden] { display: none !important; }

    .disc-root { position: absolute; inset: 0; font-family: var(--disc-sans); color: var(--disc-text); }

    /* ---------------- full-screen takeover canvas ---------------- */
    .disc-canvas {
      position: absolute;
      inset: 0;
      background: var(--disc-canvas);
      color: var(--disc-ink);
      opacity: 0;
      pointer-events: none;
      transform: scale(1.01);
      transition: opacity 0.42s cubic-bezier(0.22,1,0.36,1), transform 0.42s cubic-bezier(0.22,1,0.36,1);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .disc-canvas--visible { opacity: 1; pointer-events: auto; transform: scale(1); }

    .disc-canvas-nav {
      position: absolute; top: 0; left: 0; right: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 18px; z-index: 3;
      pointer-events: none;
    }
    .disc-nav-btn {
      pointer-events: auto;
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid rgba(128,128,128,0.28); cursor: pointer;
      font: inherit; font-size: 13px;
      color: var(--disc-ink);
      background: rgba(128,128,128,0.16);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-radius: 9999px; padding: 8px 14px 8px 10px;
      transition: background-color 0.15s ease;
    }
    .disc-nav-btn:hover { background: rgba(128,128,128,0.3); }
    .disc-nav-btn svg { width: 15px; height: 15px; }
    /* Stays hard right even when the Back button beside it is hidden. */
    .disc-close-canvas { padding: 9px; margin-left: auto; }
    .disc-close-canvas svg { width: 16px; height: 16px; }

    .disc-body {
      flex: 1; overflow-y: auto; overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 190px; /* clears the docked bar */
    }

    /* ---------------- loading ---------------- */
    .disc-loading {
      min-height: 62vh;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 22px; padding: 90px 24px 40px; text-align: center;
    }
    .disc-ornament { width: 74px; height: 11px; color: var(--disc-ink); opacity: 0.45; }
    .disc-loading-title {
      font-family: var(--disc-serif);
      font-size: clamp(26px, 4.6vw, 46px);
      font-weight: 400; letter-spacing: -0.015em; line-height: 1.15;
      transition: opacity 0.3s ease;
    }
    .disc-loading-title.disc-fade-out { opacity: 0; }
    .disc-message-body {
      font-size: 14px; color: var(--disc-ink); opacity: 0.62; max-width: 40ch; line-height: 1.5;
    }
    .disc-line-art {
      width: min(460px, 78vw); height: auto; color: var(--disc-ink); opacity: 0.55;
      stroke-dasharray: 1400; stroke-dashoffset: 1400;
      animation: disc-draw 3.2s ease-in-out infinite;
    }
    @keyframes disc-draw {
      0%   { stroke-dashoffset: 1400; }
      55%  { stroke-dashoffset: 0; }
      85%  { stroke-dashoffset: 0; opacity: 0.55; }
      100% { stroke-dashoffset: 0; opacity: 0; }
    }

    /* ---------------- results ---------------- */
    .disc-results-head {
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      padding: 92px 24px 44px; text-align: center;
    }
    .disc-heading {
      font-family: var(--disc-serif);
      font-size: clamp(26px, 4.4vw, 44px);
      font-weight: 400; letter-spacing: -0.015em; line-height: 1.15;
    }
    .disc-subhead { font-size: 13px; color: var(--disc-ink); opacity: 0.6; font-style: italic; }

    .disc-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 1px;
      background: rgba(128,128,128,0.22);
      border-top: 1px solid rgba(128,128,128,0.22);
    }
    .disc-card { background: var(--disc-canvas); cursor: pointer; display: flex; flex-direction: column; }
    .disc-card-media { position: relative; aspect-ratio: 3 / 4; overflow: hidden; background: rgba(128,128,128,0.12); }
    .disc-card-media img {
      width: 100%; height: 100%; object-fit: cover; display: block;
      transition: transform 0.7s cubic-bezier(0.22,1,0.36,1);
    }
    .disc-card:hover .disc-card-media img { transform: scale(1.035); }
    .disc-card-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 13px 16px 4px;
    }
    .disc-card-title { font-size: 13.5px; letter-spacing: 0.01em; }
    .disc-card-chevron svg { width: 13px; height: 13px; opacity: 0.5; display: block; }
    .disc-card-note {
      font-size: 11.5px; line-height: 1.45; color: var(--disc-ink); opacity: 0.62;
      padding: 0 16px 16px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }

    .disc-heart {
      position: absolute; right: 10px; bottom: 10px;
      width: 32px; height: 32px; border-radius: 9999px; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.82);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06);
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      color: #1d1d1f;
      transition: transform 0.18s cubic-bezier(0.34,1.56,0.64,1), background-color 0.15s ease;
    }
    .disc-heart svg { width: 16px; height: 16px; }
    .disc-heart:hover { transform: scale(1.1); }
    .disc-heart--on svg path { fill: currentColor; }
    .disc-heart--sm { width: 26px; height: 26px; right: 6px; bottom: 6px; }
    .disc-heart--sm svg { width: 13px; height: 13px; }
    .disc-heart--lg { position: static; width: 36px; height: 36px; background: transparent; }

    /* ---------------- detail ---------------- */
    .disc-shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1px; }
    .disc-shot { aspect-ratio: 3 / 4; background: rgba(128,128,128,0.12); }
    .disc-shot img { width: 100%; height: 100%; object-fit: cover; display: block; }

    /* Pinned above the bar, outside the scroll flow, so product imagery
       scrolls behind a stationary card — the arrangement the reference
       experience uses. */
    .disc-overlay {
      position: absolute; left: 0; right: 0;
      bottom: calc(150px + env(safe-area-inset-bottom, 0px));
      z-index: 4; pointer-events: none;
    }
    .disc-detail-ui {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      padding: 0 clamp(14px, 4vw, 40px);
      max-height: calc(100dvh - 200px);
    }
    .disc-detail-ui > * { pointer-events: auto; }
    /* Only the secondary surfaces scroll. The buy card is flex-shrink:0 and
       sits outside this box, so a short viewport (a phone in landscape) can
       never push Add to cart out of reach — it clips the chips instead. */
    .disc-detail-secondary {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      min-height: 0; overflow-y: auto; overscroll-behavior: contain;
      scrollbar-width: none;
    }
    .disc-detail-secondary::-webkit-scrollbar { display: none; }
    .disc-buy { flex-shrink: 0; }
    /* Detail imagery needs to clear both the bar and the pinned card. */
    .disc-body--detail { padding-bottom: 340px; }

    .disc-chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .disc-chip {
      display: inline-flex; align-items: center; gap: 9px;
      border: none; cursor: pointer; font: inherit;
      font-size: 11px; letter-spacing: 0.09em;
      color: var(--disc-accent-contrast);
      background: rgba(60,58,55,0.55);
      backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-radius: 9999px; padding: 10px 16px;
      transition: background-color 0.18s ease;
    }
    .disc-chip:hover { background: rgba(60,58,55,0.72); }
    .disc-chip i { font-style: normal; opacity: 0.75; }
    .disc-chip--open i { transform: rotate(45deg); display: inline-block; }
    .disc-chip-panel {
      max-width: 560px; font-size: 12.5px; line-height: 1.55;
      color: var(--disc-accent-contrast);
      background: rgba(60,58,55,0.6);
      backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-radius: 18px; padding: 14px 18px;
    }

    .disc-look {
      background: rgba(60,58,55,0.55);
      backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-radius: 20px; padding: 12px 14px; color: var(--disc-accent-contrast);
      max-width: min(560px, calc(100vw - 28px));
    }
    .disc-look-title { font-size: 10.5px; letter-spacing: 0.11em; text-transform: uppercase; opacity: 0.8; margin-bottom: 10px; }
    .disc-look-row { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; }
    .disc-look-row::-webkit-scrollbar { display: none; }
    .disc-look-item { position: relative; flex: 0 0 84px; cursor: pointer; }
    .disc-look-item img { width: 84px; height: 104px; object-fit: cover; border-radius: 12px; display: block; }
    .disc-look-name {
      display: block; font-size: 10px; margin-top: 6px; opacity: 0.85;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 84px;
    }

    .disc-buy {
      background: rgba(60,58,55,0.58);
      backdrop-filter: blur(28px) saturate(190%); -webkit-backdrop-filter: blur(28px) saturate(190%);
      border-radius: 22px; padding: 14px; color: var(--disc-accent-contrast);
      width: min(520px, calc(100vw - 28px));
      box-shadow: 0 18px 40px -14px rgba(0,0,0,0.4);
    }
    .disc-buy-head { display: flex; align-items: flex-start; gap: 13px; }
    .disc-buy-thumb { width: 58px; height: 72px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
    .disc-buy-meta { flex: 1; min-width: 0; }
    .disc-buy-title { font-size: 15px; letter-spacing: -0.005em; }
    .disc-buy-price { font-size: 13.5px; margin-top: 5px; font-variant-numeric: tabular-nums; }
    .disc-buy-colour { font-size: 12px; opacity: 0.75; margin-top: 3px; }

    .disc-sizes { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 13px; }
    .disc-size {
      min-width: 42px; padding: 8px 11px; border-radius: 9999px; cursor: pointer; font: inherit;
      font-size: 12.5px; color: var(--disc-accent-contrast);
      background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.2);
      transition: background-color 0.15s ease, transform 0.15s cubic-bezier(0.34,1.56,0.64,1);
    }
    .disc-size:hover:not(:disabled) { background: rgba(255,255,255,0.26); }
    .disc-size--on { background: #fff; color: var(--disc-ink); border-color: #fff; }
    .disc-size--out { opacity: 0.34; cursor: default; text-decoration: line-through; }

    .disc-buy-actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
    .disc-btn {
      border: none; cursor: pointer; font: inherit; font-size: 13.5px;
      border-radius: 9999px; padding: 12px 26px;
      transition: transform 0.15s cubic-bezier(0.34,1.56,0.64,1), opacity 0.15s ease;
    }
    .disc-btn--primary { background: #fff; color: var(--disc-ink); }
    .disc-btn--primary:hover { transform: scale(1.03); }
    .disc-btn--primary:active { transform: scale(0.96); }
    .disc-buy-hint { font-size: 11.5px; opacity: 0.85; }

    /* ---------------- the docked bar ---------------- */
    .disc-bar {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: min(640px, calc(100vw - 32px));
      pointer-events: auto;
      z-index: 5;
      isolation: isolate;
      display: flex; flex-direction: column; gap: 14px;
      padding: 18px 20px 16px;
      border-radius: 30px;
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
      text-shadow: 0 1px 2px var(--disc-text-shadow);
    }
    .disc-bar::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit;
      background: radial-gradient(circle at var(--disc-mx) var(--disc-my), var(--disc-specular), transparent 45%);
      opacity: var(--disc-specular-opacity); pointer-events: none;
      transition: --disc-mx 0.45s ease, --disc-my 0.45s ease, --disc-rim-angle 0.45s ease;
    }

    .disc-bar-row--input { display: flex; }
    .disc-bar-row--controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }

    .disc-input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      resize: none; overflow: hidden; font: inherit;
      font-size: 16.5px; font-weight: 480; line-height: 1.5;
      color: var(--disc-text); padding: 2px; min-height: 24px; max-height: 120px;
    }
    .disc-input::placeholder { color: var(--disc-text-secondary); }

    .disc-clear, .disc-send {
      flex-shrink: 0; width: 44px; height: 44px; border-radius: 9999px;
      display: flex; align-items: center; justify-content: center;
      border: none; padding: 0; cursor: pointer; font: inherit;
    }
    .disc-clear { background: var(--disc-hover); color: var(--disc-text-secondary); }
    .disc-clear:hover { background: rgba(0,0,0,0.12); }
    .disc-clear svg { width: 16px; height: 16px; }
    .disc-send {
      background: var(--disc-text); color: var(--disc-accent-contrast);
      /* transform is driven per-frame by bindPressSpring — animating it
         here too would fight that. */
      transition: background-color 0.15s ease, opacity 0.15s ease;
    }
    .disc-send svg { width: 18px; height: 18px; }
    .disc-send:disabled { background: rgba(120,120,128,0.18); color: var(--disc-text-secondary); cursor: default; opacity: 0.7; }
    .disc-send[data-loading="true"] { background: var(--disc-glass-top); border: 1px solid var(--disc-divider); cursor: default; }
    .disc-busy-square { width: 11px; height: 11px; border-radius: 3px; background: var(--disc-text); display: block; }

    @media (max-height: 520px) {
      .disc-overlay { bottom: calc(126px + env(safe-area-inset-bottom, 0px)); }
      .disc-look-item { flex: 0 0 58px; }
      .disc-look-item img { width: 58px; height: 72px; }
      .disc-look-name { display: none; }
      .disc-buy-thumb { width: 44px; height: 54px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .disc-canvas, .disc-card-media img, .disc-heart, .disc-btn { transition: opacity 0.15s ease; transform: none; }
      .disc-line-art { animation: none; stroke-dashoffset: 0; }
    }
  `;

  // ---------------------------------------------------------------------
  // Boot. The bar mounts immediately and is usable straight away; a
  // separate scanner hides the theme's own search input whenever it turns
  // up, since merchants don't need two search boxes once Disc is
  // installed. visibility:hidden (not display:none) preserves its layout
  // space so nothing in the theme reflows around a collapsed box.
  // ---------------------------------------------------------------------
  function init() {
    if (document.querySelector("disc-search-bar")) return;
    document.body.appendChild(document.createElement("disc-search-bar"));

    var interval = setInterval(function () {
      var input = document.querySelector(CONFIG.searchSelectors);
      if (input) {
        clearInterval(interval);
        input.style.visibility = "hidden";
      }
    }, CONFIG.scanIntervalMs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
