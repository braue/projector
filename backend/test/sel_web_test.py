"""Offline tests for py/sel_web.py, py/test_network.py and py/acrtac_bridge.py, against pages
captured from a real SEL-3350 and SEL-2730M (test/fixtures/sel_web/).

    python3 test/sel_web_test.py        (also run by test/selWeb.test.js)

The scan test swaps in simulated devices (SelWeb._request) and reads the
whole test network: switch VLANs, each RTAC's Eth_02 and running project.
"""

import json
import re
import sys
import types
import unittest
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures" / "sel_web"
sys.path.insert(0, str(HERE.parent / "py"))

# The bridge imports selacrtac at module load; give it a stand-in.
_fake = types.ModuleType("selacrtac.acrtac")
_fake.AcRTAC = None  # set per test
sys.modules.setdefault("selacrtac", types.ModuleType("selacrtac"))
sys.modules["selacrtac.acrtac"] = _fake

import acrtac_common  # noqa: E402
import sel_web  # noqa: E402
import acrtac_bridge  # noqa: E402
import test_network  # noqa: E402

fixture = lambda name: (FIX / name).read_text()
UUID = "9d42c6d6-5737-4c40-9011-7f0c41fe4218"


def fields(body):
    return dict(kv.split("=", 1) for kv in body.lstrip("&").split("&") if "=" in kv)


class CapturedPages(unittest.TestCase):
    def test_interface_page_reads_like_the_browser(self):
        page = sel_web.InterfacePage(fixture("rtac_eth02_page.html"))
        self.assertEqual(page.name, "Eth_02")
        self.assertEqual(page.ipv4, "192.168.10.2/24")

    def test_save_body_is_the_browsers_byte_for_byte(self):
        page = sel_web.InterfacePage(fixture("rtac_eth02_page.html"))
        self.assertEqual(page.save_body("192.168.10.5/24"), fixture("rtac_eth02_save_body.txt"))

    def test_unchanged_body_keeps_every_setting(self):
        page = sel_web.InterfacePage(fixture("rtac_eth02_page.html"))
        a, b = fields(page.save_body()), fields(fixture("rtac_eth02_save_body.txt"))
        self.assertEqual(a.pop("ipv4_address"), "192.168.10.2%2F24")
        b.pop("ipv4_address")
        self.assertEqual(a, b)

    def test_unknown_layout_refuses(self):
        html = fixture("rtac_eth02_page.html").replace('id="bonding_mode"', 'id="x"')
        with self.assertRaisesRegex(sel_web.SelWebError, "#bonding_mode"):
            sel_web.InterfacePage(html).save_body("10.0.0.5/24")

    def test_switch_body_is_the_browsers(self):
        vlan = {"name": "Noah", "tagged": "", "untagged": ""}
        self.assertEqual(sel_web.vlan_save_body(14, vlan, "1-5,19"), fixture("switch_save_body.txt"))

    def test_ports(self):
        self.assertEqual(sel_web.parse_ports("1-5,19"), [1, 2, 3, 4, 5, 19])
        self.assertEqual(sel_web.fold_ports([19, 1, 2, 3, 4, 5]), "1-5,19")
        for bad in ("5-1", "1-", "a"):
            with self.assertRaises(ValueError):
                sel_web.parse_ports(bad)

    def test_project_upload_body_is_the_browsers(self):
        # the capture leaves the file's bytes out; the framing is what's checked
        body, ctype = sel_web.multipart(
            [("Project", ("Pineville_35KV_REM2.exp", b"")), ("FilePath", "/Pineville_35KV_REM2.exp")],
            boundary="----WebKitFormBoundaryjlQ8trUc2wg0hrFw")
        self.assertEqual(body, (FIX / "rtac_project_upload_body.txt").read_bytes())
        self.assertEqual(ctype, "multipart/form-data; boundary=----WebKitFormBoundaryjlQ8trUc2wg0hrFw")

    def test_project_listing(self):
        web = types.SimpleNamespace(post=lambda page: fixture("rtac_project_listing.html"))
        self.assertEqual(sel_web.project_files(web), {"/Pineville_35KV_REM2.exp": 21919168})

    def test_ip_mask(self):
        self.assertEqual(sel_web.ip_mask("10.0.0.5/255.255.255.0"), "10.0.0.5/24")
        for bad in ("10.0.0.5", "10.0.0.0/24", "10.0.0.255/24", "127.0.0.1/8"):
            with self.assertRaises(ValueError):
                sel_web.ip_mask(bad)


# --- simulated devices --------------------------------------------------------

class FakeRtac:
    """Serves the captured Eth_02 page at interface_id=1 with a live address,
    and the project API: uploads land in `files`, Activate plays the captured
    poll sequence and makes the project current."""

    def __init__(self, eth02="192.168.10.2/24"):
        self.eth02 = eth02
        self.gateway = ""
        self.saves = []
        self.files = {}           # '/<name>.exp' -> bytes
        self.posted = []          # each upload's FilePath
        self.refuse_existing = False
        self.activate_logs = [p["Logs"] for p in json.loads(fixture("rtac_activate_polls.json"))]
        self.current = {"name": "Eunice_13KV_REM", "state": "running"}
        self.activating = None

    def api(self, path, body):
        if path == "api/v1/projects":
            m = re.search(rb'name="FilePath"\r\n\r\n([^\r]*)', body)
            data = re.search(rb'filename="[^"]*"\r\nContent-Type: application/octet-stream\r\n\r\n'
                             rb'(.*?)\r\n--', body, re.S).group(1)
            name = m.group(1).decode()
            if self.refuse_existing and name in self.files:
                raise sel_web.SelWebError("api/v1/projects: HTTP 409 Conflict")
            self.files[name] = data
            self.posted.append(name)
            return json.dumps({"FilePath": name.lstrip("/")})
        m = re.fullmatch(r"api/v1/projects/([^/]+)/commands(?:/(.+))?", path)
        if m and body is not None:
            assert json.loads(body) == {"Command": "Activate"}
            assert f"/{unquote(m[1])}.exp" in self.files, "activating a file that was never uploaded"
            self.activating, self.polls = unquote(m[1]), iter(self.activate_logs)
            return json.dumps({"Id": "c18c5379"})
        if m and m[2] == "c18c5379":
            logs = next(self.polls, self.activate_logs[-1])
            if any(e["Message"] == "Complete" for e in logs):
                self.current = {"name": self.activating, "state": "running"}
            return json.dumps({"Command": "Activate", "Logs": logs})
        raise AssertionError(f"RTAC API got {path}")

    def listing(self):
        rows = "".join(f"""<span onClick="return downloadFile('download_frame', 'project_uploader', '{n}');">"""
                       f'</span><td id="size_{i}">\n {len(d)}\n</td>'
                       for i, (n, d) in enumerate(self.files.items()))
        return f'<table id="project_upload_table">{rows}</table>'

    def page(self):
        html = fixture("rtac_eth02_page.html").replace('"192.168.10.2/24"', f'"{self.eth02}"')
        return re.sub(r'(id="gateway"[^>]*?value=")[^"]*"', rf'\g<1>{self.gateway}"', html, flags=re.S)

    def handle(self, path, body):
        if path.startswith("api/"):
            return self.api(path, body)
        if path == "/":
            return '<input id="temp_auth_token" value="c30d0409abc">'
        if path == "auth.sel":
            return UUID
        f = fields(body or "")
        if path == "ethernet_interface.sel":
            if f.get("interface_id") == "1":
                return self.page()
            return self.page().replace("Eth_02", f"Eth_X{f.get('interface_id')}")
        if path == "ethernet_settings_save.sel":
            self.saves.append(body)
            self.eth02 = unquote(f["ipv4_address"])
            self.gateway = f["ipv4_gateway"]
            return fixture("rtac_save_reply.html")
        if path == "project_upload.sel":
            return self.listing()
        if path == "update.sel":
            return json.dumps({"currentProject": self.current})
        if path == "logout.sel":
            return "{}"
        raise AssertionError(f"RTAC got {path}")


class FakeSwitch:
    """The captured VLAN table, live: saving moves ports off their old VLAN."""

    def __init__(self):
        page = json.loads(fixture("switch_vlans_before.json"))
        self.page = page
        self.rows = {int(r["ids"][0]["value"]): r["input"] for r in page["members"][0]["inputs"][0]["data"]}
        self.saves = []

    def handle(self, path, body):
        if path == "auth.sel":
            return json.dumps({"status": "success", "message": UUID})
        if path == "update.sel":
            return fixture("switch_port_state.json")
        if path == "vlan_settings.sel":
            return json.dumps(self.page)
        if path == "vlan_view_save.sel":
            self.saves.append(body)
            f = {k: unquote(v) for k, v in fields(body).items()}
            vid, ports = int(f["VL_VID_ST"]), set(sel_web.parse_ports(f["VL_UNTAGGED_PORTS_ST"]))
            for other, cells in self.rows.items():
                if other != vid:
                    cells[3]["value"] = sel_web.fold_ports(set(sel_web.parse_ports(cells[3]["value"])) - ports)
            self.rows[vid][3]["value"] = f["VL_UNTAGGED_PORTS_ST"]
            self.rows[vid][2]["value"] = f["VL_TAGGED_PORTS_ST"]
            return json.dumps({"status": "success", "message": "Settings successfully updated."})
        if path == "logout.sel":
            return "{}"
        raise AssertionError(f"switch got {path}")


class TestNetwork(unittest.TestCase):
    """py/test_network.py's scan over simulated devices: the switch's VLANs,
    each RTAC's Eth_02 and running project, and an unreachable RTAC kept to
    its own row."""

    def setUp(self):
        devices = {"10.42.44.34": FakeRtac(), "10.42.44.35": FakeRtac("172.16.100.201/24"),
                   "10.42.44.12": FakeSwitch()}
        devices["10.42.44.35"].current = {"name": "Station_B", "state": "running"}
        self.devices = devices
        self._sleep, sel_web.time.sleep = sel_web.time.sleep, lambda s: None
        self._orig = sel_web.SelWeb._request

        def request(web, url, body=None, *a, **kw):
            host, path = re.match(r"https://([^/]+)/?([^?]*)", url).groups()
            if host not in devices:
                raise sel_web.SelWebError(f"https://{host}: timed out")
            return devices[host].handle(path or "/", body)

        sel_web.SelWeb._request = request

    def tearDown(self):
        sel_web.SelWeb._request = self._orig
        sel_web.time.sleep = self._sleep

    def test_scan(self):
        out = test_network.scan({"switchIp": "10.42.44.12", "devices": [
            {"id": "3555-1", "networkIp": "10.42.44.34", "port": "3"},
            {"id": "3532-3", "networkIp": "10.42.44.35", "port": "4", "kind": "rtac"},
            {"id": "gone", "networkIp": "10.42.44.99", "port": "5"},
            {"id": "Pi", "networkIp": "", "port": "24", "kind": "other"},
        ]})
        self.assertIsNone(out["switch"]["error"])
        self.assertEqual(out["switch"]["ports"], list(range(1, 25)))
        vlans = {v["vid"]: v for v in out["switch"]["vlans"]}
        self.assertEqual(vlans[16]["untagged"], list(range(6, 19)))
        rows = {d["id"]: d for d in out["devices"]}
        self.assertEqual(set(rows), {"3555-1", "3532-3", "gone"})  # the Pi is not an RTAC
        self.assertEqual(rows["3555-1"]["eth02"], "192.168.10.2/24")
        self.assertEqual(rows["3555-1"]["project"], {"name": "Eunice_13KV_REM", "state": "running"})
        self.assertEqual(rows["3532-3"]["project"]["name"], "Station_B")
        self.assertIn("timed out", rows["gone"]["error"])

    def test_move_port(self):
        switch = self.devices["10.42.44.12"]
        # port 7 sits untagged on VLAN 16 in the capture; VLAN 14 takes it
        out = test_network.move({"switchIp": "10.42.44.12", "port": 7, "vid": 14})
        vlans = {v["vid"]: v["untagged"] for v in out.pop("vlans")}
        self.assertEqual(out, {"port": 7, "from": 16, "to": 14, "changed": True})
        self.assertEqual(vlans[14], [7])
        vlans = {vid: cells[3]["value"] for vid, cells in switch.rows.items()}
        self.assertEqual(vlans[14], "7")
        self.assertEqual(vlans[16], "6,8-18")   # nothing else moved
        self.assertEqual(vlans[1], "1-5,19-24")
        self.assertEqual(len(switch.saves), 1)
        again = test_network.move({"switchIp": "10.42.44.12", "port": 7, "vid": 14})
        self.assertFalse(again["changed"])
        self.assertEqual(len(switch.saves), 1)
        with self.assertRaisesRegex(sel_web.SelWebError, "VLAN 99 doesn't exist"):
            test_network.move({"switchIp": "10.42.44.12", "port": 7, "vid": 99})
        with self.assertRaisesRegex(sel_web.SelWebError, "no port 30"):
            test_network.move({"switchIp": "10.42.44.12", "port": 30, "vid": 14})

    def test_set_eth02(self):
        rtac = self.devices["10.42.44.34"]
        out = test_network.set_eth02({"networkIp": "10.42.44.34", "ip": "172.16.14.10"})
        self.assertEqual(out, {"before": "192.168.10.2/24", "after": "172.16.14.10/24",
                               "gateway": "172.16.14.1", "changed": True})
        self.assertEqual((rtac.eth02, rtac.gateway), ("172.16.14.10/24", "172.16.14.1"))
        again = test_network.set_eth02({"networkIp": "10.42.44.34", "ip": "172.16.14.10/24"})
        self.assertFalse(again["changed"])
        self.assertEqual(len(rtac.saves), 1)
        with self.assertRaisesRegex(sel_web.SelWebError, "gateway"):
            test_network.set_eth02({"networkIp": "10.42.44.34", "ip": "172.16.14.1"})
        with self.assertRaisesRegex(sel_web.SelWebError, "always /24"):
            test_network.set_eth02({"networkIp": "10.42.44.34", "ip": "172.16.14.10/16"})
        with self.assertRaisesRegex(sel_web.SelWebError, "network port's subnet"):
            test_network.set_eth02({"networkIp": "10.42.44.35", "ip": "10.42.44.200"})
        self.assertEqual(len(rtac.saves), 1)

    def test_switch_down_is_reported_not_raised(self):
        out = test_network.scan({"switchIp": "10.42.44.200", "devices": []})
        self.assertIn("timed out", out["switch"]["error"])
        self.assertEqual(out["devices"], [])

    def test_runs_without_selacrtac(self):
        import subprocess
        run = subprocess.run(
            [sys.executable, "-E", "-s", str(HERE.parent / "py" / "test_network.py")],
            input="{}", capture_output=True, text=True, cwd=HERE.parent / "py")
        self.assertEqual(run.returncode, 1)
        self.assertIn("switchIp", run.stderr)


class AcrtacBridge(unittest.TestCase):
    """py/acrtac_bridge.py's export: per-project folders or one flat one,
    .exp files, and one failure never stopping the rest."""

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.calls = []
        test = self

        class Cli:
            def exportxml(self, directory, name, project_password=None):
                if name == "Broken":
                    raise RuntimeError("project is locked")
                test.calls.append(("xml", name, Path(directory).relative_to(test.dir.name).as_posix()))
                (Path(directory) / "Devices.xml").write_text("<x/>")

            def exportexp(self, name, file, clean=False, verbose=False):
                test.calls.append(("exp", name, Path(file).name))
                Path(file).write_text("exp")

        self.cli = acrtac_common.Session(Cli())
        self._say, acrtac_bridge.say = acrtac_bridge.say, lambda line: None

    def tearDown(self):
        acrtac_bridge.say = self._say
        self.dir.cleanup()

    def export(self, **request):
        return acrtac_bridge.cmd_export(self.cli, {"directory": self.dir.name, **request})["results"]

    def test_folders_per_project_and_failures_stand_alone(self):
        out = self.export(projects=["A", "Broken", "B"], format="xml")
        self.assertEqual([r["success"] for r in out], [True, False, True])
        self.assertEqual(out[1]["error"], "project is locked")
        self.assertEqual(self.calls, [("xml", "A", "A"), ("xml", "B", "B")])

    def test_flat_is_one_project_straight_into_the_directory(self):
        self.export(projects=["A"], format="xml", flat=True)
        self.assertEqual(self.calls, [("xml", "A", ".")])
        with self.assertRaisesRegex(ValueError, "exactly one project"):
            self.export(projects=["A", "B"], format="xml", flat=True)

    def test_upload(self):
        sent = []
        self.cli._cli.upload = lambda project, host, user, password=None: sent.append((project, host, user, password))
        out = acrtac_bridge.cmd_upload(self.cli, {"project": "Station A", "host": "10.42.44.34"})
        self.assertEqual(out, {"project": "Station A", "host": "10.42.44.34"})
        self.assertEqual(sent, [('"Station A"', "10.42.44.34", "SEL", "SEL")])

    def test_exp(self):
        out = self.export(projects=["Cloud HQ"], format="exp")
        self.assertEqual(out[0]["output"], "Cloud HQ.exp")
        self.assertEqual(self.calls, [("exp", '"Cloud HQ"', "Cloud HQ.exp")])


class SessionQuoting(unittest.TestCase):
    def test_quotes_only_the_commands_that_need_it(self):
        calls = []
        cli = types.SimpleNamespace(
            exportexp=lambda **kw: calls.append(("exportexp", kw["name"])),
            upload=lambda project, *a, **kw: calls.append(("upload", project)),
            exportxml=lambda **kw: calls.append(("exportxml", kw["name"])),
        )
        session = acrtac_common.Session(cli)
        session.exportexp(name="Cloud HQ", file="x.exp")
        session.upload("Cloud HQ", "10.0.0.1", "SEL", password="SEL")
        session.exportxml(name="Cloud HQ", directory="d")   # quotes itself: untouched
        session.upload("NoSpaces", "10.0.0.1", "SEL")
        self.assertEqual(calls, [("exportexp", '"Cloud HQ"'), ("upload", '"Cloud HQ"'),
                                 ("exportxml", "Cloud HQ"), ("upload", "NoSpaces")])


if __name__ == "__main__":
    unittest.main(verbosity=1)
