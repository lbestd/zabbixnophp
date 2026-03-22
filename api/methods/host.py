from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY
from ..tags import build_tag_sql
from .. import rbac

# hosts.status: 0=monitored, 1=unmonitored
# hosts.flags: 0=plain, 4=discovered
_HOST_FIELDS = {
    "hostid", "host", "name", "status", "flags",
    "description", "maintenance_status", "maintenance_type",
    "inventory_mode",
}


_HOST_COLS_EXTEND = (
    "h.hostid, h.host, h.name, h.status, h.flags, h.description, "
    "h.maintenance_status, h.maintenance_type, h.maintenance_from, h.maintenanceid, "
    "h.proxyid, h.proxy_groupid, h.monitored_by, "
    "h.templateid, h.tls_connect, h.tls_accept, h.tls_issuer, h.tls_subject, "
    "h.uuid, h.vendor_name, h.vendor_version, h.custom_interfaces, "
    "h.ipmi_authtype, h.ipmi_privilege, h.ipmi_username, h.ipmi_password, "
    "COALESCE(hrd.active_available, 0) AS active_available, "
    "COALESCE(hi.inventory_mode, -1) AS inventory_mode, "
    "h.proxyid AS assigned_proxyid"
)


def _select_fields(output) -> str:
    if output in ("extend", None) or output == ["extend"]:
        return _HOST_COLS_EXTEND
    if isinstance(output, list):
        base = {f for f in output if f in _HOST_FIELDS}
        base.add("hostid")
        return ", ".join(f"h.{c}" for c in sorted(base))
    return "h.hostid, h.host, h.name, h.status"


@register("host.get")
async def host_get(params: dict, userid: int | None) -> list | str | dict:
    output       = params.get("output", "extend")
    count_output = params.get("countOutput", False)
    host_ids     = params.get("hostids")
    group_ids    = params.get("groupids")
    monitored    = params.get("monitored_hosts")   # truthy → status=0
    search       = params.get("search") or {}
    limit        = params.get("limit")
    offset       = params.get("offset", 0)
    preserve_keys = params.get("preservekeys", False)
    select_groups = params.get("selectGroups") or params.get("selectHostGroups")
    select_interfaces = params.get("selectInterfaces")
    select_tags  = params.get("selectTags")
    select_templates = params.get("selectParentTemplates")
    tags         = params.get("tags")
    evaltype     = params.get("evaltype", 0)
    filter_      = params.get("filter") or {}

    where = ["h.flags IN (0, 4)"]
    args: list = []

    if host_ids:
        # When querying specific hosts by ID, allow templates (status=3) too
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(i) for i in host_ids])
        where.append(f"h.hostid = ANY(${len(args)}::bigint[])")
    else:
        # General listing: exclude templates
        where.append("h.status IN (0, 1)")

    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(i) for i in group_ids])
        where.append(f"h.hostid IN (SELECT hostid FROM hosts_groups WHERE groupid = ANY(${len(args)}::bigint[]))")

    if monitored:
        where.append("h.status = 0")

    if filter_.get("status") is not None:
        statuses = filter_["status"] if isinstance(filter_["status"], list) else [filter_["status"]]
        args.append([int(s) for s in statuses])
        where.append(f"h.status = ANY(${len(args)}::int[])")

    if search.get("host"):
        args.append(f"%{search['host']}%")
        where.append(f"(h.host ILIKE ${len(args)} OR h.name ILIKE ${len(args)})")

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"h.name ILIKE ${len(args)}")

    tag_sql = build_tag_sql(tags, evaltype, args, "hostid", "host_tag", "h.hostid")
    if tag_sql:
        where.append(tag_sql)

    # ── host permission filter (non-super-admin) ──────────────────────────
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 3:
        if ctx.ugsetid == 0:
            return "0" if count_output else ({} if preserve_keys else [])
        editable = bool(params.get("editable"))
        where.append(rbac.host_perm_sql(args, ctx.ugsetid, editable=editable))

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(f"SELECT count(*) AS c FROM hosts h WHERE {where_sql}", *args)
        return str(row["c"])

    cols = _select_fields(output)
    sql = (f"SELECT {cols} FROM hosts h "
           f"LEFT JOIN host_rtdata hrd ON hrd.hostid=h.hostid "
           f"LEFT JOIN host_inventory hi ON hi.hostid=h.hostid "
           f"WHERE {where_sql} ORDER BY h.name")
    if limit:
        sql += f" LIMIT {int(limit)}"
    if offset:
        sql += f" OFFSET {int(offset)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        for k in ("proxyid", "proxy_groupid", "maintenanceid", "templateid"):
            if k in d:
                d[k] = str(d[k]) if d[k] is not None else "0"
        result[str(d["hostid"])] = d

    # enrich with groups
    if select_groups and result:
        for hid in result:
            result[hid]["groups"] = []
        grp_rows = await pool().fetch(
            """SELECT hg.hostid, g.groupid, g.name
               FROM hosts_groups hg
               JOIN hstgrp g ON g.groupid = hg.groupid
               WHERE hg.hostid = ANY($1::bigint[])""",
            [int(i) for i in result],
        )
        for r in grp_rows:
            result[str(r["hostid"])]["groups"].append(
                {"groupid": str(r["groupid"]), "name": r["name"]}
            )

    # enrich with tags
    if select_tags and result:
        for hid in result:
            result[hid]["tags"] = []
        tag_rows = await pool().fetch(
            "SELECT hostid, tag, value FROM host_tag WHERE hostid = ANY($1::bigint[])",
            [int(i) for i in result],
        )
        for tr in tag_rows:
            result[str(tr["hostid"])]["tags"].append({"tag": tr["tag"], "value": tr["value"]})

    # enrich with interfaces
    if select_interfaces and result:
        for hid in result:
            result[hid]["interfaces"] = []
        iface_rows = await pool().fetch(
            """SELECT interfaceid, hostid, main, type, useip, ip, dns, port, available, error
               FROM interface WHERE hostid = ANY($1::bigint[])""",
            [int(i) for i in result],
        )
        for r in iface_rows:
            result[str(r["hostid"])]["interfaces"].append({
                "interfaceid": str(r["interfaceid"]),
                "main": str(r["main"]),
                "type": str(r["type"]),
                "useip": str(r["useip"]),
                "ip": r["ip"],
                "dns": r["dns"],
                "port": r["port"],
                "available": str(r["available"]),
            })

    # enrich with parent templates
    if select_templates and result:
        for hid in result:
            result[hid]["parentTemplates"] = []
        tpl_rows = await pool().fetch(
            """SELECT ht.hostid, h.hostid AS templateid, h.host, h.name
               FROM hosts_templates ht
               JOIN hosts h ON h.hostid = ht.templateid
               WHERE ht.hostid = ANY($1::bigint[])""",
            [int(i) for i in result],
        )
        for r in tpl_rows:
            result[str(r["hostid"])]["parentTemplates"].append({
                "templateid": str(r["templateid"]),
                "host": r["host"],
                "name": r["name"],
            })

    if preserve_keys:
        return result
    return list(result.values())


@register("host.update")
async def host_update(params: dict, userid: int | None) -> dict:
    hostid = params.get("hostid")
    if not hostid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostid required")

    row = await pool().fetchrow(
        "SELECT hostid, status FROM hosts WHERE hostid=$1 AND status IN (0,1)", int(hostid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    fields, args = [], []
    for col, val, cast in [
        ("host",        params.get("host"),        None),
        ("name",        params.get("name") or params.get("visible_name"), None),
        ("status",      params.get("status"),       int),
        ("description", params.get("description"),  None),
    ]:
        if val is not None:
            args.append(cast(val) if cast else str(val))
            fields.append(f"{col}=${len(args)}")

    if fields:
        args.append(int(hostid))
        await pool().execute(
            f"UPDATE hosts SET {', '.join(fields)} WHERE hostid=${len(args)}", *args
        )

    # update groups if provided
    groups = params.get("groups")
    if groups is not None:
        gids = [int(g["groupid"] if isinstance(g, dict) else g) for g in groups]
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "DELETE FROM hosts_groups WHERE hostid=$1", int(hostid)
                )
                for gid in gids:
                    await conn.execute(
                        "INSERT INTO hosts_groups (hostgroupid, hostid, groupid) "
                        "VALUES ((SELECT COALESCE(MAX(hostgroupid),0)+1 FROM hosts_groups), $1, $2)",
                        int(hostid), gid,
                    )

    # templates_clear: unlink AND delete all inherited items/triggers/discovery rules
    templates_clear = params.get("templates_clear")
    if templates_clear:
        clear_tids = [int(t["templateid"] if isinstance(t, dict) else t) for t in templates_clear]
        async with pool().acquire() as conn:
            async with conn.transaction():
                # Delete items inherited from those templates
                # Items on host have templateid = itemid on the template
                tpl_itemids = await conn.fetch(
                    "SELECT itemid FROM items WHERE hostid = ANY($1::bigint[])",
                    clear_tids,
                )
                if tpl_itemids:
                    tid_list = [r["itemid"] for r in tpl_itemids]
                    await conn.execute(
                        "DELETE FROM items WHERE hostid=$1 AND templateid = ANY($2::bigint[])",
                        int(hostid), tid_list,
                    )
                # Delete LLD rules inherited from those templates
                await conn.execute(
                    """DELETE FROM items WHERE hostid=$1
                       AND templateid IN (
                           SELECT itemid FROM items WHERE hostid = ANY($2::bigint[]) AND flags=1
                       )""",
                    int(hostid), clear_tids,
                )
                # Delete triggers inherited from those templates
                tpl_trigids = await conn.fetch(
                    "SELECT triggerid FROM triggers WHERE flags=0 AND triggerid IN ("
                    "  SELECT triggerid FROM functions f JOIN items i ON i.itemid=f.itemid"
                    "  WHERE i.hostid = ANY($1::bigint[])"
                    ")",
                    clear_tids,
                )
                if tpl_trigids:
                    ttid_list = [r["triggerid"] for r in tpl_trigids]
                    await conn.execute(
                        "DELETE FROM triggers WHERE hostid=$1 AND templateid = ANY($2::bigint[])",
                        int(hostid), ttid_list,
                    )
                # Remove template links for cleared templates
                await conn.execute(
                    "DELETE FROM hosts_templates WHERE hostid=$1 AND templateid = ANY($2::bigint[])",
                    int(hostid), clear_tids,
                )

    # update templates if provided
    templates = params.get("templates")
    if templates is not None:
        from ..ids import next_id
        tids = [int(t["templateid"] if isinstance(t, dict) else t) for t in templates]
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "DELETE FROM hosts_templates WHERE hostid=$1", int(hostid)
                )
                for tid in tids:
                    htid = await next_id(conn, "hosts_templates", "hosttemplateid")
                    await conn.execute(
                        "INSERT INTO hosts_templates (hosttemplateid, hostid, templateid, link_type) "
                        "VALUES ($1,$2,$3,0)",
                        htid, int(hostid), tid,
                    )

    # update interfaces if provided
    interfaces = params.get("interfaces")
    if interfaces is not None:
        from ..ids import next_id
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM interface WHERE hostid=$1", int(hostid))
                for iface in interfaces:
                    ifid = await next_id(conn, "interface", "interfaceid")
                    await conn.execute(
                        """INSERT INTO interface
                           (interfaceid, hostid, main, type, useip, ip, dns, port, available, error)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'')""",
                        ifid, int(hostid),
                        int(iface.get("main", 1)),
                        int(iface.get("type", 1)),
                        int(iface.get("useip", 1)),
                        str(iface.get("ip", "127.0.0.1")),
                        str(iface.get("dns", "")),
                        str(iface.get("port", "10050")),
                    )

    # update tags if provided
    tags = params.get("tags")
    if tags is not None:
        from ..ids import next_id
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM host_tag WHERE hostid=$1", int(hostid))
                for tag in tags:
                    tag_name = str(tag.get("tag", "")).strip()
                    if not tag_name:
                        continue
                    tid = await next_id(conn, "host_tag", "hosttagid")
                    await conn.execute(
                        "INSERT INTO host_tag (hosttagid, hostid, tag, value) VALUES ($1,$2,$3,$4)",
                        tid, int(hostid), tag_name, str(tag.get("value", "")),
                    )

    return {"hostids": [str(hostid)]}


@register("host.create")
async def host_create(params: dict, userid: int | None) -> dict:
    host        = str(params.get("host", "")).strip()
    name        = str(params.get("name") or params.get("visible_name") or host).strip()
    status      = int(params.get("status", 0))
    description = str(params.get("description", ""))
    groups      = params.get("groups", [])
    interfaces  = params.get("interfaces", [])
    tags_param  = params.get("tags", [])

    if not host:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "host name required")
    if not groups:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "at least one group required")

    dup = await pool().fetchrow(
        "SELECT hostid FROM hosts WHERE host=$1 AND status IN (0,1)", host
    )
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f'Host "{host}" already exists')

    from ..ids import next_id
    import os, time

    async with pool().acquire() as conn:
        async with conn.transaction():
            hostid = await next_id(conn, "hosts", "hostid")
            await conn.execute(
                """INSERT INTO hosts
                   (hostid, host, name, status, description, flags,
                    ipmi_authtype, ipmi_privilege, ipmi_username, ipmi_password,
                    maintenance_status, maintenance_type, maintenance_from,
                    tls_connect, tls_accept, tls_issuer, tls_subject)
                   VALUES ($1,$2,$3,$4,$5,0,-1,2,'','',0,0,0,1,1,'','')""",
                hostid, host, name, status, description,
            )
            # groups
            gids = [int(g["groupid"] if isinstance(g, dict) else g) for g in groups]
            for gid in gids:
                hgid = await next_id(conn, "hosts_groups", "hostgroupid")
                await conn.execute(
                    "INSERT INTO hosts_groups (hostgroupid, hostid, groupid) VALUES ($1,$2,$3)",
                    hgid, hostid, gid,
                )
            # interfaces
            for iface in interfaces:
                ifid = await next_id(conn, "interface", "interfaceid")
                await conn.execute(
                    """INSERT INTO interface
                       (interfaceid, hostid, main, type, useip, ip, dns, port, available, error)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'')""",
                    ifid, hostid,
                    int(iface.get("main", 1)),
                    int(iface.get("type", 1)),
                    int(iface.get("useip", 1)),
                    str(iface.get("ip", "127.0.0.1")),
                    str(iface.get("dns", "")),
                    str(iface.get("port", "10050")),
                )
            # tags
            for tag in tags_param:
                tag_name = str(tag.get("tag", "")).strip()
                if not tag_name:
                    continue
                tid = await next_id(conn, "host_tag", "hosttagid")
                await conn.execute(
                    "INSERT INTO host_tag (hosttagid, hostid, tag, value) VALUES ($1,$2,$3,$4)",
                    tid, hostid, tag_name, str(tag.get("value", "")),
                )

    return {"hostids": [str(hostid)]}


@register("host.delete")
async def host_delete(params: dict, userid: int | None) -> dict:
    host_ids = params if isinstance(params, list) else params.get("hostids", [])
    if isinstance(host_ids, (str, int)):
        host_ids = [host_ids]
    if not host_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "hostids required")
    ids = [int(i) for i in host_ids]

    # verify all are real hosts (not templates)
    rows = await pool().fetch(
        "SELECT hostid FROM hosts WHERE hostid=ANY($1::bigint[]) AND status IN (0,1)", ids
    )
    if len(rows) != len(ids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    async with pool().acquire() as conn:
        async with conn.transaction():
            # get all itemids for these hosts
            item_rows = await conn.fetch(
                "SELECT itemid, value_type FROM items WHERE hostid=ANY($1::bigint[])", ids
            )
            item_ids = [r["itemid"] for r in item_rows]

            if item_ids:
                for tbl in ("history","history_uint","history_str","history_log","history_text",
                            "trends","trends_uint"):
                    await conn.execute(f"DELETE FROM {tbl} WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM item_rtdata WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM item_rtname WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM item_preproc WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM item_tag WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM item_discovery WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM functions WHERE itemid=ANY($1::bigint[])", item_ids)
                await conn.execute("DELETE FROM items WHERE itemid=ANY($1::bigint[])", item_ids)

            # triggers linked to these hosts
            trig_rows = await conn.fetch(
                """SELECT DISTINCT t.triggerid FROM triggers t
                   JOIN functions f ON f.triggerid=t.triggerid
                   JOIN items i ON i.itemid=f.itemid
                   WHERE i.hostid=ANY($1::bigint[])""", ids
            )
            trig_ids = [r["triggerid"] for r in trig_rows]
            if trig_ids:
                await conn.execute("DELETE FROM trigger_tag WHERE triggerid=ANY($1::bigint[])", trig_ids)
                await conn.execute("DELETE FROM trigger_depends WHERE triggerid_down=ANY($1::bigint[]) OR triggerid_up=ANY($1::bigint[])", trig_ids)
                await conn.execute("DELETE FROM trigger_discovery WHERE triggerid=ANY($1::bigint[])", trig_ids)
                await conn.execute("DELETE FROM functions WHERE triggerid=ANY($1::bigint[])", trig_ids)
                await conn.execute("DELETE FROM triggers WHERE triggerid=ANY($1::bigint[])", trig_ids)

            await conn.execute("DELETE FROM interface WHERE hostid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM hosts_groups WHERE hostid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM host_tag WHERE hostid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM hostmacro WHERE hostid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM host_inventory WHERE hostid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM host_hgset WHERE hostid=ANY($1::bigint[])", ids)
            await conn.execute("DELETE FROM hosts WHERE hostid=ANY($1::bigint[])", ids)

    return {"hostids": [str(i) for i in ids]}
