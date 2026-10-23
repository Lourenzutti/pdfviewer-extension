import functools
import http.server
import os
import threading

import pytest
from playwright.sync_api import sync_playwright

from build import SITE, build

BROWSERS = os.environ.get("PDFSLIDES_BROWSERS", "chromium,firefox,webkit").split(",")


@pytest.fixture(scope="session")
def built():
    if not os.environ.get("PDFSLIDES_SKIP_BUILD"):
        build()
    return SITE / "_site"


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows registries sometimes map .js to text/plain, which breaks ES modules.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".pdf": "application/pdf",
    }

    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def server(built):
    handler = functools.partial(Handler, directory=str(built))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture(scope="session")
def playwright_instance():
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session", params=BROWSERS)
def browser(request, playwright_instance):
    b = getattr(playwright_instance, request.param).launch()
    yield b
    b.close()


@pytest.fixture
def context_options():
    return {"viewport": {"width": 1280, "height": 800}}


@pytest.fixture
def page(browser, context_options):
    context = browser.new_context(**context_options)
    pg = context.new_page()
    pg.set_default_timeout(15000)
    pg.errors = []
    pg.on("pageerror", lambda exc: pg.errors.append(str(exc)))
    pg.on("console", lambda msg: msg.type == "error" and pg.errors.append(msg.text))
    yield pg
    context.close()
