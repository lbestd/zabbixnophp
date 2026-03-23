import pathlib
import json
from aiohttp import web

from .db import init_pool, close_pool
from .jsonrpc import dispatch
from . import methods  # noqa: F401 — registers all handlers

WEB_DIR = pathlib.Path(__file__).parent.parent / "web"


async def handle_jsonrpc(request: web.Request) -> web.Response:
    result = await dispatch(request)
    return web.Response(
        text=json.dumps(result),
        content_type="application/json",
    )


async def handle_spa(request: web.Request) -> web.Response:
    """SPA fallback — serve file if exists, otherwise index.html."""
    path = request.match_info.get("path", "")
    candidate = WEB_DIR / path
    if path and candidate.exists() and candidate.is_file():
        return web.FileResponse(candidate)
    return web.FileResponse(WEB_DIR / "index.html")


async def on_startup(app: web.Application) -> None:
    await init_pool()


async def on_cleanup(app: web.Application) -> None:
    await close_pool()


def make_app() -> web.Application:
    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    app.router.add_post("/api_jsonrpc.php", handle_jsonrpc)
    app.router.add_post("/api/jsonrpc", handle_jsonrpc)
    app.router.add_static("/css",  WEB_DIR / "css")
    app.router.add_static("/js",   WEB_DIR / "js")
    app.router.add_get("/{path:.*}", handle_spa)

    return app


if __name__ == "__main__":
    import os
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8090"))
    web.run_app(make_app(), host=host, port=port)
