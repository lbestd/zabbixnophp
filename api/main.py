from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import pathlib

from .db import init_pool, close_pool
from .jsonrpc import dispatch
from . import methods  # noqa: F401 — registers all handlers


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    yield
    await close_pool()


app = FastAPI(lifespan=lifespan)

WEB_DIR = pathlib.Path(__file__).parent.parent / "web"


@app.post("/api_jsonrpc.php")
@app.post("/api/jsonrpc")
async def jsonrpc(request: Request):
    return await dispatch(request)


# Serve static web files
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/{full_path:path}")
async def spa(full_path: str):
    """SPA fallback — always serve index.html for non-static paths."""
    candidate = WEB_DIR / full_path
    if candidate.exists() and candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(WEB_DIR / "index.html")
