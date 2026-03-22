"""
usermacro.get/create/update/delete  — host-level macros (hostmacro table)
globalmacro.get/create/update/delete — global macros (globalmacro table)
"""
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY


@register("usermacro.get")
async def usermacro_get(params: dict, userid: int | None) -> list | str | dict:
    host_ids      = params.get("hostids")
    macro_ids     = params.get("hostmacroids")
    globalmacro   = params.get("globalmacro", False)
    preserve_keys = params.get("preservekeys", False)

    if globalmacro:
        rows = await pool().fetch(
            "SELECT globalmacroid, macro, value, description, type FROM globalmacro ORDER BY macro"
        )
        result = {}
        for r in rows:
            d = dict(r)
            d["globalmacroid"] = str(d["globalmacroid"])
            result[d["globalmacroid"]] = d
        return result if preserve_keys else list(result.values())

    where = []
    args: list = []

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(h) for h in host_ids])
        where.append(f"hostid = ANY(${len(args)}::bigint[])")

    if macro_ids:
        if isinstance(macro_ids, (str, int)):
            macro_ids = [macro_ids]
        args.append([int(m) for m in macro_ids])
        where.append(f"hostmacroid = ANY(${len(args)}::bigint[])")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    rows = await pool().fetch(
        f"SELECT hostmacroid, hostid, macro, value, description, type FROM hostmacro {where_sql} ORDER BY macro",
        *args,
    )
    result = {}
    for r in rows:
        d = dict(r)
        d["hostmacroid"] = str(d["hostmacroid"])
        d["hostid"]      = str(d["hostid"])
        result[d["hostmacroid"]] = d
    return result if preserve_keys else list(result.values())


@register("usermacro.create")
async def usermacro_create(params: dict, userid: int | None) -> dict:
    hostid = params.get("hostid")
    macro  = str(params.get("macro", "")).strip().upper()
    value  = str(params.get("value", ""))
    desc   = str(params.get("description", ""))
    mtype  = int(params.get("type", 0))

    if not hostid or not macro:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostid and macro required")
    if not (macro.startswith("{$") and macro.endswith("}")):
        raise ApiError(ERR_PARAMETERS, "Invalid params.", 'Macro must be in format {$NAME}')

    dup = await pool().fetchrow(
        "SELECT hostmacroid FROM hostmacro WHERE hostid=$1 AND macro=$2", int(hostid), macro
    )
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f"Macro {macro} already exists on this host")

    async with pool().acquire() as conn:
        async with conn.transaction():
            mid = await next_id(conn, "hostmacro", "hostmacroid")
            await conn.execute(
                "INSERT INTO hostmacro (hostmacroid, hostid, macro, value, description, type, automatic) VALUES ($1,$2,$3,$4,$5,$6,0)",
                mid, int(hostid), macro, value, desc, mtype,
            )
    return {"hostmacroids": [str(mid)]}


@register("usermacro.update")
async def usermacro_update(params: dict, userid: int | None) -> dict:
    macroid = params.get("hostmacroid")
    if not macroid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostmacroid required")

    row = await pool().fetchrow("SELECT hostmacroid FROM hostmacro WHERE hostmacroid=$1", int(macroid))
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    fields, args = [], []
    for col, val, cast in [
        ("macro",       params.get("macro"),       None),
        ("value",       params.get("value"),        None),
        ("description", params.get("description"),  None),
        ("type",        params.get("type"),          int),
    ]:
        if val is not None:
            v = str(val).upper() if col == "macro" else (cast(val) if cast else str(val))
            args.append(v)
            fields.append(f"{col}=${len(args)}")

    if fields:
        args.append(int(macroid))
        await pool().execute(f"UPDATE hostmacro SET {', '.join(fields)} WHERE hostmacroid=${len(args)}", *args)
    return {"hostmacroids": [str(macroid)]}


@register("usermacro.delete")
async def usermacro_delete(params: dict, userid: int | None) -> dict:
    ids = params if isinstance(params, list) else params.get("hostmacroids", [])
    if isinstance(ids, (str, int)):
        ids = [ids]
    if not ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostmacroids required")
    iids = [int(i) for i in ids]

    rows = await pool().fetch(
        "SELECT hostmacroid FROM hostmacro WHERE hostmacroid=ANY($1::bigint[])", iids
    )
    if len(rows) != len(iids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    await pool().execute("DELETE FROM hostmacro WHERE hostmacroid=ANY($1::bigint[])", iids)
    return {"hostmacroids": [str(i) for i in iids]}


@register("globalmacro.get")
async def globalmacro_get(params: dict, userid: int | None) -> list | str | dict:
    preserve_keys = params.get("preservekeys", False)
    rows = await pool().fetch(
        "SELECT globalmacroid, macro, value, description, type FROM globalmacro ORDER BY macro"
    )
    result = {}
    for r in rows:
        d = dict(r); d["globalmacroid"] = str(d["globalmacroid"])
        result[d["globalmacroid"]] = d
    return result if preserve_keys else list(result.values())


@register("globalmacro.create")
async def globalmacro_create(params: dict, userid: int | None) -> dict:
    macro = str(params.get("macro", "")).strip().upper()
    value = str(params.get("value", ""))
    desc  = str(params.get("description", ""))
    mtype = int(params.get("type", 0))

    if not macro:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "macro required")
    if not (macro.startswith("{$") and macro.endswith("}")):
        raise ApiError(ERR_PARAMETERS, "Invalid params.", 'Macro must be in format {$NAME}')

    dup = await pool().fetchrow("SELECT globalmacroid FROM globalmacro WHERE macro=$1", macro)
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f"Global macro {macro} already exists")

    async with pool().acquire() as conn:
        async with conn.transaction():
            mid = await next_id(conn, "globalmacro", "globalmacroid")
            await conn.execute(
                "INSERT INTO globalmacro (globalmacroid, macro, value, description, type) VALUES ($1,$2,$3,$4,$5)",
                mid, macro, value, desc, mtype,
            )
    return {"globalmacroids": [str(mid)]}


@register("globalmacro.update")
async def globalmacro_update(params: dict, userid: int | None) -> dict:
    macroid = params.get("globalmacroid")
    if not macroid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "globalmacroid required")

    fields, args = [], []
    for col, val, cast in [
        ("macro",       params.get("macro"),       None),
        ("value",       params.get("value"),        None),
        ("description", params.get("description"),  None),
        ("type",        params.get("type"),          int),
    ]:
        if val is not None:
            v = str(val).upper() if col == "macro" else (cast(val) if cast else str(val))
            args.append(v)
            fields.append(f"{col}=${len(args)}")

    if fields:
        args.append(int(macroid))
        await pool().execute(f"UPDATE globalmacro SET {', '.join(fields)} WHERE globalmacroid=${len(args)}", *args)
    return {"globalmacroids": [str(macroid)]}


@register("globalmacro.delete")
async def globalmacro_delete(params: dict, userid: int | None) -> dict:
    ids = params if isinstance(params, list) else params.get("globalmacroids", [])
    if isinstance(ids, (str, int)):
        ids = [ids]
    if not ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "globalmacroids required")
    iids = [int(i) for i in ids]
    await pool().execute("DELETE FROM globalmacro WHERE globalmacroid=ANY($1::bigint[])", iids)
    return {"globalmacroids": [str(i) for i in iids]}
