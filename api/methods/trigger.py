from __future__ import annotations
"""
trigger.get / trigger.create / trigger.update / trigger.delete

priority (severity): 0=NC, 1=Info, 2=Warning, 3=Average, 4=High, 5=Disaster
value:  0=OK, 1=PROBLEM
status: 0=enabled, 1=disabled
flags:  0=normal, 2=prototype
recovery_mode: 0=expression, 1=recovery expression, 2=none
"""
import os
import re
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY
from ..tags import build_tag_sql
from .. import rbac


async def _expand_expressions(tids: list[int], result: dict) -> None:
    """Replace {functionid} tokens in expression/recovery_expression with
    function(/host/key_,param) — Zabbix 7.0 expanded trigger expression format."""
    rows = await pool().fetch(
        """SELECT f.functionid, f.triggerid, f.name, f.parameter,
                  i.key_, h.host
           FROM functions f
           JOIN items i ON i.itemid = f.itemid
           JOIN hosts h ON h.hostid = i.hostid
           WHERE f.triggerid = ANY($1::bigint[])""",
        tids,
    )
    # build map: functionid -> expanded token
    func_map: dict[str, str] = {}
    for r in rows:
        param = r["parameter"] or ""
        # Zabbix stores params as "$,actual_param" where $ means "this item"
        if param.startswith("$,"):
            param = param[2:]
        elif param == "$":
            param = ""
        fstr = f"{r['name']}(/{r['host']}/{r['key_']}"
        fstr += f",{param})" if param else ")"
        func_map[str(r["functionid"])] = fstr

    def expand(expr: str) -> str:
        if not expr:
            return expr
        return re.sub(r"\{(\d+)\}", lambda m: func_map.get(m.group(1), m.group(0)), expr)

    for tid, d in result.items():
        if "expression" in d:
            d["expression"] = expand(d["expression"])
        if "recovery_expression" in d and d.get("recovery_expression"):
            d["recovery_expression"] = expand(d["recovery_expression"])

_FIELDS = {
    "triggerid","description","expression","priority","status","value","state",
    "error","lastchange","flags","templateid","url","comments",
    "recovery_mode","recovery_expression","correlation_mode","correlation_tag",
    "manual_close","opdata","event_name",
}


@register("trigger.get")
async def trigger_get(params: dict, userid: int | None) -> list | str | dict:
    output        = params.get("output", "extend")
    trigger_ids   = params.get("triggerids")
    host_ids      = params.get("hostids")
    group_ids     = params.get("groupids")
    item_ids      = params.get("itemids")
    only_true     = params.get("only_true")
    monitored     = params.get("monitored")
    active        = params.get("active")
    filter_       = params.get("filter") or {}
    limit         = params.get("limit")
    offset        = params.get("offset", 0)
    count_output  = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    select_hosts  = params.get("selectHosts")
    select_items  = params.get("selectItems")
    select_functions = params.get("selectFunctions")
    select_host_groups = params.get("selectHostGroups")
    select_last_event  = params.get("selectLastEvent")
    select_tags        = params.get("selectTags")
    select_deps        = params.get("selectDependencies")
    skip_dependent     = params.get("skipDependent")
    tags               = params.get("tags")
    evaltype           = params.get("evaltype", 0)
    expand_expression  = params.get("expandExpression")
    expand_description = params.get("expandDescription")
    expand_comment     = params.get("expandComment")

    where = ["t.flags IN (0, 4)"]
    args: list = []

    if trigger_ids is not None:
        if isinstance(trigger_ids, (str, int)):
            trigger_ids = [trigger_ids]
        if not trigger_ids:  # empty list → no matching triggers
            return {} if preserve_keys else []
        args.append([int(i) for i in trigger_ids])
        where.append(f"t.triggerid = ANY(${len(args)}::bigint[])")

    if item_ids:
        if isinstance(item_ids, (str, int)):
            item_ids = [item_ids]
        args.append([int(i) for i in item_ids])
        where.append(
            f"t.triggerid IN (SELECT triggerid FROM functions WHERE itemid = ANY(${len(args)}::bigint[]))"
        )

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(i) for i in host_ids])
        where.append(
            f"t.triggerid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN items i ON i.itemid=f.itemid"
            f"  WHERE i.hostid = ANY(${len(args)}::bigint[])"
            f")"
        )

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(i) for i in group_ids])
        where.append(
            f"t.triggerid IN ("
            f"  SELECT f.triggerid FROM functions f"
            f"  JOIN items i ON i.itemid=f.itemid"
            f"  JOIN hosts_groups hg ON hg.hostid=i.hostid"
            f"  WHERE hg.groupid = ANY(${len(args)}::bigint[])"
            f")"
        )

    if only_true:
        where.append("t.value = 1")
    if monitored:
        where.append(
            "t.status = 0 AND t.triggerid IN ("
            "  SELECT f.triggerid FROM functions f"
            "  JOIN items i ON i.itemid=f.itemid"
            "  JOIN hosts h ON h.hostid=i.hostid"
            "  WHERE h.status=0 AND i.status=0"
            ")"
        )
    if active:
        where.append(
            "t.status = 0 AND t.triggerid IN ("
            "  SELECT f.triggerid FROM functions f"
            "  JOIN items i ON i.itemid=f.itemid"
            "  JOIN hosts h ON h.hostid=i.hostid"
            "  WHERE h.status=0 AND i.status=0"
            ")"
        )

    if filter_.get("status") is not None:
        args.append(int(filter_["status"]))
        where.append(f"t.status = ${len(args)}")

    if filter_.get("value") is not None:
        args.append(int(filter_["value"]))
        where.append(f"t.value = ${len(args)}")

    if skip_dependent:
        where.append(
            "NOT EXISTS ("
            "  SELECT 1 FROM trigger_depends td"
            "  JOIN triggers tp ON tp.triggerid = td.triggerid_up"
            "  WHERE td.triggerid_down = t.triggerid"
            "  AND tp.value = 1 AND tp.status = 0"
            ")"
        )

    tag_sql = build_tag_sql(tags, evaltype, args, "triggerid", "trigger_tag", "t.triggerid")
    if tag_sql:
        where.append(tag_sql)

    # ── trigger permission filter (non-super-admin) ───────────────────────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            return "0" if count_output else ({} if preserve_keys else [])
        where.append(rbac.trigger_perm_sql(args, ctx.ugsetid))

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(
            f"SELECT count(*) AS c FROM triggers t WHERE {where_sql}", *args
        )
        return str(row["c"])

    sql = f"""
        SELECT t.triggerid, t.description, t.expression, t.priority, t.status,
               t.value, t.state, t.error, t.lastchange, t.flags, t.type,
               t.recovery_expression, t.recovery_mode, t.correlation_mode,
               t.correlation_tag, t.manual_close, t.url, t.url_name,
               t.comments, t.templateid, t.opdata, t.event_name, t.uuid
        FROM triggers t
        WHERE {where_sql}
        ORDER BY t.priority DESC, t.lastchange DESC
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    if offset:
        sql += f" OFFSET {int(offset)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("triggerid", "templateid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["templatehostid"] = "0"
        result[d["triggerid"]] = d

    # Resolve templatehostid: for inherited triggers, find the template host via functions→items
    tpl_trig_ids = [int(d["templateid"]) for d in result.values() if d.get("templateid") and d["templateid"] != "0"]
    if tpl_trig_ids:
        tpl_rows = await pool().fetch(
            """SELECT DISTINCT ON (f.triggerid) f.triggerid, i.hostid
               FROM functions f JOIN items i ON i.itemid = f.itemid
               WHERE f.triggerid = ANY($1::bigint[])
               ORDER BY f.triggerid""",
            tpl_trig_ids,
        )
        tpl_host_map = {str(r["triggerid"]): str(r["hostid"]) for r in tpl_rows}
        for d in result.values():
            d["templatehostid"] = tpl_host_map.get(d.get("templateid", "0"), "0")

    if result and (expand_expression or expand_description or expand_comment):
        tids = [int(k) for k in result]
        if expand_expression:
            await _expand_expressions(tids, result)
        if expand_description or expand_comment:
            # {HOST.HOST}/{HOST.NAME} + {$MACRO} substitution in description/comments
            host_rows = await pool().fetch(
                """SELECT DISTINCT f.triggerid, h.hostid, h.host, h.name
                   FROM functions f JOIN items i ON i.itemid=f.itemid
                   JOIN hosts h ON h.hostid=i.hostid
                   WHERE f.triggerid = ANY($1::bigint[])""",
                tids,
            )
            trigger_host: dict[str, tuple[str, str]] = {}  # tid -> (host, name)
            trigger_hostids: dict[str, int] = {}            # tid -> hostid
            for hr in host_rows:
                tid_s = str(hr["triggerid"])
                trigger_host[tid_s] = (hr["host"], hr["name"])
                trigger_hostids[tid_s] = hr["hostid"]

            # load global macros (lower priority)
            global_macros: dict[str, str] = {}
            for gr in await pool().fetch("SELECT macro, value FROM globalmacro"):
                global_macros[gr["macro"]] = gr["value"]

            # load host macros for all involved hosts (higher priority)
            all_hostids = list(set(trigger_hostids.values()))
            host_macros: dict[int, dict[str, str]] = {}
            if all_hostids:
                for hm in await pool().fetch(
                    "SELECT hostid, macro, value FROM hostmacro "
                    "WHERE hostid = ANY($1::bigint[])",
                    all_hostids,
                ):
                    host_macros.setdefault(hm["hostid"], {})[hm["macro"]] = hm["value"]

            for tid, d in result.items():
                host_tech, host_name = trigger_host.get(tid, ("", ""))
                hostid = trigger_hostids.get(tid)
                # merge: global < host
                macros = {**global_macros, **(host_macros.get(hostid, {}) if hostid else {})}

                def _macro_sub(text: str, ht=host_tech, hn=host_name, mc=macros) -> str:
                    if not text:
                        return text
                    text = text.replace("{HOST.HOST}", ht)
                    text = text.replace("{HOST.NAME}", hn)
                    text = text.replace("{HOST.CONN}", ht)
                    # {$MACRO} substitution
                    def _repl(m):
                        key = "{$" + m.group(1) + "}"
                        return mc.get(key, m.group(0))
                    text = re.sub(r"\{\$([^}]+)\}", _repl, text)
                    return text

                if expand_description and "description" in d:
                    d["description"] = _macro_sub(d["description"])
                if expand_comment and "comments" in d:
                    d["comments"] = _macro_sub(d["comments"])

    if select_hosts and result:
        tids = [int(k) for k in result]
        hrows = await pool().fetch(
            """SELECT DISTINCT f.triggerid,
                      h.hostid, h.host, h.name, h.status,
                      h.maintenance_status, h.description,
                      COALESCE(h.proxyid::text, '0') AS proxyid
               FROM functions f
               JOIN items i ON i.itemid=f.itemid
               JOIN hosts h ON h.hostid=i.hostid
               WHERE f.triggerid = ANY($1::bigint[])""",
            tids,
        )
        for r in hrows:
            tid = str(r["triggerid"])
            result[tid].setdefault("hosts", []).append({
                "hostid":             str(r["hostid"]),
                "host":               r["host"],
                "name":               r["name"],
                "status":             str(r["status"]),
                "maintenance_status": str(r["maintenance_status"]),
                "description":        r["description"] or "",
                "proxyid":            r["proxyid"],
            })

    if select_items and result:
        tids = [int(k) for k in result]
        irows = await pool().fetch(
            """SELECT f.triggerid, i.itemid, i.name, i.key_, i.value_type, i.units
               FROM functions f JOIN items i ON i.itemid=f.itemid
               WHERE f.triggerid = ANY($1::bigint[])""",
            tids,
        )
        items_map: dict[str, dict] = {}  # itemid -> item dict
        for r in irows:
            tid = str(r["triggerid"])
            iid = str(r["itemid"])
            item_d = {
                "itemid":     iid,
                "name":       r["name"],
                "key_":       r["key_"],
                "value_type": str(r["value_type"]),
                "units":      r["units"],
                "lastvalue":  "",
            }
            result[tid].setdefault("items", []).append(item_d)
            items_map[iid] = item_d

        # fetch lastvalue from history tables
        if items_map:
            from ..methods.item import _HISTORY_TABLE
            by_vt: dict[int, list[int]] = {}
            for r in irows:
                by_vt.setdefault(int(r["value_type"]), []).append(int(r["itemid"]))
            for vt, ids in by_vt.items():
                tbl = _HISTORY_TABLE.get(vt)
                if not tbl:
                    continue
                lv_rows = await pool().fetch(
                    f"SELECT DISTINCT ON (itemid) itemid, value::text AS v"
                    f" FROM {tbl} WHERE itemid = ANY($1::bigint[])"
                    f" ORDER BY itemid, clock DESC, ns DESC",
                    ids,
                )
                for lv in lv_rows:
                    iid = str(lv["itemid"])
                    if iid in items_map:
                        items_map[iid]["lastvalue"] = lv["v"]

    if select_functions and result:
        tids = [int(k) for k in result]
        frows = await pool().fetch(
            """SELECT f.functionid, f.triggerid, f.itemid,
                      f.name AS function, f.parameter
               FROM functions f WHERE f.triggerid = ANY($1::bigint[])""",
            tids,
        )
        for r in frows:
            tid = str(r["triggerid"])
            result[tid].setdefault("functions", []).append({
                "functionid": str(r["functionid"]),
                "itemid": str(r["itemid"]),
                "function": r["function"],
                "parameter": r["parameter"],
            })

    if select_host_groups and result:
        for tid in result:
            result[tid]["hostgroups"] = []
        tids = [int(k) for k in result]
        grp_rows = await pool().fetch(
            """SELECT DISTINCT f.triggerid, g.groupid, g.name
               FROM functions f
               JOIN items i ON i.itemid=f.itemid
               JOIN hosts_groups hg ON hg.hostid=i.hostid
               JOIN hstgrp g ON g.groupid=hg.groupid
               WHERE f.triggerid = ANY($1::bigint[])""",
            tids,
        )
        for r in grp_rows:
            tid = str(r["triggerid"])
            result[tid].setdefault("hostgroups", []).append({
                "groupid": str(r["groupid"]), "name": r["name"],
            })

    if select_last_event and result:
        for tid in result:
            result[tid]["lastEvent"] = False
        tids = [int(k) for k in result]
        ev_rows = await pool().fetch(
            """SELECT DISTINCT ON (objectid)
                      eventid, objectid, clock, value, acknowledged, name, severity
               FROM events
               WHERE source=0 AND object=0 AND objectid = ANY($1::bigint[])
               ORDER BY objectid, clock DESC, eventid DESC""",
            tids,
        )
        for r in ev_rows:
            tid = str(r["objectid"])
            result[tid]["lastEvent"] = {
                "eventid": str(r["eventid"]),
                "clock": str(r["clock"]),
                "value": str(r["value"]),
                "acknowledged": str(r["acknowledged"]),
                "name": r["name"],
                "severity": str(r["severity"]),
            }

    if select_tags and result:
        for tid in result:
            result[tid]["tags"] = []
        tids = [int(k) for k in result]
        tag_rows = await pool().fetch(
            "SELECT triggerid, tag, value FROM trigger_tag WHERE triggerid = ANY($1::bigint[])",
            tids,
        )
        for tr in tag_rows:
            result[str(tr["triggerid"])]["tags"].append({"tag": tr["tag"], "value": tr["value"]})

    if select_deps and result:
        for tid in result:
            result[tid]["dependencies"] = []
        tids = [int(k) for k in result]
        dep_rows = await pool().fetch(
            """SELECT td.triggerid_down, td.triggerid_up, t.description
               FROM trigger_depends td
               JOIN triggers t ON t.triggerid = td.triggerid_up
               WHERE td.triggerid_down = ANY($1::bigint[])""",
            tids,
        )
        for r in dep_rows:
            result[str(r["triggerid_down"])]["dependencies"].append({
                "triggerid": str(r["triggerid_up"]),
                "description": r["description"],
            })

    if preserve_keys:
        return result
    return list(result.values())


@register("trigger.create")
async def trigger_create(params: dict, userid: int | None) -> dict:
    description = str(params.get("description", "")).strip()
    expression  = str(params.get("expression", "")).strip()
    priority    = int(params.get("priority", 0))
    status      = int(params.get("status", 0))
    recovery_mode = int(params.get("recovery_mode", 0))
    recovery_expr = str(params.get("recovery_expression", ""))
    comments    = str(params.get("comments", ""))
    url         = str(params.get("url", ""))
    url_name    = str(params.get("url_name", ""))
    manual_close = int(params.get("manual_close", 0))
    opdata      = str(params.get("opdata", ""))
    event_name  = str(params.get("event_name", ""))

    tags_param   = params.get("tags", [])
    dependencies = params.get("dependencies", [])

    if not description or not expression:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "description and expression are required")

    async with pool().acquire() as conn:
        async with conn.transaction():
            triggerid = await next_id(conn, "triggers", "triggerid")
            await conn.execute(
                """INSERT INTO triggers
                   (triggerid, expression, description, url, url_name, status,
                    priority, comments, recovery_mode, recovery_expression,
                    correlation_mode, correlation_tag, manual_close,
                    opdata, event_name, flags, type, uuid,
                    value, state, error, lastchange, templateid)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                           0,'',  $11,$12,$13,0,0,'',
                           0,0,   '',0,NULL)""",
                triggerid, expression, description, url, url_name, status,
                priority, comments, recovery_mode, recovery_expr,
                manual_close, opdata, event_name,
            )
            for tag in tags_param:
                ttid = await next_id(conn, "trigger_tag", "triggertagid")
                await conn.execute(
                    "INSERT INTO trigger_tag (triggertagid,triggerid,tag,value) VALUES ($1,$2,$3,$4)",
                    ttid, triggerid, str(tag.get("tag", "")), str(tag.get("value", "")),
                )
            for dep in dependencies:
                dep_tid = int(dep["triggerid"] if isinstance(dep, dict) else dep)
                depid = await next_id(conn, "trigger_depends", "triggerdepid")
                await conn.execute(
                    "INSERT INTO trigger_depends (triggerdepid,triggerid_down,triggerid_up) VALUES ($1,$2,$3)",
                    depid, triggerid, dep_tid,
                )
    return {"triggerids": [str(triggerid)]}


@register("trigger.update")
async def trigger_update(params: dict, userid: int | None) -> dict:
    triggerid = params.get("triggerid")
    if not triggerid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "triggerid required")

    row = await pool().fetchrow(
        "SELECT triggerid, templateid FROM triggers WHERE triggerid=$1", int(triggerid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")
    if row["templateid"]:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot update a templated trigger directly")

    fields, args = [], []
    for col, val, cast in [
        ("description",        params.get("description"),        None),
        ("expression",         params.get("expression"),         None),
        ("priority",           params.get("priority"),           int),
        ("status",             params.get("status"),             int),
        ("recovery_mode",      params.get("recovery_mode"),      int),
        ("recovery_expression",params.get("recovery_expression"),None),
        ("comments",           params.get("comments"),           None),
        ("url",                params.get("url"),                None),
        ("url_name",           params.get("url_name"),           None),
        ("manual_close",       params.get("manual_close"),       int),
        ("opdata",             params.get("opdata"),             None),
        ("event_name",         params.get("event_name"),         None),
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
                    ttid = await next_id(conn, "trigger_tag", "triggertagid")
                    await conn.execute(
                        "INSERT INTO trigger_tag (triggertagid,triggerid,tag,value) VALUES ($1,$2,$3,$4)",
                        ttid, int(triggerid), str(tag.get("tag", "")), str(tag.get("value", "")),
                    )

    dependencies = params.get("dependencies")
    if dependencies is not None:
        dep_ids = [int(d["triggerid"] if isinstance(d, dict) else d) for d in dependencies]
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM trigger_depends WHERE triggerid_down=$1", int(triggerid))
                for dep_id in dep_ids:
                    depid = await next_id(conn, "trigger_depends", "triggerdepid")
                    await conn.execute(
                        "INSERT INTO trigger_depends (triggerdepid,triggerid_down,triggerid_up) VALUES ($1,$2,$3)",
                        depid, int(triggerid), dep_id,
                    )

    return {"triggerids": [str(triggerid)]}


@register("trigger.delete")
async def trigger_delete(params: dict, userid: int | None) -> dict:
    trigger_ids = params if isinstance(params, list) else params.get("triggerids", [])
    if isinstance(trigger_ids, (str, int)):
        trigger_ids = [trigger_ids]
    if not trigger_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "triggerids required")

    ids = [int(i) for i in trigger_ids]

    rows = await pool().fetch(
        "SELECT triggerid FROM triggers WHERE triggerid=ANY($1::bigint[]) AND flags IN (0,4)", ids
    )
    if len(rows) != len(ids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    tmpl = await pool().fetch(
        "SELECT triggerid FROM triggers WHERE triggerid=ANY($1::bigint[]) AND templateid IS NOT NULL", ids
    )
    if tmpl:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot delete templated triggers")

    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM functions WHERE triggerid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM trigger_depends WHERE triggerid_down=ANY($1::bigint[]) OR triggerid_up=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM trigger_tag WHERE triggerid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM triggers WHERE triggerid=ANY($1::bigint[])", ids)

    return {"triggerids": [str(i) for i in ids]}
