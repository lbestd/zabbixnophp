"""
Shared tag-filtering helper for host.get, item.get, trigger.get, event.get, problem.get.

tags param format: [{tag, value, operator}]
  operator: 0=contains(default), 1=equals, 2=does not contain, 3=does not equal,
            4=exists, 5=does not exist
evaltype: 0=AND/OR, 1=OR, 2=AND
"""


def build_tag_filter(tags, evaltype, args: list, alias: str = "obj") -> str | None:
    """
    Returns a SQL fragment (or None if no tags).
    alias — the table alias for the main object (e.g. "h" for hosts, "i" for items, "t" for triggers)
    The id column name is inferred from context via id_col param.
    """
    return None  # placeholder — see build_tag_sql below


def build_tag_sql(tags, evaltype, args: list, id_col: str, tag_table: str, fk_col: str) -> str | None:
    """
    Build a SQL EXISTS / NOT EXISTS fragment for tag filtering.

    id_col   — column in tag_table that links back to parent (e.g. 'hostid', 'itemid', 'triggerid')
    tag_table — e.g. 'host_tag', 'item_tag', 'trigger_tag', 'problem_tag'
    fk_col   — the id column in the outer query (e.g. 'h.hostid')
    evaltype 0 = AND/OR: for same tag name → OR; across different names → AND
    evaltype 1 = OR: any condition matches
    evaltype 2 = AND: all conditions must match
    """
    if not tags:
        return None

    conditions = []
    for t in tags:
        tag_name = str(t.get("tag", ""))
        tag_val  = str(t.get("value", ""))
        op       = int(t.get("operator", 0))

        if op == 4:  # exists (tag name present, any value)
            args.append(tag_name)
            n = len(args)
            conditions.append(
                f"EXISTS (SELECT 1 FROM {tag_table} tt WHERE tt.{id_col}={fk_col} AND tt.tag=${n})"
            )
        elif op == 5:  # does not exist
            args.append(tag_name)
            n = len(args)
            conditions.append(
                f"NOT EXISTS (SELECT 1 FROM {tag_table} tt WHERE tt.{id_col}={fk_col} AND tt.tag=${n})"
            )
        elif op == 1:  # equals
            args.append(tag_name); args.append(tag_val)
            n = len(args)
            conditions.append(
                f"EXISTS (SELECT 1 FROM {tag_table} tt WHERE tt.{id_col}={fk_col} AND tt.tag=${n-1} AND tt.value=${n})"
            )
        elif op == 3:  # does not equal
            args.append(tag_name); args.append(tag_val)
            n = len(args)
            conditions.append(
                f"NOT EXISTS (SELECT 1 FROM {tag_table} tt WHERE tt.{id_col}={fk_col} AND tt.tag=${n-1} AND tt.value=${n})"
            )
        elif op == 2:  # does not contain
            args.append(tag_name); args.append(f"%{tag_val}%")
            n = len(args)
            conditions.append(
                f"NOT EXISTS (SELECT 1 FROM {tag_table} tt WHERE tt.{id_col}={fk_col} AND tt.tag=${n-1} AND tt.value ILIKE ${n})"
            )
        else:  # 0 = contains (default)
            args.append(tag_name); args.append(f"%{tag_val}%")
            n = len(args)
            conditions.append(
                f"EXISTS (SELECT 1 FROM {tag_table} tt WHERE tt.{id_col}={fk_col} AND tt.tag=${n-1} AND tt.value ILIKE ${n})"
            )

    if not conditions:
        return None

    ev = int(evaltype) if evaltype is not None else 0
    joiner = " OR " if ev == 1 else " AND "
    return "(" + joiner.join(conditions) + ")"
