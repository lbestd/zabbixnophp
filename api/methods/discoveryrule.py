"""
discoveryrule.get/create/update/delete — LLD rules (items.flags=1).
Also serves filter conditions via item_condition and lld_macro_path.
"""
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY


@register("discoveryrule.get")
async def discoveryrule_get(params: dict, userid: int | None) -> list | str | dict:
    host_ids      = params.get("hostids")
    item_ids      = params.get("itemids")
    limit         = params.get("limit")
    count_output  = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    select_filter         = params.get("selectFilter")
    select_lld_macro_paths = params.get("selectLLDMacroPaths")
    select_preprocessing  = params.get("selectPreprocessing")
    select_tags           = params.get("selectTags")

    where = ["i.flags = 1"]
    args: list = []

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(x) for x in host_ids])
        where.append(f"i.hostid = ANY(${len(args)}::bigint[])")

    if item_ids:
        if isinstance(item_ids, (str, int)):
            item_ids = [item_ids]
        args.append([int(x) for x in item_ids])
        where.append(f"i.itemid = ANY(${len(args)}::bigint[])")

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(f"SELECT count(*) AS c FROM items i WHERE {where_sql}", *args)
        return str(row["c"])

    sql = f"""
        SELECT i.itemid, i.hostid, i.name, i.key_, i.type, i.status,
               i.delay, i.lifetime, i.lifetime_type, i.enabled_lifetime, i.enabled_lifetime_type,
               i.description, i.flags, i.templateid, i.evaltype, i.formula, i.params,
               i.snmp_oid, i.interfaceid, i.authtype, i.username, i.password,
               i.publickey, i.privatekey, i.logtimefmt, i.trapper_hosts,
               i.url, i.timeout, i.request_method, i.post_type, i.posts,
               i.headers, i.query_fields, i.retrieve_mode, i.follow_redirects, i.http_proxy,
               i.verify_peer, i.verify_host, i.ssl_cert_file, i.ssl_key_file, i.ssl_key_password,
               i.status_codes, i.output_format, i.allow_traps,
               i.master_itemid, i.ipmi_sensor, i.jmx_endpoint,
               i.history, i.trends, i.units, i.value_type, i.valuemapid, i.inventory_link,
               i.discover, i.uuid,
               COALESCE(rd.state, 0)  AS state,
               COALESCE(rd.error, '') AS error,
               COALESCE(rn.name_resolved, i.name) AS name_resolved
        FROM items i
        LEFT JOIN item_rtdata rd ON rd.itemid = i.itemid
        LEFT JOIN item_rtname rn ON rn.itemid = i.itemid
        WHERE {where_sql}
        ORDER BY i.name
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("itemid", "hostid", "templateid", "valuemapid", "interfaceid", "master_itemid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        d["parameters"] = []
        result[d["itemid"]] = d

    if select_filter and result:
        for rid in result:
            result[rid].setdefault("filter", {
                "evaltype": result[rid].get("evaltype", "0"),
                "formula": result[rid].get("formula", ""),
                "conditions": [],
            })

    if select_lld_macro_paths and result:
        for rid in result:
            result[rid].setdefault("lld_macro_paths", [])

    if (select_filter or select_lld_macro_paths) and result:
        ruleids = [int(k) for k in result]

        if select_filter:
            cond_rows = await pool().fetch(
                """SELECT itemid, item_conditionid, operator, macro, value
                   FROM item_condition WHERE itemid = ANY($1::bigint[])
                   ORDER BY itemid, item_conditionid""",
                ruleids,
            )
            for r in cond_rows:
                rid = str(r["itemid"])
                result[rid].setdefault("filter", {"evaltype": result[rid].get("evaltype", 0),
                                                   "formula": result[rid].get("formula", ""),
                                                   "conditions": []})
                result[rid]["filter"]["conditions"].append({
                    "item_conditionid": str(r["item_conditionid"]),
                    "operator": str(r["operator"]),
                    "macro": r["macro"],
                    "value": r["value"],
                })

        if select_lld_macro_paths:
            mp_rows = await pool().fetch(
                "SELECT itemid, lld_macro_pathid, lld_macro, path FROM lld_macro_path WHERE itemid = ANY($1::bigint[])",
                ruleids,
            )
            for r in mp_rows:
                rid = str(r["itemid"])
                result[rid].setdefault("lld_macro_paths", []).append({
                    "lld_macro_pathid": str(r["lld_macro_pathid"]),
                    "lld_macro": r["lld_macro"],
                    "path": r["path"],
                })

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

    if preserve_keys:
        return result
    return list(result.values())


@register("discoveryrule.create")
async def discoveryrule_create(params: dict, userid: int | None) -> dict:
    hostid     = params.get("hostid")
    name       = str(params.get("name", "")).strip()
    key_       = str(params.get("key_", "")).strip()
    type_      = int(params.get("type", 0))
    delay      = str(params.get("delay", "1h"))
    lifetime   = str(params.get("lifetime", "30d"))
    status     = int(params.get("status", 0))
    description = str(params.get("description", ""))

    if not hostid or not name or not key_:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostid, name and key_ required")

    dup = await pool().fetchrow(
        "SELECT itemid FROM items WHERE hostid=$1 AND key_=$2 AND flags=1",
        int(hostid), key_,
    )
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f'Rule with key "{key_}" already exists')

    async with pool().acquire() as conn:
        async with conn.transaction():
            itemid = await next_id(conn, "items", "itemid")
            await conn.execute(
                """INSERT INTO items
                   (itemid, type, hostid, name, key_, delay, history, trends,
                    status, value_type, units, description, flags, lifetime,
                    formula, logtimefmt, templateid, valuemapid,
                    authtype, username, password, publickey, privatekey,
                    inventory_link, evaltype, params, trapper_hosts,
                    snmp_oid, interfaceid, lifetime_type, enabled_lifetime,
                    enabled_lifetime_type, discover, uuid)
                   VALUES ($1,$2,$3,$4,$5,$6,'0','0',$7,4,'',
                           $8,1,$9,'','',NULL,NULL,0,'','','','',0,0,'','','',NULL,0,'0d',0,0,'')""",
                itemid, type_, int(hostid), name, key_, delay,
                status, description, lifetime,
            )
    return {"itemids": [str(itemid)]}


@register("discoveryrule.update")
async def discoveryrule_update(params: dict, userid: int | None) -> dict:
    itemid = params.get("itemid")
    if not itemid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemid required")

    row = await pool().fetchrow(
        "SELECT itemid, templateid FROM items WHERE itemid=$1 AND flags=1", int(itemid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")
    if row["templateid"]:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "Cannot update a templated LLD rule")

    fields, args = [], []
    for col, val, cast in [
        ("name",          params.get("name"),          None),
        ("key_",          params.get("key_"),           None),
        ("type",          params.get("type"),           int),
        ("delay",         params.get("delay"),          None),
        ("lifetime",      params.get("lifetime"),       None),
        ("status",        params.get("status"),         int),
        ("description",   params.get("description"),    None),
        ("snmp_oid",      params.get("snmp_oid"),       None),
        ("params",        params.get("params"),         None),
        ("trapper_hosts", params.get("trapper_hosts"),  None),
        ("authtype",      params.get("authtype"),       int),
        ("username",      params.get("username"),       None),
        ("password",      params.get("password"),       None),
        ("publickey",     params.get("publickey"),      None),
        ("privatekey",    params.get("privatekey"),     None),
        ("interfaceid",   params.get("interfaceid"),    lambda v: int(v) if v else None),
    ]:
        if val is not None:
            args.append(cast(val) if cast else str(val))
            fields.append(f"{col}=${len(args)}")

    filter_obj = params.get("filter")
    if filter_obj is not None:
        evaltype = int(filter_obj.get("evaltype", 0))
        formula  = str(filter_obj.get("formula", ""))
        fields.append(f"evaltype=${len(args)+1}")
        args.append(evaltype)
        fields.append(f"formula=${len(args)+1}")
        args.append(formula)

    if fields:
        args.append(int(itemid))
        await pool().execute(
            f"UPDATE items SET {', '.join(fields)} WHERE itemid=${len(args)}", *args
        )

    async with pool().acquire() as conn:
        async with conn.transaction():
            if filter_obj is not None:
                conditions = filter_obj.get("conditions", [])
                await conn.execute(
                    "DELETE FROM item_condition WHERE itemid=$1", int(itemid)
                )
                for cond in conditions:
                    cid = await next_id(conn, "item_condition", "item_conditionid")
                    await conn.execute(
                        "INSERT INTO item_condition (item_conditionid, itemid, operator, macro, value) "
                        "VALUES ($1,$2,$3,$4,$5)",
                        cid, int(itemid),
                        int(cond.get("operator", 8)),
                        str(cond.get("macro", "")).upper(),
                        str(cond.get("value", "")),
                    )

            lld_macro_paths = params.get("lld_macro_paths")
            if lld_macro_paths is not None:
                await conn.execute(
                    "DELETE FROM lld_macro_path WHERE itemid=$1", int(itemid)
                )
                for mp in lld_macro_paths:
                    mid = await next_id(conn, "lld_macro_path", "lld_macro_pathid")
                    await conn.execute(
                        "INSERT INTO lld_macro_path (lld_macro_pathid, itemid, lld_macro, path) "
                        "VALUES ($1,$2,$3,$4)",
                        mid, int(itemid),
                        str(mp.get("lld_macro", "")).upper(),
                        str(mp.get("path", "")),
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

    return {"itemids": [str(itemid)]}


@register("discoveryrule.delete")
async def discoveryrule_delete(params: dict, userid: int | None) -> dict:
    item_ids = params if isinstance(params, list) else params.get("itemids", [])
    if isinstance(item_ids, (str, int)):
        item_ids = [item_ids]
    if not item_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "itemids required")

    ids = [int(i) for i in item_ids]

    rows = await pool().fetch(
        "SELECT itemid FROM items WHERE itemid=ANY($1::bigint[]) AND flags=1", ids
    )
    if len(rows) != len(ids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    async with pool().acquire() as conn:
        async with conn.transaction():
            # delete all prototypes and discovered items linked to these rules
            proto_ids = await conn.fetch(
                "SELECT itemid FROM item_discovery WHERE parent_itemid=ANY($1::bigint[])", ids
            )
            all_item_ids = ids + [r["itemid"] for r in proto_ids]

            for tbl in ("history","history_uint","history_str","history_log","history_text",
                        "trends","trends_uint"):
                await conn.execute(f"DELETE FROM {tbl} WHERE itemid=ANY($1::bigint[])", all_item_ids)
            await conn.execute("DELETE FROM item_rtdata WHERE itemid=ANY($1::bigint[])", all_item_ids)
            await conn.execute("DELETE FROM item_rtname WHERE itemid=ANY($1::bigint[])", all_item_ids)
            await conn.execute("DELETE FROM item_discovery WHERE parent_itemid=ANY($1::bigint[]) OR itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM item_condition WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM lld_macro_path WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM lld_override WHERE itemid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM functions WHERE itemid=ANY($1::bigint[])", all_item_ids)
            await conn.execute("DELETE FROM item_preproc WHERE itemid=ANY($1::bigint[])", all_item_ids)
            await conn.execute("DELETE FROM item_tag WHERE itemid=ANY($1::bigint[])", all_item_ids)
            await conn.execute("DELETE FROM items WHERE itemid=ANY($1::bigint[])", all_item_ids)

    return {"itemids": [str(i) for i in ids]}
