from __future__ import annotations
"""
triggerprototype.get/create/update/delete — triggers.flags=2.
Linked to LLD rules via functions → items → item_discovery.parent_itemid.
"""
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY
from .trigger import _expand_expressions


@register("triggerprototype.get")
async def triggerprototype_get(params: dict, userid: int | None) -> list | str | dict:
    rule_ids      = params.get("discoveryids")
    host_ids      = params.get("hostids")
    trigger_ids   = params.get("triggerids")
    limit         = params.get("limit")
    count_output  = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    select_hosts      = params.get("selectHosts")
    select_items      = params.get("selectItems")
    select_tags       = params.get("selectTags")
    expand_expression = params.get("expandExpression")

    where = ["t.flags = 2"]
    args: list = []

    if trigger_ids:
        if isinstance(trigger_ids, (str, int)):
            trigger_ids = [trigger_ids]
        args.append([int(i) for i in trigger_ids])
        where.append(f"t.triggerid = ANY(${len(args)}::bigint[])")

    if rule_ids:
        if isinstance(rule_ids, (str, int)):
            rule_ids = [rule_ids]
        args.append([int(x) for x in rule_ids])
        where.append(
            f"t.triggerid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN item_discovery id ON id.itemid=f.itemid"
            f"  WHERE id.parent_itemid=ANY(${len(args)}::bigint[])"
            f")"
        )

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(x) for x in host_ids])
        where.append(
            f"t.triggerid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN items i ON i.itemid=f.itemid"
            f"  WHERE i.hostid=ANY(${len(args)}::bigint[])"
            f")"
        )

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(
            f"SELECT count(*) AS c FROM triggers t WHERE {where_sql}", *args
        )
        return str(row["c"])

    sql = f"""
        SELECT t.triggerid, t.description, t.expression, t.priority, t.status,
               t.value, t.state, t.error, t.lastchange, t.type,
               t.recovery_mode, t.recovery_expression, t.comments, t.url, t.url_name,
               t.manual_close, t.opdata, t.event_name, t.flags, t.templateid,
               t.correlation_mode, t.correlation_tag, t.discover, t.uuid
        FROM triggers t
        WHERE {where_sql}
        ORDER BY t.priority DESC, t.description
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("triggerid", "templateid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["templatehostid"] = "0"
        d["templateRuleid"] = "0"
        result[d["triggerid"]] = d

    # Resolve templatehostid + templateRuleid for inherited trigger prototypes
    tpl_trig_ids = [int(d["templateid"]) for d in result.values() if d.get("templateid") and d["templateid"] != "0"]
    if tpl_trig_ids:
        tpl_rows = await pool().fetch(
            """SELECT DISTINCT ON (t.triggerid) t.triggerid AS tpl_triggerid,
                      i.hostid AS tpl_hostid, id_.parent_itemid AS tpl_ruleid
               FROM triggers t
               JOIN functions f ON f.triggerid = t.triggerid
               JOIN items i ON i.itemid = f.itemid
               JOIN item_discovery id_ ON id_.itemid = i.itemid
               WHERE t.triggerid = ANY($1::bigint[])
               ORDER BY t.triggerid""",
            tpl_trig_ids,
        )
        tpl_map = {str(r["tpl_triggerid"]): (str(r["tpl_hostid"]), str(r["tpl_ruleid"])) for r in tpl_rows}
        for d in result.values():
            hid, rid = tpl_map.get(d.get("templateid", "0"), ("0", "0"))
            d["templatehostid"] = hid
            d["templateRuleid"] = rid

    if select_hosts and result:
        tids = [int(k) for k in result]
        hrows = await pool().fetch(
            """SELECT DISTINCT f.triggerid, h.hostid, h.host, h.name
               FROM functions f JOIN items i ON i.itemid=f.itemid
               JOIN hosts h ON h.hostid=i.hostid
               WHERE f.triggerid=ANY($1::bigint[])""", tids,
        )
        for r in hrows:
            result[str(r["triggerid"])].setdefault("hosts", []).append(
                {"hostid": str(r["hostid"]), "host": r["host"], "name": r["name"]}
            )

    if select_items and result:
        tids = [int(k) for k in result]
        irows = await pool().fetch(
            """SELECT f.triggerid, i.itemid, i.name, i.key_
               FROM functions f JOIN items i ON i.itemid=f.itemid
               WHERE f.triggerid=ANY($1::bigint[])""", tids,
        )
        for r in irows:
            result[str(r["triggerid"])].setdefault("items", []).append(
                {"itemid": str(r["itemid"]), "name": r["name"], "key_": r["key_"]}
            )

    if expand_expression and result:
        await _expand_expressions([int(k) for k in result], result)

    if select_tags and result:
        tids = [int(k) for k in result]
        for tid in result:
            result[tid]["tags"] = []
        tag_rows = await pool().fetch(
            "SELECT triggerid, tag, value FROM trigger_tag WHERE triggerid = ANY($1::bigint[])", tids,
        )
        for r in tag_rows:
            tid = str(r["triggerid"])
            if tid in result:
                result[tid]["tags"].append({"tag": r["tag"], "value": r["value"]})

    if preserve_keys:
        return result
    return list(result.values())


@register("triggerprototype.create")
async def triggerprototype_create(params: dict, userid: int | None) -> dict:
    description      = str(params.get("description", "")).strip()
    expression       = str(params.get("expression", "")).strip()
    priority         = int(params.get("priority", 0))
    status           = int(params.get("status", 0))
    recovery_mode    = int(params.get("recovery_mode", 0))
    recovery_expr    = str(params.get("recovery_expression", ""))
    correlation_mode = int(params.get("correlation_mode", 0))
    comments         = str(params.get("comments", ""))
    url              = str(params.get("url", ""))
    url_name         = str(params.get("url_name", ""))
    opdata           = str(params.get("opdata", ""))
    event_name       = str(params.get("event_name", ""))
    manual_close     = int(params.get("manual_close", 0))
    discover         = int(params.get("discover", 0))
    tags_param       = params.get("tags", [])

    if not description or not expression:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "description and expression required")

    ruleid = params.get("ruleid")

    async with pool().acquire() as conn:
        async with conn.transaction():
            triggerid = await next_id(conn, "triggers", "triggerid")
            await conn.execute(
                """INSERT INTO triggers
                   (triggerid, expression, description, url, url_name, status,
                    priority, comments, recovery_mode, recovery_expression,
                    correlation_mode, correlation_tag, manual_close,
                    opdata, event_name, flags, type, uuid, discover,
                    value, state, error, lastchange, templateid)
                   VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9,$10,
                           $11,'', $12,$13,$14, 2,0,'',$15,
                           0,0,'',0,NULL)""",
                triggerid, expression, description, url, url_name, status,
                priority, comments, recovery_mode, recovery_expr,
                correlation_mode, manual_close, opdata, event_name, discover,
            )
            # Link the trigger prototype to the LLD rule via a functions entry so
            # triggerprototype.get with discoveryids filter can find it.
            if ruleid:
                item_row = await conn.fetchrow(
                    """SELECT i.itemid FROM items i
                       JOIN item_discovery id ON id.itemid = i.itemid
                       WHERE id.parent_itemid = $1 AND i.flags = 2
                       LIMIT 1""",
                    int(ruleid),
                )
                if item_row:
                    funcid = await next_id(conn, "functions", "functionid")
                    await conn.execute(
                        "INSERT INTO functions (functionid, itemid, triggerid, name, parameter)"
                        " VALUES ($1,$2,$3,'last','$')",
                        funcid, item_row["itemid"], triggerid,
                    )
            for tag in tags_param:
                tagid = await next_id(conn, "trigger_tag", "triggertagid")
                await conn.execute(
                    "INSERT INTO trigger_tag (triggertagid,triggerid,tag,value) VALUES ($1,$2,$3,$4)",
                    tagid, triggerid, str(tag.get("tag", "")), str(tag.get("value", "")),
                )
    return {"triggerids": [str(triggerid)]}


@register("triggerprototype.update")
async def triggerprototype_update(params: dict, userid: int | None) -> dict:
    triggerid = params.get("triggerid")
    if not triggerid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "triggerid required")

    row = await pool().fetchrow(
        "SELECT triggerid, templateid FROM triggers WHERE triggerid=$1 AND flags=2", int(triggerid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")
    if row["templateid"]:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot update a templated trigger prototype")

    fields, args = [], []
    for col, val, cast in [
        ("description",         params.get("description"),         None),
        ("expression",          params.get("expression"),          None),
        ("priority",            params.get("priority"),            int),
        ("status",              params.get("status"),              int),
        ("discover",            params.get("discover"),            int),
        ("recovery_mode",       params.get("recovery_mode"),       int),
        ("recovery_expression", params.get("recovery_expression"), None),
        ("correlation_mode",    params.get("correlation_mode"),    int),
        ("comments",            params.get("comments"),            None),
        ("url",                 params.get("url"),                 None),
        ("url_name",            params.get("url_name"),            None),
        ("manual_close",        params.get("manual_close"),        int),
        ("opdata",              params.get("opdata"),              None),
        ("event_name",          params.get("event_name"),          None),
    ]:
        if val is not None:
            args.append(cast(val) if cast else str(val))
            fields.append(f"{col}=${len(args)}")

    if fields:
        args.append(int(triggerid))
        await pool().execute(
            f"UPDATE triggers SET {', '.join(fields)} WHERE triggerid=${len(args)}", *args
        )

    tags_param = params.get("tags")
    if tags_param is not None:
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM trigger_tag WHERE triggerid=$1", int(triggerid))
                for tag in tags_param:
                    tagid = await next_id(conn, "trigger_tag", "triggertagid")
                    await conn.execute(
                        "INSERT INTO trigger_tag (triggertagid,triggerid,tag,value) VALUES ($1,$2,$3,$4)",
                        tagid, int(triggerid), str(tag.get("tag", "")), str(tag.get("value", "")),
                    )

    return {"triggerids": [str(triggerid)]}


@register("triggerprototype.delete")
async def triggerprototype_delete(params: dict, userid: int | None) -> dict:
    tids = params if isinstance(params, list) else params.get("triggerids", [])
    if isinstance(tids, (str, int)):
        tids = [tids]
    if not tids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "triggerids required")
    ids = [int(i) for i in tids]

    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM trigger_tag WHERE triggerid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM trigger_depends WHERE triggerid_down=ANY($1::bigint[]) OR triggerid_up=ANY($1::bigint[])", ids, ids)
            await conn.execute("DELETE FROM functions WHERE triggerid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM triggers WHERE triggerid=ANY($1::bigint[]) AND flags=2", ids)
    return {"triggerids": [str(i) for i in ids]}
