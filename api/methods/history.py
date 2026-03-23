from __future__ import annotations
"""
history.get — raw history values.

history param maps to table:
  0 = history (float)
  1 = history_str
  2 = history_log
  3 = history_uint
  4 = history_text
"""
from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_PERMISSIONS
from .. import rbac

_TABLES = {
    0: "history",
    1: "history_str",
    2: "history_log",
    3: "history_uint",
    4: "history_text",
}

_ALL_HISTORY_TABLES = ["history", "history_str", "history_log", "history_uint", "history_text"]
_ALL_TREND_TABLES   = ["trends", "trends_uint"]


@register("history.get")
async def history_get(params: dict, userid: int | None) -> list | str:
    history_type = int(params.get("history", 3))
    if history_type not in _TABLES:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f"unknown history type {history_type}")

    table = _TABLES[history_type]
    item_ids  = params.get("itemids")
    time_from = params.get("time_from")
    time_till = params.get("time_till")
    limit     = params.get("limit", 0)
    sort_order = str(params.get("sortorder", "DESC")).upper()
    if sort_order not in ("ASC", "DESC"):
        sort_order = "DESC"

    if not item_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemids required")

    if isinstance(item_ids, (str, int)):
        item_ids = [item_ids]

    args: list = [[int(i) for i in item_ids]]
    where = [f"h.itemid = ANY($1::bigint[])"]

    if time_from:
        args.append(int(time_from))
        where.append(f"h.clock >= ${len(args)}")
    if time_till:
        args.append(int(time_till))
        where.append(f"h.clock <= ${len(args)}")

    # ── history permission filter (non-super-admin) ───────────────────────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            return []
        where.append(rbac.history_perm_sql(args, ctx.ugsetid))

    where_sql = " AND ".join(where)
    # join items to filter by matching value_type (mirrors real Zabbix behaviour)
    sql = (f"SELECT h.itemid, h.clock, h.ns, h.value FROM {table} h"
           f" JOIN items i ON i.itemid = h.itemid AND i.value_type = {int(history_type)}"
           f" WHERE {where_sql} ORDER BY h.clock {sort_order}, h.ns {sort_order}")
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    return [
        {
            "itemid": str(r["itemid"]),
            "clock": str(r["clock"]),
            "ns": str(r["ns"]),
            "value": str(r["value"]),
        }
        for r in rows
    ]


@register("history.clear")
async def history_clear(params: dict, userid: int | None) -> dict:
    """Delete all history and trend data for given itemids."""
    item_ids = params.get("itemids")
    if not item_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemids required")
    if isinstance(item_ids, (str, int)):
        item_ids = [item_ids]
    item_ids = [int(i) for i in item_ids]

    # RBAC: require write access (permission >= 3) for non-super-admin
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            raise ApiError(ERR_PERMISSIONS, "No permissions to referred object or it does not exist!")
        # verify all items belong to writable hosts
        args: list = [item_ids]
        allowed_sql = rbac.item_perm_sql(args, ctx.ugsetid, editable=True)
        rows = await pool().fetch(
            f"SELECT itemid FROM items WHERE itemid = ANY($1::bigint[]) AND {allowed_sql}",
            *args,
        )
        allowed_ids = {r["itemid"] for r in rows}
        if len(allowed_ids) < len(item_ids):
            raise ApiError(ERR_PERMISSIONS, "No permissions to referred object or it does not exist!")

    db = pool()
    for table in _ALL_HISTORY_TABLES + _ALL_TREND_TABLES:
        await db.execute(
            f"DELETE FROM {table} WHERE itemid = ANY($1::bigint[])",
            item_ids,
        )

    return {"itemids": [str(i) for i in item_ids]}
