"""RTAC VLAN Deploy bridge: put a bench of RTACs on a VLAN and load their projects.

One JSON request on STDIN:

    {"switchIp": "10.42.44.12", "vlan": 14,
     "rtacs": [{"networkIp": "10.42.44.34", "vlanIp": "172.16.100.200/24",
                "port": 3, "project": "Station A RTAC"}, ...]}

Runs in order, inside one AcRTAC session:
  0. check every project exists in the AcRTAC database (before touching any device)
  1. every RTAC at once: Eth_02 -> its VLAN IP, over its web interface at networkIp
  2. switch: every RTAC's port -> untagged on the VLAN, in one save
  3. each RTAC, one at a time: upload its project over networkIp

A stage that fails for any RTAC stops the run before the next stage, so the
bench is never left half-moved onto a VLAN it can't reach; uploads (stage 3)
each stand alone and all are attempted. The upload sends no `advanced`
settings, so it doesn't touch the Ethernet 2 address stage 1 just set.

Narration goes to stderr (the job log); the result prints as one JSON
document on stdout:

    {"rtacs": [{"networkIp", "project", "ip": {...}, "upload": {...}}],
     "vlan": {...} | null, "stoppedAt": null | "ip" | "vlan"}
"""

import contextlib
import ipaddress
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from acrtac_common import run_session, wait_on

import sel_web

PORT = "Eth_02"             # the RTAC port that joins the VLAN
WEB_USER = WEB_PASSWORD = "SEL"      # RTAC + switch web login (factory default)
RTAC_USER = RTAC_PASSWORD = "SEL"    # RTAC device login for the upload


def say(line):
    print(line, file=sys.stderr, flush=True)


def validate(request):
    """The single authority on what a deploy request means (the Node service
    only checks that the fields are filled in). Returns (switch_ip, vid, rtacs)
    with addresses normalized; raises ValueError naming the bad field."""
    def ipv4(value, label):
        try:
            return str(ipaddress.IPv4Address(str(value).strip()))
        except ValueError:
            raise ValueError(f"{label}: {str(value).strip()!r} is not an IPv4 address") from None

    def whole(value, lo, hi, label):
        text = str(value).strip()
        if not text.isdigit() or not lo <= int(text) <= hi:
            raise ValueError(f"{label} must be a whole number {lo}-{hi}")
        return int(text)

    switch_ip = ipv4(request["switchIp"], "Switch IP")
    vid = whole(request["vlan"], 1, 4094, "VLAN ID")
    rtacs = []
    for n, r in enumerate(request["rtacs"], 1):
        try:
            vlan_ip = sel_web.ip_mask(r["vlanIp"])
        except ValueError as e:
            raise ValueError(f"RTAC {n} VLAN IP: {e}") from None
        rtacs.append({
            "networkIp": ipv4(r["networkIp"], f"RTAC {n} network IP"),
            "vlanIp": vlan_ip,
            "port": whole(r["port"], 1, 999, f"RTAC {n} switch port"),
            "project": str(r["project"]).strip(),
        })
    if not rtacs:
        raise ValueError("no RTACs given")
    for label, values in (("network IP", [r["networkIp"] for r in rtacs]),
                          ("VLAN IP", [r["vlanIp"].split("/")[0] for r in rtacs]),
                          ("switch port", [r["port"] for r in rtacs])):
        if dup := sorted({v for v in values if values.count(v) > 1}):
            raise ValueError(f"the same {label} is used twice: {', '.join(map(str, dup))}")
    return switch_ip, vid, rtacs


def check_projects(cli, rtacs):
    have = {p.name for p in cli.listprojects()}
    if missing := sorted({r["project"] for r in rtacs} - have):
        raise RuntimeError("not in the AcRTAC database: " + ", ".join(missing))


def set_port(r):
    try:
        with sel_web.SelWeb(r["networkIp"], WEB_USER, WEB_PASSWORD, "rtac") as web:
            return {"ok": True, **sel_web.set_interface_ip(web, PORT, r["vlanIp"], r["networkIp"])}
    except sel_web.SelWebError as e:
        return {"ok": False, "error": str(e)}


def stage_ip(rtacs, results):
    """Every RTAC at once — separate hosts, separate web sessions; the stage
    only has to be complete before the switch moves their ports."""
    say(f"— Stage 1: {PORT} on {len(rtacs)} RTAC(s)")
    with ThreadPoolExecutor(max_workers=min(8, len(rtacs))) as pool:
        jobs = {pool.submit(set_port, r): (r, res) for r, res in zip(rtacs, results)}
        for done in as_completed(jobs):
            r, res = jobs[done]
            res["ip"] = out = done.result()
            if not out["ok"]:
                say(f"✕ {r['networkIp']}: {out['error']}")
            elif out["changed"]:
                say(f"✓ {r['networkIp']}: {PORT} {out['before']} → {out['after']}")
            else:
                say(f"✓ {r['networkIp']}: {PORT} already {out['after']}")
    return all(res["ip"]["ok"] for res in results)


def stage_vlan(switch_ip, vid, rtacs):
    ports = [r["port"] for r in rtacs]
    say(f"— Stage 2: switch {switch_ip}, ports {sel_web.fold_ports(ports)} → VLAN {vid} (untagged)")
    try:
        with sel_web.SelWeb(switch_ip, WEB_USER, WEB_PASSWORD, "switch") as web:
            out = sel_web.add_untagged_ports(web, vid, ports, say)
        say(f"✓ VLAN {vid} untagged: {out['before'] or '-'} → {out['after']}" if out["changed"]
            else f"✓ ports already untagged on VLAN {vid}")
        return {"ok": True, **out}
    except sel_web.SelWebError as e:
        say(f"✕ switch {switch_ip}: {e}")
        return {"ok": False, "error": str(e)}


def stage_upload(cli, rtacs, results):
    say(f"— Stage 3: upload {len(rtacs)} project(s), one at a time")
    for i, (r, res) in enumerate(zip(rtacs, results), 1):
        say(f"… [{i}/{len(rtacs)}] {r['project']} → {r['networkIp']}")
        try:
            # the Session quotes the project name (see acrtac_common.Session)
            sent = cli.upload(r["project"], r["networkIp"], RTAC_USER,
                              password=RTAC_PASSWORD)
            wait_on(sent)
            if sent is False:
                # upload() returns False when AcRTAC only went online, nothing sent
                res["upload"] = {"ok": False, "error": "AcRTAC went online but did not send the project"}
                say(f"✕ {r['networkIp']}: went online but did not send")
            else:
                res["upload"] = {"ok": True}
                say(f"✓ {r['networkIp']}: {r['project']} sent")
        except Exception as e:  # any selacrtac failure is this RTAC's, not the run's
            res["upload"] = {"ok": False, "error": str(e)}
            say(f"✕ {r['networkIp']}: {e}")


def deploy(cli, switch_ip, vid, rtacs):
    """The run, inside a logged-in AcRTAC session."""
    results = [{"networkIp": r["networkIp"], "project": r["project"], "ip": None, "upload": None}
               for r in rtacs]
    out = {"rtacs": results, "vlan": None, "stoppedAt": None}
    # selacrtac or the CLI may print; keep stdout clean for the JSON result.
    with contextlib.redirect_stdout(sys.stderr):
        check_projects(cli, rtacs)
        if not stage_ip(rtacs, results):
            out["stoppedAt"] = "ip"
            say("Stopped: fix the failed RTAC(s) and run again (finished ones are skipped as no-ops).")
            return out
        out["vlan"] = stage_vlan(switch_ip, vid, rtacs)
        if not out["vlan"]["ok"]:
            out["stoppedAt"] = "vlan"
            say("Stopped before uploading.")
            return out
        stage_upload(cli, rtacs, results)
    return out


def main():
    # Validate before starting AcRTAC, so a bad form fails in a second.
    try:
        switch_ip, vid, rtacs = validate(json.load(sys.stdin))
    except (KeyError, TypeError, ValueError) as e:
        print(f"bad request: {e}", file=sys.stderr)
        sys.exit(1)
    run_session(lambda cli: deploy(cli, switch_ip, vid, rtacs))


if __name__ == "__main__":
    main()
