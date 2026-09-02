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

  // Last-resort read of the key straight off the script's own src
  // (…/embed.js?k=disc_xxx). /embed.js normally injects it as config
  // before this file runs, so this only matters if a merchant pastes the
  // URL somewhere that strips the prelude — a broken bar is a worse
  // failure than one extra parse.
  function _keyFromScriptUrl() {
    try {
      var src = (CURRENT_SCRIPT && CURRENT_SCRIPT.src) || "";
      var match = src.match(/[?&]k=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
      return null;
    }
  }

  var CONFIG = {
    apiUrl:
      (CURRENT_SCRIPT && CURRENT_SCRIPT.dataset.apiUrl) ||
      USER_CONFIG.apiUrl ||
      "http://localhost:8000",
    // Which tenant this install belongs to. Disc is sold direct rather
    // than through the App Store, so there is no OAuth handshake to
    // identify the store — the merchant pastes a script tag carrying
    // this key instead. /embed.js bakes it in, so the merchant never
    // types it; the dataset and DiscConfig routes exist for anyone
    // self-hosting the file.
    siteKey:
      (CURRENT_SCRIPT && CURRENT_SCRIPT.dataset.siteKey) ||
      USER_CONFIG.siteKey ||
      _keyFromScriptUrl() ||
      null,
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
      this._photos = [];
      this._lookItems = [];
      this._lookPage = 0;
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
      // A single-row pill: round + at the left, query text between, round
      // send at the right, with a clear appearing beside send once there
      // is text. Tapping + swaps the row for a nested tools pill.
      this._bar = document.createElement("div");
      this._bar.className = "disc-bar";

      this._barInner = document.createElement("div");
      this._barInner.className = "disc-bar-inner";

      this._plusBtn = document.createElement("button");
      this._plusBtn.type = "button";
      this._plusBtn.className = "disc-round disc-plus";
      this._plusBtn.setAttribute("aria-label", "More");
      this._plusBtn.innerHTML = DISC_PLUS_ICON;

      this._input = document.createElement("textarea");
      this._input.className = "disc-input";
      this._input.rows = 1;
      this._input.placeholder = "What are you looking for?";
      this._input.setAttribute("aria-label", "Search products");

      this._clearBtn = document.createElement("button");
      this._clearBtn.type = "button";
      this._clearBtn.className = "disc-clear";
      this._clearBtn.setAttribute("aria-label", "Clear");
      this._clearBtn.innerHTML = DISC_CLOSE_ICON;
      this._clearBtn.hidden = true;

      this._sendBtn = document.createElement("button");
      this._sendBtn.type = "button";
      this._sendBtn.className = "disc-round disc-send";
      this._sendBtn.disabled = true;
      this._sendBtn.setAttribute("aria-label", "Search");
      this._sendBtn.innerHTML = DISC_SEND_ICON;

      this._barInner.appendChild(this._plusBtn);
      this._barInner.appendChild(this._input);
      this._barInner.appendChild(this._clearBtn);
      this._barInner.appendChild(this._sendBtn);

      this._tools = document.createElement("div");
      this._tools.className = "disc-tools";
      this._tools.hidden = true;
      this._tools.innerHTML =
        '<button type="button" class="disc-tool disc-tool-close" aria-label="Close">' +
        DISC_CLOSE_ICON +
        "</button>" +
        '<span class="disc-tool-div"></span>' +
        '<button type="button" class="disc-tool disc-tool-attach" aria-label="Attach a photo">' +
        DISC_CLIP_ICON +
        "</button>" +
        '<span class="disc-tool-div"></span>' +
        '<button type="button" class="disc-tool disc-tool-write" aria-label="Write">' +
        DISC_COMPOSE_ICON +
        "</button>";

      // Attached-photo previews, shown above the row like the reference.
      this._thumbs = document.createElement("div");
      this._thumbs.className = "disc-thumbs";
      this._thumbs.hidden = true;

      this._fileInput = document.createElement("input");
      this._fileInput.type = "file";
      this._fileInput.accept = "image/*";
      this._fileInput.multiple = true;
      this._fileInput.style.display = "none";

      this._bar.appendChild(this._thumbs);
      this._bar.appendChild(this._barInner);
      this._bar.appendChild(this._tools);
      this._bar.appendChild(this._fileInput);

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

    // Measured off the reference: over the store (nothing open) the bar
    // floats in the lower third, centred at ~72% of viewport height (23dvh clearance below);
    // once the canvas opens it docks to the bottom. Same bar, two
    // resting positions, following what's happening.
    _updateBarOffset() {
      var base = this.isOpen()
        ? "max(20px, env(safe-area-inset-bottom, 20px))"
        : "max(20px, calc(23dvh + env(safe-area-inset-bottom, 0px)))";
      this._bar.style.bottom = this._keyboardOffset
        ? "calc(" + base + " + " + this._keyboardOffset + "px)"
        : base;
      this._bar.style.transition = "bottom 0.45s cubic-bezier(0.22, 1, 0.36, 1)";
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

      this._plusBtn.addEventListener("click", function () {
        self._setTools(true);
      });
      this._tools.querySelector(".disc-tool-close").addEventListener("click", function () {
        self._setTools(false);
      });
      this._tools.querySelector(".disc-tool-attach").addEventListener("click", function () {
        self._fileInput.click();
      });
      this._tools.querySelector(".disc-tool-write").addEventListener("click", function () {
        self._setTools(false);
        self._input.focus();
      });
      this._fileInput.addEventListener("change", function (e) {
        self._attachPhotos(e.target.files);
        self._fileInput.value = "";
      });
      this._thumbs.addEventListener("click", function (e) {
        var rm = e.target.closest("[data-rm]");
        if (rm) self._removePhoto(Number(rm.getAttribute("data-rm")));
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
          self._toggleChip(chip.getAttribute("data-chip"));
          return;
        }
        var pager = e.target.closest("[data-look-page]");
        if (pager) {
          var dir = Number(pager.getAttribute("data-look-page"));
          var pages = Math.max(1, Math.ceil(self._lookItems.length / 4));
          self._lookPage = (self._lookPage + dir + pages) % pages;
          self._paintLookPage();
          return;
        }
        if (e.target.closest("[data-select-size]")) {
          var sizeRow = self._overlay.querySelector(".disc-sizes");
          if (sizeRow) sizeRow.hidden = !sizeRow.hidden;
          return;
        }
        if (e.target.closest("[data-close-detail]")) {
          self.renderResults(self._results, self._lastQuery);
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

    _setTools(open) {
      this._tools.hidden = !open;
      this._barInner.hidden = open;
    }

    _attachPhotos(files) {
      if (!files || !files.length) return;
      var self = this;
      Array.prototype.slice.call(files, 0, 8).forEach(function (file) {
        var reader = new FileReader();
        reader.onload = function (ev) {
          self._photos.push({ url: ev.target.result });
          self._renderThumbs();
        };
        reader.readAsDataURL(file);
      });
      this._setTools(false);
    }

    _removePhoto(i) {
      this._photos.splice(i, 1);
      this._renderThumbs();
    }

    _renderThumbs() {
      this._thumbs.hidden = this._photos.length === 0;
      this._thumbs.innerHTML = this._photos
        .map(function (p, i) {
          return (
            '<span class="disc-thumb"><img src="' +
            escapeAttr(p.url) +
            '" alt="">' +
            '<button type="button" class="disc-thumb-rm" data-rm="' +
            i +
            '" aria-label="Remove">' +
            DISC_CLOSE_ICON +
            "</button></span>"
          );
        })
        .join("");
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
      this._updateBarOffset();
      this.style.pointerEvents = "auto";
      // The store shouldn't scroll behind a full takeover.
      document.documentElement.style.overflow = "hidden";
    }

    closeCanvas() {
      this._bar.hidden = false;
      this._clearOverlay();
      this._canvas.classList.remove("disc-canvas--visible");
      this.style.pointerEvents = "none";
      document.documentElement.style.overflow = "";
      this._updateBarOffset();
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
            if (data.status === "inactive") {
              // The subscription lapsed while this page was open. Get
              // out of the shopper's way and give the store its own
              // search box back.
              goDormant();
            } else if (data.status === "syncing") {
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
      this._bar.hidden = false;
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
      this._bar.hidden = false;
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
      this._bar.hidden = false;
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
      // One bar at a time: the product bar takes the search bar's place.
      this._bar.hidden = true;
      var images = (p.images && p.images.length ? p.images : [p.image_url])
        .map(function (src) {
          return (
            '<div class="disc-shot"><img src="' +
            escapeAttr(absoluteUrl(src)) +
            '" alt="" loading="lazy"></div>'
          );
        })
        .join("");

      this._body.innerHTML = '<div class="disc-shots">' + images + "</div>";
      this._body.classList.add("disc-body--detail");

      this._overlay.hidden = false;
      this._overlay.innerHTML =
        '<div class="disc-detail-ui">' +
        '<div class="disc-chips">' +
        '<button class="disc-chip" data-chip="materials">MATERIALS <i>+</i></button>' +
        '<button class="disc-chip" data-chip="style">HOW TO STYLE <i>+</i></button>' +
        "</div>" +
        '<div class="disc-chip-panel" data-chip-panel="materials" hidden>' +
        escapeHtml(p.description || "") +
        "</div>" +
        '<div class="disc-chip-panel disc-chip-panel--look" data-chip-panel="style" hidden></div>' +
        this._buyHtml(p, wished) +
        "</div>";

      this.openCanvas();
      this._body.scrollTop = 0;
    }

    // Two states, exactly as the reference shows them: the full card by
    // default, and a compact pill (Add to cart | title/price | close) once
    // a chip panel is expanded, so the panel gets the room.
    _buyHtml(p, wished) {
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

      return (
        '<div class="disc-buy">' +
        '<div class="disc-buy-full">' +
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
        (sizes ? '<div class="disc-sizes" hidden>' + sizes + "</div>" : "") +
        '<div class="disc-buy-actions">' +
        '<button class="disc-btn disc-btn--primary" data-add-to-cart>Add to cart</button>' +
        (sizes
          ? '<button class="disc-btn disc-btn--ghost" data-select-size>Select size</button>'
          : "") +
        '<button class="disc-buy-close" data-close-detail aria-label="Close">' +
        DISC_CLOSE_ICON +
        "</button>" +
        '<span class="disc-buy-hint"></span>' +
        "</div>" +
        "</div>" +
        '<div class="disc-buy-compact" hidden>' +
        '<button class="disc-btn disc-btn--primary" data-add-to-cart>Add to cart</button>' +
        '<div class="disc-buy-compact-meta">' +
        '<div class="disc-buy-title">' +
        escapeHtml(p.title) +
        "</div>" +
        '<div class="disc-buy-price">' +
        formatPrice(p.price, p.currency) +
        "</div>" +
        "</div>" +
        '<button class="disc-buy-close" data-close-detail aria-label="Close">' +
        DISC_CLOSE_ICON +
        "</button>" +
        "</div>" +
        "</div>"
      );
    }

    // The reference expands HOW TO STYLE into a paged 2-column grid of
    // complementary pieces with prev/next and dot pagination.
    _renderLook(items) {
      this._lookItems = items || [];
      this._lookPage = 0;
      var host = this._overlay.querySelector('[data-chip-panel="style"]');
      if (!host || !this._lookItems.length) return;
      this._paintLookPage();
    }

    _paintLookPage() {
      var host = this._overlay.querySelector('[data-chip-panel="style"]');
      if (!host) return;
      var perPage = 4;
      var pages = Math.max(1, Math.ceil(this._lookItems.length / perPage));
      var page = Math.min(this._lookPage, pages - 1);
      var slice = this._lookItems.slice(page * perPage, page * perPage + perPage);

      var cards = slice
        .map(
          function (it) {
            var wished = this._wishlist.indexOf(it.id) !== -1;
            return (
              '<div class="disc-look-card" data-product="' +
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
              "</button></div>"
            );
          }.bind(this)
        )
        .join("");

      var dots = "";
      for (var i = 0; i < pages; i++) {
        dots += '<span class="disc-dot' + (i === page ? " disc-dot--on" : "") + '"></span>';
      }

      host.innerHTML =
        '<div class="disc-look-grid">' +
        cards +
        "</div>" +
        (pages > 1
          ? '<div class="disc-look-nav">' +
            '<button class="disc-look-arrow" data-look-page="-1" aria-label="Previous">' +
            DISC_CHEVRON_LEFT +
            "</button>" +
            '<div class="disc-dots">' +
            dots +
            "</div>" +
            '<button class="disc-look-arrow" data-look-page="1" aria-label="Next">' +
            DISC_CHEVRON_RIGHT +
            "</button></div>"
          : "");
    }

    // Only one panel open at a time, and an open panel collapses the buy
    // card to its compact pill so the panel has room — the arrangement
    // the reference uses.
    _toggleChip(name) {
      var panels = this._overlay.querySelectorAll("[data-chip-panel]");
      var chips = this._overlay.querySelectorAll("[data-chip]");
      var target = this._overlay.querySelector('[data-chip-panel="' + name + '"]');
      var opening = target && target.hasAttribute("hidden");

      panels.forEach(function (pnl) {
        pnl.toggleAttribute("hidden", true);
      });
      chips.forEach(function (c) {
        c.classList.remove("disc-chip--open");
      });
      if (opening && target) {
        target.removeAttribute("hidden");
        var chip = this._overlay.querySelector('[data-chip="' + name + '"]');
        if (chip) chip.classList.add("disc-chip--open");
      }

      var full = this._overlay.querySelector(".disc-buy-full");
      var compact = this._overlay.querySelector(".disc-buy-compact");
      if (full && compact) {
        full.toggleAttribute("hidden", !!opening);
        compact.toggleAttribute("hidden", !opening);
      }
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
    var parts = [];
    if (CONFIG.siteKey) parts.push("site_key=" + encodeURIComponent(CONFIG.siteKey));
    var shop = detectShop();
    if (shop) parts.push("shop=" + encodeURIComponent(shop));
    return parts.length ? "?" + parts.join("&") : "";
  }

  function fetchResults(query) {
    return fetch(CONFIG.apiUrl + "/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query,
        limit: CONFIG.resultLimit,
        site_key: CONFIG.siteKey,
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
    // Ask for two pages' worth so the grid pages the way the reference
    // does; the backend still caps this at one piece per category, so a
    // small catalog simply yields fewer pages.
    var sep = shopParam() ? "&" : "?";
    return fetch(
      CONFIG.apiUrl + "/look/" + encodeURIComponent(id) + shopParam() + sep + "limit=8"
    ).then(
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

  var DISC_PLUS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round"/></svg>';

  var DISC_CLIP_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M20 11.5l-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var DISC_COMPOSE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M5 8.5A3.5 3.5 0 0 1 8.5 5H13M19 12.5v3A3.5 3.5 0 0 1 15.5 19h-7A3.5 3.5 0 0 1 5 15.5V12" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M11 13l7.4-7.4a1.7 1.7 0 0 1 2.4 2.4L13.4 15.4 10 16z" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

    .disc-grid {
      display: grid;
      /* min() keeps phones at two products per row rather than one
         oversized column, while desktops still break at 240px. */
      grid-template-columns: repeat(auto-fill, minmax(min(240px, 46%), 1fr));
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
    /* Full-height imagery the card floats over, scrolled horizontally —
       the reference fills the screen with photography rather than
       stacking shots above a band of empty canvas. */
    .disc-shots {
      display: flex; height: 100%; gap: 1px;
      overflow-x: auto; overflow-y: hidden;
      scrollbar-width: none; -webkit-overflow-scrolling: touch;
      scroll-snap-type: x mandatory;
    }
    .disc-shots::-webkit-scrollbar { display: none; }
    .disc-shot {
      flex: 0 0 min(58%, 620px); height: 100%;
      background: rgba(128,128,128,0.12); scroll-snap-align: start;
    }
    .disc-shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
    @media (max-width: 700px) { .disc-shot { flex: 0 0 86%; } }

    /* Pinned above the bar, outside the scroll flow, so product imagery
       scrolls behind a stationary card — the arrangement the reference
       experience uses. */
    .disc-overlay {
      position: absolute; left: 0; right: 0;
      bottom: calc(22px + env(safe-area-inset-bottom, 0px));
      z-index: 4; pointer-events: none;
    }
    /* Centred horizontally by request. The reference sits this column on
       the left; centring is a deliberate divergence, so flip
       align-items back to flex-start to restore the reference layout. */
    .disc-detail-ui {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 0 clamp(14px, 4vw, 40px);
      max-height: calc(100dvh - 96px);
      overflow: hidden;
    }
    .disc-detail-ui > * { pointer-events: auto; }
    /* The expandable panel is the only flexible child; chips and the buy
       card never shrink, so a short viewport clips the panel rather than
       pushing Add to cart out of reach. */
    .disc-chips, .disc-buy { flex-shrink: 0; }
    .disc-chip-panel { min-height: 0; overflow-y: auto; scrollbar-width: none; }
    .disc-chip-panel::-webkit-scrollbar { display: none; }
    /* Detail imagery needs to clear both the bar and the pinned card. */
    /* Detail imagery fills the canvas; it scrolls sideways, not down. */
    .disc-body--detail { padding-bottom: 0; overflow-y: hidden; }

    .disc-chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .disc-chip {
      display: inline-flex; align-items: center; gap: 9px;
      border: none; cursor: pointer; font: inherit;
      font-size: 11px; letter-spacing: 0.09em;
      color: var(--disc-accent-contrast);
      background: rgba(60,58,55,0.55);
      backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-radius: 9999px; padding: 11px 18px;
      transition: background-color 0.18s ease;
    }
    .disc-chip:hover { background: rgba(60,58,55,0.72); }
    .disc-chip i { font-style: normal; opacity: 0.75; transition: transform 0.2s ease; }
    .disc-chip--open i { transform: rotate(45deg); display: inline-block; }

    .disc-chip-panel {
      width: min(560px, calc(100vw - 28px));
      font-size: 12.5px; line-height: 1.55;
      color: var(--disc-accent-contrast);
      background: rgba(60,58,55,0.58);
      backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-radius: 22px; padding: 16px 18px;
    }
    .disc-chip-panel--look { padding: 12px; width: min(460px, calc(100vw - 28px)); }

    .disc-look-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .disc-look-card {
      position: relative; border-radius: 18px; overflow: hidden; cursor: pointer;
      background: rgba(255,255,255,0.9); aspect-ratio: 1 / 1;
    }
    .disc-look-card img { width: 100%; height: 100%; object-fit: cover; display: block; }

    .disc-look-nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 4px 2px;
    }
    .disc-look-arrow {
      width: 38px; height: 38px; border-radius: 9999px; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.55); background: transparent;
      color: var(--disc-accent-contrast);
      display: flex; align-items: center; justify-content: center;
      transition: background-color 0.15s ease;
    }
    .disc-look-arrow:hover { background: rgba(255,255,255,0.16); }
    .disc-look-arrow svg { width: 15px; height: 15px; }
    .disc-dots { display: flex; gap: 7px; }
    .disc-dot { width: 7px; height: 7px; border-radius: 9999px; background: rgba(255,255,255,0.4); }
    .disc-dot--on { background: #fff; }

    .disc-buy {
      background: rgba(60,58,55,0.58);
      backdrop-filter: blur(28px) saturate(190%); -webkit-backdrop-filter: blur(28px) saturate(190%);
      color: var(--disc-accent-contrast);
      width: min(560px, calc(100vw - 28px));
      box-shadow: 0 18px 40px -14px rgba(0,0,0,0.4);
      flex-shrink: 0;
      border-radius: 26px;
    }
    .disc-buy-full { padding: 14px; }
    .disc-buy-head { display: flex; align-items: flex-start; gap: 13px; }
    .disc-buy-thumb { width: 58px; height: 72px; object-fit: cover; border-radius: 10px; flex-shrink: 0; }
    .disc-buy-meta { flex: 1; min-width: 0; }
    /* One line with an ellipsis — a long title wrapped to three lines on a
       narrow phone and made the bar disproportionately tall. */
    .disc-buy-title {
      font-size: 15px; letter-spacing: -0.005em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .disc-buy-price { font-size: 13.5px; margin-top: 5px; font-variant-numeric: tabular-nums; }
    .disc-buy-colour { font-size: 12px; opacity: 0.75; margin-top: 3px; }

    /* Compact state, shown while a chip panel is expanded. */
    .disc-buy-compact {
      display: flex; align-items: center; gap: 14px; padding: 10px 12px 10px 10px;
    }
    .disc-buy-compact-meta { flex: 1; min-width: 0; }
    .disc-buy-compact .disc-buy-title { font-size: 14px; }
    .disc-buy-compact .disc-buy-price { font-size: 12.5px; margin-top: 2px; opacity: 0.85; }

    .disc-buy-close {
      flex-shrink: 0; width: 40px; height: 40px; border-radius: 9999px;
      border: none; cursor: pointer; background: rgba(255,255,255,0.14);
      color: var(--disc-accent-contrast);
      display: flex; align-items: center; justify-content: center;
      transition: background-color 0.15s ease;
    }
    .disc-buy-close:hover { background: rgba(255,255,255,0.26); }
    .disc-buy-close svg { width: 17px; height: 17px; }

    .disc-sizes { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 13px; }
    .disc-size {
      min-width: 44px; padding: 9px 12px; border-radius: 9999px; cursor: pointer; font: inherit;
      font-size: 12.5px; color: var(--disc-accent-contrast);
      background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.2);
      transition: background-color 0.15s ease;
    }
    .disc-size:hover:not(:disabled) { background: rgba(255,255,255,0.26); }
    .disc-size--on { background: #fff; color: var(--disc-ink); border-color: #fff; }
    .disc-size--out { opacity: 0.34; cursor: default; text-decoration: line-through; }

    /* wrap so the hint drops to its own line instead of squeezing the
       buttons until their labels break across lines */
    .disc-buy-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .disc-btn {
      border: none; cursor: pointer; font: inherit; font-size: 13.5px;
      border-radius: 9999px; padding: 13px 26px;
      white-space: nowrap; flex-shrink: 0;
      transition: background-color 0.15s ease, transform 0.15s cubic-bezier(0.34,1.56,0.64,1);
    }
    .disc-btn--primary { background: #fff; color: var(--disc-ink); }
    .disc-btn--primary:active { transform: scale(0.96); }
    .disc-btn--ghost {
      background: transparent; color: var(--disc-accent-contrast);
      border: 1px solid rgba(255,255,255,0.3);
    }
    .disc-btn--ghost:hover { background: rgba(255,255,255,0.14); }
    .disc-buy-actions .disc-buy-close { margin-left: auto; }
    .disc-buy-hint { font-size: 11.5px; opacity: 0.85; flex-basis: 100%; }

    /* ---------------- the docked bar ---------------- */
    .disc-bar {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: min(640px, calc(100vw - 32px));
      pointer-events: auto;
      z-index: 5;
      isolation: isolate;
      display: flex; flex-direction: column;
      padding: 12px 12px 12px 14px;
      border-radius: 9999px;
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

    .disc-bar-inner { display: flex; align-items: center; gap: 10px; }

    .disc-round {
      flex-shrink: 0; width: 52px; height: 52px; border-radius: 9999px;
      display: flex; align-items: center; justify-content: center;
      border: none; padding: 0; cursor: pointer; font: inherit;
    }
    .disc-round svg { width: 20px; height: 20px; }
    .disc-plus { background: rgba(120,120,128,0.18); color: var(--disc-text); }
    .disc-plus:hover { background: rgba(120,120,128,0.28); }
    .disc-send {
      background: var(--disc-text); color: var(--disc-accent-contrast);
      /* transform is driven per-frame by bindPressSpring — animating it
         here too would fight that. */
      transition: background-color 0.15s ease, opacity 0.15s ease;
    }
    .disc-send:disabled { background: rgba(120,120,128,0.22); color: var(--disc-text-secondary); cursor: default; }
    .disc-send[data-loading="true"] { background: var(--disc-glass-top); border: 1px solid var(--disc-divider); cursor: default; }
    .disc-busy-square { width: 12px; height: 12px; border-radius: 3px; background: var(--disc-text); display: block; }

    .disc-clear {
      flex-shrink: 0; width: 34px; height: 34px; border-radius: 9999px;
      display: flex; align-items: center; justify-content: center;
      border: none; padding: 0; cursor: pointer;
      background: rgba(120,120,128,0.18); color: var(--disc-text-secondary);
    }
    .disc-clear:hover { background: rgba(120,120,128,0.3); }
    .disc-clear svg { width: 15px; height: 15px; }

    .disc-input {
      flex: 1; min-width: 0; border: none; outline: none; background: transparent;
      resize: none; overflow: hidden; font: inherit;
      font-size: 17px; font-weight: 450; line-height: 1.45;
      color: var(--disc-text); padding: 0; min-height: 24px; max-height: 120px;
    }
    .disc-input::placeholder { color: var(--disc-text-secondary); }

    /* The + menu: a nested pill that replaces the row. */
    .disc-tools { display: flex; align-items: center; gap: 4px; height: 52px; }
    .disc-tool {
      width: 46px; height: 46px; border-radius: 9999px; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      background: transparent; color: var(--disc-text);
      transition: background-color 0.15s ease;
    }
    .disc-tool:first-child { background: rgba(120,120,128,0.18); }
    .disc-tool:hover { background: rgba(120,120,128,0.26); }
    .disc-tool svg { width: 19px; height: 19px; }
    .disc-tool-div { width: 1px; height: 20px; background: rgba(120,120,128,0.4); }

    .disc-thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .disc-thumb { position: relative; display: block; }
    .disc-thumb img { width: 62px; height: 62px; object-fit: cover; border-radius: 12px; display: block; }
    .disc-thumb-rm {
      position: absolute; top: -6px; right: -6px; width: 20px; height: 20px;
      border-radius: 9999px; border: 1.5px solid #fff; background: var(--disc-text);
      color: #fff; cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .disc-thumb-rm svg { width: 10px; height: 10px; }

    /* Narrow phones: trim the button so the product title keeps a
       readable amount of room beside it. */
    @media (max-width: 400px) {
      .disc-btn { padding: 12px 18px; font-size: 13px; }
      .disc-buy-compact { gap: 10px; padding: 10px; }
      .disc-buy-close { width: 36px; height: 36px; }
    }

    /* Short viewports (a phone in landscape) leave the expandable panel
       roughly 130px between the chips and the buy card. A 2-column grid of
       image cards needs ~290px there, so its second row and the pagination
       arrows end up scrolled out of a scrollbar-less container — reachable
       in theory, invisible in practice. One shallow row of four instead
       puts a whole page, its arrows and its dots on screen at once. Keep
       the row height in dvh so it tracks the viewport rather than
       re-clipping the next time this panel gains a few px. */
    @media (max-height: 520px) {
      .disc-overlay { bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }
      .disc-buy-thumb { width: 44px; height: 54px; }
      .disc-chip-panel--look { padding: 10px; }
      .disc-look-grid { grid-template-columns: repeat(4, 1fr); gap: 6px; }
      .disc-look-card { aspect-ratio: auto; height: clamp(44px, 17dvh, 92px); }
      .disc-look-nav { padding: 8px 4px 0; }
      .disc-look-arrow { width: 30px; height: 30px; }
      .disc-look-arrow svg { width: 13px; height: 13px; }
      .disc-round { width: 44px; height: 44px; }
      .disc-tools { height: 44px; }
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
  // Every native input Disc has hidden, so going dormant can put them
  // all back exactly as they were.
  var _hiddenInputs = [];
  var _scanInterval = null;

  function hideNativeSearch() {
    _scanInterval = setInterval(function () {
      var input = document.querySelector(CONFIG.searchSelectors);
      if (input) {
        clearInterval(_scanInterval);
        _scanInterval = null;
        _hiddenInputs.push([input, input.style.visibility]);
        input.style.visibility = "hidden";
      }
    }, CONFIG.scanIntervalMs);
  }

  // Disc switching itself off must leave the storefront no worse than it
  // found it. Hiding a merchant's search box on behalf of a bar that no
  // longer answers would take away the only way to search the shop, so
  // the bar goes and every hidden input comes back.
  function goDormant() {
    if (_scanInterval) {
      clearInterval(_scanInterval);
      _scanInterval = null;
    }
    _hiddenInputs.forEach(function (pair) {
      pair[0].style.visibility = pair[1] || "";
    });
    _hiddenInputs = [];
    var bar = document.querySelector("disc-search-bar");
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  // Where the boot config comes from. The theme app extension knows the
  // shop but carries no key, so it resolves by domain and gets one back;
  // a self-hosted install that already has a key uses that directly.
  function bootConfigUrl() {
    if (CONFIG.siteKey) {
      return CONFIG.apiUrl + "/sites/" + encodeURIComponent(CONFIG.siteKey) + "/status";
    }
    var shop = USER_CONFIG.shopDomain || detectShop();
    if (shop) {
      return CONFIG.apiUrl + "/storefront/config?shop=" + encodeURIComponent(shop);
    }
    return null;
  }

  /**
   * Apply the merchant's own identity before anything renders.
   *
   * Disc is sold to many stores, so the brand layer has always been data
   * rather than code — but until now there was nowhere to store a
   * merchant's tokens and no way to deliver them, so every store got the
   * same hardcoded cream-and-serif default. This is the missing half.
   *
   * Only known keys are copied across, and the design vocabulary is a
   * closed set on the server. A merchant (or a model) cannot put
   * arbitrary CSS on a storefront through this path.
   */
  function applyBrand(status) {
    if (!status) return;

    var tokens = status.brand_tokens;
    if (tokens && typeof tokens === "object") {
      ["canvas", "ink", "serif", "greeting", "resultsHeading", "loadingPath"].forEach(
        function (key) {
          if (typeof tokens[key] === "string" && tokens[key]) DISC_THEME[key] = tokens[key];
        }
      );
      if (Array.isArray(tokens.loadingMessages) && tokens.loadingMessages.length) {
        DISC_THEME.loadingMessages = tokens.loadingMessages.filter(function (m) {
          return typeof m === "string" && m;
        });
      }
    }

    var widget = status.widget_config;
    if (widget && typeof widget === "object") {
      if (typeof widget.greeting === "string" && widget.greeting) {
        DISC_THEME.greeting = widget.greeting;
      }
      CONFIG.workflows = Array.isArray(widget.workflows) ? widget.workflows : null;
      CONFIG.design = widget.design || null;
    }

    // The key the storefront routes are called with. Resolved by domain
    // when the extension didn't carry one.
    if (typeof status.public_key === "string" && status.public_key) {
      CONFIG.siteKey = status.public_key;
    }
  }

  function init() {
    if (document.querySelector("disc-search-bar")) return;

    var url = bootConfigUrl();

    // No tenant to resolve — that's the demo catalog (this repo's
    // test.html), which is always live.
    if (!url) {
      document.body.appendChild(document.createElement("disc-search-bar"));
      hideNativeSearch();
      return;
    }

    // Ask once, on boot, whether this store's Disc is live. Doing it
    // before hiding anything is what stops a lapsed or misconfigured
    // install from leaving a storefront with no search box at all —
    // worth one small request per page load.
    fetch(url)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      })
      .then(function (status) {
        // ATTACH ONLY ON AN AFFIRMATIVE "THIS STORE'S DISC IS LIVE".
        //
        // This guard used to read `status && status.active === false`,
        // which inverted the whole point of the check: an unresolved
        // status — a failed fetch, a non-2xx, a malformed body — is not
        // an object, so every guard was skipped and control fell through
        // to hideNativeSearch(). A Disc outage therefore took the
        // merchant's own search box away on every page of their store,
        // simultaneously, for as long as the incident lasted, and did it
        // where we could not see it.
        //
        // Failing closed costs Disc a page view. Failing open cost the
        // merchant the only way to search their shop. Those are not
        // comparable, so this fails closed, and it does so on anything
        // short of an explicit `active: true`.
        if (!status || status.active !== true) return;
        // A merchant who hasn't activated Disc yet has a storefront that
        // should look untouched, even though the app is installed.
        if (status.widget_status === "inactive") return;
        applyBrand(status);
        document.body.appendChild(document.createElement("disc-search-bar"));
        hideNativeSearch();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
