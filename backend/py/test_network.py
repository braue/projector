"""The test network: read it as it stands — the SEL-2730M's VLAN table, and
for each bench RTAC its Eth_02 address and running project — or move one
switch port onto a VLAN (the Test page's drag and drop).

One JSON request on STDIN, a scan (read-only):

    {"switchIp": "10.42.44.12",
     "devices": [{"id": "3555-1", "networkIp": "10.42.44.34", "port": "3", "kind": "rtac"}]}

or a move, which changes only that port's VLAN and prints sel_web.move_port's
result plus the VLAN table as it reads afterwards:

    {"command": "move", "switchIp": "10.42.44.12", "port": 3, "vid": 16}

or a new Eth_02 address for one RTAC, reached at its network IP — always /24,
gateway .1 (sel_web.vlan_host) — printing sel_web.set_interface_ip's result:

    {"command": "eth02", "networkIp": "10.42.44.34", "ip": "172.16.14.10"}

One JSON document on stdout:

    {"switch": {"ip", "ports": [1, ...], "vlans": [{"vid", "name", "untagged": [..], "tagged": [..]}],
                "error": null | "..."},
     "devices": [{"id", "eth02": "A.B.C.D/24" | null, "gateway", "project": {"name", "state"} | null,
                  "error": null | "..."}]}

A device that can't be reached is its own error, never the run's. The
RTACs are read side by side; each is one web login. Device web code is
py/sel_web.py.
"""

import ipaddress
import json
import sys
from concurrent.futures import ThreadPoolExecutor

import sel_web

WEB_USER = WEB_PASSWORD = "SEL"  # RTAC + switch web login (factory default)


def vlan_list(web):
    return [{"vid": vid, "name": v["name"],
             "untagged": sel_web.ports_or_empty(v["untagged"]),
             "tagged": sel_web.ports_or_empty(v["tagged"])}
            for vid, v in sorted(sel_web.read_vlans(web).items())]


def read_switch(ip):
    try:
        with sel_web.SelWeb(ip, WEB_USER, WEB_PASSWORD, "switch") as web:
            ports = sorted(sel_web.read_switch_ports(web))
            vlans = vlan_list(web)
        return {"ip": ip, "ports": ports, "vlans": vlans, "error": None}
    except sel_web.SelWebError as e:
        return {"ip": ip, "ports": [], "vlans": [], "error": str(e)}


def read_rtac(device):
    out = {"id": device["id"], "eth02": None, "gateway": None, "project": None, "error": None}
    try:
        with sel_web.SelWeb(device["networkIp"], WEB_USER, WEB_PASSWORD, "rtac") as web:
            _, page = sel_web.find_interface(web, "Eth_02")
            out["eth02"], out["gateway"] = page.ipv4, page.gateway or None
            now = sel_web.current_project(web)
            out["project"] = {"name": now.get("name"), "state": now.get("state")} if now.get("name") else None
    except sel_web.SelWebError as e:
        out["error"] = str(e)
    return out


def scan(request):
    rtacs = [d for d in request.get("devices", []) if d.get("kind", "rtac") == "rtac" and d.get("networkIp")]
    with ThreadPoolExecutor(max_workers=max(1, min(8, len(rtacs) + 1))) as pool:
        switch = pool.submit(read_switch, request["switchIp"])
        devices = list(pool.map(read_rtac, rtacs))
    return {"switch": switch.result(), "devices": devices}


def move(request):
    """Move the port, then hand back the switch's whole VLAN table as it now
    reads, so the page updates without logging into every RTAC again."""
    with sel_web.SelWeb(request["switchIp"], WEB_USER, WEB_PASSWORD, "switch") as web:
        return {**sel_web.move_port(web, request["port"], request["vid"]), "vlans": vlan_list(web)}


def set_eth02(request):
    try:
        target, gateway = sel_web.vlan_host(request["ip"])
    except ValueError as e:
        raise sel_web.SelWebError(str(e)) from e
    # Eth_02 on the network port's own subnet gives the RTAC two ports on one
    # /24, and the connection this runs over can go either way after.
    if ipaddress.ip_address(request["networkIp"]) in ipaddress.ip_interface(target).network:
        raise sel_web.SelWebError(f"{target} is on the network port's subnet ({request['networkIp']}); "
                                  "Eth_02 needs its own")
    with sel_web.SelWeb(request["networkIp"], WEB_USER, WEB_PASSWORD, "rtac") as web:
        return sel_web.set_interface_ip(web, "Eth_02", target, gateway, reached_at=request["networkIp"])


COMMANDS = {"move": move, "eth02": set_eth02}


def main():
    request = json.load(sys.stdin)
    try:
        result = COMMANDS.get(request.get("command"), scan)(request)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
