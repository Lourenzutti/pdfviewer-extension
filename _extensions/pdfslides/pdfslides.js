/* pdfslides — a small PDF.js slide player for Quarto. */
(function () {
  "use strict";

  // Must be captured now: document.currentScript is null in later callbacks.
  var SCRIPT_SRC = document.currentScript ? document.currentScript.src : "";
  var BASE = new URL(".", SCRIPT_SRC || location.href).href;
  var PDFJS = BASE + "pdfjs/";
  var MAX_PIXELS = 8.3e6; // ~4K; keeps 3 cached canvases within mobile memory limits
  var SWIPE_MIN = 50;

  var pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS + "pdf.min.js").then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
        return lib;
      });
      pdfjsPromise.catch(function () { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  var ICONS = {
    prev: '<path d="M15 18l-6-6 6-6"/>',
    next: '<path d="M9 18l6-6-6-6"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
    toc: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  var THUMB_WIDTH = 240; // CSS px; thumbnails are rendered once and kept as images
  var NARROW = 560;
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[name] + "</svg>";
  }

  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function isCancel(err) {
    return err && err.name === "RenderingCancelledException";
  }

  var players = [];
  var hashOwner = null;

  function Player(root) {
    this.root = root;
    this.id = root.id;
    this.src = root.getAttribute("data-src");
    this.title = root.getAttribute("data-title") || "Slides";
    this.page = Math.max(1, parseInt(root.getAttribute("data-start"), 10) || 1);
    this.allowDownload = root.getAttribute("data-download") !== "false";
    this.hashEnabled = root.getAttribute("data-hash") !== "false";
    this.doc = null;
    this.numPages = 0;
    this.loading = null;
    this.seq = 0;
    this.cache = new Map(); // key -> { page, sizeKey, promise, task, canvas }
    this.current = null; // canvas currently on screen
    this.linkSeq = 0;
    this.pseudoFs = false;
    this.placeholder = null;
    this.pointer = null;
    this.suppressClick = false;
    this.resizeTimer = 0;
    this.sections = parseSections(root.getAttribute("data-sections"));
    this.chapters = []; // [{title, page}] shown in the toolbar and as progress ticks
    this.contentsPromise = null;
    this.titles = new Map(); // page -> promise of the slide's guessed title
    this.panel = null; // "grid" | "toc" | null
    this.thumbQueue = [];
    this.thumbBusy = false;
    this.build();
  }

  // data-sections is JSON written by the shortcode: [{"title": "Intro", "page": 1}, ...]
  function parseSections(json) {
    if (!json) return [];
    var list;
    try { list = JSON.parse(json); } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    return list.filter(function (s) {
      return s && typeof s.title === "string" && s.page >= 1;
    }).map(function (s) {
      return { title: s.title, page: Math.floor(s.page), level: 0 };
    });
  }

  Player.prototype.build = function () {
    var self = this;
    var root = this.root;
    root.classList.add("pdfslides-js");

    this.stage = el("div", "pdfslides-stage", {
      tabindex: "0",
      "aria-roledescription": "slide deck",
      "aria-label": this.title + " — use arrow keys to change slides"
    });
    this.frame = el("div", "pdfslides-frame");
    this.links = el("div", "pdfslides-links");
    this.frame.appendChild(this.links);
    this.status = el("div", "pdfslides-status");
    this.stage.appendChild(this.frame);
    this.stage.appendChild(this.status);

    this.gridPanel = this.makePanel("grid", "Slide overview");
    this.tocPanel = this.makePanel("toc", "Contents");
    this.stage.appendChild(this.gridPanel);
    this.stage.appendChild(this.tocPanel);

    // Mouse-only scrubber: keyboard users have the page box, overview and contents.
    this.progress = el("div", "pdfslides-progress", { "aria-hidden": "true" });
    this.progressBar = el("span", "pdfslides-progress-bar");
    this.ticks = el("span", "pdfslides-ticks");
    this.progress.appendChild(this.progressBar);
    this.progress.appendChild(this.ticks);
    this.progress.addEventListener("click", function (e) { self.onProgressClick(e); });
    this.progress.addEventListener("mousemove", function (e) {
      var n = self.progressPage(e);
      if (n) self.progress.title = "Slide " + n + self.chapterSuffix(n);
    });

    var bar = el("div", "pdfslides-toolbar");
    this.prevBtn = this.button("prev", "Previous slide", function () { self.go(self.page - 1); });
    this.nextBtn = this.button("next", "Next slide", function () { self.go(self.page + 1); });
    var counter = el("span", "pdfslides-counter");
    this.input = el("input", "pdfslides-input", {
      type: "text", inputmode: "numeric", "aria-label": "Slide number", value: String(this.page), size: "3"
    });
    this.total = el("span", "pdfslides-total");
    this.total.textContent = "/ …";
    counter.appendChild(this.input);
    counter.appendChild(this.total);
    this.chapterLabel = el("span", "pdfslides-chapter");
    bar.appendChild(this.prevBtn);
    bar.appendChild(counter);
    bar.appendChild(this.nextBtn);
    bar.appendChild(this.chapterLabel);
    bar.appendChild(el("span", "pdfslides-spacer"));
    this.tocBtn = this.button("toc", "Contents (T)", function () { self.togglePanel("toc"); });
    this.gridBtn = this.button("grid", "Slide overview (G)", function () { self.togglePanel("grid"); });
    this.tocBtn.setAttribute("aria-expanded", "false");
    this.gridBtn.setAttribute("aria-expanded", "false");
    this.tocBtn.setAttribute("aria-controls", this.tocPanel.id);
    this.gridBtn.setAttribute("aria-controls", this.gridPanel.id);
    bar.appendChild(this.tocBtn);
    bar.appendChild(this.gridBtn);
    if (this.allowDownload) {
      var open = el("a", "pdfslides-btn pdfslides-open", {
        href: this.src, target: "_blank", rel: "noopener", title: "Open PDF in a new tab", "aria-label": "Open PDF in a new tab"
      });
      open.innerHTML = icon("open");
      var dl = el("a", "pdfslides-btn pdfslides-download", {
        href: this.src, download: "", title: "Download PDF", "aria-label": "Download PDF"
      });
      dl.innerHTML = icon("download");
      bar.appendChild(open);
      bar.appendChild(dl);
    }
    this.fsBtn = this.button("expand", "Enter fullscreen (F)", function () { self.toggleFullscreen(); });
    bar.appendChild(this.fsBtn);

    this.live = el("div", "pdfslides-sr", { "aria-live": "polite", "aria-atomic": "true" });
    this.text = el("div", "pdfslides-sr pdfslides-text");

    root.appendChild(this.stage);
    root.appendChild(this.text);
    root.appendChild(this.progress);
    root.appendChild(bar);
    root.appendChild(this.live);
    this.setNavEnabled();

    root.addEventListener("keydown", function (e) { self.onKey(e); });
    // Safari does not focus buttons on click; keep keyboard control in the player.
    root.addEventListener("click", function () {
      if (!root.contains(document.activeElement)) self.stage.focus({ preventScroll: true });
    });
    this.input.addEventListener("change", function () { self.onInput(); });
    this.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); self.onInput(); }
      if (e.key === "Escape") { self.input.value = String(self.page); self.stage.focus(); }
    });
    this.input.addEventListener("focus", function () { self.input.select(); });
    this.stage.addEventListener("click", function (e) { self.onClickCapture(e); }, true);
    this.stage.addEventListener("click", function (e) { self.onClick(e); });
    this.stage.addEventListener("pointerdown", function (e) { self.onPointerDown(e); });
    this.stage.addEventListener("pointerup", function (e) { self.onPointerUp(e); });
    this.stage.addEventListener("pointercancel", function () { self.pointer = null; });
    window.addEventListener("pointerdown", function (e) {
      if (!e.isPrimary && self.pointer) self.pointer = null; // pinch anywhere cancels
    }, true);
    this.stage.addEventListener("focus", function () { self.load(); });

    if ("ResizeObserver" in window) {
      new ResizeObserver(function () { self.onResize(); }).observe(this.stage);
    } else {
      window.addEventListener("resize", function () { self.onResize(); });
    }
  };

  Player.prototype.button = function (iconName, label, onClick) {
    var b = el("button", "pdfslides-btn", { type: "button", title: label, "aria-label": label });
    b.innerHTML = icon(iconName);
    b.addEventListener("click", onClick);
    return b;
  };

  Player.prototype.setStatus = function (html) {
    this.status.innerHTML = html || "";
    this.status.hidden = !html;
  };

  // ---- Loading ----------------------------------------------------------

  Player.prototype.load = function () {
    var self = this;
    if (this.loading) return this.loading;
    this.root.classList.remove("is-error");
    this.status.removeAttribute("role");
    this.root.classList.add("is-loading");
    this.setStatus('<span class="pdfslides-spinner" aria-hidden="true"></span><span>Loading slides…</span>');
    this.loading = loadPdfjs().then(function (lib) {
      var task = lib.getDocument({
        url: self.src,
        cMapUrl: PDFJS + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: PDFJS + "standard_fonts/",
        wasmUrl: PDFJS + "wasm/",
        isEvalSupported: false,
        enableScripting: false
      });
      task.onProgress = function (p) {
        if (p.total) self.progressBar.style.width = Math.min(100, (100 * p.loaded) / p.total) + "%";
      };
      return task.promise;
    }).then(function (doc) {
      self.doc = doc;
      self.numPages = doc.numPages;
      self.page = Math.min(self.page, self.numPages);
      self.total.textContent = "/ " + self.numPages;
      return doc.getPage(1);
    }).then(function (first) {
      // Size the player from the deck's own aspect ratio (unless the author set one).
      if (!self.root.style.getPropertyValue("--pdfslides-aspect")) {
        var vp = first.getViewport({ scale: 1 });
        self.root.style.setProperty("--pdfslides-aspect", vp.width + " / " + vp.height);
      }
      self.root.classList.remove("is-loading");
      self.root.classList.add("is-ready");
      self.setStatus("");
      self.total.setAttribute("aria-label", "of " + self.numPages);
      self.updateUI(self.pendingUserNav);
      self.pendingUserNav = false;
      self.contents().then(function (c) {
        self.chapters = c.source === "titles" ? [] : c.items.filter(function (it) { return it.level === 0; });
        self.renderTicks();
        self.updateChapter();
      });
      return self.show();
    }).catch(function (err) {
      self.root.classList.remove("is-loading");
      self.root.classList.add("is-error");
      self.showError(err);
      self.loading = null; // allow a retry (click, focus or hash navigation)
    });
    return this.loading;
  };

  Player.prototype.showError = function (err) {
    var name = err && err.name;
    var msg;
    if (name === "PasswordException") msg = "This PDF is password-protected and cannot be shown here.";
    else if (name === "InvalidPDFException") msg = "This file is not a valid PDF.";
    else if (name === "MissingPDFException" || name === "ResponseException" || name === "UnexpectedResponseException")
      msg = "The slides could not be loaded (file not found).";
    else if (location.protocol === "file:")
      msg = "The slides cannot be loaded from a file:// page. Use quarto preview or a web server.";
    else msg = "The slides could not be loaded.";
    if (window.console) console.error("pdfslides:", err);
    var a = el("a", null, { href: this.src });
    a.textContent = "Open the PDF instead";
    a.addEventListener("click", function (e) { e.stopPropagation(); });
    this.setStatus("");
    var p = el("p");
    p.textContent = msg + " ";
    p.appendChild(a);
    this.status.appendChild(p);
    this.status.hidden = false;
    this.status.setAttribute("role", "alert");
  };

  // ---- Navigation -------------------------------------------------------

  Player.prototype.go = function (n, opts) {
    if (!this.doc) {
      // Remember the request; it is applied (and announced) once the deck loads.
      this.page = Math.max(1, n);
      this.pendingUserNav = !(opts && opts.fromHash);
      this.load();
      return;
    }
    n = Math.max(1, Math.min(this.numPages, n));
    if (n === this.page) { this.input.value = String(n); return; }
    this.page = n;
    this.updateUI(!(opts && opts.fromHash));
    this.show();
  };

  Player.prototype.updateUI = function (fromUser) {
    var n = this.page;
    this.input.value = String(n);
    this.setNavEnabled();
    if (this.numPages) {
      this.progressBar.style.width = (100 * n) / this.numPages + "%";
      this.root.setAttribute("data-page", String(n));
    }
    this.updateChapter();
    this.markCurrent();
    if (fromUser) {
      this.live.textContent = "Slide " + n + " of " + this.numPages;
      if (this.hashEnabled) {
        var h = hashFor(this, n);
        if (location.hash !== h) history.replaceState(history.state, "", h);
      }
    }
  };

  Player.prototype.setNavEnabled = function () {
    var active = document.activeElement;
    this.prevBtn.disabled = !this.doc || this.page <= 1;
    this.nextBtn.disabled = !this.doc || this.page >= this.numPages;
    // A focused button that becomes disabled drops focus to <body>; keep it here.
    if ((active === this.prevBtn || active === this.nextBtn) && active.disabled) {
      this.stage.focus({ preventScroll: true });
    }
  };

  Player.prototype.onInput = function () {
    var v = this.input.value.trim();
    if (/^\d+$/.test(v)) this.go(parseInt(v, 10));
    else this.input.value = String(this.page);
  };

  Player.prototype.onKey = function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (t !== this.stage && t !== this.root && t.closest) {
      // Text fields keep all their keys; buttons and links keep Space/Enter.
      if (t.closest("input, select, textarea, [contenteditable]")) return;
      if (t.closest("a, button") && (e.key === " " || e.key === "Spacebar" || e.key === "Enter")) return;
    }
    var n = this.page;
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": case "PageDown": case "n": case "N":
        n++; break;
      case "ArrowLeft": case "ArrowUp": case "PageUp": case "p": case "P":
        n--; break;
      case " ": case "Spacebar":
        n += e.shiftKey ? -1 : 1; break;
      case "Home": n = 1; break;
      case "End": n = this.numPages || n; break;
      case "f": case "F":
        e.preventDefault(); this.toggleFullscreen(); return;
      case "g": case "G": case "o": case "O":
        e.preventDefault(); this.togglePanel("grid"); return;
      case "t": case "T":
        e.preventDefault(); this.togglePanel("toc"); return;
      case "Escape":
        if (this.panel) { e.preventDefault(); this.closePanel(); }
        else if (this.pseudoFs) { e.preventDefault(); this.exitPseudo(); }
        return;
      default: return;
    }
    e.preventDefault();
    this.go(n);
  };

  // Capture phase: swallow the click that follows a swipe, before PDF links see it.
  Player.prototype.onClickCapture = function (e) {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  Player.prototype.onClick = function (e) {
    if (e.target.closest && e.target.closest("a, button")) return;
    if (this.panel) { this.closePanel(); return; } // click beside the contents drawer
    if (!this.doc) { this.load(); return; }
    var r = this.frame.getBoundingClientRect();
    var x = r.width ? (e.clientX - r.left) / r.width : 1;
    this.go(x < 0.3 ? this.page - 1 : this.page + 1);
  };

  Player.prototype.onPointerDown = function (e) {
    // Only single-finger touch/pen gestures; a second finger (pinch) cancels.
    if (e.pointerType === "mouse" || !e.isPrimary) { this.pointer = null; return; }
    this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };

  Player.prototype.onPointerUp = function (e) {
    var p = this.pointer;
    this.pointer = null;
    if (!p || p.id !== e.pointerId || this.panel) return;
    var dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      this.suppressClick = true;
      var self = this;
      setTimeout(function () { self.suppressClick = false; }, 400);
      this.go(dx < 0 ? this.page + 1 : this.page - 1);
    }
  };

  // ---- Rendering --------------------------------------------------------

  Player.prototype.stageSize = function () {
    var w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return null; // hidden (e.g. inactive tab)
    return { w: w, h: h, dpr: window.devicePixelRatio || 1, key: w + "x" + h + "@" + (window.devicePixelRatio || 1) };
  };

  // Returns a promise for a canvas with page n rendered at the current stage size.
  Player.prototype.rendered = function (n, size) {
    var key = n + "|" + size.key;
    var hit = this.cache.get(key);
    if (hit) return hit.promise;
    var entry = { page: n, sizeKey: size.key, task: null, canvas: null };
    var self = this;
    entry.promise = this.doc.getPage(n).then(function (page) {
      if (self.cache.get(key) !== entry) throw { name: "RenderingCancelledException" };
      var base = page.getViewport({ scale: 1 });
      var fit = Math.min(size.w / base.width, size.h / base.height);
      var viewport = page.getViewport({ scale: fit });
      var scale = size.dpr;
      var px = viewport.width * viewport.height * scale * scale;
      if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
      var canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * scale);
      canvas.height = Math.floor(viewport.height * scale);
      canvas.setAttribute("aria-hidden", "true");
      entry.canvas = canvas;
      entry.viewport = viewport;
      entry.pdfPage = page;
      entry.task = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: viewport,
        transform: scale !== 1 ? [scale, 0, 0, scale, 0, 0] : null
      });
      return entry.task.promise.then(function () { entry.task = null; return entry; });
    });
    this.cache.set(key, entry);
    entry.promise.catch(function () { if (self.cache.get(key) === entry) self.cache.delete(key); });
    return entry.promise;
  };

  Player.prototype.release = function (canvas) {
    if (canvas && canvas !== this.current) canvas.width = canvas.height = 0; // free memory now
  };

  Player.prototype.evict = function (keep) {
    var self = this;
    this.cache.forEach(function (entry, key) {
      if (keep(entry)) return;
      self.cache.delete(key);
      if (entry.task) {
        // Cancellation is asynchronous: free the canvas only once the task settles.
        var task = entry.task;
        task.cancel();
        task.promise.catch(function () {}).then(function () { self.release(entry.canvas); });
      } else {
        self.release(entry.canvas);
      }
    });
  };

  Player.prototype.show = function () {
    var self = this;
    if (!this.doc) return Promise.resolve();
    var size = this.stageSize();
    if (!size) return Promise.resolve();
    var n = this.page;
    var seq = ++this.seq;
    this.lastSizeKey = size.key;
    this.evict(function (e) { return e.sizeKey === size.key && Math.abs(e.page - n) <= 1; });
    return this.rendered(n, size).then(function (entry) {
      if (seq !== self.seq) return;
      if (!self.status.hidden) self.setStatus(""); // clear a previous page's render error
      self.swap(entry);
      self.renderLinks(entry);
      self.renderText(entry);
      self.prefetch(size);
    }, function (err) {
      if (isCancel(err) || seq !== self.seq) return;
      self.showError(err);
    });
  };

  // Fit the frame (canvas + link overlay) inside the stage, letterboxed.
  Player.prototype.layoutFrame = function () {
    var w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!this.ratio || !w || !h) return;
    var fw = Math.min(w, h * this.ratio);
    this.frame.style.width = fw + "px";
    this.frame.style.height = fw / this.ratio + "px";
  };

  Player.prototype.swap = function (entry) {
    var old = this.current;
    this.ratio = entry.viewport.width / entry.viewport.height;
    this.layoutFrame();
    if (old !== entry.canvas) {
      if (old) {
        this.frame.replaceChild(entry.canvas, old);
        this.current = entry.canvas;
        var cached = false;
        this.cache.forEach(function (e) { if (e.canvas === old) cached = true; });
        if (!cached) this.release(old);
      } else {
        this.frame.insertBefore(entry.canvas, this.links);
      }
      this.current = entry.canvas;
    }
    this.root.setAttribute("data-rendered", String(entry.page));
  };

  Player.prototype.prefetch = function (size) {
    var self = this;
    [this.page + 1, this.page - 1].forEach(function (n) {
      if (n >= 1 && n <= self.numPages) self.rendered(n, size).catch(function () {});
    });
  };

  Player.prototype.onResize = function () {
    var self = this;
    clearTimeout(this.resizeTimer);
    this.root.classList.toggle("is-narrow", this.root.clientWidth > 0 && this.root.clientWidth < NARROW);
    // Scale the current canvas immediately; re-render sharply once resizing settles.
    this.layoutFrame();
    this.resizeTimer = setTimeout(function () {
      var size = self.stageSize();
      if (size && self.doc && size.key !== self.lastSizeKey) self.show();
    }, 120);
  };

  // The canvas is opaque to screen readers, so expose the current slide's text.
  Player.prototype.renderText = function (entry) {
    var self = this;
    var seq = this.linkSeq;
    entry.pdfPage.getTextContent().then(function (content) {
      if (seq !== self.linkSeq) return;
      var text = "";
      content.items.forEach(function (item) {
        if (item.str) text += item.str;
        text += item.hasEOL ? "\n" : (item.str ? " " : "");
      });
      text = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
      self.text.textContent = "Slide " + entry.page + " text: " + (text || "(no text)");
    }).catch(function () {
      self.text.textContent = "";
    });
  };

  // ---- Jump navigation: contents, overview, chapters --------------------

  // Contents come from (1) the shortcode's sections, (2) the PDF outline
  // (bookmarks), or (3) one entry per slide titled by its largest text.
  Player.prototype.contents = function () {
    var self = this;
    if (this.contentsPromise) return this.contentsPromise;
    var n = this.numPages;
    var sections = this.sections.filter(function (s) { return s.page <= n; });
    if (sections.length) {
      this.contentsPromise = Promise.resolve({ source: "sections", items: sections });
      return this.contentsPromise;
    }
    this.contentsPromise = this.doc.getOutline().then(function (outline) {
      if (!outline || !outline.length) return [];
      var flat = [];
      (function walk(items, level) {
        items.forEach(function (it) {
          flat.push({ title: (it.title || "").trim(), dest: it.dest, level: level });
          if (it.items && it.items.length && level < 2) walk(it.items, level + 1);
        });
      })(outline, 0);
      return Promise.all(flat.map(function (it) {
        return self.resolveDest({ dest: it.dest }, 1).then(function (page) {
          return page ? { title: it.title || "Slide " + page, page: page, level: it.level } : null;
        });
      }));
    }).catch(function () { return []; }).then(function (items) {
      items = items.filter(Boolean);
      if (items.length) return { source: "outline", items: items };
      var all = [];
      for (var i = 1; i <= n; i++) all.push({ title: null, page: i, level: 0 });
      return { source: "titles", items: all };
    });
    return this.contentsPromise;
  };

  // Guess a slide's title: the largest text on the page (PowerPoint titles are).
  Player.prototype.slideTitle = function (n) {
    var self = this;
    if (!this.titles.has(n)) {
      this.titles.set(n, this.doc.getPage(n).then(function (page) {
        return page.getTextContent();
      }).then(function (content) {
        var items = content.items.filter(function (it) {
          var s = it.str && it.str.trim();
          return s && !/^\d+$/.test(s); // skip slide numbers
        });
        if (!items.length) return "";
        function size(it) { return Math.hypot(it.transform[2], it.transform[3]) || it.height || 0; }
        var max = Math.max.apply(null, items.map(size));
        var title = items.filter(function (it) { return size(it) >= 0.85 * max; })
          .map(function (it) { return it.str; }).join(" ").replace(/\s+/g, " ").trim();
        return title.length > 80 ? title.slice(0, 77) + "…" : title;
      }).catch(function () { return ""; }));
    }
    return this.titles.get(n).then(function (t) { return t || "Slide " + n; });
  };

  Player.prototype.chapterAt = function (n) {
    var found = null;
    this.chapters.forEach(function (c) { if (c.page <= n) found = c; });
    return found;
  };

  Player.prototype.chapterSuffix = function (n) {
    var c = this.chapterAt(n);
    return c ? " · " + c.title : "";
  };

  Player.prototype.updateChapter = function () {
    var c = this.chapterAt(this.page);
    this.chapterLabel.textContent = c ? c.title : "";
    this.chapterLabel.title = c ? c.title : "";
  };

  Player.prototype.renderTicks = function () {
    var self = this;
    this.ticks.textContent = "";
    this.chapters.forEach(function (c) {
      if (c.page <= 1) return;
      var t = el("span", "pdfslides-tick");
      t.style.left = (100 * (c.page - 1)) / self.numPages + "%";
      t.title = c.title;
      self.ticks.appendChild(t);
    });
  };

  Player.prototype.progressPage = function (e) {
    if (!this.numPages) return 0;
    var r = this.progress.getBoundingClientRect();
    var x = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
    return Math.floor(x * this.numPages) + 1;
  };

  Player.prototype.onProgressClick = function (e) {
    if (!this.doc) { this.load(); return; }
    this.go(this.progressPage(e));
    this.stage.focus({ preventScroll: true });
  };

  // Panels live inside the stage so they also work in fullscreen.
  Player.prototype.makePanel = function (name, label) {
    var self = this;
    var panel = el("div", "pdfslides-panel pdfslides-panel-" + name, {
      id: this.id + "-" + name, role: "dialog", "aria-label": label
    });
    panel.hidden = true;
    var head = el("div", "pdfslides-panel-head");
    var h = el("span", "pdfslides-panel-title");
    h.textContent = label;
    var close = this.button("close", "Close", function () { self.closePanel(); });
    head.appendChild(h);
    head.appendChild(close);
    panel.appendChild(head);
    var body = el("div", "pdfslides-panel-body");
    panel.appendChild(body);
    panel.body = body;
    // Keep panel interaction away from the slide's click/swipe handlers.
    ["click", "pointerdown", "pointerup"].forEach(function (type) {
      panel.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    panel.addEventListener("keydown", function (e) { self.onPanelKey(e, name); });
    return panel;
  };

  Player.prototype.togglePanel = function (name) {
    if (this.panel === name) this.closePanel();
    else this.openPanel(name);
  };

  Player.prototype.openPanel = function (name) {
    var self = this;
    if (!this.doc) {
      this.load().then(function () { if (self.doc) self.openPanel(name); });
      return;
    }
    if (this.panel) this.closePanel(true);
    this.panel = name;
    var panel = name === "grid" ? this.gridPanel : this.tocPanel;
    var btn = name === "grid" ? this.gridBtn : this.tocBtn;
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    this.root.classList.add("has-panel");
    (name === "grid" ? this.buildGrid() : this.buildToc()).then(function () {
      if (self.panel !== name) return;
      self.markCurrent();
      var cur = panel.querySelector("[aria-current='true']") || panel.querySelector(".pdfslides-item");
      if (cur) {
        cur.focus({ preventScroll: true });
        cur.scrollIntoView({ block: "nearest" });
      }
    });
  };

  Player.prototype.closePanel = function (keepFocus) {
    if (!this.panel) return;
    var panel = this.panel === "grid" ? this.gridPanel : this.tocPanel;
    var btn = this.panel === "grid" ? this.gridBtn : this.tocBtn;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    this.panel = null;
    this.root.classList.remove("has-panel");
    if (!keepFocus) this.stage.focus({ preventScroll: true });
  };

  Player.prototype.pick = function (n) {
    this.closePanel();
    this.go(n);
  };

  Player.prototype.buildToc = function () {
    var self = this;
    if (this.tocBuilt) return this.tocBuilt;
    this.tocBuilt = this.contents().then(function (c) {
      var titleEl = self.tocPanel.querySelector(".pdfslides-panel-title");
      titleEl.textContent = c.source === "sections" ? "Sections" : "Contents";
      var list = el("ol", "pdfslides-toc-list");
      c.items.forEach(function (it) {
        var li = el("li", "pdfslides-toc-level-" + it.level);
        var b = el("button", "pdfslides-item", { type: "button", "data-page": String(it.page) });
        var num = el("span", "pdfslides-toc-num");
        num.textContent = String(it.page);
        var label = el("span", "pdfslides-toc-title");
        label.textContent = it.title || "Slide " + it.page;
        b.appendChild(label);
        b.appendChild(num);
        b.addEventListener("click", function () { self.pick(it.page); });
        if (!it.title) {
          self.slideTitle(it.page).then(function (t) { label.textContent = t; });
        }
        li.appendChild(b);
        list.appendChild(li);
      });
      self.tocPanel.body.appendChild(list);
      self.tocSource = c.source;
    });
    return this.tocBuilt;
  };

  Player.prototype.buildGrid = function () {
    var self = this;
    if (this.gridBuilt) return this.gridBuilt;
    this.gridBuilt = this.contents().then(function (c) {
      var headings = {};
      if (c.source !== "titles") {
        c.items.forEach(function (it) {
          if (it.level === 0 && !headings[it.page]) headings[it.page] = it.title;
        });
      }
      var grid = el("div", "pdfslides-grid");
      var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          self.queueThumb(en.target);
        });
      }, { root: self.gridPanel, rootMargin: "200px 0px" }) : null;
      for (var n = 1; n <= self.numPages; n++) {
        if (headings[n]) {
          var h = el("div", "pdfslides-grid-heading");
          h.textContent = headings[n];
          grid.appendChild(h);
        }
        var b = el("button", "pdfslides-item pdfslides-thumb", {
          type: "button", "data-page": String(n), "aria-label": "Slide " + n
        });
        var box = el("span", "pdfslides-thumb-img");
        var num = el("span", "pdfslides-thumb-num");
        num.textContent = String(n);
        b.appendChild(box);
        b.appendChild(num);
        b.addEventListener("click", (function (page) {
          return function () { self.pick(page); };
        })(n));
        grid.appendChild(b);
        if (io) io.observe(b); else self.queueThumb(b);
      }
      self.gridPanel.body.appendChild(grid);
    });
    return this.gridBuilt;
  };

  // Thumbnails render one at a time into a scratch canvas and are kept as
  // images, which the browser can store compressed (cheaper than canvases).
  Player.prototype.queueThumb = function (button) {
    this.thumbQueue.push(button);
    this.pumpThumbs();
  };

  Player.prototype.pumpThumbs = function () {
    var self = this;
    if (this.thumbBusy || !this.thumbQueue.length) return;
    this.thumbBusy = true;
    var button = this.thumbQueue.shift();
    var n = parseInt(button.getAttribute("data-page"), 10);
    var done = function () { self.thumbBusy = false; self.pumpThumbs(); };
    this.doc.getPage(n).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var scale = (THUMB_WIDTH * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
      var viewport = page.getViewport({ scale: scale });
      var canvas = self.thumbCanvas || (self.thumbCanvas = document.createElement("canvas"));
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      return page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise.then(function () {
        return new Promise(function (resolve) {
          if (canvas.toBlob) canvas.toBlob(function (blob) { resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL()); }, "image/png");
          else resolve(canvas.toDataURL());
        });
      });
    }).then(function (src) {
      var img = el("img", null, { alt: "", src: src });
      button.querySelector(".pdfslides-thumb-img").appendChild(img);
      button.classList.add("is-rendered");
      return self.slideTitle(n).then(function (t) {
        button.setAttribute("aria-label", "Slide " + n + ": " + t);
        button.title = t;
      });
    }).catch(function () {}).then(done);
  };

  // Highlight the current slide / section in open panels.
  Player.prototype.markCurrent = function () {
    var n = this.page;
    this.gridPanel.querySelectorAll(".pdfslides-item").forEach(function (b) {
      b.setAttribute("aria-current", String(+b.getAttribute("data-page") === n));
    });
    var tocItems = this.tocPanel.querySelectorAll(".pdfslides-item");
    var current = null;
    tocItems.forEach(function (b) {
      if (+b.getAttribute("data-page") <= n) current = b;
    });
    tocItems.forEach(function (b) { b.setAttribute("aria-current", String(b === current)); });
  };

  Player.prototype.onPanelKey = function (e, name) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var panel = name === "grid" ? this.gridPanel : this.tocPanel;
    var items = Array.prototype.slice.call(panel.querySelectorAll(".pdfslides-item"));
    var i = items.indexOf(document.activeElement);
    var step = 0;
    var cols = 1;
    if (name === "grid") {
      var grid = panel.querySelector(".pdfslides-grid");
      cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1;
    }
    switch (e.key) {
      case "Escape": e.preventDefault(); e.stopPropagation(); this.closePanel(); return;
      case "ArrowRight": step = name === "grid" ? 1 : 0; break;
      case "ArrowLeft": step = name === "grid" ? -1 : 0; break;
      case "ArrowDown": step = cols; break;
      case "ArrowUp": step = -cols; break;
      case "Home": i = 0; break;
      case "End": i = items.length - 1; break;
      case "Tab": return; // natural tab order inside the panel
      default: return;
    }
    e.preventDefault();
    e.stopPropagation(); // arrows move focus here, not slides
    if (!items.length) return;
    var j = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + step));
    items[j].focus();
    items[j].scrollIntoView({ block: "nearest" });
  };

  // Scroll a deck into view (used by links in the page text).
  Player.prototype.reveal = function () {
    var smooth = !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!this.isFullscreen()) this.root.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
    this.stage.focus({ preventScroll: true });
  };

  // ---- PDF links --------------------------------------------------------

  Player.prototype.renderLinks = function (entry) {
    var self = this;
    var seq = ++this.linkSeq;
    this.links.textContent = "";
    entry.pdfPage.getAnnotations({ intent: "display" }).then(function (annots) {
      if (seq !== self.linkSeq) return;
      annots.forEach(function (a) {
        if (a.subtype !== "Link") return;
        var p1 = entry.viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
        var p2 = entry.viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
        // Percentages keep overlays aligned while the frame is CSS-resized.
        var vw = entry.viewport.width, vh = entry.viewport.height;
        var link = el("a", "pdfslides-link");
        link.style.left = (100 * Math.min(p1[0], p2[0])) / vw + "%";
        link.style.top = (100 * Math.min(p1[1], p2[1])) / vh + "%";
        link.style.width = (100 * Math.abs(p2[0] - p1[0])) / vw + "%";
        link.style.height = (100 * Math.abs(p2[1] - p1[1])) / vh + "%";
        if (a.url && /^(https?:|mailto:)/i.test(a.url)) {
          link.href = a.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.setAttribute("aria-label", a.url);
          link.title = a.url;
        } else if (a.dest || a.action) {
          link.href = "#";
          link.setAttribute("aria-label", "Go to linked slide");
          var targetPage = 0;
          self.resolveDest(a, entry.page).then(function (target) {
            if (!target || seq !== self.linkSeq) return;
            targetPage = target;
            link.setAttribute("aria-label", "Go to slide " + target);
            link.title = "Slide " + target;
            if (self.hashEnabled) link.href = hashFor(self, target);
          });
          link.addEventListener("click", function (e) {
            e.preventDefault();
            if (targetPage) self.go(targetPage);
          });
        } else {
          return;
        }
        link.addEventListener("click", function (e) { e.stopPropagation(); });
        self.links.appendChild(link);
      });
    }).catch(function (err) {
      if (window.console) console.warn("pdfslides: could not add PDF links", err);
    });
  };

  // Resolve a link annotation to a 1-based page number (or null).
  Player.prototype.resolveDest = function (a, fromPage) {
    var doc = this.doc, self = this;
    if (a.action) {
      var map = { NextPage: fromPage + 1, PrevPage: fromPage - 1, FirstPage: 1, LastPage: this.numPages };
      var t = map[a.action];
      return Promise.resolve(t ? Math.max(1, Math.min(self.numPages, t)) : null);
    }
    var destP = typeof a.dest === "string" ? doc.getDestination(a.dest) : Promise.resolve(a.dest);
    return destP.then(function (dest) {
      if (!Array.isArray(dest) || dest[0] == null) return null;
      var ref = dest[0];
      if (typeof ref === "number") return ref + 1; // some producers store a page index
      return doc.getPageIndex(ref).then(function (i) { return i + 1; });
    }).catch(function () { return null; });
  };

  // ---- Fullscreen -------------------------------------------------------

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  Player.prototype.isFullscreen = function () {
    return this.pseudoFs || fsElement() === this.root;
  };

  Player.prototype.toggleFullscreen = function () {
    var self = this;
    if (this.pseudoFs) return this.exitPseudo();
    if (fsElement() === this.root) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    var req = this.root.requestFullscreen || this.root.webkitRequestFullscreen;
    if (req && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
      fsRequester = this;
      var p = req.call(this.root);
      if (p && p.then) {
        p.then(function () { fsRequester = null; }, function () {
          fsRequester = null;
          self.enterPseudo();
        });
      }
    } else {
      this.enterPseudo();
    }
    this.stage.focus({ preventScroll: true });
    this.load();
  };

  // Re-render after the layout change settles rather than waiting on ResizeObserver.
  Player.prototype.relayout = function () {
    var self = this;
    requestAnimationFrame(function () { self.onResize(); });
  };

  // iPhone Safari has no element fullscreen: fake it with a fixed overlay.
  // The player is moved to <body> so transformed ancestors cannot trap it.
  Player.prototype.enterPseudo = function () {
    if (this.pseudoFs) return;
    this.pseudoFs = true;
    this.scrollY = window.scrollY;
    this.placeholder = document.createComment("pdfslides");
    this.root.parentNode.insertBefore(this.placeholder, this.root);
    document.body.appendChild(this.root);
    this.root.classList.add("is-pseudo-fullscreen");
    document.documentElement.classList.add("pdfslides-noscroll");
    this.syncFullscreen();
    this.relayout();
    this.stage.focus({ preventScroll: true });
  };

  Player.prototype.exitPseudo = function () {
    if (!this.pseudoFs) return;
    this.pseudoFs = false;
    this.placeholder.parentNode.replaceChild(this.root, this.placeholder);
    this.placeholder = null;
    this.root.classList.remove("is-pseudo-fullscreen");
    document.documentElement.classList.remove("pdfslides-noscroll");
    window.scrollTo(0, this.scrollY || 0);
    this.syncFullscreen();
    this.relayout();
    this.stage.focus({ preventScroll: true });
  };

  Player.prototype.syncFullscreen = function () {
    var on = this.isFullscreen();
    this.root.classList.toggle("is-fullscreen", on);
    var label = on ? "Exit fullscreen (F)" : "Enter fullscreen (F)";
    this.fsBtn.innerHTML = icon(on ? "shrink" : "expand");
    this.fsBtn.title = label;
    this.fsBtn.setAttribute("aria-label", label);
    this.fsBtn.setAttribute("aria-pressed", String(on));
  };

  var fsRequester = null;

  function onFullscreenChange() {
    fsRequester = null; // the pending request succeeded (or fullscreen was exited)
    players.forEach(function (p) {
      var was = p.root.classList.contains("is-fullscreen");
      p.syncFullscreen();
      if (was !== p.isFullscreen()) p.relayout();
    });
  }
  // Some browsers reject element fullscreen asynchronously; fall back to the overlay.
  function onFullscreenError() {
    if (fsRequester) fsRequester.enterPseudo();
    fsRequester = null;
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("fullscreenerror", onFullscreenError);
  document.addEventListener("webkitfullscreenerror", onFullscreenError);

  // ---- URL hash ---------------------------------------------------------
  // "#/12" addresses the first hash-enabled player; "#<id>/12" any other.

  function hashFor(player, n) {
    return player === hashOwner ? "#/" + n : "#" + encodeURIComponent(player.id) + "/" + n;
  }

  // anyPlayer: links clicked in the page may also target decks with hash=false.
  function parseHash(h, anyPlayer) {
    var m = /^#\/(\d+)$/.exec(h);
    if (m) {
      var owner = hashOwner || (anyPlayer ? players[0] : null);
      return owner ? { player: owner, page: +m[1] } : null;
    }
    m = /^#(.+)\/(\d+)$/.exec(h);
    if (!m) return null;
    var id;
    try { id = decodeURIComponent(m[1]); } catch (e) { return null; }
    for (var i = 0; i < players.length; i++) {
      if (players[i].id === id && (anyPlayer || players[i].hashEnabled)) return { player: players[i], page: +m[2] };
    }
    return null;
  }

  function applyHash(scroll) {
    var t = parseHash(location.hash, false);
    if (!t) return;
    t.player.go(t.page, { fromHash: true });
    if (scroll) t.player.root.scrollIntoView({ block: "center" });
  }

  // Links in the page text ("see [slide 12](#/12)") jump the deck and bring it into
  // view, even when the URL already holds that hash (no hashchange would fire).
  function onDocumentClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.closest(".pdfslides")) return;
    var url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
    var t = parseHash(url.hash, true);
    if (!t) return;
    e.preventDefault();
    if (t.player.panel) t.player.closePanel(true);
    t.player.go(t.page);
    t.player.reveal();
  }

  // ---- Init -------------------------------------------------------------

  function init() {
    var roots = document.querySelectorAll(".pdfslides:not(.pdfslides-js)");
    if (!roots.length) return;
    roots.forEach(function (root) {
      var p = new Player(root);
      players.push(p);
      if (!hashOwner && p.hashEnabled) hashOwner = p;
    });

    // Lazy-load decks as they approach the viewport.
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          io.unobserve(en.target);
          var p = players.find(function (x) { return x.root === en.target; });
          if (p) p.load();
        });
      }, { rootMargin: "300px 0px" });
      players.forEach(function (p) { io.observe(p.root); });
    } else {
      players.forEach(function (p) { p.load(); });
    }

    applyHash(true);
    window.addEventListener("hashchange", function () { applyHash(true); });
    document.addEventListener("click", onDocumentClick);
    players.forEach(function (p) { p.onResize(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.pdfslides = { players: players };
})();
