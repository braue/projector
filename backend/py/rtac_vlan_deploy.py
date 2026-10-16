"""RTAC VLAN Deploy bridge: put a bench of RTACs on a VLAN and load their projects.

One JSON request on STDIN (the Node service has already resolved each
bench device's identifier to its network IP and switch port, and each .exp
picked from a Projector project's tree to its file on disk):

    {"switchIp": "10.42.44.12", "vlan": 14, "piPort": 24,
     "rtacs": [{"label": "3555-1", "networkIp": "10.42.44.34",
                "vlanIp": "172.16.100.200", "port": 3,
                "exp": "C:\\...\\files\\RTACs\\Station_A.exp",
                "file": "RTACs/Station_A.exp"}, ...]}

Every VLAN IP is a /24 and its gateway is that /24's .1, so a VLAN IP is just an
address. The RTACs' VLAN IPs may sit in different /24s.

Runs in order:
  0. check every .exp is there (before touching any device)
  1. every RTAC at once: Eth_02 -> its VLAN IP/24, gateway .1, over its web
     interface at networkIp
  2. switch: the VLAN's members become EXACTLY the RTAC ports + the Pi port,
     untagged, and nothing else
  3. every RTAC at once, over its web interface at networkIp: upload its .exp
     and activate it, as the RTAC's Project Management page does — retried on
     failure

No AcRTAC anywhere: the .exp files are ones already saved into the project
(selacrtac's upload compiled and sent over its own protocol, minutes per RTAC).

A stage that fails for any RTAC stops the run before the next stage, so the
bench is never left half-moved onto a VLAN it can't reach; uploads (stage 3)
each stand alone and all are attempted. Activating an .exp applies the
project only, not the RTAC's Ethernet settings, so the Eth_02 address stage 1
just set stays.

Narration goes to stderr (the job log); the result prints as one JSON
document on stdout (a failure: the reason on stderr, exit 1):

    {"rtacs": [{"label", "networkIp", "file", "ip": {...}, "upload": {...}}],
     "vlan": {...} | null, "stoppedAt": null | "ip" | "vlan"}
"""

import ipaddress
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import sel_web

PORT = "Eth_02"             # the RTAC port that joins the VLAN
WEB_USER = WEB_PASSWORD = "SEL"      # RTAC + switch web login (factory default)

RETRY_DELAYS_S = (15, 45)            # waits before the 2nd and 3rd attempt

_say_lock = threading.Lock()


def say(line):
    with _say_lock:
        print(line, file=sys.stderr, flush=True)


def validate(request):
    """The single authority on what a deploy request means (the Node service
    only resolves identifiers and checks the fields are filled in). Returns
    (switch_ip, vid, pi_port, rtacs) with addresses normalized;
    raises ValueError naming the bad field."""
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
    vid = whole(request["vlan"], 2, 4094, "VLAN ID")
    pi_port = whole(request["piPort"], 1, 999, "Raspberry Pi port")
    rtacs = []
    for n, r in enumerate(request["rtacs"], 1):
        label = str(r.get("label") or "").strip() or f"RTAC {n}"
        try:
            vlan_ip, gateway = sel_web.vlan_host(r["vlanIp"])
        except ValueError as e:
            raise ValueError(f"{label} VLAN IP: {e}") from None
        rtacs.append({
            "label": label,
            "networkIp": ipv4(r["networkIp"], f"{label} network IP"),
            "vlanIp": vlan_ip,
            "gateway": gateway,
            "port": whole(r["port"], 1, 999, f"{label} switch port"),
            "exp": str(r["exp"]),
            "file": str(r.get("file") or Path(str(r["exp"])).name),
        })
    if not rtacs:
        raise ValueError("no RTACs given")
    for label, values in (("bench device", [r["label"] for r in rtacs]),
                          ("network IP", [r["networkIp"] for r in rtacs]),
                          ("VLAN IP", [r["vlanIp"].split("/")[0] for r in rtacs]),
                          ("switch port", [r["port"] for r in rtacs] + [pi_port])):
        if dup := sorted({v for v in values if values.count(v) > 1}):
            raise ValueError(f"the same {label} is used twice: {', '.join(map(str, dup))}"
                             + (" (the Raspberry Pi port counts)" if pi_port in dup else ""))
    return switch_ip, vid, pi_port, rtacs


def check_files(rtacs):
    """Stage 0: every RTAC's .exp is a file, before any device is touched."""
    bad = [f"{r['label']} ({r['file']})" for r in rtacs
           if not r["exp"].lower().endswith(".exp") or not Path(r["exp"]).is_file()]
    if bad:
        raise RuntimeError("not an .exp file: " + ", ".join(bad))


def set_port(r):
    try:
        with sel_web.SelWeb(r["networkIp"], WEB_USER, WEB_PASSWORD, "rtac") as web:
            return {"ok": True, **sel_web.set_interface_ip(
                web, PORT, r["vlanIp"], r["gateway"], r["networkIp"])}
    except sel_web.SelWebError as e:
        return {"ok": False, "error": str(e)}


def stage_ip(rtacs, results):
    """Every RTAC at once — separate hosts, separate web sessions; the stage
    only has to be complete before the switch moves their ports."""
    say(f"— Stage 1: {PORT} on {len(rtacs)} RTAC(s), each gateway its /24's .1")
    with ThreadPoolExecutor(max_workers=min(8, len(rtacs))) as pool:
        jobs = {pool.submit(set_port, r): (r, res) for r, res in zip(rtacs, results)}
        for done in as_completed(jobs):
            r, res = jobs[done]
            res["ip"] = out = done.result()
            if not out["ok"]:
                say(f"✕ {r['label']} ({r['networkIp']}): {out['error']}")
            elif out["changed"]:
                say(f"✓ {r['label']}: {PORT} {out['before']} → {out['after']} via {out['gateway']}")
            else:
                say(f"✓ {r['label']}: {PORT} already {out['after']} via {out['gateway']}")
    return all(res["ip"]["ok"] for res in results)


def stage_vlan(switch_ip, vid, pi_port, rtacs):
    ports = [r["port"] for r in rtacs] + [pi_port]
    say(f"— Stage 2: switch {switch_ip}, VLAN {vid} = ports {sel_web.fold_ports(ports)} "
        f"only (untagged; Pi on {pi_port})")
    try:
        with sel_web.SelWeb(switch_ip, WEB_USER, WEB_PASSWORD, "switch") as web:
            out = sel_web.set_vlan_ports(web, vid, ports, say)
        say(f"✓ VLAN {vid} untagged: {out['before'] or '-'} → {out['after']}" if out["changed"]
            else f"✓ VLAN {vid} already holds exactly {out['after']}")
        return {"ok": True, **out}
    except sel_web.SelWebError as e:
        say(f"✕ switch {switch_ip}: {e}")
        return {"ok": False, "error": str(e)}


def upload_once(r):
    """One attempt: log in to the RTAC's web interface, upload its .exp and
    activate it. Raises with the RTAC's reason on failure."""
    log = lambda line: say(f"  [{r['label']}] {line}")
    with sel_web.SelWeb(r["networkIp"], WEB_USER, WEB_PASSWORD, "rtac") as web:
        t0 = time.monotonic()
        stem = sel_web.upload_project(web, r["exp"])
        log(f"uploaded {r['file']} as {stem}.exp ({time.monotonic() - t0:.0f}s); activating")
        sel_web.activate_project(web, stem, log)


def upload_with_retry(r, attempt=upload_once, delays=RETRY_DELAYS_S):
    tries = len(delays) + 1
    for n in range(1, tries + 1):
        try:
            attempt(r)
            return {"ok": True, "attempts": n}
        except Exception as e:  # any failure is this RTAC's, not the run's
            if n == tries:
                return {"ok": False, "error": str(e), "attempts": n}
            say(f"↻ {r['label']}: attempt {n}/{tries} failed ({e}); retrying in {delays[n - 1]}s")
            time.sleep(delays[n - 1])


def stage_upload(rtacs, results, attempt=upload_once, delays=RETRY_DELAYS_S):
    """Every RTAC at once: separate hosts and web sessions, nothing shared."""
    say(f"— Stage 3: upload + activate {len(rtacs)} project(s) over the web interface")
    started = time.monotonic()

    def one(r):
        say(f"… {r['label']}: {r['file']} → {r['networkIp']}")
        t0 = time.monotonic()
        out = upload_with_retry(r, attempt, delays)
        mins = f"{(time.monotonic() - t0) / 60:.1f} min"
        if out["ok"]:
            say(f"✓ {r['label']}: {r['file']} uploaded + activated ({mins})")
        else:
            say(f"✕ {r['label']}: {out['error']} (gave up after {out['attempts']} attempts, {mins})")
        return out

    with ThreadPoolExecutor(max_workers=min(8, len(rtacs))) as pool:
        for res, out in zip(results, pool.map(one, rtacs)):
            res["upload"] = out
    ok = sum(res["upload"]["ok"] for res in results)
    say(f"— Uploads: {ok}/{len(rtacs)} activated in {(time.monotonic() - started) / 60:.1f} min")


def deploy(switch_ip, vid, pi_port, rtacs, attempt=upload_once, delays=RETRY_DELAYS_S):
    results = [{"label": r["label"], "networkIp": r["networkIp"], "file": r["file"],
                "ip": None, "upload": None} for r in rtacs]
    out = {"rtacs": results, "vlan": None, "stoppedAt": None}
    check_files(rtacs)
    if not stage_ip(rtacs, results):
        out["stoppedAt"] = "ip"
        say("Stopped: fix the failed RTAC(s) and run again (finished ones are skipped as no-ops).")
        return out
    out["vlan"] = stage_vlan(switch_ip, vid, pi_port, rtacs)
    if not out["vlan"]["ok"]:
        out["stoppedAt"] = "vlan"
        say("Stopped before uploading.")
        return out
    stage_upload(rtacs, results, attempt, delays)
    return out


def main():
    # acrtac_common's framing (stdout JSON, stderr reason + exit 1), without
    # importing it: it loads selacrtac, which this bridge no longer needs.
    try:
        request = validate(json.load(sys.stdin))
    except (KeyError, TypeError, ValueError) as e:
        print(f"bad request: {e}", file=sys.stderr)
        sys.exit(1)
    try:
        result = deploy(*request)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
