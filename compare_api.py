#!/usr/bin/env python3
"""
Compare real Zabbix 7.0 API (port 80) vs our implementation (port 8090).
Calls GET methods on both, compares response structure and field sets.

Usage:
  python3 compare_api.py
  python3 compare_api.py --user Admin --password zabbix
"""
import argparse
import json
import sys
import urllib.request
import urllib.error
from typing import Any

REAL_URL = "http://localhost/api_jsonrpc.php"
OUR_URL  = "http://localhost:8090/api_jsonrpc.php"

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
CYAN   = "\033[36m"
RESET  = "\033[0m"
BOLD   = "\033[1m"


def rpc(url: str, method: str, params: dict, token: str | None = None) -> Any:
    body = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    if token:
        body["auth"] = token
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": {"code": e.code, "message": str(e)}}
    except Exception as e:
        return {"error": {"code": -1, "message": str(e)}}


def login(url: str, user: str, password: str) -> str | None:
    resp = rpc(url, "user.login", {"username": user, "password": password})
    return resp.get("result") if isinstance(resp.get("result"), str) else None


def keys_of(obj: Any) -> set[str]:
    """Recursively get top-level keys of first list item or dict."""
    if isinstance(obj, list):
        return keys_of(obj[0]) if obj else set()
    if isinstance(obj, dict):
        return set(obj.keys())
    return set()


def type_label(obj: Any) -> str:
    if isinstance(obj, list):
        return f"list[{len(obj)}]"
    if isinstance(obj, dict):
        return "dict"
    if isinstance(obj, str):
        return f"str({repr(obj)[:40]})"
    return type(obj).__name__


def compare_responses(method: str, real_r: Any, our_r: Any) -> tuple[bool, list[str]]:
    """Returns (ok, [messages])."""
    msgs = []
    ok = True

    real_err = real_r.get("error") if isinstance(real_r, dict) else None
    our_err  = our_r.get("error")  if isinstance(our_r, dict) else None

    real_res = real_r.get("result") if isinstance(real_r, dict) else None
    our_res  = our_r.get("result")  if isinstance(our_r, dict) else None

    # both errored
    if real_err and our_err:
        msgs.append(f"  both errored — real: {real_err.get('message')} / ours: {our_err.get('message')}")
        return True, msgs  # acceptable

    # real errored but ours didn't (or vice versa)
    if real_err and not our_err:
        msgs.append(f"  {RED}real returned error but ours succeeded{RESET}: {real_err}")
        return True, msgs  # ours is better or data differs

    if our_err and not real_err:
        msgs.append(f"  {RED}OURS ERRORED{RESET}: {our_err.get('message')} / data: {our_err.get('data','')}")
        return False, msgs

    # type mismatch
    rt = type_label(real_res)
    ot = type_label(our_res)
    if type(real_res) != type(our_res):
        msgs.append(f"  {RED}TYPE MISMATCH{RESET}: real={rt}  ours={ot}")
        ok = False
    else:
        msgs.append(f"  type: {GREEN}{rt}{RESET}")

    # key comparison for list/dict results
    real_keys = keys_of(real_res)
    our_keys  = keys_of(our_res)

    if real_keys or our_keys:
        missing  = real_keys - our_keys
        extra    = our_keys  - real_keys
        common   = real_keys & our_keys

        msgs.append(f"  keys common({len(common)}): {CYAN}{', '.join(sorted(common))}{RESET}")
        if missing:
            msgs.append(f"  {RED}MISSING in ours{RESET}: {', '.join(sorted(missing))}")
            ok = False
        if extra:
            msgs.append(f"  {YELLOW}extra in ours{RESET}: {', '.join(sorted(extra))}")

    # count
    if isinstance(real_res, list) and isinstance(our_res, list):
        rc, oc = len(real_res), len(our_res)
        color = GREEN if rc == oc else YELLOW
        msgs.append(f"  count: real={color}{rc}{RESET}  ours={color}{oc}{RESET}")

    return ok, msgs


def run_test(label: str, method: str, params: dict,
             real_tok: str, our_tok: str) -> bool:
    real_r = rpc(REAL_URL, method, params, real_tok)
    our_r  = rpc(OUR_URL,  method, params, our_tok)
    ok, msgs = compare_responses(method, real_r, our_r)
    status = f"{GREEN}OK{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"\n{BOLD}[{status}{BOLD}] {label}{RESET}")
    for m in msgs:
        print(m)
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user",     default="Admin")
    parser.add_argument("--password", default="zabbix")
    args = parser.parse_args()

    print(f"{BOLD}Logging in…{RESET}")
    real_tok = login(REAL_URL, args.user, args.password)
    our_tok  = login(OUR_URL,  args.user, args.password)

    if not real_tok:
        print(f"{RED}Cannot login to real Zabbix at {REAL_URL}{RESET}")
        sys.exit(1)
    if not our_tok:
        print(f"{RED}Cannot login to our API at {OUR_URL}{RESET}")
        sys.exit(1)

    print(f"  real token: {real_tok[:16]}…")
    print(f"  our  token: {our_tok[:16]}…")

    # ── Discover fixture IDs ──────────────────────────────────────────────────
    print(f"\n{BOLD}Discovering fixture IDs…{RESET}")

    hosts = rpc(REAL_URL, "host.get", {"output": ["hostid","name"], "limit": 3}, real_tok)
    host_ids = [h["hostid"] for h in (hosts.get("result") or [])]
    host_id  = host_ids[0] if host_ids else None
    print(f"  hosts: {host_ids}")

    groups = rpc(REAL_URL, "hostgroup.get", {"output": ["groupid","name"], "limit": 3}, real_tok)
    group_ids = [g["groupid"] for g in (groups.get("result") or [])]
    group_id  = group_ids[0] if group_ids else None
    print(f"  groups: {group_ids}")

    items = rpc(REAL_URL, "item.get",
                {"output": ["itemid","name"], "hostids": host_ids, "limit": 3}, real_tok)
    item_ids = [i["itemid"] for i in (items.get("result") or [])]
    item_id  = item_ids[0] if item_ids else None
    print(f"  items: {item_ids}")

    triggers = rpc(REAL_URL, "trigger.get",
                   {"output": ["triggerid"], "hostids": host_ids, "limit": 3}, real_tok)
    trigger_ids = [t["triggerid"] for t in (triggers.get("result") or [])]
    trigger_id  = trigger_ids[0] if trigger_ids else None
    print(f"  triggers: {trigger_ids}")

    events = rpc(REAL_URL, "event.get",
                 {"output": ["eventid"], "source": 0, "object": 0, "limit": 3}, real_tok)
    event_ids = [e["eventid"] for e in (events.get("result") or [])]
    event_id  = event_ids[0] if event_ids else None
    print(f"  events: {event_ids}")

    probs = rpc(REAL_URL, "problem.get",
                {"output": ["eventid"], "limit": 3}, real_tok)
    prob_ids = [p["eventid"] for p in (probs.get("result") or [])]
    print(f"  problems: {prob_ids}")

    drules = rpc(REAL_URL, "discoveryrule.get",
                 {"output": ["itemid"], "hostids": host_ids, "limit": 3}, real_tok)
    drule_ids = [r["itemid"] for r in (drules.get("result") or [])]
    drule_id  = drule_ids[0] if drule_ids else None
    print(f"  discovery rules: {drule_ids}")

    # ── Discover more fixture IDs ─────────────────────────────────────────────

    # active triggers (value=1) for trigger tests
    active_triggers = rpc(REAL_URL, "trigger.get",
                          {"output": ["triggerid","value"], "only_true": True,
                           "monitored": True, "limit": 5}, real_tok)
    active_tids = [t["triggerid"] for t in (active_triggers.get("result") or [])]
    active_tid  = active_tids[0] if active_tids else None
    print(f"  active triggers (value=1): {active_tids}")

    # active problems
    act_probs = rpc(REAL_URL, "problem.get",
                    {"output": ["eventid","severity"], "limit": 5}, real_tok)
    act_prob_ids = [p["eventid"] for p in (act_probs.get("result") or [])]
    act_prob_id  = act_prob_ids[0] if act_prob_ids else None
    print(f"  active problems: {act_prob_ids}")

    # acked problems
    acked_probs = rpc(REAL_URL, "problem.get",
                      {"output": ["eventid"], "acknowledged": True, "limit": 3}, real_tok)
    acked_prob_ids = [p["eventid"] for p in (acked_probs.get("result") or [])]
    print(f"  acked problems: {acked_prob_ids}")

    # items that have trend data
    trend_float_items = rpc(REAL_URL, "trend.get",
                            {"output": ["itemid"], "history": 0, "limit": 3,
                             "time_from": 1771200000}, real_tok)
    trend_float_ids = list({r["itemid"] for r in (trend_float_items.get("result") or [])})[:3]
    print(f"  trend float itemids: {trend_float_ids}")

    trend_uint_items = rpc(REAL_URL, "trend.get",
                           {"output": ["itemid"], "history": 3, "limit": 3,
                            "time_from": 1771200000}, real_tok)
    trend_uint_ids = list({r["itemid"] for r in (trend_uint_items.get("result") or [])})[:3]
    print(f"  trend uint itemids: {trend_uint_ids}")

    # ── Tests ─────────────────────────────────────────────────────────────────
    results = []

    def t(label, method, params):
        results.append(run_test(label, method, params, real_tok, our_tok))

    print(f"\n{'═'*60}")
    print(f"{BOLD}  RUNNING COMPARISON TESTS{RESET}")
    print('═'*60)

    # apiinfo
    t("apiinfo.version", "apiinfo.version", {})

    # hostgroup
    t("hostgroup.get — all",        "hostgroup.get", {"output": "extend"})
    t("hostgroup.get — by ids",     "hostgroup.get", {"groupids": group_ids, "output": "extend"})
    t("hostgroup.get — countOutput","hostgroup.get", {"countOutput": True})
    t("hostgroup.get — real_hosts", "hostgroup.get", {"real_hosts": True, "output": "extend"})
    t("hostgroup.get — with_hosts", "hostgroup.get", {"with_hosts": True, "output": "extend"})

    # host
    t("host.get — all",             "host.get", {"output": "extend", "limit": 10})
    t("host.get — by ids",          "host.get", {"hostids": host_ids, "output": "extend"})
    t("host.get — by groupids",     "host.get", {"groupids": group_ids, "output": "extend"})
    t("host.get — selectGroups",    "host.get", {"hostids": host_ids, "output": "extend",
                                                  "selectGroups": "extend"})
    t("host.get — selectInterfaces","host.get", {"hostids": host_ids, "output": "extend",
                                                  "selectInterfaces": "extend"})
    t("host.get — selectTags",      "host.get", {"hostids": host_ids, "output": "extend",
                                                  "selectTags": "extend"})
    t("host.get — monitored",       "host.get", {"monitored_hosts": True, "output": "extend", "limit": 5})
    t("host.get — countOutput",     "host.get", {"countOutput": True})

    # item
    if host_ids:
        t("item.get — by hostids",      "item.get", {"hostids": host_ids, "output": "extend", "limit": 5})
        t("item.get — by itemids",      "item.get", {"itemids": item_ids, "output": "extend"})
        t("item.get — selectHosts",     "item.get", {"itemids": item_ids, "output": "extend",
                                                      "selectHosts": "extend"})
        t("item.get — selectTags",      "item.get", {"itemids": item_ids, "output": "extend",
                                                      "selectTags": "extend"})
        t("item.get — sortfield/order", "item.get", {"hostids": host_ids, "output": "extend",
                                                      "sortfield": "key_", "sortorder": "ASC", "limit": 5})
        t("item.get — countOutput",     "item.get", {"hostids": host_ids, "countOutput": True})

    # ── trigger.get ───────────────────────────────────────────────────────────
    print(f"\n{BOLD}--- trigger.get ---{RESET}")

    # basic
    if host_ids:
        t("trigger.get — by hostids",         "trigger.get",
          {"hostids": host_ids, "output": "extend", "limit": 5})
        t("trigger.get — by groupids",        "trigger.get",
          {"groupids": group_ids, "output": "extend", "limit": 5})
    if trigger_ids:
        t("trigger.get — by triggerids",      "trigger.get",
          {"triggerids": trigger_ids, "output": "extend"})
    t("trigger.get — empty triggerids",       "trigger.get",
      {"triggerids": [], "output": "extend"})

    # output field subsets
    if trigger_ids:
        t("trigger.get — output fields subset","trigger.get",
          {"triggerids": trigger_ids,
           "output": ["triggerid","description","priority","value","lastchange"]})

    # filters: value / status / priority
    if host_ids:
        t("trigger.get — filter value=1",     "trigger.get",
          {"hostids": host_ids, "filter": {"value": 1}, "output": "extend", "limit": 5})
        t("trigger.get — filter value=0",     "trigger.get",
          {"hostids": host_ids, "filter": {"value": 0}, "output": "extend", "limit": 5})
        t("trigger.get — filter status=0",    "trigger.get",
          {"hostids": host_ids, "filter": {"status": 0}, "output": "extend", "limit": 5})
        t("trigger.get — only_true",          "trigger.get",
          {"hostids": host_ids, "only_true": True, "output": "extend", "limit": 5})
        t("trigger.get — monitored",          "trigger.get",
          {"hostids": host_ids, "monitored": True, "output": "extend", "limit": 5})
        t("trigger.get — skipDependent",      "trigger.get",
          {"hostids": host_ids, "skipDependent": True, "monitored": True,
           "output": "extend", "limit": 5})
        t("trigger.get — only_true+monitored+skipDep","trigger.get",
          {"hostids": host_ids, "only_true": True, "monitored": True,
           "skipDependent": True, "output": "extend"})

    # Grafana-style: global monitored problems
    t("trigger.get — Grafana all monitored active", "trigger.get",
      {"only_true": True, "monitored": True, "skipDependent": True,
       "output": "extend", "preservekeys": True})

    # selects
    if trigger_ids:
        t("trigger.get — selectHosts",        "trigger.get",
          {"triggerids": trigger_ids, "output": "extend",
           "selectHosts": ["hostid","name","host","maintenance_status","description","proxyid"]})
        t("trigger.get — selectHosts extend", "trigger.get",
          {"triggerids": trigger_ids, "output": "extend", "selectHosts": "extend"})
        t("trigger.get — selectHostGroups",   "trigger.get",
          {"triggerids": trigger_ids, "output": "extend",
           "selectHostGroups": ["groupid","name"]})
        t("trigger.get — selectItems",        "trigger.get",
          {"triggerids": trigger_ids, "output": "extend",
           "selectItems": ["itemid","name","key_","lastvalue"]})
        t("trigger.get — selectLastEvent",    "trigger.get",
          {"triggerids": trigger_ids, "output": "extend", "selectLastEvent": "extend"})
        t("trigger.get — selectTags",         "trigger.get",
          {"triggerids": trigger_ids, "output": "extend", "selectTags": "extend"})
        t("trigger.get — selectFunctions",    "trigger.get",
          {"triggerids": trigger_ids, "output": "extend", "selectFunctions": "extend"})
        t("trigger.get — selectDependencies", "trigger.get",
          {"triggerids": trigger_ids, "output": "extend", "selectDependencies": "extend"})
        t("trigger.get — all selects",        "trigger.get",
          {"triggerids": trigger_ids, "output": "extend",
           "selectHosts": "extend", "selectHostGroups": "extend",
           "selectItems": "extend", "selectLastEvent": "extend",
           "selectTags": "extend", "selectDependencies": "extend"})
        t("trigger.get — preservekeys",       "trigger.get",
          {"triggerids": trigger_ids, "output": "extend", "preservekeys": True})

    # active triggers with all selects (Grafana problems panel full request)
    if active_tids:
        t("trigger.get — active+all selects", "trigger.get",
          {"triggerids": active_tids, "output": "extend",
           "expandDescription": True, "expandExpression": True,
           "monitored": True, "skipDependent": True,
           "selectHostGroups": ["name","groupid"],
           "selectHosts": ["hostid","name","host","maintenance_status","description","proxyid"],
           "selectItems": ["itemid","name","key_","lastvalue"],
           "preservekeys": True})

    # sort / count
    if host_ids:
        t("trigger.get — sort priority DESC",  "trigger.get",
          {"hostids": host_ids, "output": "extend",
           "sortfield": "priority", "sortorder": "DESC", "limit": 5})
        t("trigger.get — sort description ASC","trigger.get",
          {"hostids": host_ids, "output": "extend",
           "sortfield": "description", "sortorder": "ASC", "limit": 5})
        t("trigger.get — countOutput",         "trigger.get",
          {"hostids": host_ids, "countOutput": True})
    t("trigger.get — countOutput all",         "trigger.get",
      {"countOutput": True})
    t("trigger.get — countOutput only_true",   "trigger.get",
      {"only_true": True, "monitored": True, "countOutput": True})

    # ── event.get ─────────────────────────────────────────────────────────────
    print(f"\n{BOLD}--- event.get ---{RESET}")
    t("event.get — recent",           "event.get",
      {"output": "extend", "source": 0, "object": 0, "limit": 5})
    if event_ids:
        t("event.get — by ids",        "event.get",
          {"eventids": event_ids, "output": "extend"})
        t("event.get — selectTags",    "event.get",
          {"eventids": event_ids, "output": "extend", "selectTags": "extend"})
        t("event.get — selectAcknowledges", "event.get",
          {"eventids": event_ids, "output": "extend", "selectAcknowledges": "extend"})
        t("event.get — selectHosts",   "event.get",
          {"eventids": event_ids, "output": "extend", "selectHosts": "extend"})
    t("event.get — countOutput",       "event.get",
      {"countOutput": True, "source": 0, "object": 0})

    # ── problem.get ───────────────────────────────────────────────────────────
    print(f"\n{BOLD}--- problem.get ---{RESET}")

    # basic
    t("problem.get — active (default)",   "problem.get", {"output": "extend", "limit": 5})
    t("problem.get — recent=True",        "problem.get", {"output": "extend", "recent": True, "limit": 5})
    t("problem.get — countOutput active", "problem.get", {"countOutput": True})
    t("problem.get — countOutput recent", "problem.get", {"countOutput": True, "recent": True})

    if act_prob_ids:
        t("problem.get — by eventids",    "problem.get",
          {"eventids": act_prob_ids, "output": "extend"})
        t("problem.get — selectTags",     "problem.get",
          {"eventids": act_prob_ids, "output": "extend", "selectTags": "extend"})
        t("problem.get — selectAcknowledges","problem.get",
          {"eventids": act_prob_ids, "output": "extend", "selectAcknowledges": "extend"})
        t("problem.get — selectHosts",    "problem.get",
          {"eventids": act_prob_ids, "output": "extend", "selectHosts": "extend"})
        t("problem.get — all selects",    "problem.get",
          {"eventids": act_prob_ids, "output": "extend",
           "selectTags": "extend", "selectAcknowledges": "extend",
           "selectHosts": "extend", "selectSuppressionData": "extend"})

    # filters
    t("problem.get — severity 3+4+5",     "problem.get",
      {"output": "extend", "severities": [3, 4, 5], "limit": 5})
    t("problem.get — severity 0+1+2",     "problem.get",
      {"output": "extend", "severities": [0, 1, 2], "limit": 5})
    if acked_prob_ids:
        t("problem.get — acknowledged=True","problem.get",
          {"eventids": acked_prob_ids, "output": "extend", "acknowledged": True})
    t("problem.get — acknowledged=False", "problem.get",
      {"output": "extend", "acknowledged": False, "limit": 5})

    # group/host filter
    if group_ids:
        t("problem.get — by groupids",    "problem.get",
          {"groupids": group_ids, "output": "extend", "limit": 5})
    if host_ids:
        t("problem.get — by hostids",     "problem.get",
          {"hostids": host_ids, "output": "extend", "limit": 5})

    # time range (last 24h)
    import time
    now = int(time.time())
    t("problem.get — time_from 24h",      "problem.get",
      {"output": "extend", "time_from": now - 86400, "limit": 10})
    t("problem.get — time_from 7d recent","problem.get",
      {"output": "extend", "recent": True,
       "time_from": now - 7 * 86400, "limit": 10})

    # sort
    t("problem.get — sort eventid DESC",  "problem.get",
      {"output": "extend", "sortfield": "eventid", "sortorder": "DESC", "limit": 5})
    t("problem.get — preservekeys",       "problem.get",
      {"output": "extend", "preservekeys": True,
       "sortfield": "eventid", "sortorder": "ASC", "limit": 3})

    # old problems (from prob_ids discovered at start)
    if prob_ids:
        t("problem.get — by prob eventids","problem.get",
          {"eventids": prob_ids, "output": "extend"})
        t("problem.get — selectAcknowledges old","problem.get",
          {"eventids": prob_ids, "output": "extend", "selectAcknowledges": "extend"})

    # ── history.get ───────────────────────────────────────────────────────────
    if item_ids:
        for vt, label in [(0,"Float"),(3,"Uint"),(1,"Str"),(4,"Text")]:
            t(f"history.get — value_type={vt} ({label})", "history.get",
              {"itemids": item_ids, "history": vt, "limit": 5, "output": "extend"})
        t("history.get — sortorder ASC",  "history.get",
          {"itemids": item_ids, "history": 3, "limit": 5,
           "sortorder": "ASC", "output": "extend"})
        t("history.get — time range",     "history.get",
          {"itemids": item_ids, "history": 3,
           "time_from": now - 3600, "time_till": now, "output": "extend"})

    # ── trend.get ─────────────────────────────────────────────────────────────
    print(f"\n{BOLD}--- trend.get ---{RESET}")
    if trend_float_ids:
        t("trend.get — float history=0",  "trend.get",
          {"itemids": trend_float_ids, "history": 0, "output": "extend", "limit": 5,
           "time_from": 1771200000})
        t("trend.get — float no history param","trend.get",
          {"itemids": trend_float_ids, "output": "extend", "limit": 5,
           "time_from": 1771200000})
        t("trend.get — float sortorder DESC","trend.get",
          {"itemids": trend_float_ids, "history": 0, "output": "extend", "limit": 5,
           "time_from": 1771200000, "sortorder": "DESC"})
    if trend_uint_ids:
        t("trend.get — uint history=3",   "trend.get",
          {"itemids": trend_uint_ids, "history": 3, "output": "extend", "limit": 5,
           "time_from": 1771200000})
        t("trend.get — uint no history param","trend.get",
          {"itemids": trend_uint_ids, "output": "extend", "limit": 5,
           "time_from": 1771200000})

    # discoveryrule
    if host_ids:
        t("discoveryrule.get — by hostids", "discoveryrule.get",
          {"hostids": host_ids, "output": "extend", "limit": 5})
    if drule_id:
        t("discoveryrule.get — selectFilter",        "discoveryrule.get",
          {"itemids": [drule_id], "output": "extend", "selectFilter": True})
        t("discoveryrule.get — selectLLDMacroPaths", "discoveryrule.get",
          {"itemids": [drule_id], "output": "extend", "selectLLDMacroPaths": True})

    # itemprototype / triggerprototype / graphprototype
    if drule_id:
        t("itemprototype.get",    "itemprototype.get",
          {"discoveryids": [drule_id], "output": "extend", "limit": 5})
        t("triggerprototype.get", "triggerprototype.get",
          {"discoveryids": [drule_id], "output": "extend", "limit": 5})
        t("graphprototype.get",   "graphprototype.get",
          {"discoveryids": [drule_id], "output": "extend", "limit": 5})

    # usermacro
    if host_ids:
        t("usermacro.get — by hostids", "usermacro.get",
          {"hostids": host_ids, "output": "extend"})
    t("usermacro.get — global", "usermacro.get", {"globalmacro": True, "output": "extend"})

    # extra / compat
    t("application.get (stub)", "application.get", {"output": "extend"})
    t("valuemap.get",           "valuemap.get",     {"output": "extend", "limit": 5})
    t("valuemap.get — selectMappings", "valuemap.get",
      {"output": "extend", "limit": 3, "selectMappings": "extend"})
    t("user.get",               "user.get",         {"output": "extend", "limit": 5})
    t("proxy.get",              "proxy.get",        {"output": "extend"})

    # ── Summary ───────────────────────────────────────────────────────────────
    total = len(results)
    passed = sum(results)
    failed = total - passed
    print(f"\n{'═'*60}")
    print(f"{BOLD}  SUMMARY: {GREEN}{passed}/{total} passed{RESET}", end="")
    if failed:
        print(f"  {RED}{failed} FAILED{RESET}", end="")
    print(f"\n{'═'*60}\n")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
