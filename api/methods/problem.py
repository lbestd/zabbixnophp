from __future__ import annotations
"""
problem.get — active problems from the `problem` table.

source: 0=trigger, 3=internal, 4=service
object: 0=trigger, 4=item, 5=lldrule, 6=service
severity: 0=not classified, 1=info, 2=warning, 3=average, 4=high, 5=disaster
"""
import re
import time as _time
from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS
from ..tags import build_tag_sql
from .. import rbac


def _parse_zabbix_time(s: str) -> int:
    """Parse Zabbix time unit string (e.g. '5m', '1h', '1d') to seconds."""
    s = str(s).strip()
    m = re.fullmatch(r"(\d+)([smhdw]?)", s, re.IGNORECASE)
    if not m:
        return 300
    val, unit = int(m.group(1)), (m.group(2) or "s").lower()
    return val * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[unit]


@register("problem.get")
async def problem_get(params: dict, userid: int | None) -> list | str | dict:
    source       = params.get("source", 0)
    object_type  = params.get("object", 0)
    search       = params.get("search") or {}
    severities   = params.get("severities")      # list of ints
    time_from    = params.get("time_from")
    time_till    = params.get("time_till")
    event_ids    = params.get("eventids")
    object_ids   = params.get("objectids")       # triggerids when object=0
    host_ids     = params.get("hostids")
    group_ids    = params.get("groupids")
    acknowledged = params.get("acknowledged")    # True/False/None
    suppressed   = params.get("suppressed")
    recent       = params.get("recent")
    tags         = params.get("tags")            # [{tag, operator, value}]
    limit        = params.get("limit")
    offset       = params.get("offset", 0)
    count_output = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    select_tags  = params.get("selectTags")
    select_hosts        = params.get("selectHosts")
    select_acknowledges = params.get("selectAcknowledges")
    select_suppression  = params.get("selectSuppressionData")
    evaltype     = params.get("evaltype", 0)
    sortfield    = params.get("sortfield", [])
    sortorder    = params.get("sortorder", [])
    output       = params.get("output", "extend")

    where = ["p.source = $1", "p.object = $2"]
    args: list = [int(source), int(object_type)]

    if severities:
        args.append(list(map(int, severities)))
        where.append(f"p.severity = ANY(${len(args)}::int[])")

    if time_from:
        args.append(int(time_from))
        where.append(f"p.clock >= ${len(args)}")

    if time_till:
        args.append(int(time_till))
        where.append(f"p.clock <= ${len(args)}")

    if event_ids:
        if isinstance(event_ids, (str, int)):
            event_ids = [event_ids]
        args.append([int(i) for i in event_ids])
        where.append(f"p.eventid = ANY(${len(args)}::bigint[])")

    if object_ids:
        if isinstance(object_ids, (str, int)):
            object_ids = [object_ids]
        args.append([int(i) for i in object_ids])
        where.append(f"p.objectid = ANY(${len(args)}::bigint[])")

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(i) for i in host_ids])
        where.append(
            f"p.objectid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN items i ON i.itemid = f.itemid"
            f"  WHERE i.hostid = ANY(${len(args)}::bigint[])"
            f")"
        )

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(i) for i in group_ids])
        where.append(
            f"p.objectid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN items i ON i.itemid = f.itemid"
            f"  JOIN hosts_groups hg ON hg.hostid = i.hostid"
            f"  WHERE hg.groupid = ANY(${len(args)}::bigint[])"
            f")"
        )

    if acknowledged is not None:
        args.append(1 if acknowledged else 0)
        where.append(f"p.acknowledged = ${len(args)}")

    if suppressed is not None:
        if suppressed:
            where.append(
                "EXISTS (SELECT 1 FROM event_suppress es WHERE es.eventid=p.eventid)"
            )
        else:
            where.append(
                "NOT EXISTS (SELECT 1 FROM event_suppress es WHERE es.eventid=p.eventid)"
            )

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"p.name ILIKE ${len(args)}")

    tag_sql = build_tag_sql(tags, evaltype, args, "eventid", "problem_tag", "p.eventid")
    if tag_sql:
        where.append(tag_sql)

    # by default show only active problems (r_eventid IS NULL in Zabbix 7.0)
    # recent=1 also includes recently resolved within ok_period (from config table)
    if recent:
        row = await pool().fetchrow("SELECT ok_period FROM config LIMIT 1")
        ok_secs = _parse_zabbix_time(row["ok_period"]) if row else 300
        args.append(int(_time.time()) - ok_secs)
        where.append(f"(p.r_eventid IS NULL OR p.r_clock >= ${len(args)})")
    else:
        where.append("p.r_eventid IS NULL")

    # ── problem permission filter (non-super-admin, object=0 = trigger) ──
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3 and int(object_type) == 0:
        if ctx.ugsetid == 0:
            return "0" if count_output else ({} if preserve_keys else [])
        where.append(rbac.event_perm_sql(args, ctx.ugsetid, event_alias="p"))

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(
            f"SELECT count(*) AS c FROM problem p WHERE {where_sql}", *args
        )
        return str(row["c"])

    # columns
    if output in ("extend", None) or output == ["extend"]:
        cols = ("p.eventid, p.source, p.object, p.objectid, p.clock, p.ns, p.name, "
                "p.acknowledged, p.severity, p.r_eventid, p.r_clock, p.r_ns, "
                "p.correlationid, p.userid, p.cause_eventid")
    else:
        allowed = {"eventid","source","object","objectid","clock","ns","name","acknowledged","severity","r_eventid","correlationid","userid","cause_eventid"}
        cols_list = [f"p.{c}" for c in (output if isinstance(output, list) else [output]) if c in allowed]
        if not cols_list:
            cols_list = ["p.eventid"]
        if "p.eventid" not in cols_list:
            cols_list.insert(0, "p.eventid")
        cols = ", ".join(cols_list)

    # sort
    allowed_sort = {"eventid", "objectid", "clock", "name", "acknowledged", "severity"}
    order_parts = []
    sf = [sortfield] if isinstance(sortfield, str) else (sortfield or [])
    so = [sortorder] if isinstance(sortorder, str) else (sortorder or [])
    for i, f in enumerate(sf):
        if f in allowed_sort:
            dir_ = "DESC" if (i < len(so) and str(so[i]).upper() == "DESC") else "ASC"
            order_parts.append(f"p.{f} {dir_}")
    if not order_parts:
        order_parts = ["p.clock DESC", "p.eventid DESC"]
    elif not any("eventid" in p for p in order_parts):
        order_parts.append("p.eventid DESC")  # tiebreaker matches real Zabbix
    order_sql = ", ".join(order_parts)

    sql = f"SELECT {cols} FROM problem p WHERE {where_sql} ORDER BY {order_sql}"
    if limit:
        sql += f" LIMIT {int(limit)}"
    if offset:
        sql += f" OFFSET {int(offset)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("eventid","objectid","r_eventid","correlationid","userid","cause_eventid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        for k in ("r_clock","r_ns"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["opdata"] = ""
        d["urls"]   = []
        result[d["eventid"]] = d

    # add suppressed flag
    if result:
        eids = [int(k) for k in result]
        sup_eids = set()
        sup_rows = await pool().fetch(
            "SELECT eventid FROM event_suppress WHERE eventid=ANY($1::bigint[])", eids
        )
        for sr in sup_rows:
            sup_eids.add(str(sr["eventid"]))
        for eid in result:
            result[eid]["suppressed"] = 1 if eid in sup_eids else 0

    # selectTags
    if select_tags and result:
        eids = [int(k) for k in result]
        tag_rows = await pool().fetch(
            "SELECT eventid, tag, value FROM problem_tag WHERE eventid = ANY($1::bigint[])",
            eids,
        )
        for tr in tag_rows:
            eid = str(tr["eventid"])
            result[eid].setdefault("tags", []).append(
                {"tag": tr["tag"], "value": tr["value"]}
            )

    # selectAcknowledges
    if select_acknowledges and result:
        for eid in result:
            result[eid]["acknowledges"] = []
        eids = [int(k) for k in result]
        ack_rows = await pool().fetch(
            """SELECT acknowledgeid, userid, eventid, clock, message, action,
                      old_severity, new_severity, suppress_until
               FROM acknowledges WHERE eventid = ANY($1::bigint[]) ORDER BY clock""",
            eids,
        )
        for ar in ack_rows:
            eid = str(ar["eventid"])
            result[eid]["acknowledges"].append({
                "acknowledgeid": str(ar["acknowledgeid"]),
                "userid": str(ar["userid"]),
                "clock": str(ar["clock"]),
                "message": ar["message"],
                "action": str(ar["action"]),
                "old_severity": str(ar["old_severity"]),
                "new_severity": str(ar["new_severity"]),
                "suppress_until": str(ar["suppress_until"]),
            })

    if select_suppression and result:
        eids = [int(k) for k in result]
        sup_rows = await pool().fetch(
            """SELECT eventid, maintenanceid, suppress_until, userid
               FROM event_suppress WHERE eventid = ANY($1::bigint[])""",
            eids,
        )
        for sr in sup_rows:
            eid = str(sr["eventid"])
            result[eid].setdefault("suppression_data", []).append({
                "maintenanceid": str(sr["maintenanceid"]),
                "suppress_until": str(sr["suppress_until"]),
                "userid": str(sr["userid"]),
            })

    if select_hosts and result:
        eids = [int(k) for k in result]
        host_rows = await pool().fetch(
            """SELECT DISTINCT p.eventid, h.hostid, h.host, h.name
               FROM problem p
               JOIN functions f ON f.triggerid = p.objectid
               JOIN items i ON i.itemid = f.itemid
               JOIN hosts h ON h.hostid = i.hostid
               WHERE p.eventid = ANY($1::bigint[])""",
            eids,
        )
        for hr in host_rows:
            eid = str(hr["eventid"])
            result[eid].setdefault("hosts", []).append({
                "hostid": str(hr["hostid"]),
                "host":   hr["host"],
                "name":   hr["name"],
            })
        # ensure every problem has the key
        for eid in result:
            result[eid].setdefault("hosts", [])

    if preserve_keys:
        return result
    return list(result.values())
