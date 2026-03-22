"""
graphprototype.get — graph prototypes (graphs linked to item prototypes).
graphs.flags doesn't exist; prototype graphs are linked via graphs_items → items.flags=2.
"""
from ..db import pool
from ..jsonrpc import register, ApiError, ERR_PARAMETERS

GRAPH_TYPE = {0: 'Normal', 1: 'Stacked', 2: 'Pie', 3: 'Exploded'}


@register("graphprototype.get")
async def graphprototype_get(params: dict, userid: int | None) -> list | str | dict:
    rule_ids      = params.get("discoveryids")
    host_ids      = params.get("hostids")
    limit         = params.get("limit")
    count_output  = params.get("countOutput", False)
    preserve_keys = params.get("preservekeys", False)
    select_items  = params.get("selectGraphItems")

    where = ["EXISTS (SELECT 1 FROM graphs_items gi JOIN items i ON i.itemid=gi.itemid WHERE gi.graphid=g.graphid AND i.flags=2)"]
    args: list = []

    if rule_ids:
        if isinstance(rule_ids, (str, int)):
            rule_ids = [rule_ids]
        args.append([int(x) for x in rule_ids])
        where.append(
            f"EXISTS (SELECT 1 FROM graphs_items gi"
            f"  JOIN item_discovery id ON id.itemid=gi.itemid"
            f"  WHERE gi.graphid=g.graphid AND id.parent_itemid=ANY(${len(args)}::bigint[]))"
        )

    if host_ids:
        if isinstance(host_ids, (str, int)):
            host_ids = [host_ids]
        args.append([int(x) for x in host_ids])
        where.append(
            f"EXISTS (SELECT 1 FROM graphs_items gi JOIN items i ON i.itemid=gi.itemid"
            f"  WHERE gi.graphid=g.graphid AND i.hostid=ANY(${len(args)}::bigint[]))"
        )

    where_sql = " AND ".join(where)

    if count_output:
        row = await pool().fetchrow(f"SELECT count(*) AS c FROM graphs g WHERE {where_sql}", *args)
        return str(row["c"])

    sql = f"""
        SELECT g.graphid, g.name, g.width, g.height, g.graphtype, g.templateid,
               g.show_legend, g.show_work_period, g.show_triggers, g.show_3d,
               g.percent_left, g.percent_right,
               g.yaxismin, g.yaxismax, g.ymin_type, g.ymax_type,
               g.ymin_itemid, g.ymax_itemid,
               g.flags, g.discover, g.uuid
        FROM graphs g
        WHERE {where_sql}
        ORDER BY g.name
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    rows = await pool().fetch(sql, *args)
    result = {}
    for r in rows:
        d = dict(r)
        d["graphid"]    = str(d["graphid"])
        d["templateid"] = str(d["templateid"]) if d.get("templateid") else "0"
        for k in ("ymin_itemid", "ymax_itemid"):
            d[k] = str(d[k]) if d.get(k) is not None else "0"
        result[d["graphid"]] = d

    if select_items and result:
        gids = [int(k) for k in result]
        irows = await pool().fetch(
            """SELECT gi.graphid, gi.itemid, gi.color, gi.drawtype, gi.sortorder,
                      i.name, i.key_, i.hostid
               FROM graphs_items gi JOIN items i ON i.itemid=gi.itemid
               WHERE gi.graphid=ANY($1::bigint[]) ORDER BY gi.sortorder""",
            gids,
        )
        for r in irows:
            result[str(r["graphid"])].setdefault("gitems", []).append({
                "itemid": str(r["itemid"]), "name": r["name"],
                "key_": r["key_"], "color": r["color"],
                "drawtype": str(r["drawtype"]),
            })

    if preserve_keys:
        return result
    return list(result.values())
