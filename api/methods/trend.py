from __future__ import annotations
"""
trend.get — hourly trend data.

history param: 0=trends (float), 3=trends_uint
If history is not provided, value_type is looked up from items table and
the correct table is chosen automatically. Mixed-type itemid lists are
handled by querying both tables and merging.
"""
from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS
from .. import rbac

_TABLES = {0: "trends", 3: "trends_uint"}


@register("trend.get")
async def trend_get(params: dict, userid: int | None) -> list | str:
    item_ids  = params.get("itemids")
    time_from = params.get("time_from")
    time_till = params.get("time_till")
    limit     = params.get("limit", 0)
    sort_order = str(params.get("sortorder", "ASC")).upper()
    if sort_order not in ("ASC", "DESC"):
        sort_order = "ASC"

    if not item_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemids required")
    if isinstance(item_ids, (str, int)):
        item_ids = [item_ids]
    item_ids = [int(i) for i in item_ids]

    # ── trend permission filter (non-super-admin) ────────────────────────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            return []
        # Filter item_ids to only those on accessible hosts
        perm_args: list = [item_ids]
        perm_args.append(ctx.ugsetid)
        accessible = await pool().fetch(
            "SELECT itemid FROM items WHERE itemid = ANY($1::bigint[]) "
            "AND hostid IN (SELECT hh.hostid FROM host_hgset hh "
            "JOIN permission p ON hh.hgsetid = p.hgsetid "
            f"WHERE p.ugsetid = $2 AND p.permission >= 2)",
            *perm_args,
        )
        item_ids = [int(r["itemid"]) for r in accessible]
        if not item_ids:
            return []

    # Always auto-detect table from items.value_type.
    # Zabbix 7.0 ignores the `history` param in trend.get and auto-detects too.
    vt_rows = await pool().fetch(
        "SELECT itemid, value_type FROM items WHERE itemid = ANY($1::bigint[])", item_ids
    )
    groups: dict[int, list[int]] = {}
    for r in vt_rows:
        vt = int(r["value_type"])
        if vt in _TABLES:
            groups.setdefault(vt, []).append(int(r["itemid"]))
    if not groups:
        return []

    rows_all = []
    for history_type, ids in groups.items():
        table = _TABLES[history_type]
        args: list = [ids]
        where = ["itemid = ANY($1::bigint[])"]

        if time_from:
            args.append(int(time_from))
            where.append(f"clock >= ${len(args)}")
        if time_till:
            args.append(int(time_till))
            where.append(f"clock <= ${len(args)}")

        where_sql = " AND ".join(where)
        sql = (f"SELECT itemid, clock, num, value_min, value_avg, value_max"
               f" FROM {table} WHERE {where_sql} ORDER BY clock {sort_order}")
        if limit:
            sql += f" LIMIT {int(limit)}"

        rows = await pool().fetch(sql, *args)
        rows_all.extend(rows)

    # if multiple groups, re-sort merged result
    if len(groups) > 1:
        rows_all.sort(key=lambda r: r["clock"], reverse=(sort_order == "DESC"))
        if limit:
            rows_all = rows_all[:int(limit)]

    return [
        {
            "itemid":    str(r["itemid"]),
            "clock":     str(r["clock"]),
            "num":       str(r["num"]),
            "value_min": str(r["value_min"]),
            "value_avg": str(r["value_avg"]),
            "value_max": str(r["value_max"]),
        }
        for r in rows_all
    ]
