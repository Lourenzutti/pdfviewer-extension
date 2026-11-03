# pdfslides

A Quarto extension that turns a PDF slide deck (e.g. exported from PowerPoint) into a
clean, site-styled slide player powered by [PDF.js](https://mozilla.github.io/pdf.js/).

```markdown
{{< pdfslides lecture3.pdf >}}
```

- One slide at a time, sized to the deck's own aspect ratio; sharp on retina screens
  and projectors (renders at device pixel ratio).
- Keyboard, click (left 30 % = back) and swipe navigation.
- **Contents** and **slide overview** panels (thumbnails), plus a clickable progress bar.
- **Annotation**: pens in a few colors and a highlighter, per slide, in normal view and fullscreen.
- Fullscreen shows only the slide (no toolbar).
- Link to a slide: `lecture3.html#/12` (Quarto/reveal style), or from the text with the
  `slidelink` shortcode.
- Hyperlinks inside the PDF work (external links open in a new tab, internal links jump).
- Next/previous slides are pre-rendered so advancing feels instant.
- Decks load lazily when scrolled near; "Open PDF" and "Download" buttons.
- Colors follow your Quarto/Bootstrap theme, and the player is protected from site-wide
  `button` styles.

## Install

```bash
quarto add Lourenzutti/pdfviewer-extension
```

or copy `_extensions/pdfslides/` into your project's `_extensions/` folder.

> Pages inside folders whose name starts with `_` or `.` are not part of a Quarto project,
> so they cannot see the project's `_extensions/`. Put pages that use the shortcode in
> regular folders.

## Usage

```markdown
{{< pdfslides slides/lecture3.pdf >}}
{{< pdfslides /slides/lecture3.pdf title="Lecture 3" start=5 >}}
{{< pdfslides "slides/week 1.pdf" id=week1 download=false >}}
{{< pdfslides lecture3.pdf sections="Intro: 1; Part 2: Regression: 9; Summary: 31" >}}
```

Paths are relative to the page; paths starting with `/` are relative to the project root.
The PDF is copied to the rendered site automatically.

| Option      | Default       | Description |
|-------------|---------------|-------------|
| `start`     | `1`           | Initial slide. |
| `title`     | –             | Accessible name of the player and text of the fallback link. |
| `id`        | `pdfslides-N` | Element id; also used in the URL hash (`#id/3`). |
| `download`  | `true`        | Show "Open PDF" and "Download" buttons. |
| `hash`      | `true`        | Keep the current slide in the URL hash. |
| `aspect`    | from PDF      | Force the player's aspect ratio, e.g. `16:9` or `4/3`. |
| `max-width` | –             | CSS max width of the player, e.g. `800px`. |
| `sections`  | PDF bookmarks | Section names for the contents panel, overview headings and progress ticks: `"Title: page; Title: page"`. |

Defaults for a page or the whole project can be set in metadata (not `id`):

```yaml
pdfslides:
  download: false
```

In non-HTML formats (PDF, Word, Typst, Markdown) the shortcode becomes a plain link.

### Linking to slides

```markdown
See {{< slidelink 12 >}}.                                  <!-- the first deck on this page -->
See {{< slidelink 3 deck=week2 text="the proof" >}}.       <!-- a specific deck (by id) -->
See {{< slidelink 5 page=lecture3.qmd >}}.                 <!-- a deck on another page -->
```

Plain links work too: `[slide 4](#/4)` or `[slide 4](other.html#/4)`.

### Keyboard shortcuts

The player reacts to keys when it has focus (click on it) or is fullscreen, so page
scrolling is never hijacked.

| Key | Action |
|-----|--------|
| <kbd>→</kbd> <kbd>↓</kbd> <kbd>PageDown</kbd> <kbd>Space</kbd> <kbd>N</kbd> | Next slide |
| <kbd>←</kbd> <kbd>↑</kbd> <kbd>PageUp</kbd> <kbd>Shift+Space</kbd> <kbd>P</kbd> | Previous slide |
| <kbd>Home</kbd> / <kbd>End</kbd> | First / last slide |
| <kbd>F</kbd> | Fullscreen (<kbd>Esc</kbd> exits) |
| <kbd>T</kbd> | Contents |
| <kbd>G</kbd> or <kbd>O</kbd> | Slide overview |
| <kbd>D</kbd> | Annotate (pens and highlighter) |
| <kbd>Z</kbd> | Undo the last stroke (while annotating) |

You can also type a slide number in the toolbar's page box.

### Contents and overview

The contents panel lists the deck's sections. They come from the `sections` option, else the
PDF's bookmarks (PowerPoint creates one per slide; a leading "Slide 12:" is dropped because
the number is shown beside the title), else the slide titles. The overview shows
thumbnails of every slide; section headings appear only when the deck has real sections.

### Annotation

Click the pen button or press <kbd>D</kbd>. A palette appears on the left of the slide with
four pens, a highlighter, undo and "clear this slide". While annotating, clicks and swipes draw
instead of changing slides (arrow keys still work) and PDF links are disabled. Press
<kbd>D</kbd> or <kbd>Esc</kbd> to stop.

Ink is kept per slide in memory only: it survives navigating and resizing, but not a page
reload. The pen button is hidden on phones. Pens and colors are the `INK_TOOLS` list at
the top of `pdfslides.js`.

### Customizing the look

Override the CSS custom properties, e.g. in your site's `styles.css`:

```css
.pdfslides {
  --pdfslides-accent: #8a2be2;
  --pdfslides-letterbox: #222;
  --pdfslides-border: transparent;
}
```

## Things to know

- **Animations/builds are lost** in PowerPoint's PDF export. If you rely on progressive
  reveals, duplicate those slides before exporting.
- **Videos and GIFs won't play.** Link out to them instead.
- The player needs a web server (`quarto preview` or your published site); it cannot load
  PDFs from `file://` pages, and `embed-resources: true` is not supported.
- Slide text is not searchable inside the player; students can use "Open PDF" to search
  or print the whole deck.
- On iPhone Safari, fullscreen is an overlay that keeps the toolbar (there is no <kbd>Esc</kbd>).

## Development

Tests render a test website and drive it in Chromium, Firefox and WebKit:

```bash
uv run --project ~/python-global python -m playwright install chromium firefox webkit
uv run --project ~/python-global python -m pytest tests
```

Set `PDFSLIDES_BROWSERS=chromium` to test one browser, `PDFSLIDES_SKIP_BUILD=1` to skip
re-rendering. See [PLAN.md](PLAN.md) for the original design notes.

PDF.js (Apache-2.0) is vendored in `_extensions/pdfslides/pdfjs/` from the
`pdfjs-dist` **legacy** build (supports older Safari versions).
