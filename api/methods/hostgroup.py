from __future__ import annotations
import os
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY
from .. import rbac

_FIELDS = {"groupid", "name", "flags", "uuid", "type"}

HOST_GROUP_TYPE = 0


def _select_fields(output) -> str:
    if output in ("extend", None) or output == ["extend"]:
        return "groupid, name, flags, uuid, type"
    if isinstance(output, list):
        cols = [f for f in output if f in _FIELDS]
        if "groupid" not in cols:
            cols.insert(0, "groupid")
        return ", ".join(cols)
    return "groupid, name"


@register("hostgroup.get")
async def hostgroup_get(params: dict, userid: int | None) -> list | str | dict:
    output        = params.get("output", "extend")
    count_output  = params.get("countOutput", False)
    limit         = params.get("limit")
    group_ids     = params.get("groupids")
    host_ids      = params.get("hostids")
    search        = params.get("search") or {}
    filter_       = params.get("filter") or {}
    preserve_keys = params.get("preservekeys", False)
    # real_hosts (≤6.0) / with_hosts (6.2+) — only groups containing real hosts
    real_hosts    = params.get("real_hosts") or params.get("with_hosts")
    sortfield     = params.get("sortfield", "name")
    sortorder     = params.get("sortorder", "ASC")

    where = ["type = 0"]
    args: list = []

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(g) for g in group_ids])
        where.append(f"groupid = ANY(${len(args)}::bigint[])")

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(h) for h in host_ids])
        where.append(f"groupid IN (SELECT groupid FROM hosts_groups WHERE hostid = ANY(${len(args)}::bigint[]))")

    if real_hosts:
        where.append(
            "groupid IN (SELECT groupid FROM hosts_groups hg "
            "JOIN hosts h ON h.hostid=hg.hostid WHERE h.status IN (0,1) AND h.flags IN (0,4))"
        )

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

    # ── hostgroup permission filter (non-super-admin) ─────────────────────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            return "0" if count_output else ({} if preserve_keys else [])
        where.append(rbac.hostgroup_perm_sql(args, ctx.ugsetid))

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(f"SELECT count(*) AS c FROM hstgrp WHERE {where_sql}", *args)
        return str(row["c"])

    cols = _select_fields(output)
    _allowed_sort = {"groupid", "name"}
    sf = sortfield if sortfield in _allowed_sort else "name"
    sd = "DESC" if str(sortorder).upper() == "DESC" else "ASC"
    sql = f"SELECT {cols} FROM hstgrp WHERE {where_sql} ORDER BY {sf} {sd}"
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {str(r["groupid"]): dict(r) for r in rows}
    if preserve_keys:
        return result
    return list(result.values())


@register("hostgroup.create")
async def hostgroup_create(params: dict, userid: int | None) -> dict:
    name = str(params.get("name", "")).strip()
    if not name:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "name required")

    dup = await pool().fetchrow("SELECT groupid FROM hstgrp WHERE name=$1 AND type=0", name)
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f'Group "{name}" already exists')

    async with pool().acquire() as conn:
        async with conn.transaction():
            gid = await next_id(conn, "hstgrp", "groupid")
            await conn.execute(
                "INSERT INTO hstgrp (groupid, name, flags, uuid, type) VALUES ($1,$2,0,'',0)",
                gid, name,
            )
    return {"groupids": [str(gid)]}


@register("hostgroup.update")
async def hostgroup_update(params: dict, userid: int | None) -> dict:
    groupid = params.get("groupid")
    name    = str(params.get("name", "")).strip()
    if not groupid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "groupid required")
    if not name:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "name required")

    row = await pool().fetchrow("SELECT groupid FROM hstgrp WHERE groupid=$1 AND type=0", int(groupid))
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    dup = await pool().fetchrow(
        "SELECT groupid FROM hstgrp WHERE name=$1 AND type=0 AND groupid!=$2", name, int(groupid)
    )
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f'Group "{name}" already exists')

    await pool().execute("UPDATE hstgrp SET name=$1 WHERE groupid=$2", name, int(groupid))
    return {"groupids": [str(groupid)]}


@register("hostgroup.delete")
async def hostgroup_delete(params: dict, userid: int | None) -> dict:
    group_ids = params if isinstance(params, list) else params.get("groupids", [])
    if isinstance(group_ids, (str, int)):
        group_ids = [group_ids]
    if not group_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "groupids required")

    ids = [int(i) for i in group_ids]

    rows = await pool().fetch(
        "SELECT groupid FROM hstgrp WHERE groupid=ANY($1::bigint[]) AND type=0", ids
    )
    if len(rows) != len(ids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    # Check no host is ONLY in one of these groups
    orphans = await pool().fetch(
        """SELECT hg.hostid FROM hosts_groups hg
           WHERE hg.groupid = ANY($1::bigint[])
           AND NOT EXISTS (
               SELECT 1 FROM hosts_groups hg2
               WHERE hg2.hostid = hg.hostid
               AND hg2.groupid != ALL($1::bigint[])
           )""",
        ids,
    )
    if orphans:
        raise ApiError(
            ERR_PARAMETERS, "Invalid params.",
            "Cannot delete: some hosts belong only to these groups"
        )

    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM hosts_groups WHERE groupid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM hstgrp WHERE groupid=ANY($1::bigint[])", ids)

    return {"groupids": [str(i) for i in ids]}
