from __future__ import annotations
"""
event.get  — query the events table.
event.acknowledge — write to acknowledges, update problem/events.acknowledged.

source: 0=trigger, 1=discovery, 2=autoregistration, 3=internal, 4=service
object: 0=trigger, 1=dhost, 2=dservice, 3=autoregistration, 4=item, 5=lldrule, 6=service
"""
import time
from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS
from ..tags import build_tag_sql
from .. import rbac

# acknowledge action bitmask
ACK_CLOSE        = 1
ACK_ACKNOWLEDGE  = 2
ACK_MESSAGE      = 4
ACK_SEV_CHANGE   = 8
ACK_UNACK        = 16
ACK_SUPPRESS     = 32
ACK_UNSUPPRESS   = 64


@register("event.get")
async def event_get(params: dict, userid: int | None) -> list | str | dict:
    source       = int(params.get("source", 0))
    object_type  = int(params.get("object", 0))
    event_ids    = params.get("eventids")
    object_ids   = params.get("objectids")
    host_ids     = params.get("hostids")
    group_ids    = params.get("groupids")
    time_from    = params.get("time_from")
    time_till    = params.get("time_till")
    value        = params.get("value")          # 0=OK, 1=PROBLEM
    severities   = params.get("severities")
    acknowledged = params.get("acknowledged")
    limit        = params.get("limit", 50)
    count_output = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    select_acknowledges    = params.get("selectAcknowledges")
    select_tags            = params.get("selectTags")
    select_hosts           = params.get("selectHosts")
    select_suppression     = params.get("selectSuppressionData")
    tags                   = params.get("tags")
    evaltype               = params.get("evaltype", 0)
    sortfield    = params.get("sortfield", ["clock"])
    sortorder    = params.get("sortorder", ["DESC"])
    output       = params.get("output", "extend")

    where = ["e.source = $1", "e.object = $2"]
    args: list = [source, object_type]

    if event_ids:
        if isinstance(event_ids, (str, int)):
            event_ids = [event_ids]
        args.append([int(i) for i in event_ids])
        where.append(f"e.eventid = ANY(${len(args)}::bigint[])")

    if object_ids:
        if isinstance(object_ids, (str, int)):
            object_ids = [object_ids]
        args.append([int(i) for i in object_ids])
        where.append(f"e.objectid = ANY(${len(args)}::bigint[])")

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(i) for i in host_ids])
        where.append(
            f"e.objectid IN ("
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
            f"e.objectid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN items i ON i.itemid = f.itemid"
            f"  JOIN hosts_groups hg ON hg.hostid = i.hostid"
            f"  WHERE hg.groupid = ANY(${len(args)}::bigint[])"
            f")"
        )

    if time_from:
        args.append(int(time_from))
        where.append(f"e.clock >= ${len(args)}")

    if time_till:
        args.append(int(time_till))
        where.append(f"e.clock <= ${len(args)}")

    if value is not None:
        args.append(int(value))
        where.append(f"e.value = ${len(args)}")

    if severities:
        args.append(list(map(int, severities)))
        where.append(f"e.severity = ANY(${len(args)}::int[])")

    if acknowledged is not None:
        args.append(1 if acknowledged else 0)
        where.append(f"e.acknowledged = ${len(args)}")

    tag_sql = build_tag_sql(tags, evaltype, args, "eventid", "event_tag", "e.eventid")
    if tag_sql:
        where.append(tag_sql)

    # ── event permission filter (non-super-admin, object=0 = trigger) ────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3 and source == 0 and object_type == 0:
        if ctx.ugsetid == 0:
            return "0" if count_output else ({} if preserve_keys else [])
        where.append(rbac.event_perm_sql(args, ctx.ugsetid))

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(f"SELECT count(*) AS c FROM events e WHERE {where_sql}", *args)
        return str(row["c"])

    # sort
    allowed_sort = {"eventid", "objectid", "clock", "name", "severity", "acknowledged"}
    sf = [sortfield] if isinstance(sortfield, str) else (sortfield or ["clock"])
    so = [sortorder] if isinstance(sortorder, str) else (sortorder or ["DESC"])
    order_parts = []
    for i, f in enumerate(sf):
        if f in allowed_sort:
            d = "DESC" if i < len(so) and str(so[i]).upper() == "DESC" else "ASC"
            order_parts.append(f"e.{f} {d}")
    if not order_parts:
        order_parts = ["e.clock DESC", "e.eventid DESC"]
    order_sql = ", ".join(order_parts)

    sql = f"""
        SELECT e.eventid, e.source, e.object, e.objectid, e.clock, e.ns,
               e.value, e.acknowledged, e.name, e.severity,
               COALESCE(p.r_eventid, 0)      AS r_eventid,
               COALESCE(p.correlationid, 0)  AS correlationid,
               COALESCE(p.userid, 0)         AS userid,
               COALESCE(p.cause_eventid, 0)  AS cause_eventid,
               COALESCE(p.r_eventid, 0)      AS c_eventid,
               ''                            AS opdata,
               (EXISTS (SELECT 1 FROM event_suppress es WHERE es.eventid=e.eventid)) AS suppressed,
               '[]'::text                    AS urls
        FROM events e
        LEFT JOIN problem p ON p.eventid = e.eventid
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT {int(limit) if limit else 100}
    """
    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("eventid", "objectid", "r_eventid", "correlationid", "userid", "cause_eventid", "c_eventid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["urls"] = []
        result[d["eventid"]] = d

    if select_hosts and result:
        eids = [int(k) for k in result]
        hrows = await pool().fetch(
            """SELECT DISTINCT e.eventid, h.hostid, h.host, h.name, h.status
               FROM events e
               JOIN functions f ON f.triggerid = e.objectid
               JOIN items i ON i.itemid = f.itemid
               JOIN hosts h ON h.hostid = i.hostid
               WHERE e.eventid = ANY($1::bigint[])""",
            eids,
        )
        for r in hrows:
            eid = str(r["eventid"])
            result[eid].setdefault("hosts", []).append({
                "hostid": str(r["hostid"]),
                "host": r["host"], "name": r["name"],
                "status": str(r["status"]),
            })

    if select_tags and result:
        for eid in result:
            result[eid]["tags"] = []
        eids = [int(k) for k in result]
        tag_rows = await pool().fetch(
            "SELECT eventid, tag, value FROM event_tag WHERE eventid = ANY($1::bigint[])",
            eids,
        )
        for tr in tag_rows:
            result[str(tr["eventid"])]["tags"].append({"tag": tr["tag"], "value": tr["value"]})

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
            })

    if preserve_keys:
        return result
    return list(result.values())


@register("event.acknowledge")
async def event_acknowledge(params: dict, userid: int | None) -> dict:
    event_ids = params.get("eventids")
    action    = int(params.get("action", ACK_ACKNOWLEDGE | ACK_MESSAGE))
    message   = params.get("message", "")
    severity  = params.get("severity")

    if not event_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "eventids required")
    if isinstance(event_ids, (str, int)):
        event_ids = [event_ids]
    event_ids = [int(i) for i in event_ids]

    # validate events exist
    rows = await pool().fetch(
        "SELECT eventid, severity FROM events WHERE eventid = ANY($1::bigint[])",
        event_ids,
    )
    if not rows:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "no such events")

    now = int(time.time())
    new_severity = int(severity) if (severity is not None and action & ACK_SEV_CHANGE) else None

    async with pool().acquire() as conn:
        async with conn.transaction():
            for row in rows:
                eid = row["eventid"]
                old_sev = row["severity"]
                ns = new_severity if new_severity is not None else old_sev

                await conn.execute(
                    """INSERT INTO acknowledges
                       (acknowledgeid, userid, eventid, clock, message, action,
                        old_severity, new_severity, suppress_until)
                       VALUES (
                         (SELECT COALESCE(MAX(acknowledgeid),0)+1 FROM acknowledges),
                         $1, $2, $3, $4, $5, $6, $7, 0
                       )""",
                    userid, eid, now, message, action, old_sev, ns,
                )

            # mark acknowledged on events + problem tables
            if action & (ACK_ACKNOWLEDGE | ACK_MESSAGE):
                await conn.execute(
                    "UPDATE events SET acknowledged=1 WHERE eventid = ANY($1::bigint[])",
                    event_ids,
                )
                await conn.execute(
                    "UPDATE problem SET acknowledged=1 WHERE eventid = ANY($1::bigint[])",
                    event_ids,
                )

            # severity change
            if action & ACK_SEV_CHANGE and new_severity is not None:
                await conn.execute(
                    "UPDATE events SET severity=$1 WHERE eventid = ANY($2::bigint[])",
                    new_severity, event_ids,
                )
                await conn.execute(
                    "UPDATE problem SET severity=$1 WHERE eventid = ANY($2::bigint[])",
                    new_severity, event_ids,
                )

    return {"eventids": [str(i) for i in event_ids]}
