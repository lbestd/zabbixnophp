"""
JSON-RPC 2.0 dispatcher — Zabbix-compatible error codes.
"""
from __future__ import annotations
import json
from typing import Any
from fastapi import Request
from fastapi.responses import JSONResponse

from . import session as sess
from . import rbac
from .errors import (ApiError, ERR_PARAMETERS, ERR_NO_ENTITY,
                     ERR_PERMISSIONS, ERR_NO_AUTH, ERR_NO_METHOD, ERR_INTERNAL)


# Registry: "service.method" -> async callable(params, userid) -> result
_registry: dict[str, Any] = {}


def register(name: str):
    def deco(fn):
        _registry[name] = fn
        return fn
    return deco


def _stringify(v: Any) -> Any:
    """Zabbix API returns all scalar DB values as strings.
    Recurse into lists/dicts; leave bool/None/str unchanged."""
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return [_stringify(x) for x in v]
    if isinstance(v, dict):
        return {k: _stringify(vv) for k, vv in v.items()}
    return v


def _ok(result: Any, req_id: Any) -> dict:
    return {"jsonrpc": "2.0", "result": _stringify(result), "id": req_id}


def _err(code: int, message: str, data: str, req_id: Any) -> dict:
    return {
        "jsonrpc": "2.0",
        "error": {"code": code, "message": message, "data": data},
        "id": req_id,
    }


# Methods that don't require authentication
_public = {"user.login", "apiinfo.version", "user.checkAuthentication"}


async def dispatch(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(_err(-32700, "Parse error", "", None))

    # batch support
    is_batch = isinstance(body, list)
    items = body if is_batch else [body]
    responses = []

    # extract token from Authorization header (Bearer <token>) once
    auth_header = request.headers.get("Authorization", "")
    header_token = auth_header.removeprefix("Bearer ").strip() if auth_header.startswith("Bearer ") else ""

    for req in items:
        if not isinstance(req, dict):
            responses.append(_err(-32600, "Invalid request", "", None))
            continue

        req_id = req.get("id")
        method = req.get("method", "")
        params = req.get("params") or {}

        # token: body "auth" field OR Authorization header
        token = req.get("auth") or header_token or ""

        try:
            # resolve auth
            userid: int | None = None
            if method not in _public:
                userid = await sess.get_userid(token)
                if userid is None:
                    raise ApiError(ERR_NO_AUTH, "Not authorised.", "")

            handler = _registry.get(method)
            if handler is None:
                raise ApiError(ERR_NO_METHOD, "No such method.", method)

            # load user context + check method access (RBAC)
            ctx = await rbac.load_user_ctx(userid) if userid is not None else None
            rbac.set_user_ctx(ctx)
            await rbac.check_method_access(ctx, method)

            result = await handler(params, userid)
            responses.append(_ok(result, req_id))

        except ApiError as e:
            responses.append(_err(e.code, e.message, e.data, req_id))
        except Exception as e:
            responses.append(_err(ERR_INTERNAL, "Internal error.", str(e), req_id))

    return JSONResponse(responses if is_batch else responses[0])
