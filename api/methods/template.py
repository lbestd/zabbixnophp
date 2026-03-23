from __future__ import annotations
"""
template.get/create/update/delete — Zabbix templates (hosts with status=3).
"""
from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY


@register("template.get")
async def template_get(params: dict, userid: int | None) -> list:
    search        = params.get("search") or {}
    limit         = params.get("limit", 500)
    count_output  = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    sel_groups    = params.get("selectGroups")
    sel_parents   = params.get("selectParentTemplates")
    sel_hosts     = params.get("selectHosts")

    where = ["h.status = 3"]
    args: list = []

    q = search.get("name") or search.get("host")
    if q:
        args.append(f"%{q}%")
        where.append(f"(h.host ILIKE ${len(args)} OR h.name ILIKE ${len(args)})")

    template_ids = params.get("templateids")
    if template_ids:
        if isinstance(template_ids, (str, int)):
            template_ids = [template_ids]
        args.append([int(i) for i in template_ids])
        where.append(f"h.hostid = ANY(${len(args)}::bigint[])")

    group_ids = params.get("groupids")
    if group_ids:
        if isinstance(group_ids, (str, int)):
            group_ids = [group_ids]
        args.append([int(i) for i in group_ids])
        where.append(f"EXISTS(SELECT 1 FROM hosts_groups hg WHERE hg.hostid=h.hostid AND hg.groupid=ANY(${len(args)}::bigint[]))")

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(
            f"SELECT count(*) AS c FROM hosts h WHERE {where_sql}", *args
        )
        return str(row["c"])

    sql = f"""
        SELECT h.hostid AS templateid, h.host, h.name,
          (SELECT count(*) FROM items i
           WHERE i.hostid=h.hostid AND i.flags=0 AND i.status=0) AS item_count,
          (SELECT count(*) FROM items i
           WHERE i.hostid=h.hostid AND i.flags=1) AS discovery_count,
          (SELECT count(*) FROM triggers t
           JOIN functions f ON f.triggerid=t.triggerid
           JOIN items i ON i.itemid=f.itemid
           WHERE i.hostid=h.hostid AND t.flags=0) AS trigger_count,
          (SELECT count(*) FROM hosts lh
           JOIN hosts_templates ht ON ht.templateid=h.hostid
           WHERE lh.hostid=ht.hostid AND lh.status!=3) AS host_count
        FROM hosts h
        WHERE {where_sql}
        ORDER BY h.name
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = {
            "templateid":     str(r["templateid"]),
            "host":           r["host"],
            "name":           r["name"],
            "item_count":     str(r["item_count"] or 0),
            "trigger_count":  str(r["trigger_count"] or 0),
            "discovery_count": str(r["discovery_count"] or 0),
            "host_count":     str(r["host_count"] or 0),
        }
        result[d["templateid"]] = d

    if sel_groups and result:
        tids = [int(k) for k in result]
        rows2 = await pool().fetch(
            """SELECT hg.hostid, g.groupid, g.name
               FROM hosts_groups hg JOIN hstgrp g ON g.groupid=hg.groupid
               WHERE hg.hostid=ANY($1::bigint[]) ORDER BY g.name""",
            tids,
        )
        for tid in result:
            result[tid]["groups"] = []
        for r in rows2:
            tid = str(r["hostid"])
            if tid in result:
                result[tid]["groups"].append({"groupid": str(r["groupid"]), "name": r["name"]})

    if sel_parents and result:
        tids = [int(k) for k in result]
        rows3 = await pool().fetch(
            """SELECT ht.hostid, h2.hostid AS templateid, h2.host, h2.name
               FROM hosts_templates ht JOIN hosts h2 ON h2.hostid=ht.templateid
               WHERE ht.hostid=ANY($1::bigint[]) ORDER BY h2.name""",
            tids,
        )
        for tid in result:
            result[tid]["parentTemplates"] = []
        for r in rows3:
            tid = str(r["hostid"])
            if tid in result:
                result[tid]["parentTemplates"].append({
                    "templateid": str(r["templateid"]),
                    "host": r["host"],
                    "name": r["name"],
                })

    if sel_hosts and result:
        tids = [int(k) for k in result]
        rows4 = await pool().fetch(
            """SELECT ht.templateid, h2.hostid, h2.host, h2.name
               FROM hosts_templates ht JOIN hosts h2 ON h2.hostid=ht.hostid
               WHERE ht.templateid=ANY($1::bigint[]) AND h2.status!=3 ORDER BY h2.name""",
            tids,
        )
        for tid in result:
            result[tid]["hosts"] = []
        for r in rows4:
            tid = str(r["templateid"])
            if tid in result:
                result[tid]["hosts"].append({"hostid": str(r["hostid"]), "name": r["name"] or r["host"]})

    out = list(result.values())
    if preserve_keys:
        return result
    return out


@register("template.create")
async def template_create(params: dict, userid: int | None) -> dict:
    host   = str(params.get("host", "")).strip()
    name   = str(params.get("name") or host).strip()
    groups = params.get("groups", [])

    if not host:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "host (technical name) required")
    if not groups:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "at least one group required")

    dup = await pool().fetchrow(
        "SELECT hostid FROM hosts WHERE host=$1 AND status=3", host
    )
    if dup:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", f'Template "{host}" already exists')

    from ..ids import next_id

    gids   = [int(g["groupid"] if isinstance(g, dict) else g) for g in groups]
    tpls   = params.get("templates", [])
    t_ids  = [int(t["templateid"] if isinstance(t, dict) else t) for t in tpls]

    async with pool().acquire() as conn:
        async with conn.transaction():
            hostid = await next_id(conn, "hosts", "hostid")
            await conn.execute(
                """INSERT INTO hosts
                   (hostid, host, name, status, description, flags,
                    ipmi_authtype, ipmi_privilege, ipmi_username, ipmi_password,
                    maintenance_status, maintenance_type, maintenance_from,
                    tls_connect, tls_accept, tls_issuer, tls_subject)
                   VALUES ($1,$2,$3,3,'',0,-1,2,'','',0,0,0,1,1,'','')""",
                hostid, host, name,
            )
            for gid in gids:
                hgid = await next_id(conn, "hosts_groups", "hostgroupid")
                await conn.execute(
                    "INSERT INTO hosts_groups (hostgroupid, hostid, groupid) VALUES ($1,$2,$3)",
                    hgid, hostid, gid,
                )
            for tid in t_ids:
                htid = await next_id(conn, "hosts_templates", "hosttemplateid")
                await conn.execute(
                    "INSERT INTO hosts_templates (hosttemplateid, hostid, templateid, link_type) "
                    "VALUES ($1,$2,$3,0)",
                    htid, hostid, tid,
                )

    return {"templateids": [str(hostid)]}


@register("template.update")
async def template_update(params: dict, userid: int | None) -> dict:
    templateid = params.get("templateid")
    if not templateid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "templateid required")

    row = await pool().fetchrow(
        "SELECT hostid FROM hosts WHERE hostid=$1 AND status=3", int(templateid)
    )
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    # scalar fields
    fields, args = [], []
    for col, val in [("host", params.get("host")), ("name", params.get("name"))]:
        if val is not None:
            args.append(str(val).strip())
            fields.append(f"{col}=${len(args)}")
    if fields:
        args.append(int(templateid))
        await pool().execute(
            f"UPDATE hosts SET {', '.join(fields)} WHERE hostid=${len(args)}", *args
        )

    # groups
    groups = params.get("groups")
    if groups is not None:
        gids = [int(g["groupid"] if isinstance(g, dict) else g) for g in groups]
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM hosts_groups WHERE hostid=$1", int(templateid))
                for gid in gids:
                    await conn.execute(
                        "INSERT INTO hosts_groups (hostgroupid, hostid, groupid) "
                        "VALUES ((SELECT COALESCE(MAX(hostgroupid),0)+1 FROM hosts_groups),$1,$2)",
                        int(templateid), gid,
                    )

    # parent templates
    templates = params.get("templates")
    if templates is not None:
        from ..ids import next_id
        t_ids = [int(t["templateid"] if isinstance(t, dict) else t) for t in templates]
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "DELETE FROM hosts_templates WHERE hostid=$1", int(templateid)
                )
                for tid in t_ids:
                    htid = await next_id(conn, "hosts_templates", "hosttemplateid")
                    await conn.execute(
                        "INSERT INTO hosts_templates (hosttemplateid, hostid, templateid, link_type) "
                        "VALUES ($1,$2,$3,0)",
                        htid, int(templateid), tid,
                    )

    return {"templateids": [str(templateid)]}


@register("template.delete")
async def template_delete(params: dict, userid: int | None) -> dict:
    template_ids = params if isinstance(params, list) else params.get("templateids", [])
    if isinstance(template_ids, (str, int)):
        template_ids = [template_ids]
    if not template_ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "templateids required")

    ids = [int(i) for i in template_ids]

    rows = await pool().fetch(
        "SELECT hostid FROM hosts WHERE hostid=ANY($1::bigint[]) AND status=3", ids
    )
    if len(rows) != len(ids):
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    async with pool().acquire() as conn:
        async with conn.transaction():
            # Unlink from hosts
            await conn.execute(
                "DELETE FROM hosts_templates WHERE templateid=ANY($1::bigint[])", ids
            )
            # Delete template items/triggers/etc cascade via FK
            await conn.execute(
                "DELETE FROM hosts WHERE hostid=ANY($1::bigint[]) AND status=3", ids
            )

    return {"templateids": [str(i) for i in ids]}
