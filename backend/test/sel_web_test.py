"""Offline tests for py/sel_web.py and py/rtac_vlan_deploy.py, against pages
captured from a real SEL-3350 and SEL-2730M (test/fixtures/sel_web/).

    python3 test/sel_web_test.py        (also run by test/selWeb.test.js)

The bridge test swaps in simulated devices (SelWeb._request), then runs the
whole deploy: RTAC ports, switch VLAN, web upload + activate of .exp files.
"""

import json
import re
import sys
import threading
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


class Deploy(unittest.TestCase):
    def setUp(self):
        self.devices = {"10.42.44.34": FakeRtac(), "10.42.44.35": FakeRtac(), "10.42.44.12": FakeSwitch()}
        devices = self.devices
        self._orig = sel_web.SelWeb._request

        def request(web, url, body=None, *a, **kw):
            host, path = re.match(r"https://([^/]+)/?([^?]*)", url).groups()
            return devices[host].handle(path or "/", body)

        sel_web.SelWeb._request = request
        sel_web.time.sleep = lambda s: None
        deploy.time.sleep = lambda s: None
        self.uploads = []
        self.request = {"switchIp": "10.42.44.12", "vlan": 16, "piPort": 24, "rtacs": [
            {"label": "3555-1", "networkIp": "10.42.44.34", "vlanIp": "172.16.100.200", "port": 3,
             "exp": self.exp("Station A.exp", b"exp of Station A"), "file": "RTACs/Station A.exp"},
            {"label": "3532-3", "networkIp": "10.42.44.35", "vlanIp": "172.16.100.201", "port": 4,
             "exp": self.exp("Station_B.exp", b"exp of Station B"), "file": "RTACs/Station_B.exp"},
        ]}

    def tearDown(self):
        sel_web.SelWeb._request = self._orig

    def attempt(self, r):
        self.uploads.append((r["file"], r["networkIp"]))

    def run_deploy(self, attempt=None):
        return deploy.deploy(*deploy.validate(self.request), attempt=attempt or self.attempt,
                             delays=(0, 0))

    def test_full_run_over_the_web(self):
        out = deploy.deploy(*deploy.validate(self.request), delays=(0, 0))
        self.assertTrue(all(r["upload"] == {"ok": True, "attempts": 1} for r in out["rtacs"]))
        a = self.devices["10.42.44.34"]
        self.assertEqual(a.files, {"/Station_A.exp": b"exp of Station A"})  # stored name: no space
        self.assertEqual(a.current, {"name": "Station_A", "state": "running"})
        self.assertEqual(self.devices["10.42.44.35"].current["name"], "Station_B")

    def test_a_rerun_reactivates_the_file_already_there(self):
        r = {"label": "3555-1", "networkIp": "10.42.44.34", "file": "Station_A.exp"}
        exp = Path(self.exp("Station_A.exp"))
        rtac = self.devices["10.42.44.34"]
        rtac.refuse_existing = True
        deploy.upload_once({**r, "exp": str(exp)})
        rtac.current = {"name": "other", "state": "running"}
        deploy.upload_once({**r, "exp": str(exp)})
        self.assertEqual(rtac.posted, ["/Station_A.exp"])
        self.assertEqual(rtac.current["name"], "Station_A")
        exp.write_bytes(b"a changed project")  # same name, different file: refused
        with self.assertRaisesRegex(sel_web.SelWebError, "refused Station_A.exp.*409"):
            deploy.upload_once({**r, "exp": str(exp)})

    def test_an_activation_error_fails_the_attempt(self):
        rtac = self.devices["10.42.44.34"]
        rtac.activate_logs = [[{"Type": "Information", "Message": "Validating..."}],
                              [{"Type": "Information", "Message": "Validating..."},
                               {"Type": "Error", "Message": "Firmware mismatch"}]]
        out = deploy.deploy(*deploy.validate(self.request), delays=(0, 0))
        self.assertEqual(out["rtacs"][0]["upload"],
                         {"ok": False, "error": "activating Station_A: Firmware mismatch", "attempts": 3})
        self.assertTrue(out["rtacs"][1]["upload"]["ok"])

    def test_complete_but_not_running_fails(self):
        rtac = self.devices["10.42.44.34"]
        rtac.api = (lambda orig: lambda path, body: (
            orig(path, body), setattr(rtac, "current", {"name": "Station_A", "state": "stopped"}))[0]
        )(rtac.api)
        with self.assertRaisesRegex(sel_web.SelWebError, "runs 'Station_A' \\(stopped\\)"):
            deploy.upload_once({"label": "x", "networkIp": "10.42.44.34", "file": "Station_A.exp",
                                "exp": self.exp("Station_A.exp")})

    def test_a_missing_exp_stops_before_any_device(self):
        Path(self.request["rtacs"][1]["exp"]).unlink()
        with self.assertRaisesRegex(RuntimeError, r"not an .exp file: 3532-3 \(RTACs/Station_B.exp\)"):
            self.run_deploy()
        self.assertEqual(self.devices["10.42.44.34"].saves, [])
        self.assertEqual(self.uploads, [])

    def test_stored_names_are_url_safe(self):
        self.assertEqual(sel_web.rtac_file_name("C:/x/Station A (rev 2).exp"), "Station_A__rev_2_.exp")
        self.assertEqual(sel_web.rtac_file_name("Pineville_35KV_REM2.exp"), "Pineville_35KV_REM2.exp")

    def tmp(self):
        import tempfile
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        return d.name

    def exp(self, name, data=b"exp"):
        path = Path(self.tmp()) / name
        path.write_bytes(data)
        return str(path)

    def test_full_run(self):
        out = self.run_deploy()
        self.assertIsNone(out["stoppedAt"])
        rtac = self.devices["10.42.44.34"]
        self.assertEqual(rtac.eth02, "172.16.100.200/24")
        self.assertEqual(fields(rtac.saves[0])["ipv4_gateway"], "172.16.100.1")
        self.assertEqual(self.devices["10.42.44.35"].eth02, "172.16.100.201/24")
        self.assertEqual([r["ip"]["before"] for r in out["rtacs"]], ["192.168.10.2/24"] * 2)
        # VLAN 16 held 6-18: now exactly the two RTACs + the Pi; 6-18 parked on VLAN 1
        rows = self.devices["10.42.44.12"].rows
        self.assertEqual(out["vlan"]["after"], "3-4,24")
        self.assertEqual(out["vlan"]["removed"], "6-18")
        self.assertEqual(rows[16][3]["value"], "3-4,24")
        self.assertEqual(rows[1][3]["value"], "1-2,5-23")
        self.assertEqual(json.loads(json.dumps(out))["vlan"]["moved"], {"1": "3-4,24"})
        self.assertEqual(sorted(self.uploads), [("RTACs/Station A.exp", "10.42.44.34"),
                                                ("RTACs/Station_B.exp", "10.42.44.35")])
        self.assertTrue(all(r["upload"]["ok"] for r in out["rtacs"]))

    def test_rerun_is_a_no_op_until_upload(self):
        self.run_deploy()
        out = self.run_deploy()
        self.assertFalse(any(r["ip"]["changed"] for r in out["rtacs"]))
        self.assertFalse(out["vlan"]["changed"])
        self.assertEqual(len(self.devices["10.42.44.34"].saves), 1)
        self.assertEqual(len(self.devices["10.42.44.12"].saves), 2)  # park 6-18, then set 16

    def test_a_changed_gateway_alone_is_saved(self):
        self.run_deploy()
        rtac = self.devices["10.42.44.34"]
        rtac.gateway = ""  # someone cleared it by hand
        self.run_deploy()
        self.assertEqual(len(rtac.saves), 2)

    def test_tagged_ports_come_off(self):
        self.devices["10.42.44.12"].rows[16][2]["value"] = "20"
        out = self.run_deploy()
        self.assertEqual(out["vlan"]["tagged"], "20")
        self.assertEqual(self.devices["10.42.44.12"].rows[16][2]["value"], "")

    def test_vlan_1_is_refused(self):
        self.request["vlan"] = 1
        with self.assertRaisesRegex(ValueError, "VLAN ID"):
            self.run_deploy()

    def test_the_connected_port_is_refused_and_the_run_stops(self):
        self.devices["10.42.44.35"].eth02 = "10.42.44.35/24"
        out = self.run_deploy()
        self.assertEqual(out["stoppedAt"], "ip")
        self.assertIn("reached at", out["rtacs"][1]["ip"]["error"])
        self.assertIsNone(out["vlan"])
        self.assertEqual(self.devices["10.42.44.12"].saves, [])
        self.assertEqual(self.uploads, [])

    def test_missing_vlan_stops_before_upload(self):
        self.request["vlan"] = 99
        out = self.run_deploy()
        self.assertEqual(out["stoppedAt"], "vlan")
        self.assertIn("VLAN 99 doesn't exist", out["vlan"]["error"])
        self.assertEqual(self.uploads, [])

    def test_a_flaky_upload_is_retried(self):
        fails = {"3555-1": 2}

        def attempt(r):
            if fails.get(r["label"], 0):
                fails[r["label"]] -= 1
                raise RuntimeError("RTAC busy")
            self.attempt(r)
        out = self.run_deploy(attempt)
        self.assertEqual([r["upload"] for r in out["rtacs"]],
                         [{"ok": True, "attempts": 3}, {"ok": True, "attempts": 1}])

    def test_one_failed_upload_does_not_stop_the_rest(self):
        def attempt(r):
            if r["label"] == "3555-1":
                raise RuntimeError("RTAC refused")
            self.attempt(r)
        out = self.run_deploy(attempt)
        self.assertEqual([r["upload"]["ok"] for r in out["rtacs"]], [False, True])
        self.assertEqual(out["rtacs"][0]["upload"], {"ok": False, "error": "RTAC refused", "attempts": 3})

    def test_uploads_run_side_by_side(self):
        both = threading.Barrier(2, timeout=5)  # breaks unless both uploads are in flight at once

        def attempt(r):
            both.wait()
            self.attempt(r)
        out = self.run_deploy(attempt)
        self.assertEqual([r["upload"] for r in out["rtacs"]], [{"ok": True, "attempts": 1}] * 2)


class Validate(unittest.TestCase):
    def form(self, **over):
        rtac = {"label": "3555-1", "networkIp": "10.42.44.34", "vlanIp": "172.16.100.200",
                "port": "3", "exp": "/d/A.exp", "file": "RTACs/A.exp"}
        return {"switchIp": " 10.42.44.12", "vlan": "14", "piPort": "24", "rtacs": [{**rtac, **over}]}

    def test_normalizes(self):
        self.assertEqual(deploy.validate(self.form(vlanIp="172.16.100.200/255.255.255.0")),
                         ("10.42.44.12", 14, 24, [
            {"label": "3555-1", "networkIp": "10.42.44.34", "vlanIp": "172.16.100.200/24",
             "gateway": "172.16.100.1", "port": 3, "exp": "/d/A.exp", "file": "RTACs/A.exp"}]))

    def test_names_the_bad_field(self):
        for over, message in (({"networkIp": "10.42.44"}, "3555-1 network IP"),
                              ({"vlanIp": "172.16.100.200/16"}, "3555-1 VLAN IP: .*always /24"),
                              ({"vlanIp": "172.16.100.0"}, "not a usable host"),
                              ({"vlanIp": "172.16.100.1"}, "gateway"),
                              ({"port": "2.5"}, "3555-1 switch port")):
            with self.assertRaisesRegex(ValueError, message):
                deploy.validate(self.form(**over))
        with self.assertRaisesRegex(ValueError, "VLAN ID"):
            deploy.validate({**self.form(), "vlan": "4095"})
        with self.assertRaisesRegex(ValueError, "Raspberry Pi port"):
            deploy.validate({**self.form(), "piPort": ""})

    def test_duplicates(self):
        form = self.form()
        form["rtacs"].append({**form["rtacs"][0], "label": "3555-2", "networkIp": "10.42.44.35", "port": "4"})
        with self.assertRaisesRegex(ValueError, "same VLAN IP is used twice: 172.16.100.200"):
            deploy.validate(form)
        with self.assertRaisesRegex(ValueError, "same switch port .*3 .*Raspberry Pi"):
            deploy.validate({**self.form(), "piPort": "3"})

    def test_vlan_ips_may_span_24s_each_with_its_own_gateway(self):
        form = self.form()
        form["rtacs"].append({**form["rtacs"][0], "label": "3555-2", "networkIp": "10.42.44.35",
                              "port": "4", "vlanIp": "172.16.101.5"})
        rtacs = deploy.validate(form)[-1]
        self.assertEqual([r["gateway"] for r in rtacs], ["172.16.100.1", "172.16.101.1"])


class NoSelacrtac(unittest.TestCase):
    def test_the_bridge_runs_without_selacrtac(self):
        import subprocess
        run = subprocess.run(
            [sys.executable, "-E", "-s", str(HERE.parent / "py" / "rtac_vlan_deploy.py")],
            input="{}", capture_output=True, text=True, cwd=HERE.parent / "py")
        self.assertEqual(run.returncode, 1)
        self.assertIn("bad request", run.stderr)


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
