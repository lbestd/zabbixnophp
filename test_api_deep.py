#!/usr/bin/env python3
"""
Deep API comparison: real Zabbix 7.0 (port 80) vs our implementation (port 8090).

Tests not just key presence but:
  - actual field values match
  - ID fields are always strings
  - sort order is correct
  - countOutput matches list length
  - filter/search params narrow results correctly
  - selectXxx always returns the key (even when empty)
  - preservekeys produces dict with string keys
  - limit is respected
  - unknown IDs return empty list
  - nested object structure is correct

Usage: python3 test_api_deep.py [--user Admin] [--password zabbix]
"""
from __future__ import annotations
import argparse, json, sys, time, urllib.request, urllib.error
from typing import Any

REAL = "http://localhost/api_jsonrpc.php"
OUR  = "http://localhost:8090/api_jsonrpc.php"

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
CYAN   = "\033[36m"
DIM    = "\033[2m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

_passes = _fails = 0


# ── Transport ─────────────────────────────────────────────────────────────────

def rpc(url: str, method: str, params: dict, token: str | None = None) -> Any:
    body = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    if token:
        body["auth"] = token
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": {"code": e.code, "message": str(e)}}
    except Exception as e:
        return {"error": {"code": -1, "message": str(e)}}


def real(method, params, tok):  return rpc(REAL, method, params, tok)
def ours(method, params, tok):  return rpc(OUR,  method, params, tok)
def res(r): return r.get("result") if isinstance(r, dict) else None
def err(r): return r.get("error")  if isinstance(r, dict) else None


# ── Assertion helpers ─────────────────────────────────────────────────────────

_section = ""

def section(name: str):
    global _section
    _section = name
    print(f"\n{BOLD}{'─'*60}{RESET}")
    print(f"{BOLD}  {name}{RESET}")
    print(f"{BOLD}{'─'*60}{RESET}")


def ok(msg: str):
    global _passes
    _passes += 1
    print(f"  {GREEN}✓{RESET} {msg}")


def fail(msg: str, detail: str = ""):
    global _fails
    _fails += 1
    d = f"\n    {DIM}{detail}{RESET}" if detail else ""
    print(f"  {RED}✗{RESET} {msg}{d}")


def warn(msg: str):
    print(f"  {YELLOW}~{RESET} {msg}")


def assert_ok(cond: bool, msg: str, detail: str = ""):
    if cond:
        ok(msg)
    else:
        fail(msg, detail)


# ── Type validators ───────────────────────────────────────────────────────────

def is_str_id(v) -> bool:
    """Zabbix API always returns IDs as string digits."""
    return isinstance(v, str) and v.isdigit()


def check_ids_are_strings(obj: dict, id_fields: list[str], label: str):
    for f in id_fields:
        if f not in obj:
            continue
        v = obj[f]
        assert_ok(is_str_id(v), f"{label}.{f} is string digit (got {v!r})")


def check_list_ids(items: list, id_fields: list[str], label: str, sample: int = 3):
    for item in items[:sample]:
        check_ids_are_strings(item, id_fields, label)


# ── Value comparison helpers ──────────────────────────────────────────────────

def compare_values(real_item: dict, our_item: dict, fields: list[str], label: str):
    """Compare specific field values between two objects."""
    for f in fields:
        rv = real_item.get(f)
        ov = our_item.get(f)
        if rv is None and ov is None:
            continue
        assert_ok(rv == ov, f"{label}.{f} value matches",
                  f"real={rv!r}  ours={ov!r}")


def compare_sorted_lists(real_list: list, our_list: list, key: str, label: str):
    """Verify two lists have the same order by key."""
    r_keys = [str(x.get(key, "")) for x in real_list]
    o_keys = [str(x.get(key, "")) for x in our_list]
    assert_ok(r_keys == o_keys, f"{label} sort order matches by {key!r}",
              f"real={r_keys[:5]}…  ours={o_keys[:5]}…")


def compare_counts(real_r: Any, our_r: Any, label: str):
    r, o = res(real_r), res(our_r)
    if isinstance(r, str) and isinstance(o, str):
        assert_ok(r == o, f"{label} countOutput matches (real={r} ours={o})")
    elif isinstance(r, list) and isinstance(o, list):
        assert_ok(len(r) == len(o), f"{label} list length matches (real={len(r)} ours={len(o)})")


def check_select_key(items: list, key: str, label: str):
    """Every item must have the select key, even if empty list."""
    if not items:
        warn(f"{label}: empty list, skipping {key!r} check")
        return
    missing = [i for i, x in enumerate(items) if key not in x]
    assert_ok(not missing, f"{label}: all items have '{key}' key",
              f"missing at indices {missing[:5]}")


def check_select_structure(items: list, key: str, required_subkeys: list[str], label: str):
    """Every item in the select array must have the required sub-keys."""
    check_select_key(items, key, label)
    for item in items:
        arr = item.get(key, [])
        if not isinstance(arr, list):
            fail(f"{label}.{key} is list (got {type(arr).__name__})")
            return
        for sub in arr[:3]:
            for sk in required_subkeys:
                assert_ok(sk in sub, f"{label}.{key}[*].{sk!r} exists",
                          f"got keys: {list(sub.keys())}")
            break  # one sub-item per parent is enough


# ── Main test runner ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user",     default="Admin")
    parser.add_argument("--password", default="zabbix")
    args = parser.parse_args()

    print(f"\n{BOLD}Logging in to both APIs…{RESET}")
    rt = rpc(REAL, "user.login", {"username": args.user, "password": args.password}).get("result")
    ot = rpc(OUR,  "user.login", {"username": args.user, "password": args.password}).get("result")
    if not rt:
        print(f"{RED}Cannot login to real Zabbix{RESET}"); sys.exit(1)
    if not ot:
        print(f"{RED}Cannot login to our API{RESET}"); sys.exit(1)
    print(f"  real={rt[:12]}…  ours={ot[:12]}…")

    # ── discover fixtures ────────────────────────────────────────────────────
    print(f"\n{BOLD}Discovering fixtures…{RESET}")

    hosts_r    = res(real("host.get", {"output": ["hostid","name","host","status"], "limit": 5}, rt)) or []
    host_ids   = [h["hostid"] for h in hosts_r]
    host_id    = host_ids[0] if host_ids else None

    groups_r   = res(real("hostgroup.get", {"output": ["groupid","name"], "real_hosts": True, "limit": 5}, rt)) or []
    group_ids  = [g["groupid"] for g in groups_r]
    group_id   = group_ids[0] if group_ids else None

    items_r    = res(real("item.get", {"output": ["itemid","name","key_","value_type","status"], "hostids": host_ids, "limit": 10}, rt)) or []
    item_ids   = [i["itemid"] for i in items_r]
    item_id    = item_ids[0] if item_ids else None

    trigs_r    = res(real("trigger.get", {"output": ["triggerid","description","priority","status"], "hostids": host_ids, "limit": 10}, rt)) or []
    trig_ids   = [t["triggerid"] for t in trigs_r]
    trig_id    = trig_ids[0] if trig_ids else None

    events_r   = res(real("event.get", {"output": ["eventid","name","severity"], "source": 0, "object": 0, "limit": 5}, rt)) or []
    event_ids  = [e["eventid"] for e in events_r]

    probs_r    = res(real("problem.get", {"output": "extend", "limit": 5}, rt)) or []
    prob_ids   = [p["eventid"] for p in probs_r]

    drules_r   = res(real("discoveryrule.get", {"output": ["itemid","name"], "hostids": host_ids, "limit": 3}, rt)) or []
    drule_ids  = [r["itemid"] for r in drules_r]
    drule_id   = drule_ids[0] if drule_ids else None

    for label, lst in [("hosts", host_ids), ("groups", group_ids), ("items", item_ids),
                       ("triggers", trig_ids), ("events", event_ids), ("problems", prob_ids),
                       ("discovery rules", drule_ids)]:
        print(f"  {label}: {lst}")

    # ═════════════════════════════════════════════════════════════════════════
    # 1. VALUE IDENTITY
    # ═════════════════════════════════════════════════════════════════════════
    section("1. Value identity — same IDs, same field values")

    # hostgroup
    rr = res(real("hostgroup.get", {"groupids": group_ids, "output": "extend"}, rt)) or []
    or_ = res(ours("hostgroup.get", {"groupids": group_ids, "output": "extend"}, ot)) or []
    r_map = {x["groupid"]: x for x in rr}
    o_map = {x["groupid"]: x for x in or_}
    for gid in group_ids[:3]:
        if gid in r_map and gid in o_map:
            compare_values(r_map[gid], o_map[gid], ["groupid","name","flags","uuid"], f"hostgroup[{gid}]")

    # host
    rr = res(real("host.get", {"hostids": host_ids, "output": "extend"}, rt)) or []
    or_ = res(ours("host.get", {"hostids": host_ids, "output": "extend"}, ot)) or []
    r_map = {x["hostid"]: x for x in rr}
    o_map = {x["hostid"]: x for x in or_}
    for hid in host_ids[:3]:
        if hid in r_map and hid in o_map:
            compare_values(r_map[hid], o_map[hid],
                ["hostid","host","name","status","flags","description",
                 "maintenance_status","monitored_by","uuid","vendor_name"],
                f"host[{hid}]")

    # item
    if item_ids:
        rr  = res(real("item.get", {"itemids": item_ids, "output": "extend"}, rt)) or []
        or_ = res(ours("item.get", {"itemids": item_ids, "output": "extend"}, ot)) or []
        r_map = {x["itemid"]: x for x in rr}
        o_map = {x["itemid"]: x for x in or_}
        for iid in item_ids[:3]:
            if iid in r_map and iid in o_map:
                compare_values(r_map[iid], o_map[iid],
                    ["itemid","hostid","name","key_","type","value_type","status",
                     "delay","history","units","uuid","flags"],
                    f"item[{iid}]")

    # trigger
    if trig_ids:
        rr  = res(real("trigger.get", {"triggerids": trig_ids, "output": "extend"}, rt)) or []
        or_ = res(ours("trigger.get", {"triggerids": trig_ids, "output": "extend"}, ot)) or []
        r_map = {x["triggerid"]: x for x in rr}
        o_map = {x["triggerid"]: x for x in or_}
        for tid in trig_ids[:3]:
            if tid in r_map and tid in o_map:
                compare_values(r_map[tid], o_map[tid],
                    ["triggerid","description","expression","priority","status",
                     "value","flags","uuid","opdata","event_name"],
                    f"trigger[{tid}]")

    # event
    if event_ids:
        rr  = res(real("event.get", {"eventids": event_ids, "output": "extend"}, rt)) or []
        or_ = res(ours("event.get", {"eventids": event_ids, "output": "extend"}, ot)) or []
        r_map = {x["eventid"]: x for x in rr}
        o_map = {x["eventid"]: x for x in or_}
        for eid in event_ids[:3]:
            if eid in r_map and eid in o_map:
                compare_values(r_map[eid], o_map[eid],
                    ["eventid","source","object","objectid","clock","value",
                     "acknowledged","name","severity"],
                    f"event[{eid}]")

    # problem
    if prob_ids:
        rr  = res(real("problem.get", {"eventids": prob_ids, "output": "extend"}, rt)) or []
        or_ = res(ours("problem.get", {"eventids": prob_ids, "output": "extend"}, ot)) or []
        r_map = {x["eventid"]: x for x in rr}
        o_map = {x["eventid"]: x for x in or_}
        for pid in prob_ids[:3]:
            if pid in r_map and pid in o_map:
                compare_values(r_map[pid], o_map[pid],
                    ["eventid","source","object","objectid","clock","name",
                     "acknowledged","severity","r_eventid","correlationid","userid"],
                    f"problem[{pid}]")

    # ═════════════════════════════════════════════════════════════════════════
    # 2. ID FIELDS ARE ALWAYS STRINGS
    # ═════════════════════════════════════════════════════════════════════════
    section("2. All *id fields are strings")

    def check_all_ids(method, params, id_fields, label):
        items = res(ours(method, params, ot)) or []
        if isinstance(items, str):
            return  # countOutput
        check_list_ids(items, id_fields, label, sample=5)

    check_all_ids("hostgroup.get", {"output": "extend", "limit": 5},
                  ["groupid"], "hostgroup")
    check_all_ids("host.get", {"output": "extend", "limit": 5},
                  ["hostid", "proxyid", "proxy_groupid", "maintenanceid", "templateid"], "host")
    if item_ids:
        check_all_ids("item.get", {"itemids": item_ids, "output": "extend"},
                      ["itemid", "hostid", "templateid", "valuemapid", "interfaceid", "master_itemid"], "item")
    if trig_ids:
        check_all_ids("trigger.get", {"triggerids": trig_ids, "output": "extend"},
                      ["triggerid", "templateid"], "trigger")
    if event_ids:
        check_all_ids("event.get", {"eventids": event_ids, "output": "extend"},
                      ["eventid", "objectid", "r_eventid", "userid", "correlationid"], "event")
    if prob_ids:
        check_all_ids("problem.get", {"eventids": prob_ids, "output": "extend"},
                      ["eventid", "objectid", "r_eventid", "userid", "correlationid", "cause_eventid"], "problem")
    if drule_ids:
        check_all_ids("discoveryrule.get", {"itemids": drule_ids, "output": "extend"},
                      ["itemid", "hostid", "templateid", "valuemapid", "interfaceid", "master_itemid"], "discoveryrule")

    # ═════════════════════════════════════════════════════════════════════════
    # 3. countOutput MATCHES LIST LENGTH (both APIs agree)
    # ═════════════════════════════════════════════════════════════════════════
    section("3. countOutput consistency")

    for method, params, label in [
        ("hostgroup.get", {}, "hostgroup"),
        ("host.get", {}, "host"),
        ("item.get", {"hostids": host_ids} if host_ids else {}, "item"),
        ("trigger.get", {"hostids": host_ids} if host_ids else {}, "trigger"),
        ("event.get", {"source": 0, "object": 0, "limit": 10000}, "event"),
        ("problem.get", {}, "problem"),
    ]:
        r_cnt = res(real(method, {**params, "countOutput": True}, rt))
        o_cnt = res(ours(method, {**params, "countOutput": True}, ot))
        o_list = res(ours(method, {**params, "output": "extend"}, ot))

        # count from both APIs must match
        assert_ok(r_cnt == o_cnt, f"{label}.countOutput real={r_cnt} == ours={o_cnt}")

        # our count must match our list (when no limit)
        if isinstance(o_list, list) and isinstance(o_cnt, str):
            assert_ok(str(len(o_list)) == o_cnt,
                      f"{label} countOutput({o_cnt}) == len(list)({len(o_list)})")

    # ═════════════════════════════════════════════════════════════════════════
    # 4. SORT ORDER CORRECTNESS
    # ═════════════════════════════════════════════════════════════════════════
    section("4. Sort order")

    # Explicit sortfield tests — both APIs get same sortfield param so order must match
    # hostgroup — sortfield=name ASC
    sf_params = {"output": ["groupid","name"], "sortfield": "name", "sortorder": "ASC", "limit": 20}
    r_grps = res(real("hostgroup.get", sf_params, rt)) or []
    o_grps = res(ours("hostgroup.get", sf_params, ot)) or []
    compare_sorted_lists(r_grps, o_grps, "name", "hostgroup (sortfield=name ASC)")
    # verify our list is actually ascending
    names = [x["name"] for x in o_grps]
    assert_ok(names == sorted(names, key=str.casefold), "hostgroup: local sort order is ASC",
              str(names[:5]))

    # hostgroup — sortfield=name DESC
    sf_params2 = {"output": ["groupid","name"], "sortfield": "name", "sortorder": "DESC", "limit": 10}
    r_grps2 = res(real("hostgroup.get", sf_params2, rt)) or []
    o_grps2 = res(ours("hostgroup.get", sf_params2, ot)) or []
    compare_sorted_lists(r_grps2, o_grps2, "name", "hostgroup (sortfield=name DESC)")

    # item — sortfield=name ASC
    if host_ids:
        sf_i = {"hostids": [host_id], "output": ["itemid","name"], "sortfield": "name", "sortorder": "ASC", "limit": 10}
        r_items = res(real("item.get", sf_i, rt)) or []
        o_items = res(ours("item.get", sf_i, ot)) or []
        compare_sorted_lists(r_items, o_items, "name", "item (sortfield=name ASC)")

        # item — sortfield=key_ DESC
        sf_i2 = {"hostids": [host_id], "output": ["itemid","key_"], "sortfield": "key_", "sortorder": "DESC", "limit": 10}
        r_items2 = res(real("item.get", sf_i2, rt)) or []
        o_items2 = res(ours("item.get", sf_i2, ot)) or []
        compare_sorted_lists(r_items2, o_items2, "key_", "item (sortfield=key_ DESC)")

    # event — by clock DESC (default, no explicit sortfield needed)
    r_evts = res(real("event.get", {"output": ["eventid","clock"], "source": 0, "object": 0,
                                     "sortfield": "clock", "sortorder": "DESC", "limit": 10}, rt)) or []
    o_evts = res(ours("event.get", {"output": ["eventid","clock"], "source": 0, "object": 0,
                                     "sortfield": "clock", "sortorder": "DESC", "limit": 10}, ot)) or []
    clocks = [int(e["clock"]) for e in o_evts]
    assert_ok(clocks == sorted(clocks, reverse=True), "event clock order is DESC", str(clocks[:5]))
    compare_sorted_lists(r_evts, o_evts, "eventid", "event (sortfield=clock DESC)")

    # problem — by eventid DESC (only sortfield real Zabbix accepts for problem.get)
    r_probs2 = res(real("problem.get", {"output": ["eventid","clock"],
                                         "sortfield": "eventid", "sortorder": "DESC", "limit": 10}, rt)) or []
    o_probs2 = res(ours("problem.get", {"output": ["eventid","clock"],
                                         "sortfield": "eventid", "sortorder": "DESC", "limit": 10}, ot)) or []
    compare_sorted_lists(r_probs2, o_probs2, "eventid", "problem (sortfield=eventid DESC)")

    # ═════════════════════════════════════════════════════════════════════════
    # 5. SEARCH / FILTER CORRECTNESS
    # ═════════════════════════════════════════════════════════════════════════
    section("5. Search and filter correctness")

    # search by group name — results must contain search term
    if groups_r:
        name_frag = groups_r[0]["name"][:3]
        r_s = res(real("hostgroup.get", {"output": ["groupid","name"], "search": {"name": name_frag}}, rt)) or []
        o_s = res(ours("hostgroup.get", {"output": ["groupid","name"], "search": {"name": name_frag}}, ot)) or []
        assert_ok(len(o_s) > 0, f"hostgroup search name~={name_frag!r} returns results")
        bad = [x["name"] for x in o_s if name_frag.lower() not in x["name"].lower()]
        assert_ok(not bad, f"all hostgroup search results contain {name_frag!r}",
                  f"bad: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"hostgroup search count matches real({len(r_s)}) ours({len(o_s)})")

    # search by host name
    if hosts_r:
        name_frag = hosts_r[0]["name"][:3]
        r_s = res(real("host.get", {"output": ["hostid","name"], "search": {"host": name_frag}}, rt)) or []
        o_s = res(ours("host.get", {"output": ["hostid","name"], "search": {"host": name_frag}}, ot)) or []
        assert_ok(len(r_s) == len(o_s), f"host search count matches (real={len(r_s)} ours={len(o_s)})")

    # item filter by value_type
    for vt in [0, 3]:  # float, uint
        r_s = res(real("item.get", {"hostids": host_ids, "output": ["itemid","value_type"],
                                     "filter": {"value_type": vt}, "limit": 20}, rt)) or []
        o_s = res(ours("item.get", {"hostids": host_ids, "output": ["itemid","value_type"],
                                     "filter": {"value_type": vt}, "limit": 20}, ot)) or []
        bad = [x["value_type"] for x in o_s if str(x["value_type"]) != str(vt)]
        assert_ok(not bad, f"item filter value_type={vt}: all results have correct type",
                  f"wrong values: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"item filter value_type={vt} count real={len(r_s)} ours={len(o_s)}")

    # trigger filter by status
    r_s = res(real("trigger.get", {"hostids": host_ids, "output": ["triggerid","status"],
                                    "filter": {"status": 0}, "limit": 20}, rt)) or []
    o_s = res(ours("trigger.get", {"hostids": host_ids, "output": ["triggerid","status"],
                                    "filter": {"status": 0}, "limit": 20}, ot)) or []
    bad = [x["status"] for x in o_s if str(x["status"]) != "0"]
    assert_ok(not bad, "trigger filter status=0: all enabled", f"wrong: {bad[:3]}")
    assert_ok(len(r_s) == len(o_s), f"trigger filter status=0 count real={len(r_s)} ours={len(o_s)}")

    # problem filter by severity
    for sev in [3, 4]:  # average, high
        r_s = res(real("problem.get", {"severities": [sev], "output": ["eventid","severity"], "limit": 20}, rt)) or []
        o_s = res(ours("problem.get", {"severities": [sev], "output": ["eventid","severity"], "limit": 20}, ot)) or []
        bad = [x["severity"] for x in o_s if str(x["severity"]) != str(sev)]
        assert_ok(not bad, f"problem filter severity={sev}: all correct", f"wrong: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"problem severity={sev} count real={len(r_s)} ours={len(o_s)}")

    # groupids filter for host
    if group_ids:
        r_s = res(real("host.get", {"groupids": [group_id], "output": ["hostid"], "limit": 20}, rt)) or []
        o_s = res(ours("host.get", {"groupids": [group_id], "output": ["hostid"], "limit": 20}, ot)) or []
        assert_ok(len(r_s) == len(o_s), f"host.get by groupid={group_id} count real={len(r_s)} ours={len(o_s)}")

    # hostids filter for item
    if host_ids:
        r_s = res(real("item.get", {"hostids": [host_id], "output": ["itemid","hostid"], "limit": 30}, rt)) or []
        o_s = res(ours("item.get", {"hostids": [host_id], "output": ["itemid","hostid"], "limit": 30}, ot)) or []
        bad = [x["hostid"] for x in o_s if x["hostid"] != host_id]
        assert_ok(not bad, f"item.get hostids filter: all items belong to host {host_id}",
                  f"foreign hosts: {bad[:3]}")

    # ═════════════════════════════════════════════════════════════════════════
    # 6. selectXxx STRUCTURE
    # ═════════════════════════════════════════════════════════════════════════
    section("6. selectXxx: always present key, correct sub-structure")

    # selectTags
    for method, params, label, tag_table in [
        ("host.get",    {"hostids": host_ids, "output": "extend"} if host_ids else {"output": "extend", "limit": 5},
         "host", "host_tag"),
        ("item.get",    {"itemids": item_ids, "output": "extend"} if item_ids else {},
         "item", "item_tag"),
        ("trigger.get", {"triggerids": trig_ids, "output": "extend"} if trig_ids else {},
         "trigger", "trigger_tag"),
        ("event.get",   {"eventids": event_ids, "output": "extend"} if event_ids else {"output": "extend","source":0,"object":0,"limit":5},
         "event", "event_tag"),
        ("problem.get", {"eventids": prob_ids, "output": "extend"} if prob_ids else {"output": "extend","limit":5},
         "problem", "problem_tag"),
    ]:
        if not params:
            continue
        items = res(ours(method, {**params, "selectTags": "extend"}, ot)) or []
        check_select_key(items, "tags", f"{label}.selectTags")
        check_select_structure(items, "tags", ["tag", "value"], f"{label}.selectTags")

    # selectHosts
    if trig_ids:
        items = res(ours("trigger.get", {"triggerids": trig_ids, "output": "extend",
                                          "selectHosts": "extend"}, ot)) or []
        check_select_key(items, "hosts", "trigger.selectHosts")
        check_select_structure(items, "hosts", ["hostid", "host", "name"], "trigger.selectHosts")

    if item_ids:
        items = res(ours("item.get", {"itemids": item_ids, "output": "extend",
                                       "selectHosts": "extend"}, ot)) or []
        check_select_key(items, "hosts", "item.selectHosts")
        check_select_structure(items, "hosts", ["hostid", "host", "name"], "item.selectHosts")

    # selectGroups
    if host_ids:
        items = res(ours("host.get", {"hostids": host_ids, "output": "extend",
                                       "selectGroups": "extend"}, ot)) or []
        check_select_key(items, "groups", "host.selectGroups")
        check_select_structure(items, "groups", ["groupid", "name"], "host.selectGroups")

    # selectInterfaces
    if host_ids:
        items = res(ours("host.get", {"hostids": host_ids, "output": "extend",
                                       "selectInterfaces": "extend"}, ot)) or []
        check_select_key(items, "interfaces", "host.selectInterfaces")

    # selectAcknowledges
    if event_ids:
        items = res(ours("event.get", {"eventids": event_ids, "output": "extend",
                                        "selectAcknowledges": "extend"}, ot)) or []
        check_select_key(items, "acknowledges", "event.selectAcknowledges")

    if prob_ids:
        items = res(ours("problem.get", {"eventids": prob_ids, "output": "extend",
                                          "selectAcknowledges": "extend"}, ot)) or []
        check_select_key(items, "acknowledges", "problem.selectAcknowledges")

    # selectLastEvent in trigger — either False or dict with eventid
    if trig_ids:
        items = res(ours("trigger.get", {"triggerids": trig_ids, "output": "extend",
                                          "selectLastEvent": "extend"}, ot)) or []
        check_select_key(items, "lastEvent", "trigger.selectLastEvent")
        for item in items:
            le = item.get("lastEvent")
            if le and le is not False:
                assert_ok("eventid" in le, f"trigger.lastEvent has eventid (tid={item['triggerid']})",
                          f"got: {list(le.keys())}")

    # selectHostGroups in trigger
    if trig_ids:
        items = res(ours("trigger.get", {"triggerids": trig_ids, "output": "extend",
                                          "selectHostGroups": "extend"}, ot)) or []
        check_select_key(items, "hostgroups", "trigger.selectHostGroups")

    # selectMappings in valuemap
    vm_r = res(ours("valuemap.get", {"output": "extend", "limit": 3, "selectMappings": "extend"}, ot)) or []
    if vm_r:
        check_select_key(vm_r, "mappings", "valuemap.selectMappings")

    # selectFilter + selectLLDMacroPaths in discoveryrule
    if drule_id:
        items = res(ours("discoveryrule.get", {"itemids": [drule_id], "output": "extend",
                                                "selectFilter": True}, ot)) or []
        check_select_key(items, "filter", "discoveryrule.selectFilter")
        if items:
            f = items[0].get("filter", {})
            for k in ["evaltype", "conditions"]:
                assert_ok(k in f, f"discoveryrule.filter has '{k}' key")

        items = res(ours("discoveryrule.get", {"itemids": [drule_id], "output": "extend",
                                                "selectLLDMacroPaths": True}, ot)) or []
        check_select_key(items, "lld_macro_paths", "discoveryrule.selectLLDMacroPaths")

    # ═════════════════════════════════════════════════════════════════════════
    # 7. LIMIT IS RESPECTED
    # ═════════════════════════════════════════════════════════════════════════
    section("7. limit is respected")

    for method, params, label in [
        ("hostgroup.get", {"output": "extend"}, "hostgroup"),
        ("host.get",      {"output": "extend"}, "host"),
        ("item.get",      {"output": "extend", "hostids": host_ids} if host_ids else {}, "item"),
        ("trigger.get",   {"output": "extend", "hostids": host_ids} if host_ids else {}, "trigger"),
        ("event.get",     {"output": "extend", "source": 0, "object": 0}, "event"),
        ("problem.get",   {"output": "extend"}, "problem"),
    ]:
        if not params:
            continue
        for lim in [1, 3, 5]:
            items = res(ours(method, {**params, "limit": lim}, ot)) or []
            if isinstance(items, list):
                assert_ok(len(items) <= lim, f"{label} limit={lim}: got {len(items)} items")

    # ═════════════════════════════════════════════════════════════════════════
    # 8. preservekeys
    # ═════════════════════════════════════════════════════════════════════════
    section("8. preservekeys → dict with string ID keys")

    for method, params, id_field, label in [
        ("hostgroup.get", {"output": "extend", "limit": 5}, "groupid", "hostgroup"),
        ("host.get",      {"output": "extend", "limit": 5}, "hostid",  "host"),
        ("item.get",      {"output": "extend", "itemids": item_ids} if item_ids else {}, "itemid", "item"),
        ("trigger.get",   {"output": "extend", "triggerids": trig_ids} if trig_ids else {}, "triggerid", "trigger"),
        ("event.get",     {"output": "extend", "eventids": event_ids} if event_ids else {}, "eventid", "event"),
        ("problem.get",   {"output": "extend", "eventids": prob_ids} if prob_ids else {}, "eventid", "problem"),
    ]:
        if not params:
            continue
        result = res(ours(method, {**params, "preservekeys": True}, ot))
        assert_ok(isinstance(result, dict), f"{label} preservekeys returns dict")
        if isinstance(result, dict):
            all_str_keys = all(isinstance(k, str) and k.isdigit() for k in result)
            assert_ok(all_str_keys, f"{label} preservekeys: all keys are string digits",
                      f"keys: {list(result.keys())[:5]}")
            # values should have the id_field matching the key
            for k, v in list(result.items())[:3]:
                if isinstance(v, dict):
                    assert_ok(str(v.get(id_field)) == k,
                              f"{label} preservekeys: key {k!r} matches {id_field}={v.get(id_field)!r}")

    # ═════════════════════════════════════════════════════════════════════════
    # 9. EDGE CASES
    # ═════════════════════════════════════════════════════════════════════════
    section("9. Edge cases")

    FAKE_ID = "9999999999"

    # non-existent IDs → empty list (not error)
    for method, params, label in [
        ("hostgroup.get", {"groupids": [FAKE_ID], "output": "extend"}, "hostgroup"),
        ("host.get",      {"hostids": [FAKE_ID], "output": "extend"}, "host"),
        ("item.get",      {"itemids": [FAKE_ID], "output": "extend"}, "item"),
        ("trigger.get",   {"triggerids": [FAKE_ID], "output": "extend"}, "trigger"),
        ("event.get",     {"eventids": [FAKE_ID], "output": "extend"}, "event"),
        ("problem.get",   {"eventids": [FAKE_ID], "output": "extend"}, "problem"),
        ("discoveryrule.get", {"itemids": [FAKE_ID], "output": "extend"}, "discoveryrule"),
    ]:
        r = ours(method, params, ot)
        items = res(r)
        assert_ok(isinstance(items, list) and len(items) == 0,
                  f"{label} non-existent ID → empty list (not error)",
                  f"got: {r}")

    # countOutput with non-existent ID → "0"
    for method, params, label in [
        ("hostgroup.get", {"groupids": [FAKE_ID], "countOutput": True}, "hostgroup"),
        ("host.get",      {"hostids":  [FAKE_ID], "countOutput": True}, "host"),
        ("item.get",      {"itemids":  [FAKE_ID], "countOutput": True}, "item"),
    ]:
        r = res(ours(method, params, ot))
        assert_ok(r == "0", f"{label} countOutput non-existent → '0' (got {r!r})")

    # output=['hostid'] — only requested fields + hostid
    if host_ids:
        items = res(ours("host.get", {"hostids": host_ids, "output": ["name"]}, ot)) or []
        for item in items[:3]:
            assert_ok("name" in item and "hostid" in item,
                      f"host output=['name'] has name+hostid (keys: {list(item.keys())})")
            has_extra = any(k not in ("name","hostid") for k in item)
            assert_ok(not has_extra, f"host output=['name'] has no extra keys",
                      f"extra: {[k for k in item if k not in ('name','hostid')]}")

    # empty list params
    r = res(ours("hostgroup.get", {"output": "extend"}, ot))
    assert_ok(isinstance(r, list) and len(r) > 0, "hostgroup.get no filter returns all groups")

    # ═════════════════════════════════════════════════════════════════════════
    # 10. HISTORY AND TREND
    # ═════════════════════════════════════════════════════════════════════════
    section("10. history.get / trend.get")

    if item_ids:
        for vt, label in [(0,"float"), (3,"uint"), (1,"str"), (4,"text")]:
            r_h = res(real("history.get", {"itemids": item_ids, "history": vt,
                                            "output": "extend", "limit": 5}, rt)) or []
            o_h = res(ours("history.get", {"itemids": item_ids, "history": vt,
                                            "output": "extend", "limit": 5}, ot)) or []
            if len(r_h) != len(o_h):
                warn(f"history vt={vt} ({label}) count real={len(r_h)} ours={len(o_h)} (may differ due to housekeeping)")
            if o_h:
                for row in o_h[:3]:
                    assert_ok(is_str_id(row.get("itemid")), f"history.itemid is string")
                    assert_ok("clock" in row and "value" in row,
                              f"history row has clock+value")

                # clock order DESC
                clocks = [int(x["clock"]) for x in o_h]
                assert_ok(clocks == sorted(clocks, reverse=True),
                          f"history vt={vt} clock DESC", str(clocks))

                # values from real match ours
                r_map = {(x["itemid"], x["clock"], x.get("ns","0")): x["value"] for x in r_h}
                mismatches = []
                for row in o_h:
                    key = (row["itemid"], row["clock"], row.get("ns","0"))
                    if key in r_map and r_map[key] != row["value"]:
                        mismatches.append(key)
                assert_ok(not mismatches, f"history vt={vt} values match real",
                          f"mismatches: {mismatches[:3]}")

        # trend
        r_t = res(real("trend.get", {"itemids": item_ids, "output": "extend", "limit": 5}, rt)) or []
        o_t = res(ours("trend.get", {"itemids": item_ids, "output": "extend", "limit": 5}, ot)) or []
        assert_ok(len(r_t) == len(o_t), f"trend count real={len(r_t)} ours={len(o_t)}")
        if o_t:
            for row in o_t[:3]:
                assert_ok(is_str_id(row.get("itemid")), "trend.itemid is string")
                for f in ["clock","num","value_min","value_avg","value_max"]:
                    assert_ok(f in row, f"trend has {f!r}")

    # ═════════════════════════════════════════════════════════════════════════
    # 11. CROSS-QUERY CONSISTENCY
    # ═════════════════════════════════════════════════════════════════════════
    section("11. Cross-query consistency (internal)")

    # hostgroup real_hosts vs with_hosts must match
    r1 = res(ours("hostgroup.get", {"real_hosts": True, "output": ["groupid"]}, ot)) or []
    r2 = res(ours("hostgroup.get", {"with_hosts":  True, "output": ["groupid"]}, ot)) or []
    ids1 = sorted(x["groupid"] for x in r1)
    ids2 = sorted(x["groupid"] for x in r2)
    assert_ok(ids1 == ids2, "hostgroup real_hosts == with_hosts (same result)")

    # host countOutput must equal len(list)
    cnt = res(ours("host.get", {"countOutput": True}, ot))
    lst = res(ours("host.get", {"output": "extend"}, ot)) or []
    assert_ok(cnt == str(len(lst)), f"host countOutput({cnt}) == len(list)({len(lst)})")

    # item by hostids: all returned items belong to those hosts
    if host_ids:
        items = res(ours("item.get", {"hostids": host_ids, "output": ["itemid","hostid"]}, ot)) or []
        foreign = [x["hostid"] for x in items if x["hostid"] not in host_ids]
        assert_ok(not foreign, f"all items from hostids filter belong to queried hosts",
                  f"foreign: {foreign[:3]}")

    # trigger by hostids: all returned triggers link to those hosts
    if host_ids and trig_ids:
        trig_items = res(ours("trigger.get",
                              {"hostids": host_ids, "output": "extend",
                               "selectHosts": ["hostid"]}, ot)) or []
        for t in trig_items[:5]:
            host_ids_in_trig = [h["hostid"] for h in t.get("hosts", [])]
            overlap = any(hid in host_ids for hid in host_ids_in_trig)
            assert_ok(overlap, f"trigger {t['triggerid']} links to a queried host",
                      f"trigger hosts: {host_ids_in_trig}, queried: {host_ids}")

    # problem objectids must be triggerids (when object=0)
    p_obj_ids = [p["objectid"] for p in probs_r[:5]]
    if p_obj_ids:
        trig_check = res(ours("trigger.get",
                              {"triggerids": p_obj_ids, "output": ["triggerid"]}, ot)) or []
        found_ids = {t["triggerid"] for t in trig_check}
        for oid in p_obj_ids:
            assert_ok(oid in found_ids, f"problem.objectid={oid} is a real triggerid")

    # ═════════════════════════════════════════════════════════════════════════
    # 12. USERMACRO / DISCOVERYRULE / PROTOTYPES
    # ═════════════════════════════════════════════════════════════════════════
    section("12. Macros, discovery rules, prototypes")

    # global macros
    r_gm = res(real("usermacro.get", {"globalmacro": True, "output": "extend"}, rt)) or []
    o_gm = res(ours("usermacro.get", {"globalmacro": True, "output": "extend"}, ot)) or []
    assert_ok(len(r_gm) == len(o_gm), f"global macro count real={len(r_gm)} ours={len(o_gm)}")
    if r_gm and o_gm:
        r_map = {x["macro"]: x for x in r_gm}
        o_map = {x["macro"]: x for x in o_gm}
        for macro in list(r_map.keys())[:3]:
            if macro in o_map:
                compare_values(r_map[macro], o_map[macro], ["macro","value","type"], f"global_macro[{macro}]")

    # discoveryrule with LLD select sub-keys
    if drule_id:
        r_dr = (res(real("discoveryrule.get", {"itemids": [drule_id], "output": "extend",
                                                "selectFilter": True,
                                                "selectLLDMacroPaths": True}, rt)) or [{}])[0]
        o_dr = (res(ours("discoveryrule.get", {"itemids": [drule_id], "output": "extend",
                                                "selectFilter": True,
                                                "selectLLDMacroPaths": True}, ot)) or [{}])[0]
        compare_values(r_dr, o_dr, ["itemid","name","key_","type","status","delay","lifetime"], "discoveryrule")
        # filter conditions count must match
        r_conds = (r_dr.get("filter") or {}).get("conditions", [])
        o_conds = (o_dr.get("filter") or {}).get("conditions", [])
        assert_ok(len(r_conds) == len(o_conds),
                  f"discoveryrule filter conditions count real={len(r_conds)} ours={len(o_conds)}")

    # itemprototype count + values
    if drule_id:
        r_ip = res(real("itemprototype.get", {"discoveryids": [drule_id], "output": "extend"}, rt)) or []
        o_ip = res(ours("itemprototype.get", {"discoveryids": [drule_id], "output": "extend"}, ot)) or []
        assert_ok(len(r_ip) == len(o_ip),
                  f"itemprototype count real={len(r_ip)} ours={len(o_ip)}")
        r_map = {x["itemid"]: x for x in r_ip}
        o_map = {x["itemid"]: x for x in o_ip}
        for iid in list(r_map.keys())[:3]:
            if iid in o_map:
                compare_values(r_map[iid], o_map[iid],
                    ["itemid","name","key_","type","value_type","status","delay","uuid"],
                    f"itemprototype[{iid}]")

    # triggerprototype count + values
    if drule_id:
        r_tp = res(real("triggerprototype.get", {"discoveryids": [drule_id], "output": "extend"}, rt)) or []
        o_tp = res(ours("triggerprototype.get", {"discoveryids": [drule_id], "output": "extend"}, ot)) or []
        assert_ok(len(r_tp) == len(o_tp),
                  f"triggerprototype count real={len(r_tp)} ours={len(o_tp)}")
        r_map = {x["triggerid"]: x for x in r_tp}
        o_map = {x["triggerid"]: x for x in o_tp}
        for tid in list(r_map.keys())[:3]:
            if tid in o_map:
                compare_values(r_map[tid], o_map[tid],
                    ["triggerid","description","expression","priority","status","uuid"],
                    f"triggerprototype[{tid}]")

    # ═════════════════════════════════════════════════════════════════════════
    # 13. EXTENDED SEARCH / FILTER / FLAGS
    # ═════════════════════════════════════════════════════════════════════════
    section("13. Extended search, filter, flags")

    # item.get search by key_
    if host_ids:
        kw = "system"
        r_s = res(real("item.get", {"hostids": host_ids, "search": {"key_": kw},
                                     "output": ["itemid","key_"], "limit": 10}, rt)) or []
        o_s = res(ours("item.get", {"hostids": host_ids, "search": {"key_": kw},
                                     "output": ["itemid","key_"], "limit": 10}, ot)) or []
        assert_ok(len(r_s) == len(o_s), f"item search key_~={kw!r} count real={len(r_s)} ours={len(o_s)}")
        bad = [x["key_"] for x in o_s if kw not in x["key_"].lower()]
        assert_ok(not bad, f"item search key_~={kw!r}: all contain keyword", f"bad: {bad[:3]}")

    # item.get filter value_type with array [0, 3]
    if host_ids:
        r_s = res(real("item.get", {"hostids": host_ids, "filter": {"value_type": [0, 3]},
                                     "output": ["itemid","value_type"], "limit": 30}, rt)) or []
        o_s = res(ours("item.get", {"hostids": host_ids, "filter": {"value_type": [0, 3]},
                                     "output": ["itemid","value_type"], "limit": 30}, ot)) or []
        bad = [x["value_type"] for x in o_s if str(x["value_type"]) not in ("0", "3")]
        assert_ok(not bad, "item filter value_type=[0,3] array: all correct", f"wrong: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"item filter value_type array count real={len(r_s)} ours={len(o_s)}")

    # trigger.get filter value=1 (PROBLEM state)
    if host_ids:
        r_s = res(real("trigger.get", {"hostids": host_ids, "filter": {"value": 1},
                                        "output": ["triggerid","value"], "limit": 20}, rt)) or []
        o_s = res(ours("trigger.get", {"hostids": host_ids, "filter": {"value": 1},
                                        "output": ["triggerid","value"], "limit": 20}, ot)) or []
        bad = [x["value"] for x in o_s if str(x["value"]) != "1"]
        assert_ok(not bad, "trigger filter value=1: all in PROBLEM state", f"wrong: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"trigger filter value=1 count real={len(r_s)} ours={len(o_s)}")

    # trigger.get only_true flag
    if host_ids:
        r_s = res(real("trigger.get", {"hostids": host_ids, "only_true": True,
                                        "output": ["triggerid","value"], "limit": 20}, rt)) or []
        o_s = res(ours("trigger.get", {"hostids": host_ids, "only_true": True,
                                        "output": ["triggerid","value"], "limit": 20}, ot)) or []
        bad = [x["value"] for x in o_s if str(x["value"]) != "1"]
        assert_ok(not bad, "trigger only_true=True: all value=1", f"wrong: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"trigger only_true count real={len(r_s)} ours={len(o_s)}")

    # trigger.get monitored flag
    if host_ids:
        r_s = res(real("trigger.get", {"hostids": host_ids, "monitored": True,
                                        "output": ["triggerid","status"], "limit": 20}, rt)) or []
        o_s = res(ours("trigger.get", {"hostids": host_ids, "monitored": True,
                                        "output": ["triggerid","status"], "limit": 20}, ot)) or []
        bad = [x["status"] for x in o_s if str(x["status"]) != "0"]
        assert_ok(not bad, "trigger monitored=True: all status=0", f"wrong: {bad[:3]}")
        assert_ok(len(r_s) == len(o_s), f"trigger monitored count real={len(r_s)} ours={len(o_s)}")

    # trigger.get active flag — enabled triggers on monitored hosts (status=0, host monitored)
    if host_ids:
        r_s = res(real("trigger.get", {"hostids": host_ids, "active": True,
                                        "output": ["triggerid","status"], "limit": 20}, rt)) or []
        o_s = res(ours("trigger.get", {"hostids": host_ids, "active": True,
                                        "output": ["triggerid","status"], "limit": 20}, ot)) or []
        bad_s = [x["status"] for x in o_s if str(x["status"]) != "0"]
        assert_ok(not bad_s, "trigger active=True: all status=0", f"wrong: {bad_s[:3]}")
        assert_ok(len(r_s) == len(o_s), f"trigger active count real={len(r_s)} ours={len(o_s)}")

    # trigger.get skipDependent
    if host_ids:
        r_s = res(real("trigger.get", {"hostids": host_ids, "skipDependent": True,
                                        "output": ["triggerid"], "limit": 20}, rt)) or []
        o_s = res(ours("trigger.get", {"hostids": host_ids, "skipDependent": True,
                                        "output": ["triggerid"], "limit": 20}, ot)) or []
        assert_ok(len(r_s) == len(o_s), f"trigger skipDependent count real={len(r_s)} ours={len(o_s)}")

    # host.get monitored_hosts flag
    r_s = res(real("host.get", {"monitored_hosts": True, "output": ["hostid","status"], "limit": 20}, rt)) or []
    o_s = res(ours("host.get", {"monitored_hosts": True, "output": ["hostid","status"], "limit": 20}, ot)) or []
    bad = [x["status"] for x in o_s if str(x["status"]) != "0"]
    assert_ok(not bad, "host monitored_hosts=True: all status=0", f"wrong: {bad[:3]}")
    assert_ok(len(r_s) == len(o_s), f"host monitored_hosts count real={len(r_s)} ours={len(o_s)}")

    # problem.get acknowledged filter
    for ack_val in [True, False]:
        r_s = res(real("problem.get", {"acknowledged": ack_val,
                                        "output": ["eventid","acknowledged"], "limit": 20}, rt)) or []
        o_s = res(ours("problem.get", {"acknowledged": ack_val,
                                        "output": ["eventid","acknowledged"], "limit": 20}, ot)) or []
        assert_ok(len(r_s) == len(o_s), f"problem acknowledged={ack_val} count real={len(r_s)} ours={len(o_s)}")
        exp = "1" if ack_val else "0"
        bad = [x["acknowledged"] for x in o_s if str(x["acknowledged"]) != exp]
        assert_ok(not bad, f"problem acknowledged={ack_val}: all correct", f"bad: {bad[:3]}")

    # event.get time_from / time_till
    now_ts = int(time.time())
    hour_ago = now_ts - 3600
    r_s = res(real("event.get", {"source": 0, "object": 0,
                                   "time_from": hour_ago, "time_till": now_ts,
                                   "output": ["eventid","clock"], "limit": 20}, rt)) or []
    o_s = res(ours("event.get", {"source": 0, "object": 0,
                                   "time_from": hour_ago, "time_till": now_ts,
                                   "output": ["eventid","clock"], "limit": 20}, ot)) or []
    bad = [x["clock"] for x in o_s if not (hour_ago <= int(x["clock"]) <= now_ts)]
    assert_ok(not bad, "event time_from/time_till: all clocks in range", f"wrong: {bad[:3]}")
    assert_ok(len(r_s) == len(o_s), f"event time_from/time_till count real={len(r_s)} ours={len(o_s)}")

    # hostgroup.get filter.name (exact match) — real Zabbix supports this
    if groups_r:
        exact_name = groups_r[0]["name"]
        r_s = res(real("hostgroup.get", {"filter": {"name": exact_name},
                                          "output": ["groupid","name"]}, rt)) or []
        o_s = res(ours("hostgroup.get", {"filter": {"name": exact_name},
                                          "output": ["groupid","name"]}, ot)) or []
        assert_ok(len(r_s) == len(o_s),
                  f"hostgroup filter.name exact={exact_name!r} count real={len(r_s)} ours={len(o_s)}")
        bad = [x["name"] for x in o_s if x["name"] != exact_name]
        assert_ok(not bad, "hostgroup filter.name: exact match only", f"bad: {bad[:3]}")

    # item.get search.name ILIKE
    if host_ids:
        first_items = res(real("item.get", {"hostids": [host_id], "output": ["name"], "limit": 5}, rt)) or []
        if first_items:
            frag = first_items[0]["name"][:4] if len(first_items[0]["name"]) >= 4 else first_items[0]["name"]
            r_s = res(real("item.get", {"hostids": host_ids, "search": {"name": frag},
                                         "output": ["itemid","name"], "limit": 20}, rt)) or []
            o_s = res(ours("item.get", {"hostids": host_ids, "search": {"name": frag},
                                         "output": ["itemid","name"], "limit": 20}, ot)) or []
            assert_ok(len(r_s) == len(o_s), f"item search.name~={frag!r} count real={len(r_s)} ours={len(o_s)}")
            bad = [x["name"] for x in o_s if frag.lower() not in x["name"].lower()]
            assert_ok(not bad, f"item search.name ILIKE {frag!r}: all match", f"bad: {bad[:3]}")

    # ═════════════════════════════════════════════════════════════════════════
    # 14. CRUD — hostgroup
    # ═════════════════════════════════════════════════════════════════════════
    section("14. CRUD — hostgroup.create / update / delete")

    ts = str(int(time.time()))
    grp_name = f"test_group_{ts}"
    grp_id = None
    try:
        # create
        r = ours("hostgroup.create", {"name": grp_name}, ot)
        assert_ok(not err(r), "hostgroup.create returns no error", str(err(r)))
        gids = (res(r) or {}).get("groupids", [])
        assert_ok(len(gids) == 1, "hostgroup.create returns 1 groupid", str(gids))
        assert_ok(is_str_id(gids[0]), f"hostgroup.create groupid is string digit ({gids[0]!r})")
        grp_id = gids[0]

        # verify get
        fetched = res(ours("hostgroup.get", {"groupids": [grp_id], "output": "extend"}, ot)) or []
        assert_ok(len(fetched) == 1, "hostgroup: created group retrievable")
        if fetched:
            assert_ok(fetched[0]["name"] == grp_name, "hostgroup: name matches",
                      f"got {fetched[0]['name']!r}")
            assert_ok(fetched[0]["groupid"] == grp_id, "hostgroup: groupid matches")

        # update name
        new_name = f"test_group_upd_{ts}"
        r = ours("hostgroup.update", {"groupid": grp_id, "name": new_name}, ot)
        assert_ok(not err(r), "hostgroup.update returns no error", str(err(r)))
        fetched2 = res(ours("hostgroup.get", {"groupids": [grp_id], "output": "extend"}, ot)) or []
        assert_ok(fetched2 and fetched2[0]["name"] == new_name,
                  "hostgroup.update: name persisted", str(fetched2))

        # duplicate create → error
        r2 = ours("hostgroup.create", {"name": new_name}, ot)
        assert_ok(err(r2) is not None, "hostgroup.create duplicate name → error")

        # missing name → error
        r3 = ours("hostgroup.create", {}, ot)
        assert_ok(err(r3) is not None, "hostgroup.create missing name → error")

        # update missing name → error
        r4 = ours("hostgroup.update", {"groupid": grp_id, "name": ""}, ot)
        assert_ok(err(r4) is not None, "hostgroup.update empty name → error")

        # update non-existent → error
        r5 = ours("hostgroup.update", {"groupid": "9999999999", "name": "x"}, ot)
        assert_ok(err(r5) is not None, "hostgroup.update non-existent → error")

    finally:
        if grp_id:
            ours("hostgroup.delete", {"groupids": [grp_id]}, ot)

    # verify deleted
    f3 = res(ours("hostgroup.get", {"groupids": [grp_id or "0"], "output": "extend"}, ot)) or []
    assert_ok(len(f3) == 0, "hostgroup: deleted group not found")

    # ═════════════════════════════════════════════════════════════════════════
    # 15. CRUD — host
    # ═════════════════════════════════════════════════════════════════════════
    section("15. CRUD — host.create / update / delete")

    h_name = f"test.host.{ts}"
    h_id = None
    tmp_gid = None
    try:
        cr = res(ours("hostgroup.create", {"name": f"tmp_grp_{ts}"}, ot)) or {}
        tmp_gid = (cr.get("groupids") or [None])[0]
        if not tmp_gid:
            raise RuntimeError("Could not create temp group for host test")

        r = ours("host.create", {
            "host": h_name,
            "name": f"Test Host {ts}",
            "groups": [{"groupid": tmp_gid}],
            "interfaces": [{"type": 1, "main": 1, "useip": 1,
                            "ip": "127.0.0.1", "dns": "", "port": "10050"}],
        }, ot)
        assert_ok(not err(r), "host.create returns no error", str(err(r)))
        hids = (res(r) or {}).get("hostids", [])
        assert_ok(len(hids) == 1, "host.create returns 1 hostid")
        assert_ok(is_str_id(hids[0]), f"host.create hostid is string digit ({hids[0]!r})")
        h_id = hids[0]

        # verify get with selectInterfaces and selectGroups
        fetched = res(ours("host.get", {
            "hostids": [h_id], "output": "extend",
            "selectInterfaces": "extend", "selectGroups": "extend",
        }, ot)) or []
        assert_ok(len(fetched) == 1, "host: created host retrievable")
        if fetched:
            h = fetched[0]
            assert_ok(h["host"] == h_name, f"host.host matches ({h.get('host')!r})")
            assert_ok(h.get("name") == f"Test Host {ts}", f"host.name matches")
            assert_ok(len(h.get("interfaces", [])) == 1, "host: 1 interface created")
            assert_ok(len(h.get("groups", [])) == 1, "host: 1 group assigned")
            iface = h.get("interfaces", [{}])[0]
            assert_ok(iface.get("ip") == "127.0.0.1", "host interface ip matches")
            assert_ok(str(iface.get("type")) == "1", "host interface type matches")

        # update status to unmonitored
        r = ours("host.update", {"hostid": h_id, "status": 1}, ot)
        assert_ok(not err(r), "host.update returns no error", str(err(r)))
        fetched2 = res(ours("host.get", {"hostids": [h_id], "output": ["hostid","status"]}, ot)) or []
        assert_ok(fetched2 and str(fetched2[0]["status"]) == "1",
                  "host.update status=1 persisted", str(fetched2))

        # update visible name
        r = ours("host.update", {"hostid": h_id, "name": f"Updated {ts}"}, ot)
        assert_ok(not err(r), "host.update name returns no error", str(err(r)))
        fetched3 = res(ours("host.get", {"hostids": [h_id], "output": ["name"]}, ot)) or []
        assert_ok(fetched3 and fetched3[0]["name"] == f"Updated {ts}",
                  "host.update name persisted")

        # duplicate host → error
        r2 = ours("host.create", {"host": h_name, "groups": [{"groupid": tmp_gid}]}, ot)
        assert_ok(err(r2) is not None, "host.create duplicate name → error")

        # missing groups → error
        r3 = ours("host.create", {"host": f"no_grp_{ts}"}, ot)
        assert_ok(err(r3) is not None, "host.create missing groups → error")

        # missing host name → error
        r4 = ours("host.create", {"groups": [{"groupid": tmp_gid}]}, ot)
        assert_ok(err(r4) is not None, "host.create missing host name → error")

        # update non-existent → error
        r5 = ours("host.update", {"hostid": "9999999999", "status": 0}, ot)
        assert_ok(err(r5) is not None, "host.update non-existent → error")

    finally:
        if h_id:
            ours("host.delete", {"hostids": [h_id]}, ot)
        if tmp_gid:
            ours("hostgroup.delete", {"groupids": [tmp_gid]}, ot)

    f3 = res(ours("host.get", {"hostids": [h_id or "0"], "output": ["hostid"]}, ot)) or []
    assert_ok(len(f3) == 0, "host: deleted host not found")

    # ═════════════════════════════════════════════════════════════════════════
    # 16. CRUD — item
    # ═════════════════════════════════════════════════════════════════════════
    section("16. CRUD — item.create / update / delete")

    item_test_id = None
    if host_id:
        try:
            r = ours("item.create", {
                "hostid": host_id,
                "name": f"Test Item {ts}",
                "key_": f"test.item[{ts}]",
                "type": 2,        # trapper (no interface or polling needed)
                "value_type": 3,  # unsigned int
                "delay": "0",
                "history": "7d",
                "trends": "365d",
            }, ot)
            assert_ok(not err(r), "item.create returns no error", str(err(r)))
            iids = (res(r) or {}).get("itemids", [])
            assert_ok(len(iids) == 1, "item.create returns 1 itemid")
            assert_ok(is_str_id(iids[0]), f"item.create itemid is string digit ({iids[0]!r})")
            item_test_id = iids[0]

            # verify get
            fetched = res(ours("item.get", {"itemids": [item_test_id], "output": "extend"}, ot)) or []
            assert_ok(len(fetched) == 1, "item: created item retrievable")
            if fetched:
                it = fetched[0]
                assert_ok(it["name"] == f"Test Item {ts}", "item.name matches")
                assert_ok(it["key_"] == f"test.item[{ts}]", "item.key_ matches")
                assert_ok(str(it["value_type"]) == "3", "item.value_type matches")
                assert_ok(str(it["type"]) == "2", "item.type matches")
                assert_ok(str(it["hostid"]) == str(host_id), "item.hostid matches")

            # update name and history
            r = ours("item.update", {
                "itemid": item_test_id,
                "name": f"Test Item Updated {ts}",
                "history": "14d",
            }, ot)
            assert_ok(not err(r), "item.update returns no error", str(err(r)))
            fetched2 = res(ours("item.get", {"itemids": [item_test_id],
                                              "output": ["name","history"]}, ot)) or []
            assert_ok(fetched2 and fetched2[0]["name"] == f"Test Item Updated {ts}",
                      "item.update name persisted")
            assert_ok(fetched2 and fetched2[0]["history"] == "14d",
                      "item.update history persisted")

            # duplicate key → error
            r2 = ours("item.create", {
                "hostid": host_id, "name": "Dup", "key_": f"test.item[{ts}]",
                "type": 2, "value_type": 3, "delay": "0",
            }, ot)
            assert_ok(err(r2) is not None, "item.create duplicate key → error")

            # missing required fields → error
            r3 = ours("item.create", {"hostid": host_id, "name": "No Key"}, ot)
            assert_ok(err(r3) is not None, "item.create missing key_ → error")
            r4 = ours("item.create", {"key_": f"x.{ts}", "name": "No Host",
                                       "type": 2, "value_type": 3, "delay": "0"}, ot)
            assert_ok(err(r4) is not None, "item.create missing hostid → error")

            # update non-existent → error
            r5 = ours("item.update", {"itemid": "9999999999", "name": "X"}, ot)
            assert_ok(err(r5) is not None, "item.update non-existent → error")

        finally:
            if item_test_id:
                ours("item.delete", {"itemids": [item_test_id]}, ot)

        f3 = res(ours("item.get", {"itemids": [item_test_id or "0"], "output": ["itemid"]}, ot)) or []
        assert_ok(len(f3) == 0, "item: deleted item not found")
    else:
        warn("item CRUD skipped: no host available")

    # ═════════════════════════════════════════════════════════════════════════
    # 17. CRUD — trigger
    # ═════════════════════════════════════════════════════════════════════════
    section("17. CRUD — trigger.create / update / delete")

    trig_test_id = None
    try:
        r = ours("trigger.create", {
            "description": f"Test Trigger {ts}",
            "expression": f"last(/Zabbix server/system.cpu.load)>100",
            "priority": 2,
            "status": 1,  # disabled — don't fire it
            "comments": f"created by test {ts}",
        }, ot)
        assert_ok(not err(r), "trigger.create returns no error", str(err(r)))
        tids = (res(r) or {}).get("triggerids", [])
        assert_ok(len(tids) == 1, "trigger.create returns 1 triggerid")
        assert_ok(is_str_id(tids[0]), f"trigger.create triggerid is string digit ({tids[0]!r})")
        trig_test_id = tids[0]

        # verify get
        fetched = res(ours("trigger.get", {"triggerids": [trig_test_id], "output": "extend"}, ot)) or []
        assert_ok(len(fetched) == 1, "trigger: created trigger retrievable")
        if fetched:
            tg = fetched[0]
            assert_ok(tg["description"] == f"Test Trigger {ts}", "trigger.description matches")
            assert_ok(str(tg["priority"]) == "2", "trigger.priority matches")
            assert_ok(str(tg["status"]) == "1", "trigger.status matches")

        # update description and priority
        r = ours("trigger.update", {
            "triggerid": trig_test_id,
            "description": f"Test Trigger Updated {ts}",
            "priority": 4,
        }, ot)
        assert_ok(not err(r), "trigger.update returns no error", str(err(r)))
        fetched2 = res(ours("trigger.get", {"triggerids": [trig_test_id],
                                             "output": ["description","priority"]}, ot)) or []
        assert_ok(fetched2 and fetched2[0]["description"] == f"Test Trigger Updated {ts}",
                  "trigger.update description persisted")
        assert_ok(fetched2 and str(fetched2[0]["priority"]) == "4",
                  "trigger.update priority persisted")

        # missing required → error
        r2 = ours("trigger.create", {"expression": "last(/h/k)>0"}, ot)
        assert_ok(err(r2) is not None, "trigger.create missing description → error")
        r3 = ours("trigger.create", {"description": f"No expr {ts}"}, ot)
        assert_ok(err(r3) is not None, "trigger.create missing expression → error")

        # update non-existent → error
        r4 = ours("trigger.update", {"triggerid": "9999999999", "description": "X"}, ot)
        assert_ok(err(r4) is not None, "trigger.update non-existent → error")

        # delete missing param → error
        r5 = ours("trigger.delete", {"triggerids": []}, ot)
        assert_ok(err(r5) is not None, "trigger.delete empty list → error")

    finally:
        if trig_test_id:
            ours("trigger.delete", {"triggerids": [trig_test_id]}, ot)

    f3 = res(ours("trigger.get", {"triggerids": [trig_test_id or "0"],
                                   "output": ["triggerid"]}, ot)) or []
    assert_ok(len(f3) == 0, "trigger: deleted trigger not found")

    # ═════════════════════════════════════════════════════════════════════════
    # 18. CRUD — usermacro
    # ═════════════════════════════════════════════════════════════════════════
    section("18. CRUD — usermacro.create / update / delete")

    macro_id = None
    if host_id:
        macro_name = "{$TEST_" + ts + "}"
        try:
            r = ours("usermacro.create", {
                "hostid": host_id,
                "macro": macro_name,
                "value": "initial_value",
                "description": f"Test macro {ts}",
            }, ot)
            assert_ok(not err(r), "usermacro.create returns no error", str(err(r)))
            mids = (res(r) or {}).get("hostmacroids", [])
            assert_ok(len(mids) == 1, "usermacro.create returns 1 hostmacroid")
            assert_ok(is_str_id(mids[0]), f"usermacro.create id is string digit ({mids[0]!r})")
            macro_id = mids[0]

            # verify get
            fetched = res(ours("usermacro.get", {"hostmacroids": [macro_id],
                                                   "output": "extend"}, ot)) or []
            assert_ok(len(fetched) == 1, "usermacro: created macro retrievable")
            if fetched:
                m = fetched[0]
                assert_ok(m["macro"] == macro_name, f"usermacro.macro matches ({m.get('macro')!r})")
                assert_ok(m["value"] == "initial_value", "usermacro.value matches")
                assert_ok(str(m["hostid"]) == str(host_id), "usermacro.hostid matches")

            # update value
            r = ours("usermacro.update", {"hostmacroid": macro_id, "value": "updated_value"}, ot)
            assert_ok(not err(r), "usermacro.update returns no error", str(err(r)))
            fetched2 = res(ours("usermacro.get", {"hostmacroids": [macro_id],
                                                    "output": "extend"}, ot)) or []
            assert_ok(fetched2 and fetched2[0]["value"] == "updated_value",
                      "usermacro.update value persisted")

            # by hostids filter
            by_host = res(ours("usermacro.get", {"hostids": [host_id],
                                                   "output": "extend"}, ot)) or []
            found = any(m["hostmacroid"] == macro_id for m in by_host)
            assert_ok(found, "usermacro.get by hostids finds the created macro")

            # duplicate macro on same host → error
            r2 = ours("usermacro.create", {"hostid": host_id, "macro": macro_name,
                                             "value": "x"}, ot)
            assert_ok(err(r2) is not None, "usermacro.create duplicate → error")

            # invalid format → error
            r3 = ours("usermacro.create", {"hostid": host_id, "macro": "NOT_A_MACRO",
                                             "value": "x"}, ot)
            assert_ok(err(r3) is not None, "usermacro.create invalid format → error")

            # update non-existent → error
            r4 = ours("usermacro.update", {"hostmacroid": "9999999999", "value": "x"}, ot)
            assert_ok(err(r4) is not None, "usermacro.update non-existent → error")

        finally:
            if macro_id:
                ours("usermacro.delete", {"hostmacroids": [macro_id]}, ot)

        f3 = res(ours("usermacro.get", {"hostmacroids": [macro_id or "0"],
                                         "output": ["hostmacroid"]}, ot)) or []
        assert_ok(len(f3) == 0, "usermacro: deleted macro not found")
    else:
        warn("usermacro CRUD skipped: no host available")

    # ═════════════════════════════════════════════════════════════════════════
    # 19. CRUD — discoveryrule
    # ═════════════════════════════════════════════════════════════════════════
    section("19. CRUD — discoveryrule.create / update / delete")

    drule_test_id = None
    if host_id:
        try:
            r = ours("discoveryrule.create", {
                "hostid": host_id,
                "name": f"Test LLD Rule {ts}",
                "key_": f"test.lld[{ts}]",
                "type": 2,       # trapper
                "delay": "1h",
                "lifetime": "30d",
            }, ot)
            assert_ok(not err(r), "discoveryrule.create returns no error", str(err(r)))
            rids = (res(r) or {}).get("itemids", [])
            assert_ok(len(rids) == 1, "discoveryrule.create returns 1 itemid")
            assert_ok(is_str_id(rids[0]), f"discoveryrule.create itemid is string digit ({rids[0]!r})")
            drule_test_id = rids[0]

            # verify get
            fetched = res(ours("discoveryrule.get", {"itemids": [drule_test_id],
                                                      "output": "extend"}, ot)) or []
            assert_ok(len(fetched) == 1, "discoveryrule: created rule retrievable")
            if fetched:
                dr = fetched[0]
                assert_ok(dr["name"] == f"Test LLD Rule {ts}", "discoveryrule.name matches")
                assert_ok(dr["key_"] == f"test.lld[{ts}]", "discoveryrule.key_ matches")
                assert_ok(str(dr["flags"]) == "1", "discoveryrule.flags=1 (LLD)")
                assert_ok(str(dr["hostid"]) == str(host_id), "discoveryrule.hostid matches")

            # update name and delay
            r = ours("discoveryrule.update", {
                "itemid": drule_test_id,
                "name": f"Test LLD Rule Updated {ts}",
                "delay": "30m",
            }, ot)
            assert_ok(not err(r), "discoveryrule.update returns no error", str(err(r)))
            fetched2 = res(ours("discoveryrule.get", {"itemids": [drule_test_id],
                                                       "output": ["name","delay"]}, ot)) or []
            assert_ok(fetched2 and fetched2[0]["name"] == f"Test LLD Rule Updated {ts}",
                      "discoveryrule.update name persisted")
            assert_ok(fetched2 and fetched2[0]["delay"] == "30m",
                      "discoveryrule.update delay persisted")

            # duplicate key → error
            r2 = ours("discoveryrule.create", {
                "hostid": host_id, "name": "Dup LLD", "key_": f"test.lld[{ts}]",
                "type": 2, "delay": "1h", "lifetime": "30d",
            }, ot)
            assert_ok(err(r2) is not None, "discoveryrule.create duplicate key → error")

            # missing required → error
            r3 = ours("discoveryrule.create", {"hostid": host_id, "name": "No Key",
                                                "type": 2}, ot)
            assert_ok(err(r3) is not None, "discoveryrule.create missing key_ → error")
            r4 = ours("discoveryrule.create", {"name": "No Host", "key_": f"y.{ts}",
                                                "type": 2}, ot)
            assert_ok(err(r4) is not None, "discoveryrule.create missing hostid → error")

            # update non-existent → error
            r5 = ours("discoveryrule.update", {"itemid": "9999999999", "name": "X"}, ot)
            assert_ok(err(r5) is not None, "discoveryrule.update non-existent → error")

        finally:
            if drule_test_id:
                ours("discoveryrule.delete", {"itemids": [drule_test_id]}, ot)

        f3 = res(ours("discoveryrule.get", {"itemids": [drule_test_id or "0"],
                                             "output": ["itemid"]}, ot)) or []
        assert_ok(len(f3) == 0, "discoveryrule: deleted rule not found")
    else:
        warn("discoveryrule CRUD skipped: no host available")

    # ═════════════════════════════════════════════════════════════════════════
    # 20. event.acknowledge
    # ═════════════════════════════════════════════════════════════════════════
    section("20. event.acknowledge")

    if event_ids:
        ack_eid = event_ids[0]
        # acknowledge with message (action=6: ACK_ACKNOWLEDGE|ACK_MESSAGE)
        r = ours("event.acknowledge", {
            "eventids": [ack_eid],
            "action": 6,
            "message": f"Test ack {ts}",
        }, ot)
        assert_ok(not err(r), "event.acknowledge returns no error", str(err(r)))
        ack_result = res(r) or {}
        assert_ok("eventids" in ack_result, "event.acknowledge result has eventids key")
        assert_ok(str(ack_eid) in [str(x) for x in ack_result.get("eventids", [])],
                  "event.acknowledge result contains our eventid")

        # verify acknowledges appear in event.get selectAcknowledges
        ev = res(ours("event.get", {"eventids": [ack_eid], "output": "extend",
                                     "selectAcknowledges": "extend"}, ot)) or []
        assert_ok(len(ev) == 1, "acknowledged event still retrievable")
        if ev:
            acks = ev[0].get("acknowledges", [])
            assert_ok(isinstance(acks, list), "event.acknowledges is a list")
            found = any(a.get("message") == f"Test ack {ts}" for a in acks)
            assert_ok(found, "event.acknowledge: our message appears in acknowledges",
                      f"acks messages: {[a.get('message') for a in acks]}")
            if acks:
                a = acks[-1]
                for k in ("acknowledgeid", "userid", "clock", "message", "action"):
                    assert_ok(k in a, f"acknowledge entry has {k!r} key")

        # also verify in problem.get selectAcknowledges if that event is a problem
        if prob_ids and str(ack_eid) in [str(p) for p in prob_ids]:
            pv = res(ours("problem.get", {"eventids": [ack_eid], "output": "extend",
                                           "selectAcknowledges": "extend"}, ot)) or []
            if pv:
                p_acks = pv[0].get("acknowledges", [])
                found_p = any(a.get("message") == f"Test ack {ts}" for a in p_acks)
                assert_ok(found_p, "problem.selectAcknowledges also shows our message")

        # missing eventids → error
        r2 = ours("event.acknowledge", {"action": 2, "message": "x"}, ot)
        assert_ok(err(r2) is not None, "event.acknowledge missing eventids → error")

        # non-existent eventid → error
        r3 = ours("event.acknowledge", {"eventids": ["9999999999"], "action": 2, "message": "x"}, ot)
        assert_ok(err(r3) is not None, "event.acknowledge non-existent eventid → error")
    else:
        warn("event.acknowledge skipped: no events available")

    # ═════════════════════════════════════════════════════════════════════════
    # 21. Delete error cases
    # ═════════════════════════════════════════════════════════════════════════
    section("21. Delete error cases")

    # non-existent IDs → error
    for method, params, label in [
        ("hostgroup.delete",    {"groupids":   ["9999999999"]}, "hostgroup"),
        ("host.delete",         {"hostids":    ["9999999999"]}, "host"),
        ("item.delete",         {"itemids":    ["9999999999"]}, "item"),
        ("trigger.delete",      {"triggerids": ["9999999999"]}, "trigger"),
        ("discoveryrule.delete",{"itemids":    ["9999999999"]}, "discoveryrule"),
        ("usermacro.delete",    {"hostmacroids":["9999999999"]},"usermacro"),
    ]:
        r = ours(method, params, ot)
        # Zabbix returns error for non-existent IDs
        assert_ok(err(r) is not None, f"{label}.delete non-existent → error", str(res(r)))

    # empty param list → error
    for method, params, label in [
        ("hostgroup.delete",    {"groupids":   []}, "hostgroup"),
        ("host.delete",         {"hostids":    []}, "host"),
        ("item.delete",         {"itemids":    []}, "item"),
        ("trigger.delete",      {"triggerids": []}, "trigger"),
        ("discoveryrule.delete",{"itemids":    []}, "discoveryrule"),
    ]:
        r = ours(method, params, ot)
        assert_ok(err(r) is not None, f"{label}.delete empty list → error", str(res(r)))

    # ═════════════════════════════════════════════════════════════════════════
    # SUMMARY
    # ═════════════════════════════════════════════════════════════════════════
    total = _passes + _fails
    print(f"\n{'═'*60}")
    print(f"{BOLD}  {GREEN}{_passes}/{total} passed{RESET}", end="")
    if _fails:
        print(f"  {RED}{_fails} FAILED{RESET}", end="")
    print(f"\n{'═'*60}\n")
    sys.exit(0 if _fails == 0 else 1)


if __name__ == "__main__":
    main()
