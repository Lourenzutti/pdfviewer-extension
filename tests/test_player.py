"""Browser tests for the player (Chromium, Firefox and WebKit)."""

import re

import pytest
from playwright.sync_api import expect


def open_page(page, server, path, sel="#pdfslides-1", page_no=None):
    page.goto(f"{server}/{path}")
    return wait_ready(page, sel, page_no)


def wait_ready(page, sel, page_no=None):
    root = page.locator(sel)
    expect(root).to_have_class(re.compile(r"\bis-ready\b"))
    if page_no is not None:
        expect(root).to_have_attribute("data-rendered", str(page_no))
    else:
        expect(root).to_have_attribute("data-rendered", re.compile(r"\d+"))
    return root


def rendered(root, n):
    expect(root).to_have_attribute("data-rendered", str(n))
    expect(root.locator(".pdfslides-input")).to_have_value(str(n))


def no_errors(page):
    assert page.errors == [], page.errors


# ---- Loading -------------------------------------------------------------

def test_loads_first_slide(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    expect(root.locator(".pdfslides-total")).to_have_text("/ 6")
    expect(root.locator(".pdfslides-fallback")).to_be_hidden()
    canvas = root.locator("canvas:not(.pdfslides-ink)")
    expect(canvas).to_have_count(1)
    assert canvas.evaluate("c => c.width > 0 && c.height > 0")
    no_errors(page)


def test_canvas_is_not_blank(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    dark = root.locator("canvas:not(.pdfslides-ink)").evaluate("""c => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++;
        return n;
    }""")
    assert dark > 1000  # the "Slide 1" title was drawn


def test_aspect_ratio_comes_from_pdf(page, server):
    page.goto(f"{server}/multi.html#square/1")
    root = wait_ready(page, "#square", 1)
    box = root.locator(".pdfslides-stage").bounding_box()
    assert box["width"] / box["height"] == pytest.approx(4 / 3, rel=0.02)


def test_hidpi_backing_store(browser, server):
    ctx = browser.new_context(viewport={"width": 1000, "height": 800}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.goto(f"{server}/index.html")
    root = wait_ready(pg, "#pdfslides-1", 1)
    w, css = root.locator("canvas:not(.pdfslides-ink)").evaluate("c => [c.width, c.getBoundingClientRect().width]")
    assert w == pytest.approx(2 * css, abs=2)
    ctx.close()


def test_lazy_loading_waits_for_viewport(page, server):
    requested = []
    page.on("request", lambda r: requested.append(r.url))
    open_page(page, server, "multi.html", page_no=1)
    page.wait_for_timeout(500)
    assert not any("deck43.pdf" in u for u in requested), "off-screen deck was fetched"
    page.locator("#square").scroll_into_view_if_needed()
    wait_ready(page, "#square", 1)
    assert any("deck43.pdf" in u for u in requested)


# ---- Navigation ----------------------------------------------------------

def test_keyboard_navigation(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    kb = page.keyboard
    kb.press("ArrowLeft"); rendered(root, 1)          # clamped at start
    kb.press("ArrowRight"); kb.press("ArrowRight"); rendered(root, 3)
    kb.press("ArrowLeft"); rendered(root, 2)
    kb.press("Space"); rendered(root, 3)
    kb.press("Shift+Space"); rendered(root, 2)
    kb.press("PageDown"); rendered(root, 3)
    kb.press("End"); rendered(root, 6)
    kb.press("ArrowRight"); rendered(root, 6)         # clamped at end
    kb.press("Home"); rendered(root, 1)
    no_errors(page)


def test_keys_ignored_without_focus(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    page.locator("h1").first.click()
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(300)
    rendered(root, 1)


def test_keys_on_toolbar_controls_keep_native_meaning(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator("button[aria-label='Next slide']").focus()
    page.keyboard.press("Space")  # activates the button once, must not also advance
    rendered(root, 2)
    page.wait_for_timeout(300)
    rendered(root, 2)
    root.locator(".pdfslides-input").focus()
    page.keyboard.press("ArrowRight")  # moves the text cursor only
    page.wait_for_timeout(300)
    rendered(root, 2)


def test_toolbar_buttons_and_disabled_state(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    prev = root.locator("button[aria-label='Previous slide']")
    nxt = root.locator("button[aria-label='Next slide']")
    expect(prev).to_be_disabled()
    nxt.click(); rendered(root, 2)
    expect(prev).to_be_enabled()
    prev.click(); rendered(root, 1)
    root.locator(".pdfslides-input").fill("6")
    page.keyboard.press("Enter")
    rendered(root, 6)
    expect(nxt).to_be_disabled()


def test_page_input_rejects_garbage(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    inp = root.locator(".pdfslides-input")
    inp.fill("abc"); page.keyboard.press("Enter")
    expect(inp).to_have_value("1")
    inp.fill("99"); page.keyboard.press("Enter")
    rendered(root, 6)


def test_click_zones(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    frame = root.locator(".pdfslides-frame")
    box = frame.bounding_box()
    # Click the lower part of the slide to avoid the link on slide 1.
    page.mouse.click(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.9)
    rendered(root, 2)
    page.mouse.click(box["x"] + box["width"] * 0.1, box["y"] + box["height"] * 0.9)
    rendered(root, 1)


def test_swipe(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    swipe = """([stage, dx]) => {
        const r = stage.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const opts = { pointerType: 'touch', bubbles: true, isPrimary: true, pointerId: 7 };
        stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x, clientY: y }));
        stage.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x + dx, clientY: y + 5 }));
        stage.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + dx, clientY: y }));
    }"""
    stage = root.locator(".pdfslides-stage").element_handle()
    page.evaluate(swipe, [stage, -150]); rendered(root, 2)  # click after swipe is suppressed
    page.evaluate(swipe, [stage, 150]); rendered(root, 1)
    page.evaluate(swipe, [stage, -20])  # too short: just a tap on the right -> next
    rendered(root, 2)


def test_rapid_navigation_lands_on_last_slide(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    for _ in range(10):
        page.keyboard.press("ArrowRight", delay=0)
    rendered(root, 6)
    page.wait_for_timeout(500)
    rendered(root, 6)
    assert root.locator("canvas:not(.pdfslides-ink)").count() == 1
    no_errors(page)


def test_mixed_page_sizes_are_letterboxed(page, server):
    page.goto(f"{server}/multi.html#mixed/1")
    root = wait_ready(page, "#mixed", 1)
    stage = root.locator(".pdfslides-stage").bounding_box()
    frame = root.locator(".pdfslides-frame").bounding_box()
    assert frame["width"] == pytest.approx(stage["width"], abs=2)
    root.locator(".pdfslides-input").fill("3"); page.keyboard.press("Enter")
    rendered(root, 3)
    frame = root.locator(".pdfslides-frame").bounding_box()
    assert frame["height"] == pytest.approx(stage["height"], abs=2)
    assert frame["width"] < stage["width"] * 0.6  # portrait page, pillarboxed


def test_players_are_independent(page, server):
    page.goto(f"{server}/multi.html#square/2")
    sq = wait_ready(page, "#square", 2)
    first = page.locator("#pdfslides-1")
    page.evaluate("window.scrollTo(0, 0)")
    wait_ready(page, "#pdfslides-1", 1)
    first.locator("button[aria-label='Next slide']").click()
    rendered(first, 2)
    rendered(sq, 2)


# ---- Hash routing --------------------------------------------------------

def test_navigation_updates_hash(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    assert page.evaluate("location.hash") == ""  # nothing added on load
    entries = page.evaluate("history.length")
    root.locator("button[aria-label='Next slide']").click()
    rendered(root, 2)
    root.locator("button[aria-label='Next slide']").click()
    rendered(root, 3)
    assert page.evaluate("location.hash") == "#/3"
    assert page.evaluate("history.length") == entries  # replaceState, no history spam


def test_deep_link(page, server):
    root = open_page(page, server, "index.html#/4", page_no=4)
    rendered(root, 4)


def test_hashchange_navigates(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    page.evaluate("location.hash = '#/5'")
    rendered(root, 5)


def test_deep_link_to_offscreen_player_scrolls_and_loads(page, server):
    page.goto(f"{server}/multi.html#square/3")
    root = wait_ready(page, "#square", 3)
    expect(root).to_be_in_viewport()


def test_hash_disabled_player(page, server):
    root = open_page(page, server, "options.html", page_no=3)  # start=3
    root.locator("button[aria-label='Next slide']").click()
    rendered(root, 4)
    assert page.evaluate("location.hash") == ""


# ---- Links ---------------------------------------------------------------

def test_external_link_overlay(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    link = root.locator("a.pdfslides-link")
    expect(link).to_have_count(1)
    expect(link).to_have_attribute("href", "https://example.com/external")
    expect(link).to_have_attribute("target", "_blank")
    lb, fb = link.bounding_box(), root.locator(".pdfslides-frame").bounding_box()
    assert fb["x"] <= lb["x"] and lb["x"] + lb["width"] <= fb["x"] + fb["width"]
    assert fb["y"] <= lb["y"] and lb["y"] + lb["height"] <= fb["y"] + fb["height"]


def test_internal_link_jumps(page, server):
    root = open_page(page, server, "index.html#/2", page_no=2)
    link = root.locator("a.pdfslides-link")
    expect(link).to_have_attribute("href", "#/5")
    link.click()
    rendered(root, 5)


# ---- Fullscreen ----------------------------------------------------------

def test_fullscreen_toggle(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    btn = root.locator("button[aria-label='Enter fullscreen (F)']")
    btn.click()
    expect(root).to_have_class(re.compile(r"\bis-fullscreen\b"))
    stage = root.locator(".pdfslides-stage").bounding_box()
    assert stage["height"] > 600  # fills (most of) the 800px viewport
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("f")
    expect(root).not_to_have_class(re.compile(r"\bis-fullscreen\b"))


def test_pseudo_fullscreen_fallback(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    page.evaluate("window.pdfslides.players[0].enterPseudo()")
    expect(root).to_have_class(re.compile(r"\bis-pseudo-fullscreen\b"))
    assert page.evaluate("document.getElementById('pdfslides-1').parentElement === document.body")
    box = root.bounding_box()
    assert box["width"] == pytest.approx(1280, abs=2) and box["height"] == pytest.approx(800, abs=2)
    page.keyboard.press("ArrowRight")
    rendered(root, 2)
    page.keyboard.press("Escape")
    expect(root).not_to_have_class(re.compile(r"\bis-pseudo-fullscreen\b"))
    assert page.evaluate("document.getElementById('pdfslides-1').parentElement !== document.body")


# ---- Layout edge cases ---------------------------------------------------

def test_resize_rerenders_sharply(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    before = root.locator("canvas:not(.pdfslides-ink)").evaluate("c => c.width")
    page.set_viewport_size({"width": 700, "height": 800})
    page.wait_for_function(
        "w => document.querySelector('#pdfslides-1 canvas:not(.pdfslides-ink)').width < w", arg=before)
    w, css = root.locator("canvas:not(.pdfslides-ink)").evaluate("c => [c.width, c.getBoundingClientRect().width]")
    assert w == pytest.approx(css, abs=2)


def test_player_in_hidden_tab_renders_when_shown(page, server):
    page.goto(f"{server}/multi.html")
    page.get_by_role("tab", name="Slides tab").click()
    root = wait_ready(page, "#tabbed", 1)
    assert root.locator("canvas:not(.pdfslides-ink)").evaluate("c => c.width") > 100


def test_nested_page_paths(page, server):
    page.goto(f"{server}/sub/dir/nested.html")
    wait_ready(page, "#absolute", 1)
    page.locator("#relative").scroll_into_view_if_needed()
    wait_ready(page, "#relative", 1)
    no_errors(page)


def test_filename_with_spaces(page, server):
    page.goto(f"{server}/options.html")
    page.locator("#spaces").scroll_into_view_if_needed()
    root = wait_ready(page, "#spaces", 1)
    expect(root.locator("a[download]")).to_have_attribute("href", "slides/my%20deck.pdf")


def test_download_option(page, server):
    root = open_page(page, server, "options.html", page_no=3)
    expect(root.locator("a[download]")).to_have_count(0)


def test_missing_pdf_shows_error(page, server):
    page.goto(f"{server}/options.html")
    root = page.locator("#missing")
    root.scroll_into_view_if_needed()
    expect(root).to_have_class(re.compile(r"\bis-error\b"))
    status = root.locator(".pdfslides-status")
    expect(status).to_contain_text("could not be loaded")
    expect(status.locator("a")).to_have_attribute("href", "slides/does-not-exist.pdf")


def test_live_region_announces_slide(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator("button[aria-label='Next slide']").click()
    expect(root.locator(".pdfslides-sr[aria-live]")).to_have_text("Slide 2 of 6")


def test_slide_text_exposed_to_screen_readers(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    text = root.locator(".pdfslides-text")
    expect(text).to_contain_text("Slide 1 text:")
    expect(text).to_contain_text("External link")
    root.locator("button[aria-label='Next slide']").click()
    expect(text).to_contain_text("Jump to slide 5")


# ---- Regressions found in review -----------------------------------------

def test_keyboard_still_works_after_next_button_is_disabled(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    nxt = root.locator("button[aria-label='Next slide']")
    for n in range(2, 7):
        nxt.click()
        rendered(root, n)
    expect(nxt).to_be_disabled()
    page.keyboard.press("ArrowLeft")  # focus moved to the stage, not <body>
    rendered(root, 5)


def test_arrow_keys_work_on_focused_toolbar_button(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator("button[aria-label='Enter fullscreen (F)']").focus()
    page.keyboard.press("ArrowRight")
    rendered(root, 2)


def test_render_cache_is_bounded(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    for n in range(2, 7):
        page.keyboard.press("ArrowRight")
        rendered(root, n)
    assert page.evaluate("window.pdfslides.players[0].cache.size") <= 3
    before = page.evaluate("window.pdfslides.players[0].lastSizeKey")
    page.set_viewport_size({"width": 700, "height": 700})
    page.wait_for_function("k => window.pdfslides.players[0].lastSizeKey !== k", arg=before)
    page.wait_for_timeout(300)  # let prefetch settle
    sizes = page.evaluate("""() => {
        const p = window.pdfslides.players[0];
        return [...p.cache.values()].map(e => e.sizeKey);
    }""")
    assert len(sizes) <= 3
    assert all(s != before for s in sizes)  # old-size renders were evicted


def test_swipe_ending_on_link_does_not_follow_it(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    popups = []
    page.on("popup", lambda p: popups.append(p))
    page.evaluate("""([stage, link]) => {
        const s = stage.getBoundingClientRect(), l = link.getBoundingClientRect();
        const opts = { pointerType: 'touch', bubbles: true, isPrimary: true, pointerId: 3 };
        const x0 = l.left + l.width / 2 + 200, y = l.top + l.height / 2;
        stage.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y }));
        link.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 - 200, clientY: y }));
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x0 - 200, clientY: y }));
    }""", [root.locator(".pdfslides-stage").element_handle(),
           root.locator("a.pdfslides-link").element_handle()])
    rendered(root, 2)
    page.wait_for_timeout(300)
    assert popups == []


def test_pinch_does_not_change_slide(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    page.evaluate("""stage => {
        const r = stage.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const t = { pointerType: 'touch', bubbles: true };
        stage.dispatchEvent(new PointerEvent('pointerdown', { ...t, isPrimary: true, pointerId: 1, clientX: x, clientY: y }));
        stage.dispatchEvent(new PointerEvent('pointerdown', { ...t, isPrimary: false, pointerId: 2, clientX: x + 50, clientY: y }));
        stage.dispatchEvent(new PointerEvent('pointerup', { ...t, isPrimary: true, pointerId: 1, clientX: x - 200, clientY: y }));
    }""", root.locator(".pdfslides-stage").element_handle())
    page.wait_for_timeout(300)
    rendered(root, 1)


def test_deep_link_into_inactive_tab(page, server):
    page.goto(f"{server}/multi.html#tabbed/2")
    page.get_by_role("tab", name="Slides tab").click()
    wait_ready(page, "#tabbed", 2)


def test_out_of_range_deep_link_is_clamped(page, server):
    open_page(page, server, "index.html#/99", page_no=6)


def test_unrelated_hash_is_left_alone(page, server):
    open_page(page, server, "index.html#some-section", page_no=1)
    assert page.evaluate("location.hash") == "#some-section"


def test_id_with_dot_in_hash(page, server):
    page.goto(f"{server}/ids.html#week.1/3")
    wait_ready(page, "#week\\.1", 3)


def test_retry_after_failed_load(page, server):
    calls = []

    def flaky(route):
        calls.append(1)
        if len(calls) == 1:
            route.abort()
        else:
            route.continue_()

    page.route("**/deck169.pdf", flaky)
    page.goto(f"{server}/index.html")
    root = page.locator("#pdfslides-1")
    expect(root).to_have_class(re.compile(r"\bis-error\b"))
    root.locator(".pdfslides-stage").click(position={"x": 10, "y": 10})
    wait_ready(page, "#pdfslides-1", 1)
    expect(root).not_to_have_class(re.compile(r"\bis-error\b"))


def test_page_input_requires_integer(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    inp = root.locator(".pdfslides-input")
    inp.fill("2junk"); page.keyboard.press("Enter")
    expect(inp).to_have_value("1")
    rendered(root, 1)


# ---- Annotation ------------------------------------------------------------

def ink_alpha_sum(root):
    return root.locator("canvas.pdfslides-ink").evaluate("""c => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) n += d[i];
        return n;
    }""")


def draw(page, root, dx=200, dy=60):
    box = root.locator(".pdfslides-frame").bounding_box()
    x, y = box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.5
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx / 2, y + dy / 2)
    page.mouse.move(x + dx, y + dy)
    page.mouse.up()


def test_annotation_draws_without_turning_pages(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    palette = root.locator(".pdfslides-palette")
    expect(palette).to_be_hidden()
    root.locator("button[aria-label='Annotate (D)']").click()
    expect(palette).to_be_visible()
    assert ink_alpha_sum(root) == 0
    draw(page, root)
    rendered(root, 1)  # a stroke is not a click on the slide
    assert ink_alpha_sum(root) > 0
    no_errors(page)


def test_annotation_is_kept_per_slide_and_undo_clear(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("d")
    expect(root).to_have_class(re.compile(r"\bis-drawing\b"))
    draw(page, root)
    drawn = ink_alpha_sum(root)
    assert drawn > 0
    page.keyboard.press("ArrowRight")
    rendered(root, 2)
    assert ink_alpha_sum(root) == 0
    page.keyboard.press("ArrowLeft")
    rendered(root, 1)
    assert ink_alpha_sum(root) == drawn
    draw(page, root, dy=-80)
    assert ink_alpha_sum(root) > drawn
    page.keyboard.press("z")
    assert ink_alpha_sum(root) == drawn
    root.locator("button[aria-label=\"Clear this slide's ink\"]").click()
    assert ink_alpha_sum(root) == 0
    page.keyboard.press("Escape")
    expect(root).not_to_have_class(re.compile(r"\bis-drawing\b"))
    expect(root.locator(".pdfslides-palette")).to_be_hidden()


def test_annotation_colors_and_highlighter(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("d")
    root.locator("button[aria-label='Blue pen']").click()
    expect(root.locator("button[aria-label='Blue pen']")).to_have_attribute("aria-pressed", "true")
    draw(page, root)
    rgb = root.locator("canvas.pdfslides-ink").evaluate("""c => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] === 255) return [d[i-3], d[i-2], d[i-1]];
        return null;
    }""")
    assert rgb == [0x1c, 0x7e, 0xd6]


def test_annotation_not_available_in_toolbar_on_phones(browser, server):
    ctx = browser.new_context(viewport={"width": 390, "height": 800})
    pg = ctx.new_page()
    pg.goto(f"{server}/index.html")
    root = wait_ready(pg, "#pdfslides-1", 1)
    expect(root.locator("button[aria-label='Annotate (D)']")).to_be_hidden()
    ctx.close()


# ---- Fullscreen toolbar and site shortcuts ---------------------------------

def test_true_fullscreen_hides_toolbar_but_overlay_keeps_it(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    bar = root.locator(".pdfslides-toolbar")
    page.evaluate("document.getElementById('pdfslides-1').classList.add('is-fullscreen')")
    expect(bar).to_be_hidden()
    page.evaluate("document.getElementById('pdfslides-1').classList.add('is-pseudo-fullscreen')")
    expect(bar).to_be_visible()  # no Esc on iPhone: keep the way out


def test_f_keyup_does_not_reach_site_shortcuts(page, server):
    root = open_page(page, server, "index.html", page_no=1)
    page.evaluate("window.__keyups = []; document.addEventListener('keyup', e => window.__keyups.push(e.key))")
    root.locator(".pdfslides-stage").focus()
    page.keyboard.press("f")
    page.keyboard.press("f")
    page.keyboard.press("ArrowRight")
    assert page.evaluate("window.__keyups") == ["ArrowRight"]
