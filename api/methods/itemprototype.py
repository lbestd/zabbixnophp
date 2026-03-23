from __future__ import annotations
"""
itemprototype.get/create/update/delete — items.flags=2,
linked to LLD rules via item_discovery.parent_itemid.
"""
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY
from .item import _http_defaults

_ITEM_TYPE = {
    0:'Zabbix agent', 2:'Trapper', 5:'Internal', 7:'Active agent',
    10:'External', 11:'DB monitor', 12:'IPMI', 13:'SSH', 14:'Telnet',
    15:'Calculated', 17:'SNMP trap', 18:'Dependent', 19:'HTTP agent',
    20:'SNMP', 21:'Script',
}


@register("itemprototype.get")
async def itemprototype_get(params: dict, userid: int | None) -> list | str | dict:
    rule_ids          = params.get("discoveryids")
    proto_ids         = params.get("itemids")
    host_ids          = params.get("hostids")
    limit             = params.get("limit")
    count_output      = params.get("countOutput", False)
    preserve_keys     = params.get("preservekeys", False)
    select_preprocessing = params.get("selectPreprocessing")
    select_tags       = params.get("selectTags")

    where = ["i.flags = 2"]
    args: list = []

    if rule_ids:
        if isinstance(rule_ids, (str, int)):
            rule_ids = [rule_ids]
        args.append([int(x) for x in rule_ids])
        where.append(
            f"i.itemid IN (SELECT itemid FROM item_discovery WHERE parent_itemid=ANY(${len(args)}::bigint[]))"
        )

    if proto_ids:
        if isinstance(proto_ids, (str, int)):
            proto_ids = [proto_ids]
        args.append([int(x) for x in proto_ids])
        where.append(f"i.itemid = ANY(${len(args)}::bigint[])")

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(x) for x in host_ids])
        where.append(f"i.hostid = ANY(${len(args)}::bigint[])")

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(f"SELECT count(*) AS c FROM items i WHERE {where_sql}", *args)
        return str(row["c"])

    sql = f"""
        SELECT i.itemid, i.hostid, i.name, i.key_, i.type, i.status,
               i.value_type, i.units, i.delay, i.history, i.trends,
               i.description, i.flags, i.templateid, i.valuemapid,
               i.snmp_oid, i.params, i.trapper_hosts, i.logtimefmt,
               i.evaltype, i.formula, i.lifetime, i.lifetime_type,
               i.enabled_lifetime, i.enabled_lifetime_type,
               i.url, i.timeout, i.request_method, i.post_type, i.posts,
               i.headers, i.query_fields, i.retrieve_mode, i.follow_redirects, i.http_proxy,
               i.verify_peer, i.verify_host, i.ssl_cert_file, i.ssl_key_file, i.ssl_key_password,
               i.status_codes, i.output_format, i.allow_traps,
               i.authtype, i.username, i.password, i.publickey, i.privatekey,
               i.master_itemid, i.interfaceid, i.inventory_link,
               i.ipmi_sensor, i.jmx_endpoint, i.discover, i.uuid,
               COALESCE(rn.name_resolved, i.name) AS name_resolved,
               id.parent_itemid AS ruleid,
               ti.hostid AS templatehostid
        FROM items i
        LEFT JOIN item_rtname rn ON rn.itemid = i.itemid
        LEFT JOIN item_discovery id ON id.itemid = i.itemid
        LEFT JOIN items ti ON ti.itemid = i.templateid AND i.templateid != 0
        WHERE {where_sql}
        ORDER BY i.name
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("itemid","hostid","templateid","valuemapid","ruleid","master_itemid","interfaceid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["templatehostid"] = str(d["templatehostid"]) if d.get("templatehostid") is not None else "0"
        d["templateRuleid"] = "0"
        d["parameters"] = []
        result[d["itemid"]] = d

    # Resolve templateRuleid: for inherited prototypes, find the LLD rule in the template
    tpl_item_ids = [int(d["templateid"]) for d in result.values() if d.get("templateid") and d["templateid"] != "0"]
    if tpl_item_ids:
        trl_rows = await pool().fetch(
            "SELECT itemid, parent_itemid FROM item_discovery WHERE itemid = ANY($1::bigint[])",
            tpl_item_ids,
        )
        trl_map = {str(r["itemid"]): str(r["parent_itemid"]) for r in trl_rows}
        for d in result.values():
            d["templateRuleid"] = trl_map.get(d.get("templateid", "0"), "0")

    if select_tags and result:
        iids = [int(k) for k in result]
        tag_rows = await pool().fetch(
            "SELECT itemid, tag, value FROM item_tag WHERE itemid = ANY($1::bigint[])", iids,
        )
        for iid in result:
            result[iid]["tags"] = []
        for tr in tag_rows:
            iid = str(tr["itemid"])
            if iid in result:
                result[iid]["tags"].append({"tag": tr["tag"], "value": tr["value"]})

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
            if iid in result:
                result[iid]["preprocessing"].append({
                    "step": str(r["step"]),
                    "type": str(r["type"]),
                    "params": r["params"],
                    "error_handler": str(r["error_handler"]),
                    "error_handler_params": r["error_handler_params"],
                })

    if preserve_keys:
        return result
    return list(result.values())


@register("itemprototype.create")
async def itemprototype_create(params: dict, userid: int | None) -> dict:
    hostid     = params.get("hostid")
    ruleid     = params.get("ruleid")
    name       = str(params.get("name", "")).strip()
    key_       = str(params.get("key_", "")).strip()
    type_      = int(params.get("type", 0))
    value_type = int(params.get("value_type", 3))
    delay      = str(params.get("delay", "60s"))
    history    = str(params.get("history", "31d"))
    trends     = str(params.get("trends", "365d"))
    units      = str(params.get("units", ""))
    description = str(params.get("description", ""))
    status     = int(params.get("status", 0))
    discover   = int(params.get("discover", 0))

    if not hostid or not ruleid or not name or not key_:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostid, ruleid, name, key_ required")

    rule = await pool().fetchrow(
        "SELECT itemid FROM items WHERE itemid=$1 AND flags=1", int(ruleid)
    )
    if not rule:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "LLD rule not found")

    snmp_oid   = str(params.get("snmp_oid", ""))
    params_val = str(params.get("params", ""))
    trapper    = str(params.get("trapper_hosts", ""))
    ex         = _http_defaults(params)

    async with pool().acquire() as conn:
        async with conn.transaction():
            itemid = await next_id(conn, "items", "itemid")
            await conn.execute(
                """INSERT INTO items
                   (itemid, type, hostid, name, key_, delay, history, trends,
                    status, value_type, units, description, flags,
                    formula, logtimefmt, templateid, valuemapid,
                    authtype, username, password, publickey, privatekey,
                    inventory_link, evaltype, params, trapper_hosts,
                    snmp_oid, interfaceid, lifetime, lifetime_type,
                    enabled_lifetime, enabled_lifetime_type, discover, uuid,
                    url, timeout, request_method, post_type, posts, headers,
                    query_fields, retrieve_mode, follow_redirects, http_proxy,
                    verify_peer, verify_host, ssl_cert_file, ssl_key_file,
                    ssl_key_password, status_codes, output_format, allow_traps,
                    master_itemid)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                           2,'','',NULL,NULL,
                           $13,$14,$15,$16,$17,
                           0,0,$18,$19,$20,NULL,'30d',0,'0d',0,$40,'',
                           $21,$22,$23,$24,$25,$26,
                           $27,$28,$29,$30,
                           $31,$32,$33,$34,
                           $35,$36,$37,$38,
                           $39)""",
                itemid, type_, int(hostid), name, key_, delay, history, trends,
                status, value_type, units, description,
                ex["authtype"], ex["username"], ex["password"], ex["publickey"], ex["privatekey"],
                params_val, trapper, snmp_oid,
                ex["url"], ex["timeout"], ex["request_method"], ex["post_type"], ex["posts"], ex["headers"],
                ex["query_fields"], ex["retrieve_mode"], ex["follow_redirects"], ex["http_proxy"],
                ex["verify_peer"], ex["verify_host"], ex["ssl_cert_file"], ex["ssl_key_file"],
                ex["ssl_key_password"], ex["status_codes"], ex["output_format"], ex["allow_traps"],
                int(ex["master_itemid"]) if ex["master_itemid"] else None,
                discover,
            )
            disc_id = await next_id(conn, "item_discovery", "itemdiscoveryid")
            await conn.execute(
                "INSERT INTO item_discovery (itemdiscoveryid, itemid, parent_itemid, key_) VALUES ($1,$2,$3,$4)",
                disc_id, itemid, int(ruleid), key_,
            )
    return {"itemids": [str(itemid)]}


@register("itemprototype.update")
async def itemprototype_update(params: dict, userid: int | None) -> dict:
    itemid = params.get("itemid")
    if not itemid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemid required")

    row = await pool().fetchrow(
        "SELECT itemid, templateid FROM items WHERE itemid=$1 AND flags=2", int(itemid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")
    if row["templateid"]:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot update a templated item prototype")

    fields, args = [], []
    int_cols = {"type","value_type","status","discover","authtype","request_method","post_type",
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
        ("discover",         params.get("discover")),
        ("snmp_oid",         params.get("snmp_oid")),
        ("params",           params.get("params")),
        ("trapper_hosts",    params.get("trapper_hosts")),
        ("url",              params.get("url")),
        ("timeout",          params.get("timeout")),
        ("request_method",   params.get("request_method")),
        ("post_type",        params.get("post_type")),
        ("posts",            params.get("posts")),
        ("headers",          params.get("headers")),
        ("retrieve_mode",    params.get("retrieve_mode")),
        ("follow_redirects", params.get("follow_redirects")),
        ("http_proxy",       params.get("http_proxy")),
        ("verify_peer",      params.get("verify_peer")),
        ("verify_host",      params.get("verify_host")),
        ("authtype",         params.get("authtype")),
        ("username",         params.get("username")),
        ("password",         params.get("password")),
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


@register("itemprototype.delete")
async def itemprototype_delete(params: dict, userid: int | None) -> dict:
    item_ids = params if isinstance(params, list) else params.get("itemids", [])
    if isinstance(item_ids, (str, int)):
        item_ids = [item_ids]
    if not item_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemids required")

    ids = [int(i) for i in item_ids]

    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM item_discovery WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_preproc WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_tag WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM functions WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM items WHERE itemid=ANY($1::bigint[]) AND flags=2", ids)

    return {"itemids": [str(i) for i in ids]}
