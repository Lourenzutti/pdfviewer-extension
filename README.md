# pdfslides

A Quarto shortcode that turns a PDF slide deck (e.g. exported from PowerPoint) into a
clean, site-styled slide player powered by [PDF.js](https://mozilla.github.io/pdf.js/).

```markdown
{{< pdfslides lecture3.pdf >}}
```

- One slide at a time, sized to the deck's own aspect ratio; sharp on retina screens
  and projectors (renders at device pixel ratio).
- Arrow keys / Space / PageUp/PageDown / Home / End, click (left 30 % = back), and swipe.
- Fullscreen with the button or <kbd>F</kbd> (with a fallback on iPhone).
- Link to a slide: `lecture3.html#/12` (Quarto/reveal style). Other decks on the same
  page use `#<id>/12`.
- Hyperlinks inside the PDF work (external links open in a new tab, internal links jump).
- Next/previous slides are pre-rendered so advancing feels instant.
- Decks load lazily when scrolled near; "Open PDF" and "Download" buttons.
- Colors follow your Quarto/Bootstrap theme.

## Install

```bash
quarto add <github-user>/pdfshow-extension
```

or copy `_extensions/pdfslides/` into your project's `_extensions/` folder.

## Usage

```markdown
{{< pdfslides slides/lecture3.pdf >}}
{{< pdfslides /slides/lecture3.pdf title="Lecture 3" start=5 >}}
{{< pdfslides "slides/week 1.pdf" id=week1 download=false >}}
```

Paths are relative to the page; paths starting with `/` are relative to the project root.
The PDF is copied to the rendered site automatically.

| Option      | Default      | Description |
|-------------|--------------|-------------|
| `start`     | `1`          | Initial slide. |
| `title`     | –            | Accessible name of the player and text of the fallback link. |
| `id`        | `pdfslides-N`| Element id; also used in the URL hash (`#id/3`). |
| `download`  | `true`       | Show "Open PDF" and "Download" buttons. |
| `hash`      | `true`       | Keep the current slide in the URL hash. |
| `aspect`    | from PDF     | Force the player's aspect ratio, e.g. `16:9` or `4/3`. |
| `max-width` | –            | CSS max width of the player, e.g. `800px`. |

Defaults for a page or the whole project can be set in metadata:

```yaml
pdfslides:
  download: false
```

In non-HTML formats (PDF, Word, Typst, Markdown) the shortcode becomes a plain link.

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

## Development

Tests render a test website and drive it in Chromium, Firefox and WebKit:

```bash
uv run --project ~/python-global python -m playwright install chromium firefox webkit
uv run --project ~/python-global python -m pytest tests
```

Set `PDFSLIDES_BROWSERS=chromium` to test one browser, `PDFSLIDES_SKIP_BUILD=1` to skip
re-rendering.

PDF.js (Apache-2.0) is vendored in `_extensions/pdfslides/pdfjs/` from the
`pdfjs-dist` **legacy** build (supports older Safari versions).
