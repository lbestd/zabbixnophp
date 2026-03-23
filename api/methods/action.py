from __future__ import annotations
from ..db import pool
from ..jsonrpc import register

EVENTSOURCE = {0: 'Trigger', 1: 'Discovery', 2: 'Auto-registration', 3: 'Internal', 4: 'Service'}
STATUS_LABEL = {0: 'Enabled', 1: 'Disabled'}


@register("action.get")
async def action_get(params: dict, userid: int | None) -> list | dict:
    action_ids    = params.get("actionids")
    eventsource   = params.get("eventsource")
    limit         = params.get("limit")
    search        = params.get("search") or {}
    preserve_keys = params.get("preservekeys", False)

    where = []
    args: list = []

    if action_ids:
        if isinstance(action_ids, (str, int)):
            action_ids = [action_ids]
        args.append([int(a) for a in action_ids])
        where.append(f"actionid = ANY(${len(args)}::bigint[])")

    if eventsource is not None:
        args.append(int(eventsource))
        where.append(f"eventsource = ${len(args)}")

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"name ILIKE ${len(args)}")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = (f"SELECT actionid, name, eventsource, evaltype, status, esc_period "
           f"FROM actions {where_sql} ORDER BY name")
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        d["actionid"]        = str(d["actionid"])
        d["eventsource_name"] = EVENTSOURCE.get(d["eventsource"], str(d["eventsource"]))
        d["status_name"]     = STATUS_LABEL.get(d["status"], str(d["status"]))
        result[d["actionid"]] = d

    if preserve_keys:
        return result
    return list(result.values())
