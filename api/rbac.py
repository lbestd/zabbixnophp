"""RBAC — roles and access rights, matching Zabbix 7.0 behaviour exactly.

user_type=1 (User):       limited methods + host permission filtering
user_type=2 (Admin):      most methods   + host permission filtering
user_type=3 (Super Admin): all methods   + no filtering

Permission model (Zabbix 7.0 hash-based sets):
  user_ugset(userid, ugsetid)          — user → user-group-set
  host_hgset(hostid, hgsetid)          — host → host-group-set
  permission(ugsetid, hgsetid, perm)   — 2=read, 3=read-write

  ugsetid=0 for non-super-admin → no host access (empty result).

API method gating:
  1. _METHOD_MIN_TYPE: hard min user_type per method (from PHP ACCESS_RULES).
  2. role_rule table: api.access=0 → deny all; api.mode + per-method list.
     Super admins (type=3) bypass role_rule checks entirely.
"""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from .db import pool
from .errors import ApiError, ERR_PERMISSIONS, ERR_NO_AUTH


# ─────────────────────────────── User context ────────────────────────────────

@dataclass
class UserCtx:
    userid:    int
    roleid:    int
    user_type: int   # 1=User, 2=Admin, 3=Super Admin  (from role.type)
    ugsetid:   int   # 0 = no host access for non-super-admin


_current: ContextVar[UserCtx | None] = ContextVar("_zbx_user_ctx", default=None)


def get_user_ctx() -> UserCtx | None:
    return _current.get()


def set_user_ctx(ctx: UserCtx | None) -> None:
    _current.set(ctx)


async def load_user_ctx(userid: int) -> UserCtx:
    row = await pool().fetchrow(
        """SELECT u.roleid, r.type AS user_type
           FROM users u JOIN role r ON r.roleid = u.roleid
           WHERE u.userid = $1""",
        userid,
    )
    if not row:
        raise ApiError(ERR_NO_AUTH, "Not authorised.", "")

    user_type = int(row["user_type"])
    roleid    = int(row["roleid"])
    ugsetid   = 0

    if user_type < 3:          # non-super-admin: look up ugsetid
        ug = await pool().fetchrow(
            "SELECT ugsetid FROM user_ugset WHERE userid = $1", userid
        )
        ugsetid = int(ug["ugsetid"]) if ug else 0

    return UserCtx(userid=userid, roleid=roleid, user_type=user_type, ugsetid=ugsetid)


# ─────────────────────────── Method min_user_type ────────────────────────────
# Source: PHP ACCESS_RULES constants in ui/include/classes/api/services/*.php
# 0=public, 1=User, 2=Admin, 3=Super Admin

_METHOD_MIN_TYPE: dict[str, int] = {
    # ── public (no auth) ──────────────────────────────────────────────────
    "apiinfo.version":           0,
    "user.login":                0,
    "user.checkAuthentication":  0,

    # ── type ≥ 1 (User) ───────────────────────────────────────────────────
    "user.get":                  1,
    "user.update":               1,   # extra self-only check in user.py
    "user.logout":               1,
    "host.get":                  1,
    "hostgroup.get":             1,
    "item.get":                  1,
    "trigger.get":               1,
    "template.get":              1,
    "discoveryrule.get":         1,
    "itemprototype.get":         1,
    "triggerprototype.get":      1,
    "graphprototype.get":        1,
    "problem.get":               1,
    "event.get":                 1,
    "event.acknowledge":         1,
    "history.get":               1,
    "trend.get":                 1,
    "usermacro.get":             1,
    "application.get":           1,
    "proxy.get":                 1,
    "valuemap.get":              1,
    "maintenance.get":           1,
    "action.get":                1,
    "usergroup.get":             1,
    "role.get":                  1,

    # ── type ≥ 2 (Admin) ──────────────────────────────────────────────────
    "host.create":               2,
    "host.update":               2,
    "host.delete":               2,
    "hostgroup.create":          2,
    "hostgroup.update":          2,
    "hostgroup.delete":          2,
    "item.create":               2,
    "item.update":               2,
    "item.delete":               2,
    "trigger.create":            2,
    "trigger.update":            2,
    "trigger.delete":            2,
    "template.create":           2,
    "template.update":           2,
    "template.delete":           2,
    "discoveryrule.create":      2,
    "discoveryrule.update":      2,
    "discoveryrule.delete":      2,
    "itemprototype.create":      2,
    "itemprototype.update":      2,
    "itemprototype.delete":      2,
    "triggerprototype.create":   2,
    "triggerprototype.update":   2,
    "triggerprototype.delete":   2,
    "usermacro.create":          2,
    "usermacro.update":          2,
    "usermacro.delete":          2,
    "globalmacro.get":           2,
    "globalmacro.create":        2,
    "globalmacro.update":        2,
    "globalmacro.delete":        2,
    "valuemap.create":           2,
    "valuemap.update":           2,
    "valuemap.delete":           2,
    "maintenance.create":        2,
    "maintenance.update":        2,
    "maintenance.delete":        2,
    "action.create":             2,
    "action.update":             2,
    "action.delete":             2,

    # ── type ≥ 3 (Super Admin) ────────────────────────────────────────────
    "user.create":               3,
    "user.delete":               3,
    "usergroup.create":          3,
    "usergroup.update":          3,
    "usergroup.delete":          3,
    "role.create":               3,
    "role.update":               3,
    "role.delete":               3,
    "proxy.create":              3,
    "proxy.update":              3,
    "proxy.delete":              3,
    "auditlog.get":              3,
}


async def check_method_access(ctx: UserCtx | None, method: str) -> None:
    """Raise ApiError(ERR_PERMISSIONS) if *ctx* may not call *method*."""
    min_type = _METHOD_MIN_TYPE.get(method, 1)
    if min_type == 0:
        return   # public method

    if ctx is None:
        raise ApiError(ERR_PERMISSIONS, "No permissions to call method.", "")

    if ctx.user_type < min_type:
        raise ApiError(ERR_PERMISSIONS, "No permissions to call method.", "")

    if ctx.user_type == 3:
        return   # super admin bypasses all role_rule checks

    # ── role_rule: api.access / api.mode / per-method list ───────────────
    rules = await pool().fetch(
        "SELECT name, value_int, value_str FROM role_rule "
        "WHERE roleid = $1 AND (name = 'api.access' OR name = 'api.mode' OR name = 'api') "
        "ORDER BY name",
        ctx.roleid,
    )

    api_access: int = 1   # default: enabled
    api_mode:   int = 0   # 0=DENY mode (deny list), 1=ALLOW mode (allow list)
    method_rules: list[str] = []

    for r in rules:
        n = r["name"]
        if n == "api.access":
            api_access = int(r["value_int"])
        elif n == "api.mode":
            api_mode = int(r["value_int"])
        elif n == "api" and r["value_str"]:
            method_rules.append(r["value_str"])

    if api_access == 0:
        raise ApiError(ERR_PERMISSIONS, "No permissions to call method.", "")

    if not method_rules:
        # DENY + empty list = allow all; ALLOW + empty list = deny all
        if api_mode == 1:
            raise ApiError(ERR_PERMISSIONS, "No permissions to call method.", "")
        return

    svc, _, meth = method.partition(".")

    def in_list(rule: str) -> bool:
        return (rule in ("*", "*.*")
                or rule == f"{svc}.*"
                or rule == f"*.{meth}"
                or rule == method)

    matched = any(in_list(r) for r in method_rules)
    if api_mode == 0 and matched:      # DENY mode: method is in deny list
        raise ApiError(ERR_PERMISSIONS, "No permissions to call method.", "")
    if api_mode == 1 and not matched:  # ALLOW mode: method not in allow list
        raise ApiError(ERR_PERMISSIONS, "No permissions to call method.", "")


# ──────────────────────── Host permission SQL helpers ────────────────────────
# Each helper appends ugsetid to *args* and returns a WHERE clause fragment.
# Use only when user_type < 3; super admin never needs these.

def _perm_subq(ugsetid_placeholder: str, perm_min: int) -> str:
    return (
        f"SELECT hh.hostid FROM host_hgset hh "
        f"JOIN permission p ON hh.hgsetid = p.hgsetid "
        f"WHERE p.ugsetid = {ugsetid_placeholder} AND p.permission >= {perm_min}"
    )


def host_perm_sql(args: list, ugsetid: int,
                  host_alias: str = "h", editable: bool = False) -> str:
    """WHERE fragment: restrict host_alias.hostid to accessible hosts."""
    args.append(ugsetid)
    return f"{host_alias}.hostid IN ({_perm_subq(f'${len(args)}', 3 if editable else 2)})"


def item_perm_sql(args: list, ugsetid: int,
                  item_alias: str = "i", editable: bool = False) -> str:
    """WHERE fragment: restrict item_alias.hostid to accessible hosts."""
    args.append(ugsetid)
    return f"{item_alias}.hostid IN ({_perm_subq(f'${len(args)}', 3 if editable else 2)})"


def trigger_perm_sql(args: list, ugsetid: int,
                     trigger_alias: str = "t", editable: bool = False) -> str:
    """WHERE fragment: restrict trigger via functions→items→hosts."""
    args.append(ugsetid)
    p = f"${len(args)}"
    pmin = 3 if editable else 2
    return (
        f"{trigger_alias}.triggerid IN ("
        f"SELECT DISTINCT f.triggerid FROM functions f "
        f"JOIN items i ON i.itemid = f.itemid "
        f"WHERE i.hostid IN ({_perm_subq(p, pmin)}))"
    )


def event_perm_sql(args: list, ugsetid: int,
                   event_alias: str = "e") -> str:
    """WHERE fragment: restrict event/problem via objectid=triggerid→functions→hosts."""
    args.append(ugsetid)
    p = f"${len(args)}"
    return (
        f"{event_alias}.objectid IN ("
        f"SELECT DISTINCT f.triggerid FROM functions f "
        f"JOIN items i ON i.itemid = f.itemid "
        f"WHERE i.hostid IN ({_perm_subq(p, 2)}))"
    )


def history_perm_sql(args: list, ugsetid: int,
                     history_alias: str = "h") -> str:
    """WHERE fragment: restrict history/trend items to accessible hosts."""
    args.append(ugsetid)
    p = f"${len(args)}"
    return (
        f"{history_alias}.itemid IN ("
        f"SELECT i.itemid FROM items i "
        f"WHERE i.hostid IN ({_perm_subq(p, 2)}))"
    )


def hostgroup_perm_sql(args: list, ugsetid: int) -> str:
    """WHERE fragment: restrict hstgrp to groups containing at least one accessible host."""
    args.append(ugsetid)
    p = f"${len(args)}"
    return (
        f"groupid IN ("
        f"SELECT hg.groupid FROM hosts_groups hg "
        f"JOIN host_hgset hh ON hh.hostid = hg.hostid "
        f"JOIN permission p ON p.hgsetid = hh.hgsetid "
        f"WHERE p.ugsetid = {p} AND p.permission >= 2)"
    )
