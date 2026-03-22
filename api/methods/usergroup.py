from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY


# ── helpers ───────────────────────────────────────────────────────────────────

def _normalize_userids(users_param):
    """Accept [userid, ...] or [{userid: N}, ...] → list of int."""
    if not users_param:
        return []
    result = []
    for u in users_param:
        uid = u.get("userid") if isinstance(u, dict) else u
        if uid is not None:
            result.append(int(uid))
    return result


def _normalize_rights(rights_param):
    """Accept [{id: groupid, permission: N}, ...] → list of (groupid, perm)."""
    if not rights_param:
        return []
    result = []
    for r in rights_param:
        if isinstance(r, dict):
            gid  = r.get("id")
            perm = r.get("permission", 0)
            if gid is not None:
                result.append((int(gid), int(perm)))
    return result


def _normalize_tag_filters(tf_param):
    """Accept [{groupid, tag, value}, ...] → list of (groupid, tag, value)."""
    if not tf_param:
        return []
    result = []
    for tf in tf_param:
        if isinstance(tf, dict):
            gid   = tf.get("groupid")
            tag   = str(tf.get("tag", ""))
            value = str(tf.get("value", ""))
            if gid is not None:
                result.append((int(gid), tag, value))
    return result


# ── usergroup.get ─────────────────────────────────────────────────────────────

@register("usergroup.get")
async def usergroup_get(params: dict, userid: int | None) -> list | dict:
    group_ids          = params.get("usrgrpids")
    limit              = params.get("limit")
    search             = params.get("search") or {}
    filter_            = params.get("filter") or {}
    preserve_keys      = params.get("preservekeys", False)
    select_users       = params.get("selectUsers")
    select_rights      = params.get("selectRights")
    select_tag_filters = params.get("selectTagFilters")

    where: list[str] = []
    args: list = []

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(g) for g in group_ids])
        where.append(f"usrgrpid = ANY(${len(args)}::bigint[])")

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"name ILIKE ${len(args)}")

    if filter_.get("name") is not None:
        fn = filter_["name"]
        if isinstance(fn, list):
            args.append(fn)
            where.append(f"name = ANY(${len(args)}::text[])")
        else:
            args.append(str(fn))
            where.append(f"name = ${len(args)}")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = (
        f"SELECT usrgrpid, name, gui_access, users_status, debug_mode "
        f"FROM usrgrp {where_sql} ORDER BY name"
    )
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result: dict[str, dict] = {}
    for r in rows:
        d = dict(r)
        d["usrgrpid"] = str(d["usrgrpid"])
        result[d["usrgrpid"]] = d

    if result and select_users:
        gids = [int(g) for g in result]
        user_rows = await pool().fetch(
            """SELECT ug.usrgrpid, u.userid, u.username, u.name, u.surname
               FROM users_groups ug
               JOIN users u ON u.userid = ug.userid
               WHERE ug.usrgrpid = ANY($1::bigint[])
               ORDER BY u.username""",
            gids,
        )
        for g in result.values():
            g["users"] = []
        for r in user_rows:
            gid = str(r["usrgrpid"])
            if gid in result:
                result[gid]["users"].append({
                    "userid":   str(r["userid"]),
                    "username": r["username"],
                    "name":     r["name"] or "",
                    "surname":  r["surname"] or "",
                })

    if result and select_rights:
        gids = [int(g) for g in result]
        right_rows = await pool().fetch(
            """SELECT r.groupid AS usrgrpid, r.rightid, r.permission, r.id, h.name, h.type
               FROM rights r
               JOIN hstgrp h ON h.groupid = r.id
               WHERE r.groupid = ANY($1::bigint[])
               ORDER BY h.type, r.permission DESC, h.name""",
            gids,
        )
        for g in result.values():
            g["rights"] = []
        for r in right_rows:
            gid = str(r["usrgrpid"])
            if gid in result:
                result[gid]["rights"].append({
                    "rightid":    str(r["rightid"]),
                    "id":         str(r["id"]),
                    "name":       r["name"],
                    "permission": str(r["permission"]),
                    "type":       str(r["type"]),
                })

    if result and select_tag_filters:
        gids = [int(g) for g in result]
        tf_rows = await pool().fetch(
            """SELECT tf.usrgrpid, tf.tag_filterid, tf.groupid, h.name AS groupname,
                      tf.tag, tf.value
               FROM tag_filter tf
               JOIN hstgrp h ON h.groupid = tf.groupid
               WHERE tf.usrgrpid = ANY($1::bigint[])
               ORDER BY h.name, tf.tag""",
            gids,
        )
        for g in result.values():
            g["tag_filters"] = []
        for r in tf_rows:
            gid = str(r["usrgrpid"])
            if gid in result:
                result[gid]["tag_filters"].append({
                    "tag_filterid": str(r["tag_filterid"]),
                    "groupid":      str(r["groupid"]),
                    "groupname":    r["groupname"],
                    "tag":          r["tag"],
                    "value":        r["value"],
                })

    if preserve_keys:
        return result
    return list(result.values())


# ── usergroup.create ──────────────────────────────────────────────────────────

@register("usergroup.create")
async def usergroup_create(params: dict, userid: int | None) -> dict:
    name = str(params.get("name", "")).strip()
    if not name:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "name required")

    gui_access   = int(params.get("gui_access", 0))
    users_status = int(params.get("users_status", 0))
    debug_mode   = int(params.get("debug_mode", 0))

    user_ids    = _normalize_userids(params.get("users", []))
    hg_rights   = _normalize_rights(params.get("hostgroup_rights", []))
    tg_rights   = _normalize_rights(params.get("templategroup_rights", []))
    tag_filters = _normalize_tag_filters(params.get("tag_filters", []))

    async with pool().acquire() as conn:
        async with conn.transaction():
            gid = await next_id(conn, "usrgrp", "usrgrpid")
            await conn.execute(
                "INSERT INTO usrgrp (usrgrpid, name, gui_access, users_status, debug_mode) "
                "VALUES ($1,$2,$3,$4,$5)",
                gid, name, gui_access, users_status, debug_mode,
            )
            for uid in user_ids:
                ugid = await next_id(conn, "users_groups", "id")
                await conn.execute(
                    "INSERT INTO users_groups (id, usrgrpid, userid) VALUES ($1,$2,$3)",
                    ugid, gid, uid,
                )
            for hgid, perm in hg_rights + tg_rights:
                rid = await next_id(conn, "rights", "rightid")
                await conn.execute(
                    "INSERT INTO rights (rightid, groupid, permission, id) VALUES ($1,$2,$3,$4)",
                    rid, gid, perm, hgid,
                )
            for tf_gid, tag, value in tag_filters:
                tfid = await next_id(conn, "tag_filter", "tag_filterid")
                await conn.execute(
                    "INSERT INTO tag_filter (tag_filterid, usrgrpid, groupid, tag, value) "
                    "VALUES ($1,$2,$3,$4,$5)",
                    tfid, gid, tf_gid, tag, value,
                )

    return {"usrgrpids": [str(gid)]}


# ── usergroup.update ──────────────────────────────────────────────────────────

@register("usergroup.update")
async def usergroup_update(params: dict, userid: int | None) -> dict:
    gid = params.get("usrgrpid")
    if not gid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "usrgrpid required")

    row = await pool().fetchrow("SELECT usrgrpid FROM usrgrp WHERE usrgrpid=$1", int(gid))
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    fields, args = [], []
    for col, val, cast in [
        ("name",         params.get("name"),         None),
        ("gui_access",   params.get("gui_access"),   int),
        ("users_status", params.get("users_status"), int),
        ("debug_mode",   params.get("debug_mode"),   int),
    ]:
        if val is not None:
            args.append(cast(val) if cast else str(val).strip())
            fields.append(f"{col}=${len(args)}")

    async with pool().acquire() as conn:
        async with conn.transaction():
            if fields:
                args.append(int(gid))
                await conn.execute(
                    f"UPDATE usrgrp SET {', '.join(fields)} WHERE usrgrpid=${len(args)}",
                    *args,
                )

            if "users" in params:
                user_ids = _normalize_userids(params["users"])
                await conn.execute("DELETE FROM users_groups WHERE usrgrpid=$1", int(gid))
                for uid in user_ids:
                    ugid = await next_id(conn, "users_groups", "id")
                    await conn.execute(
                        "INSERT INTO users_groups (id, usrgrpid, userid) VALUES ($1,$2,$3)",
                        ugid, int(gid), uid,
                    )

            if "hostgroup_rights" in params or "templategroup_rights" in params:
                hg_rights = _normalize_rights(params.get("hostgroup_rights", []))
                tg_rights = _normalize_rights(params.get("templategroup_rights", []))
                await conn.execute("DELETE FROM rights WHERE groupid=$1", int(gid))
                for hgid, perm in hg_rights + tg_rights:
                    rid = await next_id(conn, "rights", "rightid")
                    await conn.execute(
                        "INSERT INTO rights (rightid, groupid, permission, id) VALUES ($1,$2,$3,$4)",
                        rid, int(gid), perm, hgid,
                    )

            if "tag_filters" in params:
                tag_filters = _normalize_tag_filters(params["tag_filters"])
                await conn.execute("DELETE FROM tag_filter WHERE usrgrpid=$1", int(gid))
                for tf_gid, tag, value in tag_filters:
                    tfid = await next_id(conn, "tag_filter", "tag_filterid")
                    await conn.execute(
                        "INSERT INTO tag_filter (tag_filterid, usrgrpid, groupid, tag, value) "
                        "VALUES ($1,$2,$3,$4,$5)",
                        tfid, int(gid), tf_gid, tag, value,
                    )

    return {"usrgrpids": [str(gid)]}


# ── usergroup.delete ──────────────────────────────────────────────────────────

@register("usergroup.delete")
async def usergroup_delete(params: dict, userid: int | None) -> dict:
    ids = params if isinstance(params, list) else params.get("usrgrpids", [])
    if isinstance(ids, (str, int)):
        ids = [ids]
    if not ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "usrgrpids required")

    iids = [int(i) for i in ids]
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM users_groups WHERE usrgrpid=ANY($1::bigint[])", iids)
            await conn.execute("DELETE FROM rights WHERE groupid=ANY($1::bigint[])", iids)
            await conn.execute("DELETE FROM tag_filter WHERE usrgrpid=ANY($1::bigint[])", iids)
            await conn.execute("DELETE FROM usrgrp WHERE usrgrpid=ANY($1::bigint[])", iids)

    return {"usrgrpids": [str(i) for i in iids]}


# ── templategroup.get ─────────────────────────────────────────────────────────

@register("templategroup.get")
async def templategroup_get(params: dict, userid: int | None) -> list | dict:
    """Return template groups (hstgrp.type=1)."""
    search        = params.get("search") or {}
    limit         = params.get("limit")
    preserve_keys = params.get("preservekeys", False)
    group_ids     = params.get("groupids")

    where: list[str] = ["type = 1"]
    args: list = []

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(g) for g in group_ids])
        where.append(f"groupid = ANY(${len(args)}::bigint[])")

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"name ILIKE ${len(args)}")

    where_sql = " AND ".join(where)
    sql = f"SELECT groupid, name FROM hstgrp WHERE {where_sql} ORDER BY name"
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {str(r["groupid"]): {"groupid": str(r["groupid"]), "name": r["name"]} for r in rows}

    if preserve_keys:
        return result
    return list(result.values())
