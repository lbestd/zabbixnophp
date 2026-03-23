from __future__ import annotations
from ..jsonrpc import register
from ..config import API_VERSION


@register("apiinfo.version")
async def version(params: dict, userid: int | None) -> str:
    return API_VERSION
