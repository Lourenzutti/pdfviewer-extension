"""Static checks on what the shortcode renders (no browser needed)."""

import re

from build import FALLBACK


def container(html, id_):
    m = re.search(r'<div class="pdfslides" id="%s"[^>]*>' % re.escape(id_), html)
    assert m, f"no pdfslides container with id={id_}"
    return m.group(0)


def attr(tag, name):
    m = re.search(r'%s="([^"]*)"' % re.escape(name), tag)
    return m.group(1) if m else None


def read(site, name):
    return (site / name).read_text(encoding="utf-8")


def test_basic_container_and_dependency(built):
    html = read(built, "index.html")
    tag = container(html, "pdfslides-1")
    assert attr(tag, "data-src") == "slides/deck169.pdf"
    assert attr(tag, "data-start") == "1"
    assert attr(tag, "aria-label") == "Lecture 1"
    assert 'class="pdfslides-fallback" href="slides/deck169.pdf"' in html
    assert "site_libs/quarto-contrib/pdfslides-1.0.0/pdfslides.js" in html
    assert "site_libs/quarto-contrib/pdfslides-1.0.0/pdfslides.css" in html


def test_pdfjs_assets_are_published(built):
    lib = built / "site_libs/quarto-contrib/pdfslides-1.0.0/pdfjs"
    for rel in ["pdf.min.js", "pdf.worker.min.js", "LICENSE", "wasm/openjpeg.wasm",
                "standard_fonts/LiberationSans-Regular.ttf", "cmaps/UniGB-UCS2-H.bcmap"]:
        assert (lib / rel).is_file(), rel


def test_pdfs_are_copied_to_site(built):
    for name in ["deck169.pdf", "deck43.pdf", "mixed.pdf", "my deck.pdf"]:
        assert (built / "slides" / name).is_file(), name


def test_ids_unique_and_explicit(built):
    html = read(built, "multi.html")
    ids = re.findall(r'<div class="pdfslides" id="([^"]+)"', html)
    assert ids == ["pdfslides-1", "square", "mixed", "tabbed"]


def test_metadata_defaults_and_kwargs(built):
    html = read(built, "options.html")
    first = container(html, "pdfslides-1")
    assert attr(first, "data-start") == "3"
    assert attr(first, "data-hash") == "false"
    assert attr(first, "data-download") == "false"  # from document metadata
    assert "--pdfslides-aspect: 4 / 3" in attr(first, "style")
    assert "max-width: 600px" in attr(first, "style")
    spaces = container(html, "spaces")
    assert attr(spaces, "data-download") == "true"  # kwarg overrides metadata
    assert attr(spaces, "data-src") == "slides/my%20deck.pdf"


def test_auto_ids_skip_explicit_ones(built):
    html = read(built, "ids.html")
    ids = re.findall(r'<div class="pdfslides" id="([^"]+)"', html)
    assert ids == ["pdfslides-1", "pdfslides-2", "week.1", "query"]


def test_metadata_cannot_set_id(built):
    html = read(built, "options.html")
    assert "ignored-in-metadata" not in html


def test_query_string_kept_and_bad_css_rejected(built):
    tag = container(read(built, "ids.html"), "query")
    assert attr(tag, "data-src") == "slides/deck43.pdf?v=2"
    assert attr(tag, "style") is None  # max-width="10px;color:red" was refused


def test_site_absolute_path_uses_project_offset(built):
    html = read(built, "sub/dir/nested.html")
    assert attr(container(html, "absolute"), "data-src") == "../../slides/deck169.pdf"
    assert attr(container(html, "relative"), "data-src") == "../../slides/deck43.pdf"


def test_non_html_formats_get_a_plain_link(built):
    md = (FALLBACK / "fallback.md").read_text(encoding="utf-8")
    assert "[Lecture slides](deck.pdf)" in md
    assert "See the fourth slide." in md  # slidelink becomes plain text
    assert "pdfslides" not in md


def test_sections_are_parsed_and_sorted(built):
    import html as htmllib
    import json

    tag = container(read(built, "jump.html"), "pdfslides-1")
    sections = json.loads(htmllib.unescape(attr(tag, "data-sections")))
    assert sections == [  # "broken" (no page) is dropped; colons allowed in titles
        {"title": "Intro", "page": 1},
        {"title": "Part 2: The middle", "page": 3},
        {"title": "The end", "page": 6},
    ]


def test_slidelink_targets(built):
    html = read(built, "jump.html")
    assert '<a href="#/2" class="pdfslides-slidelink">slide 2</a>' in html
    assert '<a href="#outlined/2" class="pdfslides-slidelink">outline slide 2</a>' in html
    assert '<a href="index.html#/3" class="pdfslides-slidelink">lecture 1, slide 3</a>' in html
