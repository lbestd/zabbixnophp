"""
Zabbix-compatible ID generator using the `ids` table.
Must be called inside an open transaction.
"""


async def next_id(conn, table_name: str, field_name: str) -> int:
    row = await conn.fetchrow(
        "SELECT nextid FROM ids WHERE table_name=$1 AND field_name=$2 FOR UPDATE",
        table_name, field_name,
    )
    if row is None:
        max_row = await conn.fetchrow(
            f"SELECT COALESCE(MAX({field_name}), 0) AS m FROM {table_name}"
        )
        nextid = int(max_row["m"] or 0) + 1
        await conn.execute(
            "INSERT INTO ids (table_name, field_name, nextid) VALUES ($1, $2, $3)",
            table_name, field_name, nextid,
        )
    else:
        nextid = int(row["nextid"]) + 1
        await conn.execute(
            "UPDATE ids SET nextid=$1 WHERE table_name=$2 AND field_name=$3",
            nextid, table_name, field_name,
        )
    return nextid
