"""The SEL device web interfaces the RTAC VLAN Deploy tool drives: an RTAC's
Ethernet settings page and an SEL-2730M switch's VLAN table.

Ported from the standalone rtac-web scripts (set_eth_ip.py, set_vlan_ports.py),
onto the standard library so the bridge needs nothing beyond selacrtac. Both
devices speak the same framework: POST `*.sel` endpoints with a text/plain
body that carries `session_id` + `session_username`, plus an
`asfdasfowefsj=<epoch_ms>` cache-buster. They differ only in login:

  RTAC   GET / for a per-load hidden `temp_auth_token`, POST auth.sel,
         a bare session UUID comes back.
  switch POST auth.sel straight away, `{"status", "message": <uuid>}` back.

Both ship self-signed certificates, so TLS is not verified (bench network).
"""

import http.cookiejar
import ipaddress
import json
import re
import ssl
import time
import urllib.error
import urllib.request
from functools import cached_property
from html.parser import HTMLParser
from urllib.parse import quote

TIMEOUT = 20

_TOKEN_RE = re.compile(r'id="temp_auth_token"[^>]*\bvalue="([^"]*)"', re.I)
_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


class SelWebError(RuntimeError):
    """Any failure talking to a device's web interface (network, HTTP, auth, page shape)."""


class SelWeb:
    """One logged-in web session. Use as a context manager: login on enter,
    best-effort logout on exit."""

    def __init__(self, host, username, password, kind):
        if kind not in ("rtac", "switch"):
            raise ValueError(kind)
        self.base = f"https://{host}"
        self.username, self.password, self.kind = username, password, kind
        self.session_id = None
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self._open = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ctx),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        ).open

    def _request(self, url, body=None):
        headers = {"Origin": self.base, "Referer": self.base + "/"}
        data = None
        if body is not None:
            data = body.encode()
            headers["Content-Type"] = "text/plain;charset=UTF-8"
        try:
            with self._open(urllib.request.Request(url, data=data, headers=headers),
                            timeout=TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, OSError) as e:
            raise SelWebError(f"{url.split('?')[0]}: {getattr(e, 'reason', e)}") from e

    @staticmethod
    def _cb():
        return f"asfdasfowefsj={int(time.time() * 1000)}"

    def login(self):
        if self.kind == "rtac":
            m = _TOKEN_RE.search(self._request(self.base + "/"))
            if not m:
                raise SelWebError(f"{self.base}: no temp_auth_token on the login page (is this an RTAC?)")
            body = (f"session_username={self.username}&password={self.password}"
                    f"&auto_login=false&temp_auth_token={m.group(1)}")
            reply = self._request(f"{self.base}/auth.sel?{self._cb()}", body).strip()
            m = _UUID_RE.fullmatch(reply)
            if not m:
                raise SelWebError(f"{self.base}: login rejected ({reply[:80]!r})")
        else:
            body = (f"session_username={self.username}&password={self.password}"
                    f"&session_username={self.username}")  # sent twice, as the browser does
            reply = self._json(self._request(f"{self.base}/auth.sel?{self._cb()}", body), "auth.sel")
            m = _UUID_RE.fullmatch(str(reply.get("message", "")).strip())
            if reply.get("status") != "success" or not m:
                raise SelWebError(f"{self.base}: login rejected ({reply.get('message')!r})")
        self.session_id = m.group(0)

    def post(self, page, extra="", cache_bust=True):
        """Authenticated POST to a `*.sel` endpoint; returns the response text."""
        url = f"{self.base}/{page}"
        if cache_bust:
            url += ("&" if "?" in url else "?") + self._cb()
        body = f"&session_id={self.session_id}&session_username={self.username}"
        if extra:
            body += "&" + extra.lstrip("&")
        return self._request(url, body)

    def post_json(self, page, extra="", cache_bust=False):
        return self._json(self.post(page, extra, cache_bust), page)

    @staticmethod
    def _json(text, page):
        try:
            return json.loads(text)
        except ValueError as e:
            raise SelWebError(f"{page} did not return JSON: {text[:80]!r}") from e

    def __enter__(self):
        self.login()
        return self

    def __exit__(self, *exc):
        if self.session_id:
            try:
                self.post("logout.sel", "action=logoff")  # as the RTAC capture sends it
            except SelWebError:
                pass  # best effort; the session expires server-side regardless
            self.session_id = None


# --- RTAC: an Ethernet interface's IPv4 address ------------------------------
#
# ethernet_interface.sel?interface_id=N is an HTML form; the browser's save
# body is assembled by the page's submitEthernetSettings() (home.sel). The
# functions below reproduce that function against the fetched page, element
# by element, so every setting on the port goes back exactly as the browser
# would send it with only the IPv4 address changed. Verified against the
# 10.42.44.34 capture: an untouched page yields the browser's body byte for
# byte (bar the address the user edited).
#
# Interface ids are NOT the port numbers: on the captured SEL-3350,
# Eth_01=0, Eth_02=1, Eth_F=2, Eth_03=5, Eth_04=6. Ports are found by the
# name in the page's title ("Interface Eth_02 Settings").

INTERFACE_FORM = "ethernet_interface.sel"
INTERFACE_SAVE = "ethernet_settings_save.sel"
_TITLE_RE = re.compile(r"Interface\s+(\S+)\s+Settings")
_TEMP_IP_RE = re.compile(
    r'var\s+tempIP\s*=\s*"([^"]*)"[^<]*?getElementById\("(ipv4_address1|ipv6_address)"\)', re.S)


class _Page(HTMLParser):
    """Just enough DOM for submitEthernetSettings(): each element by id (tag +
    attributes, bare attributes like `checked` present with value None) and
    each <select>'s options."""

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.by_id, self._select = {}, None
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "option" and self._select is not None:
            self._select["options"].append(a)
            return
        el = {"tag": tag, "attrs": a, "options": []}
        if tag == "select":
            self._select = el
        if a.get("id"):
            self.by_id.setdefault(a["id"], el)

    def handle_endtag(self, tag):
        if tag == "select":
            self._select = None


def js_encode(value):
    """JavaScript's encodeURIComponent."""
    return quote(str(value), safe="!'()*-._~")


class InterfacePage:
    """One fetched ethernet_interface.sel page."""

    def __init__(self, html):
        self._html = html
        m = _TITLE_RE.search(html)
        self.name = m.group(1) if m else None
        # The address inputs are filled by inline scripts from `tempIP`.
        self.script_ips = {field: ip for ip, field in _TEMP_IP_RE.findall(html)}

    @cached_property
    def dom(self):
        """The parsed form — built only when saving, not for every page probed."""
        return _Page(self._html).by_id

    @property
    def ipv4(self):
        if "ipv4_address1" not in self.script_ips:
            raise SelWebError(f"no IPv4 address on the {self.name or 'interface'} page")
        return self.script_ips["ipv4_address1"]

    def _el(self, id_):
        el = self.dom.get(id_)
        if el is None:
            raise SelWebError(f"the {self.name or 'interface'} page has no #{id_}; "
                              f"its layout isn't the one this tool knows")
        return el

    def checked(self, id_, missing=None):
        """`el.checked` as JS prints it; `missing` stands in for an absent element
        (the page's fakeCheckbox / NULL fallbacks), else absence is an error."""
        if missing is not None and id_ not in self.dom:
            return missing
        return "true" if "checked" in self._el(id_)["attrs"] else "false"

    def value(self, id_):
        """`el.value`: a select's selected option (else its first), an input's value."""
        el = self._el(id_)
        if el["tag"] == "select":
            opts = el["options"]
            pick = [o for o in opts if "selected" in o] or opts[:1]
            return (pick[0].get("value") or "") if pick else ""
        return el["attrs"].get("value") or ""

    @property
    def gateway(self):
        return self.value("gateway")

    def save_body(self, ipv4=None, gateway=None):
        """submitEthernetSettings()'s post_string, with `ipv4` ('A.B.C.D/prefix')
        and `gateway` ('A.B.C.D') in place of the page's when given."""
        enc = js_encode
        iface_id = self.value("network_interface_id")
        axion_front = "is_axion" in self.dom and self.value("is_axion") == "t" and iface_id == "2"

        # the checked bridge checkboxes, in order
        boxes = (self.dom.get(f"bridge_interface_id_{i}") for i in range(101))
        bridged_interfaces = ",".join(el["attrs"].get("value") or ""
                                      for el in boxes if el and "checked" in el["attrs"])

        if axion_front:  # the 2241 front port has no bond/bridge/PRP settings
            bond = ["0", "1", "1", "1", "0"]
            bridge = ["0", "0", "0"]
            prp = ["0", "0", "2", "500", "0"]
        else:
            bond = [self.checked("bonded"), enc(self.value("bonding_mode")),
                    enc(self.value("bonding_link_frequency")), enc(self.value("bonding_downdelay")),
                    enc(self.value("secondary_interface_id"))]
            bridge = [self.checked("bridged", "false"), enc(bridged_interfaces),
                      self.checked("enable_stp", "false")]
            prp = [self.checked("prp_paired"), enc(self.value("prp_destination")),
                   enc(self.value("prp_interval")), enc(self.value("prp_timeout")),
                   enc(self.value("prp_secondary_interface_id"))]

        addr, _, cidr = (ipv4 or self.ipv4).partition("/")

        if axion_front:
            v6 = {"addr": "", "prefix": "", "web": "false", "odbc": "false", "pgw": "false", "gw": ""}
        else:
            v6addr, _, v6prefix = self.script_ips.get("ipv6_address", "").partition("/")
            v6 = {"addr": v6addr, "prefix": v6prefix or "128",
                  "web": self.checked("ipv6_web_access"), "odbc": self.checked("ipv6_odbc_access"),
                  "pgw": self.checked("ipv6_primary_gw"), "gw": self.value("ipv6_gateway")}

        fields = [
            ("network_interface_id", enc(iface_id)),
            ("interface_enabled", self.checked("enable_nic")),
            ("autoneg_enabled", self.checked("enable_autoneg", "NULL")),
            ("ping", self.checked("ping")),
            ("web_access", self.checked("web_access")),
            ("odbc_access", self.checked("odbc_access")),
            ("bonded", bond[0]), ("bonding_mode", bond[1]),
            ("bonding_link_frequency", bond[2]), ("bonding_downdelay", bond[3]),
            ("secondary_interface_id", bond[4]),
            ("bridged", bridge[0]), ("bridged_interfaces", bridge[1]), ("enable_stp", bridge[2]),
            ("ethercat", self.checked("ethercat", "f")),
            ("Ipv4Dhcp", self.checked("Ipv4Dhcp")),
            ("Ipv4DhcpServer", self.checked("Ipv4DhcpServer", "false")),
            ("ipv4_address", enc(f"{addr}/{cidr}")),
            ("ipv4_gateway", self.gateway if gateway is None else gateway),
            ("primary_gw", self.checked("primary_gw")),
            ("ipv6_address", enc(f"{v6['addr']}/{v6['prefix']}")),
            ("ipv6_interface_enabled", self.checked("ipv6_enable_nic")),
            ("ipv6_web_access", v6["web"]), ("ipv6_odbc_access", v6["odbc"]),
            ("ipv6_primary_gw", v6["pgw"]), ("ipv6_gateway", v6["gw"]),
            ("prp_paired", prp[0]), ("prp_destination", prp[1]), ("prp_interval", prp[2]),
            ("prp_timeout", prp[3]), ("prp_secondary_interface", prp[4]),
        ]
        for name, v in fields:
            if "&" in v or "\n" in v:
                # the page sends the gateways unencoded; this would corrupt the body
                raise SelWebError(f"{name} value {v!r} can't be sent safely; refusing to save")
        return "&".join(f"{name}={v}" for name, v in fields)


def vlan_host(text):
    """A VLAN address typed as 'A.B.C.D' (or with /24): every VLAN is a /24,
    so the mask is fixed. Returns ('A.B.C.D/24', gateway 'A.B.C.1')."""
    text = str(text).strip()
    addr, slash, prefix = text.partition("/")
    if slash and prefix.strip() not in ("24", "255.255.255.0"):
        raise ValueError(f"{text}: VLAN addresses are always /24")
    iface = ipaddress.IPv4Interface(f"{addr.strip()}/24")
    gateway = iface.network.network_address + 1
    if iface.ip == gateway:
        raise ValueError(f"{iface.ip} is the VLAN's gateway (.1); pick another host")
    return ip_mask(iface.with_prefixlen), str(gateway)


def ip_mask(text):
    """Normalize 'A.B.C.D/prefix' (or /netmask) to 'A.B.C.D/prefix'; the mask
    is required and the address must be a usable host address."""
    text = str(text).strip()
    if "/" not in text:
        raise ValueError(f"{text!r} needs a mask, e.g. {text}/24")
    iface = ipaddress.IPv4Interface(text)
    ip, net = iface.ip, iface.network
    if ip.is_unspecified or ip.is_loopback or ip.is_multicast or (
            net.prefixlen < 31 and ip in (net.network_address, net.broadcast_address)):
        raise ValueError(f"{text} is not a usable host address")
    return iface.with_prefixlen


def read_interface(web, iface_id):
    return InterfacePage(web.post(INTERFACE_FORM, f"interface_id={iface_id}", cache_bust=False))


def find_interface(web, name):
    """The interface_id whose page is titled `name` (e.g. 'Eth_02'), and that page.
    Tries id 1 first (Eth_02 on the captured SEL-3350), then the rest."""
    seen = []
    for iface_id in [1, 0, *range(2, 16)]:
        try:
            page = read_interface(web, iface_id)
        except SelWebError:
            continue
        if page.name == name:
            return iface_id, page
        if page.name:
            seen.append(page.name)
    raise SelWebError(f"no {name} on this RTAC (interfaces found: {', '.join(seen) or 'none'})")


def set_interface_ip(web, name, target, gateway, reached_at):
    """Set the RTAC port `name` (e.g. 'Eth_02') to `target` ('A.B.C.D/prefix')
    with default gateway `gateway`, changing nothing else on the port, and
    confirm by re-reading. Refuses the port the session reaches the RTAC
    through (`reached_at`), since changing it would cut the connection the
    rest of the run depends on.
    Returns {"before", "after", "gateway", "changed"}."""
    iface_id, page = find_interface(web, name)
    current = page.ipv4
    if current == target and page.gateway == gateway:
        return {"before": current, "after": current, "gateway": gateway, "changed": False}
    if current.split("/")[0] == reached_at:
        raise SelWebError(f"{name} holds {current}, the address this RTAC is reached at; "
                          f"changing it would cut the connection")
    body = page.save_body(target, gateway)
    web.post("update.sel?check_only=true")  # the browser's pre-save session check
    reply = web.post(INTERFACE_SAVE, body)
    if "Ethernet Settings Saved" not in reply:
        text = " ".join(re.sub(r"<[^>]+>", " ", reply).split())
        raise SelWebError(f"the RTAC did not save {name}: {text[:200] or 'empty reply'}")
    reread = read_interface(web, iface_id)
    now, now_gw = reread.ipv4, reread.gateway
    if now != target or now_gw != gateway:
        raise SelWebError(f"saved, but {name} now reads {now} via {now_gw or 'no gateway'} "
                          f"(expected {target} via {gateway})")
    return {"before": current, "after": now, "gateway": gateway, "changed": True}


# --- SEL-2730M switch: untagged VLAN membership ------------------------------

def parse_ports(text):
    """'1-5,19' -> [1, 2, 3, 4, 5, 19]"""
    ports = set()
    for part in filter(None, (p.strip() for p in str(text).split(","))):
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        lo, hi = (int(m[1]), int(m[2] or m[1])) if m else (0, -1)
        if hi < lo:
            raise ValueError(f"bad port range {part!r}")
        ports.update(range(lo, hi + 1))
    return sorted(ports)


def fold_ports(ports):
    """[1, 2, 3, 4, 5, 19] -> '1-5,19' (the switch's own format)"""
    runs = []
    for p in sorted(set(ports)):
        if runs and p == runs[-1][1] + 1:
            runs[-1][1] = p
        else:
            runs.append([p, p])
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in runs)


def _ports_or_empty(text):
    try:
        return parse_ports(text)
    except ValueError:
        return []


def read_switch_ports(web):
    try:
        return {int(s["port_id"]) for s in web.post_json("update.sel")["portState"]}
    except (KeyError, TypeError, ValueError) as e:
        raise SelWebError(f"unexpected update.sel layout ({e!r})") from e


def read_vlans(web):
    """{vid: {"name", "tagged", "untagged"}} from the switch's VLAN View table."""
    page = web.post_json("vlan_settings.sel")
    try:
        vlans = {}
        for row in page["members"][0]["inputs"][0]["data"]:
            vid, name, tagged, untagged = (c["value"] for c in row["input"])
            vlans[int(vid)] = {"name": name, "tagged": tagged, "untagged": untagged}
        return vlans
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise SelWebError(f"unexpected vlan_settings.sel layout ({e!r})") from e


def vlan_save_body(vid, vlan, untagged, tagged=None):
    tagged = vlan["tagged"] if tagged is None else tagged
    return (f"&VL_VID_ST={vid}&VL_NAME_ST={js_encode(vlan['name'])}"
            f"&VL_TAGGED_PORTS_ST={js_encode(tagged)}"
            f"&VL_UNTAGGED_PORTS_ST={js_encode(untagged)}&operation=modify")


DEFAULT_VLAN = 1  # where ports this run takes off its VLAN are parked


def _save_vlan(web, vid, vlan, untagged, tagged=None):
    reply = web.post_json("vlan_view_save.sel", vlan_save_body(vid, vlan, untagged, tagged),
                          cache_bust=True)
    if reply.get("status") != "success":
        raise SelWebError(f"the switch refused the change to VLAN {vid}: {reply.get('message')!r}")


def set_vlan_ports(web, vid, ports, log=lambda line: None):
    """Make `ports` the ONLY members of VLAN `vid`: exactly those untagged, no
    tagged ports, and its name kept. Untagged ports already on it that aren't
    in `ports` are parked on VLAN 1 — adding them there is what takes them
    off `vid` (a port is untagged on exactly one VLAN and the switch moves
    it itself; removing a port from every VLAN is never asked of it). Ports
    coming from other VLANs leave them the same way. Confirms by re-reading.
    Returns {"before", "after", "changed", "moved": {vid: 'ports'},
    "removed": untagged ports parked on VLAN 1, "tagged": tagged ports taken off}."""
    ports = sorted(set(ports))
    known = read_switch_ports(web)
    if bad := [p for p in ports if p not in known]:
        raise SelWebError(f"the switch has no port {fold_ports(bad)} (its ports are {fold_ports(known)})")
    vlans = read_vlans(web)
    if vid not in vlans:
        raise SelWebError(f"VLAN {vid} doesn't exist on the switch "
                          f"(VLANs: {', '.join(map(str, sorted(vlans)))})")
    if vid == DEFAULT_VLAN:
        raise SelWebError(f"VLAN {DEFAULT_VLAN} is the switch's default VLAN; deploy onto a test VLAN")
    vlan = vlans[vid]
    try:
        current = parse_ports(vlan["untagged"])
        tagged = parse_ports(vlan["tagged"])
    except ValueError as e:
        raise SelWebError(f"can't read VLAN {vid}'s current ports: {e}") from e
    if current == ports and not tagged:
        return {"before": vlan["untagged"], "after": vlan["untagged"], "changed": False,
                "moved": {}, "removed": "", "tagged": ""}

    extra = sorted(set(current) - set(ports))
    if extra:
        if DEFAULT_VLAN not in vlans:
            raise SelWebError(f"ports {fold_ports(extra)} must leave VLAN {vid}, but the switch "
                              f"has no VLAN {DEFAULT_VLAN} to park them on")
        home = vlans[DEFAULT_VLAN]
        log(f"  ports {fold_ports(extra)} leave VLAN {vid} → VLAN {DEFAULT_VLAN} ({home['name']})")
        _save_vlan(web, DEFAULT_VLAN, home,
                   fold_ports(_ports_or_empty(home["untagged"]) + extra))
    if tagged:
        log(f"  tagged ports {fold_ports(tagged)} come off VLAN {vid}")

    moved = {}
    for other, v in sorted(vlans.items()):
        if other != vid and (hit := set(_ports_or_empty(v["untagged"])) & set(ports)):
            moved[other] = fold_ports(hit)
            log(f"  ports {fold_ports(hit)} leave VLAN {other} ({v['name']})")

    _save_vlan(web, vid, vlan, fold_ports(ports), tagged="")
    time.sleep(1)  # let the switch apply before re-reading
    now = read_vlans(web)[vid]
    if _ports_or_empty(now["untagged"]) != ports or now["tagged"].strip():
        raise SelWebError(f"the switch said success but VLAN {vid} is now untagged "
                          f"{now['untagged'] or '-'}, tagged {now['tagged'] or '-'} "
                          f"(expected untagged {fold_ports(ports)} only)")
    return {"before": vlan["untagged"], "after": now["untagged"], "changed": True,
            "moved": moved, "removed": fold_ports(extra), "tagged": fold_ports(tagged)}
