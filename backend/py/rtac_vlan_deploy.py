"""RTAC VLAN Deploy bridge: put a bench of RTACs on a VLAN and load their projects.

One JSON request on STDIN (the Node service has already resolved each
bench device's identifier to its network IP and switch port):

    {"switchIp": "10.42.44.12", "vlan": 14, "piPort": 24, "parallel": true,
     "rtacs": [{"label": "3555-1", "networkIp": "10.42.44.34",
                "vlanIp": "172.16.100.200", "port": 3,
                "project": "Station A RTAC"}, ...]}

Every VLAN is a /24 and its gateway is .1, so a VLAN IP is just an address.

Runs in order:
  0. check every project exists in the AcRTAC database (before touching any device)
  1. every RTAC at once: Eth_02 -> its VLAN IP/24, gateway .1, over its web
     interface at networkIp
  2. switch: the VLAN's members become EXACTLY the RTAC ports + the Pi port,
     untagged, and nothing else
  3. upload each RTAC's project over networkIp — all at once when `parallel`,
     else one at a time — each in its own AcRTAC session (py/rtac_upload.py), retried on failure

A stage that fails for any RTAC stops the run before the next stage, so the
bench is never left half-moved onto a VLAN it can't reach; uploads (stage 3)
each stand alone and all are attempted. The upload sends no `advanced`
settings, so it doesn't touch the Ethernet 2 address stage 1 just set.

Narration goes to stderr (the job log); the result prints as one JSON
document on stdout:

    {"rtacs": [{"label", "networkIp", "project", "ip": {...}, "upload": {...}}],
     "vlan": {...} | null, "stoppedAt": null | "ip" | "vlan"}
"""

import contextlib
import ipaddress
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from acrtac_common import bridge_main, session

import sel_web

PORT = "Eth_02"             # the RTAC port that joins the VLAN
WEB_USER = WEB_PASSWORD = "SEL"      # RTAC + switch web login (factory default)

UPLOAD_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rtac_upload.py")
UPLOAD_TIMEOUT_S = 25 * 60           # one attempt; a healthy upload is minutes
RETRY_DELAYS_S = (15, 45)            # waits before the 2nd and 3rd attempt

_say_lock = threading.Lock()


def say(line):
    with _say_lock:
        print(line, file=sys.stderr, flush=True)


def validate(request):
    """The single authority on what a deploy request means (the Node service
    only resolves identifiers and checks the fields are filled in). Returns
    (switch_ip, vid, pi_port, parallel, rtacs) with addresses normalized;
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
    parallel = request.get("parallel", True)
    if not isinstance(parallel, bool):
        raise ValueError("Parallel uploads must be true or false")
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
            "project": str(r["project"]).strip(),
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
    if len(nets := {r["gateway"] for r in rtacs}) > 1:
        raise ValueError("the VLAN IPs span more than one /24 (gateways "
                         + ", ".join(sorted(nets)) + "); one VLAN is one /24")
    return switch_ip, vid, pi_port, parallel, rtacs


def check_projects(rtacs):
    # selacrtac or the CLI may print; keep stdout clean for the JSON result.
    with contextlib.redirect_stdout(sys.stderr), session() as cli:
        have = {p.name for p in cli.listprojects()}
    if missing := sorted({r["project"] for r in rtacs} - have):
        raise RuntimeError("not in the AcRTAC database: " + ", ".join(missing))


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
    say(f"— Stage 1: {PORT} on {len(rtacs)} RTAC(s), gateway {rtacs[0]['gateway']}")
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
    """One upload attempt in its own process + AcRTAC session. Streams the
    worker's narration into the log under the device's label; raises with
    the worker's reason on failure."""
    proc = subprocess.Popen(
        [sys.executable, UPLOAD_SCRIPT],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    timed_out = threading.Event()

    def kill():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(UPLOAD_TIMEOUT_S, kill)
    timer.start()
    tail = []
    try:
        # stdout is one small JSON line; read it after stderr drains, which
        # ends when the worker exits.
        proc.stdin.write(json.dumps({"project": r["project"], "networkIp": r["networkIp"]}))
        proc.stdin.close()
        for line in proc.stderr:
            if line := line.rstrip():
                tail.append(line)
                say(f"  [{r['label']}] {line}")
        stdout = proc.stdout.read()
        code = proc.wait()
    finally:
        timer.cancel()
    if timed_out.is_set():
        raise RuntimeError(f"no result after {UPLOAD_TIMEOUT_S // 60} minutes; stopped it")
    if code != 0:
        raise RuntimeError(tail[-1] if tail else f"upload worker exited with code {code}")
    try:
        json.loads(stdout)
    except ValueError:
        raise RuntimeError(f"upload worker returned {stdout[:120]!r}") from None


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


def stage_upload(rtacs, results, parallel, attempt=upload_once, delays=RETRY_DELAYS_S):
    workers = len(rtacs) if parallel else 1
    say(f"— Stage 3: upload {len(rtacs)} project(s), "
        + ("all at once" if parallel and workers > 1 else "one at a time"))
    started = time.monotonic()

    def one(r):
        say(f"… {r['label']}: {r['project']} → {r['networkIp']}")
        t0 = time.monotonic()
        out = upload_with_retry(r, attempt, delays)
        mins = f"{(time.monotonic() - t0) / 60:.1f} min"
        if out["ok"]:
            say(f"✓ {r['label']}: {r['project']} sent ({mins})")
        else:
            say(f"✕ {r['label']}: {out['error']} (gave up after {out['attempts']} attempts, {mins})")
        return out

    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = {pool.submit(one, r): res for r, res in zip(rtacs, results)}
        for done in as_completed(jobs):
            jobs[done]["upload"] = done.result()
    ok = sum(res["upload"]["ok"] for res in results)
    say(f"— Uploads: {ok}/{len(rtacs)} sent in {(time.monotonic() - started) / 60:.1f} min")


def deploy(switch_ip, vid, pi_port, parallel, rtacs, attempt=upload_once, delays=RETRY_DELAYS_S):
    results = [{"label": r["label"], "networkIp": r["networkIp"], "project": r["project"],
                "ip": None, "upload": None} for r in rtacs]
    out = {"rtacs": results, "vlan": None, "stoppedAt": None}
    check_projects(rtacs)
    if not stage_ip(rtacs, results):
        out["stoppedAt"] = "ip"
        say("Stopped: fix the failed RTAC(s) and run again (finished ones are skipped as no-ops).")
        return out
    out["vlan"] = stage_vlan(switch_ip, vid, pi_port, rtacs)
    if not out["vlan"]["ok"]:
        out["stoppedAt"] = "vlan"
        say("Stopped before uploading.")
        return out
    stage_upload(rtacs, results, parallel, attempt, delays)
    return out


def main():
    # Validate before starting AcRTAC, so a bad form fails in a second.
    try:
        request = validate(json.load(sys.stdin))
    except (KeyError, TypeError, ValueError) as e:
        print(f"bad request: {e}", file=sys.stderr)
        sys.exit(1)
    bridge_main(lambda: deploy(*request))


if __name__ == "__main__":
    main()
