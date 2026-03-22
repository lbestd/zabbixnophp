from ..db import pool
from ..jsonrpc import register

ACTION_LABEL = {0: 'Add', 1: 'Update', 2: 'Delete', 3: 'Logout',
                4: 'Login', 5: 'Failed login', 6: 'Logout', 7: 'Execute'}
RESOURCE_LABEL = {0: 'User', 1: 'Zabbix configuration', 2: 'Media type', 3: 'Host',
                  4: 'Action', 5: 'Graph prototype', 6: 'User group', 7: 'Trigger',
                  8: 'Graph', 9: 'Host group', 10: 'Item', 11: 'Image', 12: 'Value map',
                  13: 'IT service', 14: 'Map', 15: 'Setting', 16: 'Maintenance',
                  17: 'Script', 18: 'Proxy', 19: 'Discovery rule', 20: 'Scenario',
                  21: 'Authentication', 22: 'Template', 23: 'Macro', 25: 'Dashboard',
                  26: 'Correlation', 27: 'Module', 28: 'Token', 29: 'Report',
                  30: 'SLA', 31: 'Role', 32: 'Auth token', 33: 'Scheduled report',
                  36: 'MFA'}


@register("auditlog.get")
async def auditlog_get(params: dict, userid: int | None) -> list:
    user_ids      = params.get("userids")
    action_filter = params.get("action")
    restype       = params.get("resourcetype")
    time_from     = params.get("time_from")
    time_till     = params.get("time_till")
    limit         = params.get("limit", 50)

    where = []
    args: list = []

    if user_ids:
        if isinstance(user_ids, (str, int)):
            user_ids = [user_ids]
        args.append([int(u) for u in user_ids])
        where.append(f"userid = ANY(${len(args)}::bigint[])")

    if action_filter is not None:
        args.append(int(action_filter))
        where.append(f"action = ${len(args)}")

    if restype is not None:
        args.append(int(restype))
        where.append(f"resourcetype = ${len(args)}")

    if time_from:
        args.append(int(time_from))
        where.append(f"clock >= ${len(args)}")

    if time_till:
        args.append(int(time_till))
        where.append(f"clock <= ${len(args)}")

    where_sql = "WHERE " + " AND ".join(where) if where else ""
    sql = (f"SELECT auditid, userid, username, clock, ip, action, resourcetype, "
           f"resourceid, resourcename, details FROM auditlog {where_sql} "
           f"ORDER BY clock DESC LIMIT {int(limit)}")

    rows = await pool().fetch(sql, *args)
    result = []
    for r in rows:
        d = dict(r)
        d["userid"]     = str(d["userid"]) if d.get("userid") is not None else "0"
        d["resourceid"] = str(d["resourceid"]) if d.get("resourceid") is not None else "0"
        d["action_name"]   = ACTION_LABEL.get(d["action"], str(d["action"]))
        d["resource_name"] = RESOURCE_LABEL.get(d["resourcetype"], str(d["resourcetype"]))
        result.append(d)
    return result
