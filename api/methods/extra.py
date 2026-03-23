from __future__ import annotations
"""
Extra API methods needed for Grafana Zabbix plugin compatibility:
  application.get  — stub (removed in Zabbix 5.4+, returns [])
  valuemap.get     — value mappings
  user.get         — users list (with selectUsrgrps, role JOIN)
  role.get         — roles list
  proxy.get        — proxies list
"""
from ..db import pool
from ..jsonrpc import register
from .. import rbac


@register("application.get")
async def application_get(params: dict, userid: int | None) -> list:
    """Removed in Zabbix 5.4. Return empty list for backwards compatibility."""
    return []


@register("valuemap.get")
async def valuemap_get(params: dict, userid: int | None) -> list | dict:
    output         = params.get("output", "extend")
    valuemap_ids   = params.get("valuemapids")
    host_ids       = params.get("hostids")
    limit          = params.get("limit")
    preserve_keys  = params.get("preservekeys", False)
    select_mappings = params.get("selectMappings")

    where = []
    args: list = []

    if valuemap_ids:
        if isinstance(valuemap_ids, (str, int)):
            valuemap_ids = [valuemap_ids]
        args.append([int(i) for i in valuemap_ids])
        where.append(f"v.valuemapid = ANY(${len(args)}::bigint[])")

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(h) for h in host_ids])
        where.append(f"v.hostid = ANY(${len(args)}::bigint[])")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = f"SELECT v.valuemapid, v.hostid, v.name, v.uuid FROM valuemap v {where_sql} ORDER BY v.name"
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        d["valuemapid"] = str(d["valuemapid"])
        d["hostid"]     = str(d["hostid"])
        result[d["valuemapid"]] = d

    if select_mappings and result:
        vids = [int(k) for k in result]
        mrows = await pool().fetch(
            """SELECT valuemapid, value, newvalue, type, sortorder
               FROM valuemap_mapping WHERE valuemapid = ANY($1::bigint[])
               ORDER BY sortorder""",
            vids,
        )
        for mr in mrows:
            vid = str(mr["valuemapid"])
            result[vid].setdefault("mappings", []).append({
                "value":     mr["value"],
                "newvalue":  mr["newvalue"],
                "type":      str(mr["type"]),
                "sortorder": str(mr["sortorder"]),
            })

    if preserve_keys:
        return result
    return list(result.values())


@register("user.get")
async def user_get(params: dict, userid: int | None) -> list | dict:
    output           = params.get("output", "extend")
    user_ids         = params.get("userids")
    limit            = params.get("limit")
    preserve_keys    = params.get("preservekeys", False)
    select_usrgrps   = params.get("selectUsrgrps")   # truthy → attach groups
    select_role      = params.get("selectRole")       # truthy → attach role info

    where = []
    args: list = []

    # type=1 (User) can only see their own record
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 2:
        args.append(ctx.userid)
        where.append(f"u.userid = ${len(args)}")
    elif user_ids:
        if isinstance(user_ids, (str, int)):
            user_ids = [user_ids]
        args.append([int(i) for i in user_ids])
        where.append(f"u.userid = ANY(${len(args)}::bigint[])")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = f"""SELECT u.userid, u.username, u.name, u.surname, u.url, u.autologin, u.autologout,
                     u.lang, u.refresh, u.rows_per_page, u.theme, u.attempt_failed, u.attempt_ip,
                     u.attempt_clock, u.timezone, u.roleid, u.userdirectoryid, u.ts_provisioned,
                     r.name AS role_name, r.type AS role_type
              FROM users u
              LEFT JOIN role r ON r.roleid = u.roleid
              {where_sql} ORDER BY u.username"""
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        d["userid"]  = str(d["userid"])
        d["roleid"]  = str(d["roleid"]) if d.get("roleid") is not None else "0"
        d["userdirectoryid"] = str(d["userdirectoryid"]) if d.get("userdirectoryid") is not None else "0"
        d["ts_provisioned"]  = str(d["ts_provisioned"]) if d.get("ts_provisioned") is not None else "0"
        d["provisioned"] = "1" if d.get("ts_provisioned", "0") != "0" else "0"
        d["alias"] = d["username"]  # backwards compat
        result[d["userid"]] = d

    # Attach user groups if requested
    if select_usrgrps and result:
        uids = list(result.keys())
        grp_rows = await pool().fetch(
            """SELECT ug.userid, g.usrgrpid, g.name
               FROM users_groups ug
               JOIN usrgrp g ON g.usrgrpid = ug.usrgrpid
               WHERE ug.userid = ANY($1::bigint[])
               ORDER BY g.name""",
            [int(uid) for uid in uids],
        )
        for uid in uids:
            result[uid]["usrgrps"] = []
        for gr in grp_rows:
            uid_str = str(gr["userid"])
            if uid_str in result:
                result[uid_str]["usrgrps"].append({
                    "usrgrpid": str(gr["usrgrpid"]),
                    "name": gr["name"],
                })

    if preserve_keys:
        return result
    return list(result.values())


@register("role.get")
async def role_get(params: dict, userid: int | None) -> list | dict:
    rows = await pool().fetch("SELECT roleid, name, type FROM role ORDER BY type, name")
    return [{"roleid": str(r["roleid"]), "name": r["name"], "type": str(r["type"])} for r in rows]


@register("proxy.get")
async def proxy_get(params: dict, userid: int | None) -> list | dict:
    output        = params.get("output", "extend")
    proxy_ids     = params.get("proxyids")
    limit         = params.get("limit")
    preserve_keys = params.get("preservekeys", False)

    where = []
    args: list = []

    if proxy_ids:
        if isinstance(proxy_ids, (str, int)):
            proxy_ids = [proxy_ids]
        args.append([int(i) for i in proxy_ids])
        where.append(f"p.proxyid = ANY(${len(args)}::bigint[])")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = f"""
        SELECT p.proxyid, p.name, p.operating_mode, p.description,
               COALESCE(pr.lastaccess, 0) AS lastaccess,
               (SELECT COUNT(*) FROM hosts h
                WHERE h.proxyid = p.proxyid AND h.status < 2 AND h.flags = 0) AS hosts_count
        FROM proxy p
        LEFT JOIN proxy_rtdata pr ON pr.proxyid = p.proxyid
        {where_sql} ORDER BY p.name
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = {"proxyid": str(r["proxyid"]), "name": r["name"],
             "host": r["name"],  # backwards compat alias
             "operating_mode": str(r["operating_mode"]),
             "description": r["description"] or "",
             "lastaccess": str(r["lastaccess"]),
             "hosts_count": str(r["hosts_count"])}
        result[d["proxyid"]] = d

    if preserve_keys:
        return result
    return list(result.values())
