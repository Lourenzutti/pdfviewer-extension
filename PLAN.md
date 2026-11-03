> **Status (v1.1.0):** this is the original design plan, kept for background. The README is
> the up-to-date user documentation. Added since this plan: contents and overview panels,
> `sections` option, `slidelink` shortcode, progress-bar scrubbing, annotation (pens and
> highlighter), a toolbar without slide titles, a toolbar-less fullscreen, and CSS isolation
> from site-wide `button` styles. Where this plan and the code disagree, the code wins.

# pdfslides — Quarto shortcode extension: design plan

Goal: a course website (Quarto website/book, HTML output) embeds PowerPoint-exported
PDF slide decks with a clean, site-styled player:

```
{{< pdfslides lecture3.pdf >}}
```

## Layout

```
_extensions/pdfslides/
  _extension.yml          # contributes shortcode pdfslides.lua
  pdfslides.lua           # shortcode -> HTML container (+ fallback for non-HTML formats)
  pdfslides.js            # player (classic script, ~300 lines incl. links/cache/swipe)
  pdfslides.css           # styling via CSS custom properties, inherits Bootstrap/Quarto vars
  pdfjs/pdf.min.js        # vendored pdfjs-dist (ES module, renamed .mjs -> .js for MIME safety)
  pdfjs/pdf.worker.min.js
  pdfjs/LICENSE
example.qmd / tests/
```

## Shortcode (Lua)

- Positional arg 1 = PDF path (relative to the document, or site-absolute `/slides/x.pdf`).
- kwargs: `start` (1), `id` (auto `pdfslides-N`), `aspect` (placeholder ratio before load,
  default 16/9; real ratio taken from page 1), `download` (true), `hash` (true for first
  player on page), `title` (aria label / caption), `width`/`max-width`.
- Global defaults from document metadata key `pdfslides:` (shortcode kwargs override).
- HTML output: `<div class="pdfslides" data-src=... data-start=...>` containing
  a real `<a href="lecture3.pdf">` (download + no-JS fallback). The real href lets Quarto's
  resource discovery copy the PDF into `_site/`.
- Dependency added via `quarto.doc.add_html_dependency` (js + css + pdfjs files as resources).
- Non-HTML output (pdf/docx/typst): emit a plain link "Slides (PDF): lecture3.pdf".

## Player (JS)

- PDF.js loaded lazily by dynamic `import()` from a URL computed relative to
  `document.currentScript.src`; worker set via `GlobalWorkerOptions.workerSrc`.
- Lazy init with IntersectionObserver (don't download a 20 MB deck until near viewport).
- One `<canvas>` sized to fit the container (letterboxed) using page 1's aspect ratio;
  backing store = CSS size × devicePixelRatio (capped at ~16 M pixels).
- Rendering: render into offscreen canvas, then swap (no flicker); cancel in-flight
  `RenderTask` on fast navigation; small LRU cache of rendered pages; preload next
  (and previous) page after the current one finishes.
- Navigation: → ↓ PageDown Space = next; ← ↑ PageUp Shift+Space = prev; Home/End;
  number + Enter to jump; F = fullscreen; Esc exits. Keys are handled only when the
  player has focus (tabindex=0) or is fullscreen, so page scrolling is not hijacked.
- Click: left 30% of slide = previous, rest = next (clicks on PDF links follow the link).
- Swipe: Pointer Events horizontal swipe threshold; `touch-action: pan-y` to keep
  vertical page scroll on mobile.
- Fullscreen: Fullscreen API on the player element; fallback "pseudo-fullscreen"
  (fixed, inset 0) for iPhone Safari which lacks element fullscreen.
- URL hash: `#/12` for the hash-owning player (Quarto/reveal style); `#<id>/12` for others.
  Uses `history.replaceState` (no history spam); listens to `hashchange` for deep links.
- PDF links: `page.getAnnotations()` → Link annotations become absolutely positioned
  `<a>` overlays (external URL → `target=_blank rel=noopener`; internal dest → resolve
  with `getDestination`/`getPageIndex` and jump).
- Toolbar: prev / "3 / 20" / next / fullscreen / download; thin progress bar. Visible on
  hover/focus, always on touch. Colors from `--bs-body-color`, `--bs-primary`, etc.
- Accessibility: `role=region`, aria-label = title, aria-live "Slide 3 of 20", buttons
  with labels; page text (`getTextContent`) placed in a visually-hidden element for
  screen readers / Ctrl+F of the current slide.
- Errors (404, file://, CORS) → message + download link.
- ResizeObserver → re-render at new size (debounced).

## Tests

1. Render tests (Quarto): render a test website with fixtures; assert HTML contains the
   container with right data attributes, kwargs/metadata defaults merge, PDF copied to
   `_site/`, non-HTML formats (typst/docx) produce the fallback link, multiple shortcodes.
2. Browser tests (Python Playwright + pytest, serve `_site/` over http.server):
   loads & shows "1 / N"; arrow/space/PageDown navigation; Home/End; keys ignored when
   unfocused; click zones; simulated swipe; hash updated on navigation and deep-link
   `#/3` opens slide 3; `#id/2` for second player; two players independent; canvas
   backing size = CSS × DPR (device_scale_factor=2); external link overlay has the URL;
   internal link jumps; fullscreen toggles (pseudo-fullscreen class in headless);
   missing PDF shows error state; lazy loading does not fetch off-screen PDF.
3. Fixture PDFs generated with `quarto typst compile` (16:9 pages, external + internal
   links), plus a 4:3 deck to test aspect handling.

## Revisions after review (Codex + Antigravity)

Plan review:
- Legacy pdfjs-dist build (modern build needs `Map.getOrInsertComputed`, no polyfill);
  vendored cmaps, standard fonts and wasm, passed to `getDocument`.
- Script base URL captured at load time; warning for `embed-resources`.
- Fallback `<a href>` always emitted (resource discovery); `/abs` paths via project offset.
- Editable page box instead of a blind number buffer; always-visible toolbar; load progress.
- Cache limited to current ±1 page; pixel cap 8.3 MP; canvases zeroed on eviction.
- Per-page letterboxing (mixed sizes); pseudo-fullscreen moves the player to `<body>`.
- Deep link to an off-screen deck scrolls to it and loads it.

Code review:
- Focus kept in the player when a nav button becomes disabled / on Safari clicks.
- Arrow keys work on toolbar buttons; Space/Enter keep native button behavior.
- Canvas zeroed only after a cancelled render settles; frame resized immediately on resize;
  link overlays positioned in %.
- Primary-pointer-only swipes; capture-phase click suppression after a swipe.
- Link URLs limited to http/https/mailto; stale link-resolution guard.
- Retryable load failure; navigation during load applied afterwards.
- Hash ids URL-encoded; `fullscreenerror` falls back to pseudo-fullscreen.
- Screen-reader text of the current slide (canvas is opaque).
- Lua: no `id` from metadata, unique auto ids, duplicate warning, query strings preserved,
  `max-width` validated.

## Non-goals / documented limits

PowerPoint animations/builds lost (duplicate slides before export); video/GIF won't play
(link out); no speaker notes.
