"""
Session management using Zabbix native sessions table.
Tokens are the 32-char sessionid stored in that table,
or 64-char raw API tokens looked up via SHA-512 in the token table.
"""
import hashlib
import os
import time
from .db import pool
from .config import SESSION_TTL


def _new_sid() -> str:
    return os.urandom(16).hex()  # 32 hex chars


async def create(userid: int) -> str:
    sid = _new_sid()
    now = int(time.time())
    await pool().execute(
        """INSERT INTO sessions (sessionid, userid, lastaccess, status, secret)
           VALUES ($1, $2, $3, 0, '')""",
        sid, userid, now,
    )
    return sid


async def get_userid(token: str) -> int | None:
    """Return userid for a valid session or API token."""
    if not token:
        return None
    if len(token) == 32:
        return await _get_userid_session(token)
    if len(token) == 64:
        return await _get_userid_apitoken(token)
    return None


async def _get_userid_session(token: str) -> int | None:
    now = int(time.time())
    row = await pool().fetchrow(
        "SELECT userid, lastaccess FROM sessions WHERE sessionid=$1 AND status=0",
        token,
    )
    if row is None:
        return None
    if now - row["lastaccess"] > SESSION_TTL:
        await pool().execute("DELETE FROM sessions WHERE sessionid=$1", token)
        return None
    await pool().execute(
        "UPDATE sessions SET lastaccess=$1 WHERE sessionid=$2", now, token
    )
    return row["userid"]


async def _get_userid_apitoken(token: str) -> int | None:
    token_hash = hashlib.sha512(token.encode()).hexdigest()
    now = int(time.time())
    row = await pool().fetchrow(
        "SELECT userid, expires_at FROM token WHERE token=$1 AND status=0",
        token_hash,
    )
    if row is None:
        return None
    if row["expires_at"] != 0 and now > row["expires_at"]:
        return None
    await pool().execute(
        "UPDATE token SET lastaccess=$1 WHERE token=$2", now, token_hash
    )
    return row["userid"]


async def delete(token: str) -> None:
    await pool().execute("DELETE FROM sessions WHERE sessionid=$1", token)
