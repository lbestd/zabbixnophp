from __future__ import annotations
import time
import bcrypt
from ..db import pool
from ..ids import next_id
from ..jsonrpc import register, ApiError, ERR_PARAMETERS, ERR_NO_AUTH, ERR_PERMISSIONS, ERR_NO_ENTITY
from .. import session as sess
from .. import rbac

# Zabbix user types
USER_TYPE_REGULAR    = 1
USER_TYPE_POWER      = 2
USER_TYPE_SUPER_ADMIN = 3

# Zabbix passwd is bcrypt (stored as $2y$ — PHP compat, identical to $2b$)
def _check_password(plain: str, hashed: str) -> bool:
    # PHP uses $2y$, Python bcrypt uses $2b$ — they are identical
    hashed_b = hashed.replace("$2y$", "$2b$").encode()
    return bcrypt.checkpw(plain.encode(), hashed_b)


async def _get_user(username: str) -> dict | None:
    row = await pool().fetchrow(
        """SELECT u.userid, u.username, u.passwd, u.name, u.surname,
                  u.attempt_failed, u.attempt_clock, u.roleid,
                  r.type AS role_type
           FROM users u
           LEFT JOIN role r ON r.roleid = u.roleid
           WHERE u.username = $1""",
        username,
    )
    return dict(row) if row else None


@register("user.login")
async def login(params: dict, userid: int | None) -> str:
    username = params.get("username") or params.get("user", "")
    password = params.get("password") or params.get("Password", "")
    if not username or not password:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "username and password are required")

    user = await _get_user(username)
    if user is None or not _check_password(password, user["passwd"]):
        raise ApiError(ERR_NO_AUTH, "Login name or password is incorrect.", "")

    # Reset failed attempts on success
    await pool().execute(
        "UPDATE users SET attempt_failed=0 WHERE userid=$1", user["userid"]
    )
    return await sess.create(user["userid"])


@register("user.logout")
async def logout(params: dict, userid: int | None) -> bool:
    # token comes through dispatcher; we need the raw token
    # We delete via userid — all sessions for this user, or just resolve current
    # The dispatcher already validated the token; delete by userid is safe enough
    await pool().execute("DELETE FROM sessions WHERE userid=$1 AND status=0", userid)
    return True


@register("user.create")
async def user_create(params: dict, userid: int | None) -> dict:
    username = str(params.get("username", "")).strip()
    password = str(params.get("passwd", "")).strip()
    if not username or not password:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "username and passwd required")

    name    = str(params.get("name", ""))
    surname = str(params.get("surname", ""))
    roleid  = int(params.get("roleid", 1))

    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode().replace("$2b$", "$2y$")

    usrgrps = params.get("usrgrps", [])
    grp_ids = [int(g["usrgrpid"]) for g in usrgrps if g.get("usrgrpid")]

    async with pool().acquire() as conn:
        async with conn.transaction():
            uid = await next_id(conn, "users", "userid")
            await conn.execute(
                """INSERT INTO users (userid, username, name, surname, passwd, roleid,
                   url, autologin, autologout, lang, refresh, theme,
                   attempt_failed, attempt_ip, attempt_clock, rows_per_page, timezone,
                   userdirectoryid, ts_provisioned)
                   VALUES ($1,$2,$3,$4,$5,$6,'',0,'15m','default','30s','default',0,'',0,50,'default',NULL,0)""",
                uid, username, name, surname, hashed, roleid,
            )
            if grp_ids:
                await conn.executemany(
                    "INSERT INTO users_groups (id, usrgrpid, userid) VALUES ($1,$2,$3)",
                    [(await next_id(conn, "users_groups", "id"), gid, uid) for gid in grp_ids],
                )
    return {"userids": [str(uid)]}


@register("user.update")
async def user_update(params: dict, userid: int | None) -> dict:
    uid = params.get("userid")
    if not uid:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "userid required")

    # type=1 (User) can only update themselves
    ctx = rbac.get_user_ctx()
    if ctx and ctx.user_type < 2 and int(uid) != ctx.userid:
        raise ApiError(ERR_PERMISSIONS, "No permissions to referred object.", "")

    row = await pool().fetchrow("SELECT userid FROM users WHERE userid=$1", int(uid))
    if not row:
        raise ApiError(ERR_NO_ENTITY, "No permissions to referred object.", "")

    fields, args = [], []
    for col, val, cast in [
        ("username",       params.get("username"),       None),
        ("name",           params.get("name"),           None),
        ("surname",        params.get("surname"),        None),
        ("roleid",         params.get("roleid"),         int),
        ("attempt_failed", params.get("attempt_failed"), int),
    ]:
        if val is not None:
            args.append(cast(val) if cast else str(val))
            fields.append(f"{col}=${len(args)}")

    if params.get("passwd"):
        hashed = bcrypt.hashpw(str(params["passwd"]).encode(), bcrypt.gensalt()).decode().replace("$2b$", "$2y$")
        args.append(hashed)
        fields.append(f"passwd=${len(args)}")

    if fields:
        args.append(int(uid))
        await pool().execute(f"UPDATE users SET {', '.join(fields)} WHERE userid=${len(args)}", *args)

    # Update group memberships if provided
    if "usrgrps" in params:
        grp_ids = [int(g["usrgrpid"]) for g in params["usrgrps"] if g.get("usrgrpid")]
        async with pool().acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM users_groups WHERE userid=$1", int(uid))
                for gid in grp_ids:
                    iid = await next_id(conn, "users_groups", "id")
                    await conn.execute(
                        "INSERT INTO users_groups (id, usrgrpid, userid) VALUES ($1,$2,$3)",
                        iid, gid, int(uid),
                    )

    return {"userids": [str(uid)]}


@register("user.delete")
async def user_delete(params: dict, userid: int | None) -> dict:
    ids = params if isinstance(params, list) else params.get("userids", [])
    if isinstance(ids, (str, int)):
        ids = [ids]
    if not ids:
        raise ApiError(ERR_PARAMETERS, "Invalid params.", "userids required")

    iids = [int(i) for i in ids]
    async with pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM users_groups WHERE userid=ANY($1::bigint[])", iids)
            await conn.execute("DELETE FROM sessions WHERE userid=ANY($1::bigint[])", iids)
            await conn.execute("DELETE FROM users WHERE userid=ANY($1::bigint[])", iids)

    return {"userids": [str(i) for i in iids]}


@register("user.checkAuthentication")
async def check_authentication(params: dict, userid: int | None) -> dict:
    # Real Zabbix: sessionid comes from params (method is public — no auth required).
    # Also accept token already resolved by dispatcher as fallback.
    token = params.get("sessionid") or params.get("token") or ""
    resolved = await sess.get_userid(token) if token else userid
    if not resolved:
        raise ApiError(ERR_NO_AUTH, "Not authorised.", "")
    row = await pool().fetchrow(
        """SELECT u.userid, u.username, u.name, u.surname, u.lang, u.theme,
                  u.autologin, u.autologout, u.refresh, u.rows_per_page,
                  u.timezone, u.roleid, r.type AS role_type
           FROM users u
           LEFT JOIN role r ON r.roleid = u.roleid
           WHERE u.userid = $1""",
        resolved,
    )
    if row is None:
        raise ApiError(ERR_NO_AUTH, "Not authorised.", "")
    d = dict(row)
    d["type"] = d.pop("role_type") or USER_TYPE_REGULAR
    return d
