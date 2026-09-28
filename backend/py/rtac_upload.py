"""Upload ONE AcRTAC project to ONE RTAC, in its own AcRTAC session.

rtac_vlan_deploy.py runs several of these side by side: each is its own
Python process with its own AcRtacCmd session, so parallel uploads never
share a selacrtac client (whose thread-safety nobody vouches for).

One JSON request on STDIN:  {"project": "Station A", "networkIp": "10.42.44.34"}
Result on stdout:           {"ok": true}
Failure: the reason on stderr, exit 1 (acrtac_common's framing).
"""

import contextlib
import json
import sys

from acrtac_common import run_session, wait_on

RTAC_USER = RTAC_PASSWORD = "SEL"    # RTAC device login for the upload


def upload(cli, project, network_ip):
    # selacrtac or the CLI may print; keep stdout clean for the JSON result.
    with contextlib.redirect_stdout(sys.stderr):
        # the Session quotes the project name (see acrtac_common.Session)
        sent = cli.upload(project, network_ip, RTAC_USER, password=RTAC_PASSWORD)
        wait_on(sent)
    if sent is False:
        # upload() returns False when AcRTAC only went online, nothing sent
        raise RuntimeError("AcRTAC went online but did not send the project")
    return {"ok": True}


def main():
    request = json.load(sys.stdin)
    run_session(lambda cli: upload(cli, request["project"], request["networkIp"]))


if __name__ == "__main__":
    main()
