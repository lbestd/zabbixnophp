from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_ENTITY


@register("maintenance.get")
async def maintenance_get(params: dict, userid: int | None) -> list | dict:
    maint_ids      = params.get("maintenanceids")
    limit          = params.get("limit")
    search         = params.get("search") or {}
    preserve_keys  = params.get("preservekeys", False)
    select_hosts   = params.get("selectHosts")
    select_groups  = params.get("selectGroups")
    select_tags    = params.get("selectTags")
    select_periods = params.get("selectTimeperiods")

    where = []
    args: list = []

    if maint_ids:
        if isinstance(maint_ids, (str, int)):
            maint_ids = [maint_ids]
        args.append([int(m) for m in maint_ids])
        where.append(f"maintenanceid = ANY(${len(args)}::bigint[])")

    if search.get("name"):
        args.append(f"%{search['name']}%")
        where.append(f"name ILIKE ${len(args)}")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = (f"SELECT maintenanceid, name, maintenance_type, description, "
           f"active_since, active_till, tags_evaltype FROM maintenances {where_sql} "
           f"ORDER BY name")
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        d["maintenanceid"] = str(d["maintenanceid"])
        d["active_since"]  = str(d["active_since"])
        d["active_till"]   = str(d["active_till"])
        result[d["maintenanceid"]] = d

    if not result:
        return {} if preserve_keys else []

    mid_list = [int(k) for k in result]

    if select_hosts:
        for mid in result:
            result[mid]["hosts"] = []
        host_rows = await pool().fetch(
            """SELECT mh.maintenanceid, h.hostid, h.name, h.host
               FROM maintenances_hosts mh
               JOIN hosts h ON h.hostid = mh.hostid
               WHERE mh.maintenanceid = ANY($1::bigint[])""",
            mid_list,
        )
        for r in host_rows:
            result[str(r["maintenanceid"])]["hosts"].append(
                {"hostid": str(r["hostid"]), "name": r["name"] or r["host"]}
            )

    if select_groups:
        for mid in result:
            result[mid]["groups"] = []
        grp_rows = await pool().fetch(
            """SELECT mg.maintenanceid, g.groupid, g.name
               FROM maintenances_groups mg
               JOIN hstgrp g ON g.groupid = mg.groupid
               WHERE mg.maintenanceid = ANY($1::bigint[])""",
            mid_list,
        )
        for r in grp_rows:
            result[str(r["maintenanceid"])]["groups"].append(
                {"groupid": str(r["groupid"]), "name": r["name"]}
            )

    if select_tags:
        for mid in result:
            result[mid]["tags"] = []
        tag_rows = await pool().fetch(
            "SELECT maintenanceid, tag, operator, value FROM maintenance_tag "
            "WHERE maintenanceid = ANY($1::bigint[])",
            mid_list,
        )
        for r in tag_rows:
            result[str(r["maintenanceid"])]["tags"].append(
                {"tag": r["tag"], "operator": str(r["operator"]), "value": r["value"]}
            )

    if select_periods:
        for mid in result:
            result[mid]["timeperiods"] = []
        period_rows = await pool().fetch(
            """SELECT mw.maintenanceid, t.timeperiodid, t.timeperiod_type,
                      t.every, t.month, t.dayofweek, t.day,
                      t.start_time, t.period, t.start_date
               FROM maintenances_windows mw
               JOIN timeperiods t ON t.timeperiodid = mw.timeperiodid
               WHERE mw.maintenanceid = ANY($1::bigint[])""",
            mid_list,
        )
        for r in period_rows:
            result[str(r["maintenanceid"])]["timeperiods"].append({
                "timeperiodid":   str(r["timeperiodid"]),
                "timeperiod_type": str(r["timeperiod_type"]),
                "every":          str(r["every"]),
                "month":          str(r["month"]),
                "dayofweek":      str(r["dayofweek"]),
                "day":            str(r["day"]),
                "start_time":     str(r["start_time"]),
                "period":         str(r["period"]),
                "start_date":     str(r["start_date"]),
            })

    if preserve_keys:
        return result
    return list(result.values())


async def _save_related(conn, mid: int, params: dict):
    """Save hosts, groups, tags, timeperiods for a maintenance."""

    host_ids = params.get("hostids")
    if host_ids is not None:
        await conn.execute(
            "DELETE FROM maintenances_hosts WHERE maintenanceid=$1", mid
        )
        for hid in host_ids:
            pk = await next_id(conn, "maintenances_hosts", "maintenance_hostid")
            await conn.execute(
                "INSERT INTO maintenances_hosts (maintenance_hostid, maintenanceid, hostid) "
                "VALUES ($1,$2,$3)",
                pk, mid, int(hid),
            )

    group_ids = params.get("groupids")
    if group_ids is not None:
        await conn.execute(
            "DELETE FROM maintenances_groups WHERE maintenanceid=$1", mid
        )
        for gid in group_ids:
            pk = await next_id(conn, "maintenances_groups", "maintenance_groupid")
            await conn.execute(
                "INSERT INTO maintenances_groups (maintenance_groupid, maintenanceid, groupid) "
                "VALUES ($1,$2,$3)",
                pk, mid, int(gid),
            )

    tags = params.get("tags")
    if tags is not None:
        await conn.execute(
            "DELETE FROM maintenance_tag WHERE maintenanceid=$1", mid
        )
        for tag in tags:
            tag_name = str(tag.get("tag", "")).strip()
            if not tag_name:
                continue
            pk = await next_id(conn, "maintenance_tag", "maintenancetagid")
            await conn.execute(
                "INSERT INTO maintenance_tag (maintenancetagid, maintenanceid, tag, operator, value) "
                "VALUES ($1,$2,$3,$4,$5)",
                pk, mid, tag_name, int(tag.get("operator", 2)), str(tag.get("value", "")),
            )

    timeperiods = params.get("timeperiods")
    if timeperiods is not None:
        # Delete old windows+periods
        old_tpids = await conn.fetch(
            "SELECT timeperiodid FROM maintenances_windows WHERE maintenanceid=$1", mid
        )
        await conn.execute(
            "DELETE FROM maintenances_windows WHERE maintenanceid=$1", mid
        )
        if old_tpids:
            await conn.execute(
                "DELETE FROM timeperiods WHERE timeperiodid = ANY($1::bigint[])",
                [r["timeperiodid"] for r in old_tpids],
            )
        for tp in timeperiods:
            tpid = await next_id(conn, "timeperiods", "timeperiodid")
            await conn.execute(
                """INSERT INTO timeperiods
                   (timeperiodid, timeperiod_type, every, month, dayofweek, day,
                    start_time, period, start_date)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                tpid,
                int(tp.get("timeperiod_type", 0)),
                int(tp.get("every", 1)),
                int(tp.get("month", 0)),
                int(tp.get("dayofweek", 0)),
                int(tp.get("day", 0)),
                int(tp.get("start_time", 0)),
                int(tp.get("period", 3600)),
                int(tp.get("start_date", 0)),
            )
            mwid = await next_id(conn, "maintenances_windows", "maintenance_timeperiodid")
            await conn.execute(
                "INSERT INTO maintenances_windows (maintenance_timeperiodid, maintenanceid, timeperiodid) "
                "VALUES ($1,$2,$3)",
                mwid, mid, tpid,
            )


@register("maintenance.create")
async def maintenance_create(params: dict, userid: int | None) -> dict:
    name = str(params.get("name", "")).strip()
    if not name:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "name required")

    mtype       = int(params.get("maintenance_type", 0))
    description = str(params.get("description", ""))
    since       = int(params.get("active_since", 0))
    till        = int(params.get("active_till", 0))
    tags_eval   = int(params.get("tags_evaltype", 0))

    async with pool().acquire() as conn:
        async with conn.transaction():
            mid = await next_id(conn, "maintenances", "maintenanceid")
            await conn.execute(
                """INSERT INTO maintenances
                   (maintenanceid, name, maintenance_type, description, active_since, active_till, tags_evaltype)
                   VALUES ($1,$2,$3,$4,$5,$6,$7)""",
                mid, name, mtype, description, since, till, tags_eval,
            )
            await _save_related(conn, mid, params)

    return {"maintenanceids": [str(mid)]}


@register("maintenance.update")
async def maintenance_update(params: dict, userid: int | None) -> dict:
    mid = params.get("maintenanceid")
    if not mid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "maintenanceid required")

    row = await pool().fetchrow("SELECT maintenanceid FROM maintenances WHERE maintenanceid=$1", int(mid))
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    fields, args = [], []
    for col, val, cast in [
        ("name",             params.get("name"),             None),
        ("maintenance_type", params.get("maintenance_type"), int),
        ("description",      params.get("description"),      None),
        ("active_since",     params.get("active_since"),     int),
        ("active_till",      params.get("active_till"),      int),
        ("tags_evaltype",    params.get("tags_evaltype"),    int),
    ]:
        if val is not None:
            args.append(cast(val) if cast else str(val))
            fields.append(f"{col}=${len(args)}")

    async with pool().acquire() as conn:
        async with conn.transaction():
            if fields:
                args.append(int(mid))
                await conn.execute(
                    f"UPDATE maintenances SET {', '.join(fields)} WHERE maintenanceid=${len(args)}", *args
                )
            await _save_related(conn, int(mid), params)

    return {"maintenanceids": [str(mid)]}


@register("maintenance.delete")
async def maintenance_delete(params: dict, userid: int | None) -> dict:
    ids = params if isinstance(params, list) else params.get("maintenanceids", [])
    if isinstance(ids, (str, int)):
        ids = [ids]
    if not ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "maintenanceids required")

    iids = [int(i) for i in ids]
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM maintenances WHERE maintenanceid=ANY($1::bigint[])", iids)

    return {"maintenanceids": [str(i) for i in iids]}
