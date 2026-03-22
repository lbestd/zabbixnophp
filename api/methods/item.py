"""
item.get / item.create / item.update / item.delete

flags: 0=normal, 1=LLD rule, 2=prototype, 4=LLD-created
value_type: 0=Float, 1=String, 2=Log, 3=Uint, 4=Text
type: 0=ZabbixAgent, 2=Trapper, 5=Internal, 7=ActiveAgent,
      10=External, 11=DBMonitor, 12=IPMI, 13=SSH, 14=Telnet,
      15=Calculated, 18=Dependent, 19=HTTPAgent, 20=SNMP, 21=Script
"""
import os
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY
from ..tags import build_tag_sql
from .. import rbac

_HISTORY_TABLE = {0: "history", 1: "history_str", 2: "history_log", 3: "history_uint", 4: "history_text"}


_HISTORY_PERIOD = 7 * 86400  # 7 days, matching real Zabbix default


async def _enrich_last_values(result: dict) -> None:
    """Fill lastclock/lastns/lastvalue/prevvalue by querying history tables.

    Limits to the last 7 days (HISTORY_PERIOD) to avoid full table scans.
    Uses a window function to fetch at most 2 rows per item efficiently.
    """
    import time as _time
    time_from = int(_time.time()) - _HISTORY_PERIOD

    by_vt: dict[int, list[int]] = {}
    for d in result.values():
        vt = int(d.get("value_type", 0))
        by_vt.setdefault(vt, []).append(int(d["itemid"]))

    for vt, ids in by_vt.items():
        table = _HISTORY_TABLE.get(vt)
        if not table:
            continue
        rows = await pool().fetch(
            f"""SELECT itemid, clock, ns, v, rn FROM (
                  SELECT itemid, clock, ns, value::text AS v,
                         row_number() OVER (PARTITION BY itemid
                                            ORDER BY clock DESC, ns DESC) AS rn
                  FROM {table}
                  WHERE itemid = ANY($1::bigint[]) AND clock >= $2
                ) t WHERE rn <= 2""",
            ids, time_from,
        )
        for r in rows:
            iid = str(r["itemid"])
            if iid not in result:
                continue
            if r["rn"] == 1:
                result[iid]["lastclock"] = str(r["clock"])
                result[iid]["lastns"]    = str(r["ns"])
                result[iid]["lastvalue"] = r["v"]
            else:
                result[iid]["prevvalue"] = r["v"]


_ITEM_FIELDS = {
    "itemid","type","hostid","name","key_","delay","history","trends",
    "status","value_type","units","description","state","error",
    "lastclock","lastvalue","templateid","valuemapid","flags",
    "logtimefmt","params","formula","trapper_hosts","snmp_oid","interfaceid",
}

_LAST_VALUE_FIELDS = {"lastvalue", "lastclock", "prevvalue", "lastns"}


@register("item.get")
async def item_get(params: dict, userid: int | None) -> list | str | dict:
    output        = params.get("output", "extend")
    count_output  = params.get("countOutput", False)
    item_ids      = params.get("itemids")
    host_ids      = params.get("hostids")
    group_ids     = params.get("groupids")
    trigger_ids   = params.get("triggerids")
    monitored     = params.get("monitored")
    search        = params.get("search") or {}
    filter_       = params.get("filter") or {}
    limit         = params.get("limit")
    offset        = params.get("offset", 0)
    preserve_keys = params.get("preservekeys", False)
    web_items     = params.get("webitems", False)
    flags         = params.get("flags")
    select_hosts          = params.get("selectHosts")
    select_tags           = params.get("selectTags")
    select_preprocessing  = params.get("selectPreprocessing")
    select_discovery_rule = params.get("selectDiscoveryRule")
    select_triggers       = params.get("selectTriggers")
    select_item_discovery = params.get("selectItemDiscovery")
    select_last_values    = params.get("selectLastValues", False)
    tags          = params.get("tags")
    evaltype      = params.get("evaltype", 0)
    sortfield     = params.get("sortfield", "name")
    sortorder     = params.get("sortorder", "ASC")
    interface_ids = params.get("interfaceids")
    templated     = params.get("templated")
    group_count   = params.get("groupCount", False)
    editable      = bool(params.get("editable", False))
    need_history  = select_last_values or (
        isinstance(output, list) and bool(_LAST_VALUE_FIELDS & set(output))
    )

    where = []
    args: list = []

    if flags is not None:
        fl = [flags] if isinstance(flags, int) else list(map(int, flags))
        args.append(fl)
        where.append(f"i.flags = ANY(${len(args)}::int[])")
    else:
        where.append("i.flags IN (0, 4)")  # normal + LLD-created only

    if not web_items:
        where.append("i.type != 9")

    if item_ids:
        if isinstance(item_ids, (str, int)):
            item_ids = [item_ids]
        args.append([int(x) for x in item_ids])
        where.append(f"i.itemid = ANY(${len(args)}::bigint[])")

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(x) for x in host_ids])
        where.append(f"i.hostid = ANY(${len(args)}::bigint[])")

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(x) for x in group_ids])
        where.append(
            f"i.hostid IN (SELECT hostid FROM hosts_groups WHERE groupid = ANY(${len(args)}::bigint[]))"
        )

    if trigger_ids:
        if isinstance(trigger_ids, (str, int)):
            trigger_ids = [trigger_ids]
        args.append([int(x) for x in trigger_ids])
        where.append(
            f"i.itemid IN (SELECT itemid FROM functions WHERE triggerid = ANY(${len(args)}::bigint[]))"
        )

    if interface_ids:
        if isinstance(interface_ids, (str, int)):
            interface_ids = [interface_ids]
        args.append([int(x) for x in interface_ids])
        where.append(f"i.interfaceid = ANY(${len(args)}::bigint[])")

    if monitored:
        where.append(
            "i.status = 0 AND EXISTS (SELECT 1 FROM hosts h WHERE h.hostid=i.hostid AND h.status=0)"
        )

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"i.name ILIKE ${len(args)}")

    if search.get("key_"):
        args.append(f"%{search['key_']}%")
        where.append(f"i.key_ ILIKE ${len(args)}")

    if filter_.get("value_type") is not None:
        vt = filter_["value_type"]
        if isinstance(vt, list):
            args.append(list(map(int, vt)))
            where.append(f"i.value_type = ANY(${len(args)}::int[])")
        else:
            args.append(int(vt))
            where.append(f"i.value_type = ${len(args)}")

    if filter_.get("status") is not None:
        args.append(int(filter_["status"]))
        where.append(f"i.status = ${len(args)}")

    if filter_.get("state") is not None:
        args.append(int(filter_["state"]))
        where.append(f"COALESCE(rd.state, 0) = ${len(args)}")

    if filter_.get("interfaceid") is not None:
        iid = filter_["interfaceid"]
        if isinstance(iid, list):
            args.append([int(x) for x in iid])
            where.append(f"i.interfaceid = ANY(${len(args)}::bigint[])")
        else:
            args.append(int(iid))
            where.append(f"i.interfaceid = ${len(args)}")

    if filter_.get("type") is not None:
        t = filter_["type"]
        if isinstance(t, list):
            args.append(list(map(int, t)))
            where.append(f"i.type = ANY(${len(args)}::int[])")
        else:
            args.append(int(t))
            where.append(f"i.type = ${len(args)}")

    tag_sql = build_tag_sql(tags, evaltype, args, "itemid", "item_tag", "i.itemid")
    if tag_sql:
        where.append(tag_sql)

    if templated is not None and templated != "":
        if templated and str(templated) not in ("0", "false"):
            where.append("i.templateid != 0")
        else:
            where.append("(i.templateid IS NULL OR i.templateid = 0)")

    # ── item permission filter (non-super-admin) ──────────────────────────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            return "0" if count_output else ({} if preserve_keys else [])
        where.append(rbac.item_perm_sql(args, ctx.ugsetid, editable=editable))

    where_sql = " AND ".join(where) if where else "TRUE"

    if count_output:
        needs_rtdata = filter_.get("state") is not None
        rtdata_join = "LEFT JOIN item_rtdata rd ON rd.itemid = i.itemid" if needs_rtdata else ""
        if group_count:
            group_col = "i.interfaceid" if interface_ids else "i.hostid"
            col_name  = "interfaceid"   if interface_ids else "hostid"
            rows = await pool().fetch(
                f"SELECT COUNT(*) AS rowscount, {group_col} AS {col_name} "
                f"FROM items i {rtdata_join} WHERE {where_sql} GROUP BY {group_col}", *args
            )
            return [{"rowscount": str(r["rowscount"]), col_name: str(r[col_name])} for r in rows]
        row = await pool().fetchrow(
            f"SELECT count(*) AS c FROM items i {rtdata_join} WHERE {where_sql}", *args
        )
        return str(row["c"])

    sql = f"""
        SELECT i.itemid, i.hostid, i.name, i.key_, i.status, i.value_type,
               i.units, i.delay, i.history, i.trends, i.description, i.flags,
               i.templateid, i.valuemapid, i.type, i.snmp_oid, i.params,
               i.trapper_hosts, i.logtimefmt, i.interfaceid,
               i.evaltype, i.formula,
               i.lifetime, i.lifetime_type, i.enabled_lifetime, i.enabled_lifetime_type,
               i.inventory_link, i.ipmi_sensor, i.jmx_endpoint,
               i.password, i.privatekey, i.publickey,
               i.url, i.timeout, i.request_method, i.post_type, i.posts,
               i.headers, i.query_fields, i.retrieve_mode, i.follow_redirects, i.http_proxy,
               i.verify_peer, i.verify_host, i.authtype, i.username,
               i.ssl_cert_file, i.ssl_key_file, i.ssl_key_password,
               i.status_codes, i.output_format, i.allow_traps,
               i.master_itemid, i.uuid,
               COALESCE(rd.state, 0)  AS state,
               COALESCE(rd.error, '') AS error,
               COALESCE(rn.name_resolved, i.name) AS name_resolved,
               ti.hostid AS templatehostid
        FROM items i
        LEFT JOIN item_rtdata rd ON rd.itemid = i.itemid
        LEFT JOIN item_rtname rn ON rn.itemid = i.itemid
        LEFT JOIN items ti ON ti.itemid = i.templateid AND i.templateid != 0
        WHERE {where_sql}
        ORDER BY i.{sortfield if sortfield in _ITEM_FIELDS else 'name'} {('DESC' if str(sortorder).upper()=='DESC' else 'ASC')}
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    if offset:
        sql += f" OFFSET {int(offset)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("itemid", "hostid", "templateid", "valuemapid", "interfaceid", "master_itemid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["templatehostid"] = str(d["templatehostid"]) if d.get("templatehostid") is not None else "0"
        if need_history:
            d["lastclock"] = "0"
            d["lastns"]    = "0"
            d["lastvalue"] = ""
            d["prevvalue"] = ""
        d["parameters"] = []
        result[d["itemid"]] = d

    # fetch last values (and prev) from history tables — only when explicitly requested
    if result and need_history:
        await _enrich_last_values(result)

    # fetch script parameters
    if result:
        iids = [int(k) for k in result]
        prows = await pool().fetch(
            "SELECT itemid, name, value FROM item_parameter WHERE itemid=ANY($1::bigint[])",
            iids,
        )
        for pr in prows:
            result[str(pr["itemid"])]["parameters"].append(
                {"name": pr["name"], "value": pr["value"]}
            )

    if select_hosts and result:
        iids = [int(k) for k in result]
        hrows = await pool().fetch(
            """SELECT i.itemid, h.hostid, h.host, h.name, h.status
               FROM items i JOIN hosts h ON h.hostid = i.hostid
               WHERE i.itemid = ANY($1::bigint[])""",
            iids,
        )
        for r in hrows:
            iid = str(r["itemid"])
            result[iid].setdefault("hosts", []).append({
                "hostid": str(r["hostid"]),
                "host": r["host"], "name": r["name"],
                "status": str(r["status"]),
            })

    if select_tags and result:
        iids = [int(k) for k in result]
        tag_rows = await pool().fetch(
            "SELECT itemid, tag, value FROM item_tag WHERE itemid = ANY($1::bigint[])",
            iids,
        )
        for tr in tag_rows:
            iid = str(tr["itemid"])
            result[iid].setdefault("tags", []).append({"tag": tr["tag"], "value": tr["value"]})

    if select_preprocessing and result:
        iids = [int(k) for k in result]
        for iid in result:
            result[iid]["preprocessing"] = []
        pp_rows = await pool().fetch(
            """SELECT itemid, step, type, params, error_handler, error_handler_params
               FROM item_preproc WHERE itemid = ANY($1::bigint[]) ORDER BY itemid, step""",
            iids,
        )
        for r in pp_rows:
            iid = str(r["itemid"])
            result[iid]["preprocessing"].append({
                "step":                  str(r["step"]),
                "type":                  str(r["type"]),
                "params":                r["params"],
                "error_handler":         str(r["error_handler"]),
                "error_handler_params":  r["error_handler_params"],
            })

    # selectDiscoveryRule: for LLD-created items (flags=4), resolve their discovery rule
    # Chain: discovered item -> item_discovery.parent_itemid -> prototype (flags=2)
    #        prototype -> item_discovery.parent_itemid -> LLD rule (flags=1)
    if select_discovery_rule and result:
        lld_ids = [int(k) for k in result if int(result[k].get("flags", 0)) == 4]
        if lld_ids:
            dr_rows = await pool().fetch(
                """SELECT di.itemid AS discovered_id,
                          id2.parent_itemid AS rule_id,
                          COALESCE(rn.name_resolved, irule.name) AS rule_name
                   FROM item_discovery di
                   JOIN item_discovery id2 ON id2.itemid = di.parent_itemid
                   JOIN items irule ON irule.itemid = id2.parent_itemid
                   LEFT JOIN item_rtname rn ON rn.itemid = irule.itemid
                   WHERE di.itemid = ANY($1::bigint[])""",
                lld_ids,
            )
            for r in dr_rows:
                iid = str(r["discovered_id"])
                result[iid]["discoveryRule"] = {
                    "itemid": str(r["rule_id"]),
                    "name": r["rule_name"],
                }

    if select_triggers is not None and result:
        iids = [int(k) for k in result]
        for iid in result:
            result[iid]["triggers"] = []
        trows = await pool().fetch(
            "SELECT DISTINCT f.itemid, f.triggerid FROM functions f "
            "WHERE f.itemid = ANY($1::bigint[])", iids
        )
        for r in trows:
            result[str(r["itemid"])]["triggers"].append({"triggerid": str(r["triggerid"])})

    _DISCOVERY_COLS = {"itemdiscoveryid", "parent_itemid", "key_", "status",
                       "ts_delete", "ts_disable", "disable_source"}
    if select_item_discovery is not None and result:
        iids = [int(k) for k in result]
        for iid in result:
            result[iid]["itemDiscovery"] = {}
        cols = (
            [c for c in select_item_discovery if c in _DISCOVERY_COLS]
            if isinstance(select_item_discovery, list)
            else list(_DISCOVERY_COLS)
        )
        if cols:
            sel = ", ".join(f"t.{c}" for c in cols)
            drows = await pool().fetch(
                f"SELECT t.itemid, {sel} FROM item_discovery t "
                f"WHERE t.itemid = ANY($1::bigint[])", iids
            )
            for r in drows:
                result[str(r["itemid"])]["itemDiscovery"] = {c: str(r[c]) for c in cols}

    if preserve_keys:
        return result
    return list(result.values())


def _http_defaults(params: dict) -> dict:
    """Extract HTTP agent + auth + SSH/script extra fields from params dict."""
    return dict(
        url              = str(params.get("url", "")),
        timeout          = str(params.get("timeout", "3s")),
        request_method   = int(params.get("request_method", 0)),
        post_type        = int(params.get("post_type", 0)),
        posts            = str(params.get("posts", "")),
        headers          = str(params.get("headers", "")),
        query_fields     = str(params.get("query_fields", "")),
        retrieve_mode    = int(params.get("retrieve_mode", 0)),
        follow_redirects = int(params.get("follow_redirects", 1)),
        http_proxy       = str(params.get("http_proxy", "")),
        verify_peer      = int(params.get("verify_peer", 0)),
        verify_host      = int(params.get("verify_host", 0)),
        ssl_cert_file    = str(params.get("ssl_cert_file", "")),
        ssl_key_file     = str(params.get("ssl_key_file", "")),
        ssl_key_password = str(params.get("ssl_key_password", "")),
        status_codes     = str(params.get("status_codes", "200-299")),
        output_format    = int(params.get("output_format", 0)),
        allow_traps      = int(params.get("allow_traps", 0)),
        authtype         = int(params.get("authtype", 0)),
        username         = str(params.get("username", "")),
        password         = str(params.get("password", "")),
        publickey        = str(params.get("publickey", "")),
        privatekey       = str(params.get("privatekey", "")),
        master_itemid    = params.get("master_itemid"),
    )


@register("item.create")
async def item_create(params: dict, userid: int | None) -> dict:
    hostid     = params.get("hostid")
    name       = params.get("name", "").strip()
    key_       = params.get("key_", "").strip()
    type_      = int(params.get("type", 0))
    value_type = int(params.get("value_type", 3))
    delay      = str(params.get("delay", "60s"))
    history    = str(params.get("history", "31d"))
    trends     = str(params.get("trends", "365d"))
    units      = str(params.get("units", ""))
    description = str(params.get("description", ""))
    status     = int(params.get("status", 0))
    snmp_oid   = str(params.get("snmp_oid", ""))
    params_val = str(params.get("params", ""))
    trapper    = str(params.get("trapper_hosts", ""))
    interfaceid = params.get("interfaceid")
    ex         = _http_defaults(params)

    preprocessing = params.get("preprocessing", [])
    tags_param    = params.get("tags", [])

    if not hostid or not name or not key_:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostid, name and key_ are required")

    host = await pool().fetchrow("SELECT hostid FROM hosts WHERE hostid=$1", int(hostid))
    if not host:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    dup = await pool().fetchrow(
        "SELECT itemid FROM items WHERE hostid=$1 AND key_=$2 AND flags IN (0,4)",
        int(hostid), key_,
    )
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f"Item with key \"{key_}\" already exists on this host")

    async with pool().acquire() as conn:
        async with conn.transaction():
            itemid = await next_id(conn, "items", "itemid")
            await conn.execute(
                """INSERT INTO items
                   (itemid, type, hostid, name, key_, delay, history, trends,
                    status, value_type, units, description, flags,
                    snmp_oid, params, trapper_hosts, interfaceid,
                    formula, logtimefmt, templateid, valuemapid,
                    authtype, username, password, publickey, privatekey,
                    inventory_link, evaltype, lifetime, lifetime_type,
                    enabled_lifetime, enabled_lifetime_type, discover, uuid,
                    url, timeout, request_method, post_type, posts, headers,
                    query_fields, retrieve_mode, follow_redirects, http_proxy,
                    verify_peer, verify_host, ssl_cert_file, ssl_key_file,
                    ssl_key_password, status_codes, output_format, allow_traps,
                    master_itemid)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                           0,$13,$14,$15,$16,
                           '','',NULL,NULL,
                           $17,$18,$19,$20,$21,
                           0,0,'30d',0,'0d',0,0,'',
                           $22,$23,$24,$25,$26,$27,
                           $28,$29,$30,$31,
                           $32,$33,$34,$35,
                           $36,$37,$38,$39,
                           $40)""",
                itemid, type_, int(hostid), name, key_, delay, history, trends,
                status, value_type, units, description,
                snmp_oid, params_val, trapper,
                int(interfaceid) if interfaceid else None,
                ex["authtype"], ex["username"], ex["password"], ex["publickey"], ex["privatekey"],
                ex["url"], ex["timeout"], ex["request_method"], ex["post_type"], ex["posts"], ex["headers"],
                ex["query_fields"], ex["retrieve_mode"], ex["follow_redirects"], ex["http_proxy"],
                ex["verify_peer"], ex["verify_host"], ex["ssl_cert_file"], ex["ssl_key_file"],
                ex["ssl_key_password"], ex["status_codes"], ex["output_format"], ex["allow_traps"],
                int(ex["master_itemid"]) if ex["master_itemid"] else None,
            )
            for step_num, pp in enumerate(preprocessing, 1):
                ppid = await next_id(conn, "item_preproc", "item_preprocid")
                await conn.execute(
                    "INSERT INTO item_preproc "
                    "(item_preprocid,itemid,step,type,params,error_handler,error_handler_params) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    ppid, itemid, step_num,
                    int(pp.get("type", 0)), str(pp.get("params", "")),
                    int(pp.get("error_handler", 0)), str(pp.get("error_handler_params", "")),
                )
            for tag in tags_param:
                tagid = await next_id(conn, "item_tag", "itemtagid")
                await conn.execute(
                    "INSERT INTO item_tag (itemtagid,itemid,tag,value) VALUES ($1,$2,$3,$4)",
                    tagid, itemid, str(tag.get("tag", "")), str(tag.get("value", "")),
                )
    return {"itemids": [str(itemid)]}


@register("item.update")
async def item_update(params: dict, userid: int | None) -> dict:
    itemid = params.get("itemid")
    if not itemid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemid required")

    row = await pool().fetchrow(
        "SELECT itemid, hostid, templateid FROM items WHERE itemid=$1", int(itemid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")
    if row["templateid"]:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot update a templated item directly")

    fields = []
    args: list = []

    int_cols = {"type","value_type","status","authtype","request_method","post_type",
                "retrieve_mode","follow_redirects","verify_peer","verify_host",
                "output_format","allow_traps"}
    nullable_int_cols = {"master_itemid"}

    for col, val in [
        ("name",             params.get("name")),
        ("key_",             params.get("key_")),
        ("type",             params.get("type")),
        ("value_type",       params.get("value_type")),
        ("delay",            params.get("delay")),
        ("history",          params.get("history")),
        ("trends",           params.get("trends")),
        ("units",            params.get("units")),
        ("description",      params.get("description")),
        ("status",           params.get("status")),
        ("snmp_oid",         params.get("snmp_oid")),
        ("params",           params.get("params")),
        ("trapper_hosts",    params.get("trapper_hosts")),
        ("url",              params.get("url")),
        ("timeout",          params.get("timeout")),
        ("request_method",   params.get("request_method")),
        ("post_type",        params.get("post_type")),
        ("posts",            params.get("posts")),
        ("headers",          params.get("headers")),
        ("query_fields",     params.get("query_fields")),
        ("retrieve_mode",    params.get("retrieve_mode")),
        ("follow_redirects", params.get("follow_redirects")),
        ("http_proxy",       params.get("http_proxy")),
        ("verify_peer",      params.get("verify_peer")),
        ("verify_host",      params.get("verify_host")),
        ("ssl_cert_file",    params.get("ssl_cert_file")),
        ("ssl_key_file",     params.get("ssl_key_file")),
        ("ssl_key_password", params.get("ssl_key_password")),
        ("status_codes",     params.get("status_codes")),
        ("authtype",         params.get("authtype")),
        ("username",         params.get("username")),
        ("password",         params.get("password")),
        ("publickey",        params.get("publickey")),
        ("privatekey",       params.get("privatekey")),
        ("master_itemid",    params.get("master_itemid")),
    ]:
        if val is not None:
            if col in int_cols:
                args.append(int(val))
            elif col in nullable_int_cols:
                args.append(int(val) if val else None)
            else:
                args.append(str(val))
            fields.append(f"{col}=${len(args)}")

    if fields:
        args.append(int(itemid))
        await pool().execute(
            f"UPDATE items SET {', '.join(fields)} WHERE itemid=${len(args)}", *args
        )

    preprocessing = params.get("preprocessing")
    if preprocessing is not None:
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM item_preproc WHERE itemid=$1", int(itemid))
                for step_num, pp in enumerate(preprocessing, 1):
                    ppid = await next_id(conn, "item_preproc", "item_preprocid")
                    await conn.execute(
                        "INSERT INTO item_preproc "
                        "(item_preprocid,itemid,step,type,params,error_handler,error_handler_params) "
                        "VALUES ($1,$2,$3,$4,$5,$6,$7)",
                        ppid, int(itemid), step_num,
                        int(pp.get("type", 0)), str(pp.get("params", "")),
                        int(pp.get("error_handler", 0)), str(pp.get("error_handler_params", "")),
                    )

    tags_param = params.get("tags")
    if tags_param is not None:
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM item_tag WHERE itemid=$1", int(itemid))
                for tag in tags_param:
                    tagid = await next_id(conn, "item_tag", "itemtagid")
                    await conn.execute(
                        "INSERT INTO item_tag (itemtagid,itemid,tag,value) VALUES ($1,$2,$3,$4)",
                        tagid, int(itemid), str(tag.get("tag", "")), str(tag.get("value", "")),
                    )

    return {"itemids": [str(itemid)]}


@register("item.delete")
async def item_delete(params: dict, userid: int | None) -> dict:
    item_ids = params
    if isinstance(params, dict):
        item_ids = params.get("itemids", [])
    if isinstance(item_ids, (str, int)):
        item_ids = [item_ids]
    if not item_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemids required")

    ids = [int(i) for i in item_ids]

    rows = await pool().fetch(
        "SELECT itemid FROM items WHERE itemid=ANY($1::bigint[]) AND flags IN (0,4)", ids
    )
    if len(rows) != len(ids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    # prevent deleting templated items
    tmpl = await pool().fetch(
        "SELECT itemid FROM items WHERE itemid=ANY($1::bigint[]) AND templateid IS NOT NULL", ids
    )
    if tmpl:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot delete templated items")

    async with pool().acquire() as conn:
        async with conn.transaction():
            # cascade: history data, rtdata, functions
            for tbl in ("history", "history_uint", "history_str", "history_log", "history_text",
                        "trends", "trends_uint"):
                await conn.execute(f"DELETE FROM {tbl} WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_rtdata WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_rtname WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM functions WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_preproc WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_tag WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM items WHERE itemid=ANY($1::bigint[])", ids)

    return {"itemids": [str(i) for i in ids]}
