"""Jump navigation: overview grid, contents menu, sections, links from page text."""

import re

import pytest
from playwright.sync_api import expect

from test_player import open_page, rendered, wait_ready, no_errors


def grid_panel(root):
    return root.locator(".pdfslides-panel-grid")


def toc_panel(root):
    return root.locator(".pdfslides-panel-toc")


# ---- Overview grid -------------------------------------------------------

def test_overview_opens_and_jumps(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    btn = root.locator("button[aria-label='Slide overview (G)']")
    btn.click()
    panel = grid_panel(root)
    expect(panel).to_be_visible()
    expect(btn).to_have_attribute("aria-expanded", "true")
    thumbs = panel.locator(".pdfslides-thumb")
    expect(thumbs).to_have_count(6)
    expect(thumbs.nth(0)).to_have_attribute("aria-current", "true")
    expect(thumbs.nth(0)).to_be_focused()
    thumbs.nth(3).click()
    rendered(root, 4)
    expect(panel).to_be_hidden()
    expect(btn).to_have_attribute("aria-expanded", "false")
    expect(root.locator(".pdfslides-stage")).to_be_focused()
    no_errors(page)


def test_overview_thumbnails_render_with_titles(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("g")
    thumbs = grid_panel(root).locator(".pdfslides-thumb")
    expect(thumbs.nth(5)).to_have_class(re.compile(r"\bis-rendered\b"))
    assert thumbs.nth(5).locator("img").evaluate("i => i.complete && i.naturalWidth > 0")
    expect(thumbs.nth(4)).to_have_attribute("aria-label", re.compile(r"^Slide 5: Slide 5"))


def test_overview_keyboard(page, server):
    root = open_page(page, server, "index.html#/2", page_no=2)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("g")
    thumbs = grid_panel(root).locator(".pdfslides-thumb")
    expect(thumbs.nth(1)).to_be_focused()  # starts on the current slide
    page.keyboard.press("ArrowRight")
    expect(thumbs.nth(2)).to_be_focused()
    rendered(root, 2)  # arrows move focus in the grid, not slides
    page.keyboard.press("End")
    expect(thumbs.nth(5)).to_be_focused()
    page.keyboard.press("Enter")
    rendered(root, 6)
    expect(grid_panel(root)).to_be_hidden()


def test_overview_escape_closes_and_keeps_slide(page, server):
    root = open_page(page, server, "index.html#/3", page_no=3)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("g")
    expect(grid_panel(root)).to_be_visible()
    page.keyboard.press("Escape")
    expect(grid_panel(root)).to_be_hidden()
    expect(root.locator(".pdfslides-stage")).to_be_focused()
    page.keyboard.press("ArrowRight")
    rendered(root, 4)


def test_overview_has_section_headings(page, server):
    root = open_page(page, server, "jump.html", page_no=1)
    root.locator("button[aria-label='Slide overview (G)']").click()
    headings = grid_panel(root).locator(".pdfslides-grid-heading")
    expect(headings).to_have_text(["Intro", "Part 2: The middle", "The end"])


def test_overview_works_in_fullscreen(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    page.evaluate("window.pdfslides.players[0].enterPseudo()")
    page.keyboard.press("g")
    expect(grid_panel(root)).to_be_visible()
    grid_panel(root).locator(".pdfslides-thumb").nth(2).click()
    rendered(root, 3)
    expect(root).to_have_class(re.compile(r"\bis-pseudo-fullscreen\b"))


# ---- Contents menu -------------------------------------------------------

def test_contents_from_slide_titles(page, server):
    """PowerPoint-style deck without bookmarks: one entry per slide, titled by its largest text."""
    root = open_page(page, server, "index.html", page_no=1)
    root.locator("button[aria-label='Contents (T)']").click()
    panel = toc_panel(root)
    expect(panel).to_be_visible()
    items = panel.locator(".pdfslides-item")
    expect(items).to_have_count(6)
    expect(items.locator(".pdfslides-toc-title")).to_have_text(
        ["Slide 1", "Slide 2", "Slide 3", "Slide 4", "Slide 5", "Slide 6"])
    items.nth(4).click()
    rendered(root, 5)
    expect(panel).to_be_hidden()


def test_contents_from_pdf_outline(page, server):
    page.goto(f"{server}/jump.html#outlined/1")
    root = wait_ready(page, "#outlined", 1)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("t")
    items = toc_panel(root).locator(".pdfslides-item")
    expect(items.locator(".pdfslides-toc-title")).to_have_text(["Introduction", "Details", "Methods"])
    expect(items.locator(".pdfslides-toc-num")).to_have_text(["1", "2", "3"])
    expect(toc_panel(root).locator("li.pdfslides-toc-level-1")).to_have_count(1)  # "Details" is nested
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    rendered(root, 3)
    # Slide 4 has no bookmark: "Methods" stays the current chapter.
    page.keyboard.press("ArrowRight")
    rendered(root, 4)
    expect(root.locator(".pdfslides-chapter")).to_have_text("Methods")


def test_contents_from_sections(page, server):
    root = open_page(page, server, "jump.html", page_no=1)
    root.locator("button[aria-label='Contents (T)']").click()
    panel = toc_panel(root)
    expect(panel.locator(".pdfslides-panel-title")).to_have_text("Sections")
    items = panel.locator(".pdfslides-item")
    expect(items.locator(".pdfslides-toc-title")).to_have_text(["Intro", "Part 2: The middle", "The end"])
    expect(items.nth(0)).to_have_attribute("aria-current", "true")
    items.nth(1).click()
    rendered(root, 3)
    root.locator("button[aria-label='Contents (T)']").click()
    expect(items.nth(1)).to_have_attribute("aria-current", "true")


def test_click_beside_contents_drawer_closes_it(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator("button[aria-label='Contents (T)']").click()
    expect(toc_panel(root)).to_be_visible()
    box = root.locator(".pdfslides-stage").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.95, box["y"] + box["height"] * 0.9)
    expect(toc_panel(root)).to_be_hidden()
    rendered(root, 1)  # the click closed the drawer instead of advancing


def test_only_one_panel_at_a_time(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("t")
    expect(toc_panel(root)).to_be_visible()
    root.locator("button[aria-label='Slide overview (G)']").click()
    expect(grid_panel(root)).to_be_visible()
    expect(toc_panel(root)).to_be_hidden()


# ---- Sections: chapter label and progress ticks --------------------------

def test_chapter_label_and_ticks(page, server):
    root = open_page(page, server, "jump.html", page_no=1)
    label = root.locator(".pdfslides-chapter")
    expect(label).to_have_text("Intro")
    root.locator(".pdfslides-stage").focus()
    for _ in range(3):
        page.keyboard.press("ArrowRight")
    rendered(root, 4)
    expect(label).to_have_text("Part 2: The middle")
    ticks = root.locator(".pdfslides-tick")
    expect(ticks).to_have_count(2)  # no tick at slide 1
    assert ticks.nth(0).get_attribute("title") == "Part 2: The middle"


def test_progress_bar_scrubbing(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    box = root.locator(".pdfslides-progress").bounding_box()
    page.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
    rendered(root, 5)  # 6 slides: 75 % falls in slide 5
    page.mouse.click(box["x"] + 2, box["y"] + box["height"] / 2)
    rendered(root, 1)


# ---- Links from the page text --------------------------------------------

def test_text_link_jumps_deck(page, server):
    root = open_page(page, server, "jump.html", page_no=1)
    page.get_by_role("link", name="see slide 4").click()
    rendered(root, 4)
    assert page.evaluate("location.hash") == "#/4"
    expect(root.locator(".pdfslides-stage")).to_be_focused()


def test_text_link_scrolls_deck_into_view_even_with_same_hash(page, server):
    root = open_page(page, server, "jump.html", page_no=1)
    page.get_by_role("link", name="see slide 4").click()
    rendered(root, 4)  # hash is now #/4
    bottom = page.get_by_role("link", name="again slide 4")
    bottom.scroll_into_view_if_needed()
    expect(root).not_to_be_in_viewport()
    bottom.click()  # same hash: no hashchange, still must scroll back
    expect(root).to_be_in_viewport()
    rendered(root, 4)


def test_slidelink_to_other_deck(page, server):
    page.goto(f"{server}/jump.html")
    link = page.get_by_role("link", name="outline slide 2")
    link.scroll_into_view_if_needed()
    link.click()
    root = wait_ready(page, "#outlined", 2)
    expect(root).to_be_in_viewport()
    rendered(page.locator("#pdfslides-1"), 1)  # the other deck did not move


def test_slidelink_to_other_page(page, server):
    page.goto(f"{server}/jump.html")
    page.get_by_role("link", name="lecture 1, slide 3").click()
    page.wait_for_url(re.compile(r"/(index\.html)?#/3$"))  # Quarto may link index as "/"
    wait_ready(page, "#pdfslides-1", 3)


def test_modified_click_is_not_intercepted(page, server):
    root = open_page(page, server, "jump.html", page_no=1)
    intercepted = page.evaluate("""() => {
        const a = [...document.querySelectorAll('a')].find(x => x.textContent === 'see slide 4');
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
        a.addEventListener('click', e => e.preventDefault(), { once: true });  // don't navigate
        a.dispatchEvent(ev);
        return window.pdfslides.players[0].page;
    }""")
    assert intercepted == 1


# ---- Small screens -------------------------------------------------------

@pytest.mark.parametrize("width", [390, 320])
def test_toolbar_fits_on_phones(browser, server, width):
    ctx = browser.new_context(viewport={"width": width, "height": 800})
    pg = ctx.new_page()
    pg.goto(f"{server}/jump.html")
    root = wait_ready(pg, "#pdfslides-1", 1)
    expect(root).to_have_class(re.compile(r"\bis-narrow\b"))
    bar = root.locator(".pdfslides-toolbar")
    assert bar.evaluate("b => b.scrollWidth <= b.clientWidth")
    for label in ["Previous slide", "Next slide", "Contents (T)", "Slide overview (G)", "Enter fullscreen (F)"]:
        expect(bar.get_by_role("button", name=label)).to_be_visible()
    rows = bar.evaluate("""b => [...b.children].filter(c => c.offsetParent).map(c => {
        const r = c.getBoundingClientRect();
        return [c.className, Math.round(r.top), Math.round(r.bottom), Math.round(r.width)];
    })""")
    rows = [r for r in rows if "spacer" not in r[0]]  # zero-height flex filler
    one_row = max(r[1] for r in rows) < min(r[2] for r in rows)
    assert one_row, f"toolbar wrapped onto several rows: {rows}"
    ctx.close()


# ---- One bookmark per slide (PowerPoint export) ----------------------------

def test_per_slide_bookmarks_are_not_sections(page, server):
    page.goto(f"{server}/jump.html")
    root = page.locator("#perslide")
    root.scroll_into_view_if_needed()
    root = wait_ready(page, "#perslide")
    # "Slide N:" is stripped (the number is shown separately) and no section label/headings.
    root.locator("button[aria-label='Contents (T)']").click()
    expect(toc_panel(root).locator(".pdfslides-toc-title")).to_have_text(["Alpha", "Beta", "Gamma"])
    root.locator("button[aria-label='Contents (T)']").click()
    expect(root.locator(".pdfslides-chapter")).to_have_text("")
    root.locator("button[aria-label='Slide overview (G)']").click()
    expect(grid_panel(root).locator(".pdfslides-grid-heading")).to_have_count(0)
