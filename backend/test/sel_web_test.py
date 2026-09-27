"""Offline tests for py/sel_web.py and py/rtac_vlan_deploy.py, against pages
captured from a real SEL-3350 and SEL-2730M (test/fixtures/sel_web/).

    python3 test/sel_web_test.py        (also run by test/selWeb.test.js)

The bridge test swaps in simulated devices (SelWeb._request) and a fake
selacrtac, then runs the whole deploy: RTAC ports, switch VLAN, uploads.
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
import rtac_vlan_deploy as deploy  # noqa: E402

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

    def test_ip_mask(self):
        self.assertEqual(sel_web.ip_mask("10.0.0.5/255.255.255.0"), "10.0.0.5/24")
        for bad in ("10.0.0.5", "10.0.0.0/24", "10.0.0.255/24", "127.0.0.1/8"):
            with self.assertRaises(ValueError):
                sel_web.ip_mask(bad)


# --- simulated devices --------------------------------------------------------

class FakeRtac:
    """Serves the captured Eth_02 page at interface_id=1 with a live address."""

    def __init__(self, eth02="192.168.10.2/24"):
        self.eth02 = eth02
        self.saves = []

    def page(self):
        return fixture("rtac_eth02_page.html").replace('"192.168.10.2/24"', f'"{self.eth02}"')

    def handle(self, path, body):
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
            return fixture("rtac_save_reply.html")
        if path in ("update.sel", "logout.sel"):
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
            return json.dumps({"status": "success", "message": "Settings successfully updated."})
        if path == "logout.sel":
            return "{}"
        raise AssertionError(f"switch got {path}")


class FakeAcRTAC:
    projects = ["Station A", "Station B"]

    def __init__(self):
        self.uploads = []
        FakeAcRTAC.last = self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, *a):
        return None

    def listprojects(self):
        return [types.SimpleNamespace(name=n) for n in self.projects]

    def upload(self, project, ip, user, password=None):
        self.uploads.append((project, ip, user, password))
        return True


class Deploy(unittest.TestCase):
    def setUp(self):
        self.devices = {"10.42.44.34": FakeRtac(), "10.42.44.35": FakeRtac(), "10.42.44.12": FakeSwitch()}
        devices = self.devices
        self._orig = sel_web.SelWeb._request

        def request(web, url, body=None):
            host, path = re.match(r"https://([^/]+)/?([^?]*)", url).groups()
            return devices[host].handle(path or "/", body)

        sel_web.SelWeb._request = request
        sel_web.time.sleep = lambda s: None
        self.request = {"switchIp": "10.42.44.12", "vlan": 14, "rtacs": [
            {"networkIp": "10.42.44.34", "vlanIp": "172.16.100.200/24", "port": 3, "project": "Station A"},
            {"networkIp": "10.42.44.35", "vlanIp": "172.16.100.201/24", "port": 4, "project": "Station B"},
        ]}

    def tearDown(self):
        sel_web.SelWeb._request = self._orig

    def run_deploy(self):
        # through the Session, as run_session hands it to the bridge
        return deploy.deploy(acrtac_common.Session(FakeAcRTAC()), *deploy.validate(self.request))

    def test_full_run(self):
        out = self.run_deploy()
        self.assertIsNone(out["stoppedAt"])
        self.assertEqual(self.devices["10.42.44.34"].eth02, "172.16.100.200/24")
        self.assertEqual(self.devices["10.42.44.35"].eth02, "172.16.100.201/24")
        self.assertEqual([r["ip"]["before"] for r in out["rtacs"]], ["192.168.10.2/24"] * 2)
        self.assertEqual(out["vlan"]["after"], "3-4")
        self.assertEqual(json.loads(json.dumps(out))["vlan"]["moved"], {"1": "3-4"})  # as the bridge prints it
        self.assertEqual(self.devices["10.42.44.12"].rows[1][3]["value"], "1-2,5,19-24")
        # spaced names reach selacrtac quoted, by the Session
        self.assertEqual(FakeAcRTAC.last.uploads, [
            ('"Station A"', "10.42.44.34", "SEL", "SEL"), ('"Station B"', "10.42.44.35", "SEL", "SEL")])
        self.assertTrue(all(r["upload"]["ok"] for r in out["rtacs"]))

    def test_rerun_is_a_no_op_until_upload(self):
        self.run_deploy()
        out = self.run_deploy()
        self.assertFalse(any(r["ip"]["changed"] for r in out["rtacs"]))
        self.assertFalse(out["vlan"]["changed"])
        self.assertEqual(len(self.devices["10.42.44.34"].saves), 1)
        self.assertEqual(len(self.devices["10.42.44.12"].saves), 1)

    def test_missing_project_stops_before_any_device(self):
        self.request["rtacs"][1]["project"] = "Nope"
        with self.assertRaisesRegex(RuntimeError, "not in the AcRTAC database: Nope"):
            self.run_deploy()
        self.assertEqual(self.devices["10.42.44.34"].saves, [])

    def test_the_connected_port_is_refused_and_the_run_stops(self):
        self.devices["10.42.44.35"].eth02 = "10.42.44.35/24"
        out = self.run_deploy()
        self.assertEqual(out["stoppedAt"], "ip")
        self.assertIn("reached at", out["rtacs"][1]["ip"]["error"])
        self.assertIsNone(out["vlan"])
        self.assertEqual(self.devices["10.42.44.12"].saves, [])
        self.assertEqual(FakeAcRTAC.last.uploads, [])

    def test_missing_vlan_stops_before_upload(self):
        self.request["vlan"] = 99
        out = self.run_deploy()
        self.assertEqual(out["stoppedAt"], "vlan")
        self.assertIn("VLAN 99 doesn't exist", out["vlan"]["error"])
        self.assertEqual(FakeAcRTAC.last.uploads, [])

    def test_one_failed_upload_does_not_stop_the_rest(self):
        def upload(self, project, ip, user, password=None):
            if project == '"Station A"':
                raise RuntimeError("RTAC refused")
            self.uploads.append((project, ip, user, password))
            return True
        FakeAcRTAC.upload, orig = upload, FakeAcRTAC.upload
        try:
            out = self.run_deploy()
        finally:
            FakeAcRTAC.upload = orig
        self.assertEqual([r["upload"]["ok"] for r in out["rtacs"]], [False, True])


class Validate(unittest.TestCase):
    def form(self, **over):
        rtac = {"networkIp": "10.42.44.34", "vlanIp": "172.16.100.200/255.255.255.0", "port": "3", "project": " A "}
        return {"switchIp": " 10.42.44.12", "vlan": "14", "rtacs": [{**rtac, **over}]}

    def test_normalizes(self):
        self.assertEqual(deploy.validate(self.form()), ("10.42.44.12", 14, [
            {"networkIp": "10.42.44.34", "vlanIp": "172.16.100.200/24", "port": 3, "project": "A"}]))

    def test_names_the_bad_field(self):
        for over, message in (({"networkIp": "10.42.44"}, "RTAC 1 network IP"),
                              ({"vlanIp": "172.16.100.200"}, "RTAC 1 VLAN IP: .*needs a mask"),
                              ({"vlanIp": "172.16.100.0/24"}, "not a usable host"),
                              ({"port": "2.5"}, "RTAC 1 switch port")):
            with self.assertRaisesRegex(ValueError, message):
                deploy.validate(self.form(**over))
        with self.assertRaisesRegex(ValueError, "VLAN ID"):
            deploy.validate({**self.form(), "vlan": "4095"})

    def test_duplicates(self):
        form = self.form()
        form["rtacs"].append({**form["rtacs"][0], "networkIp": "10.42.44.35", "port": "4"})
        with self.assertRaisesRegex(ValueError, "same VLAN IP is used twice: 172.16.100.200"):
            deploy.validate(form)


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
