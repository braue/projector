"""Open bridge: launch AcSELerator RTAC's GUI on a named database project.

One JSON request on STDIN: {"name": <db project name>}. Framing (stdout
JSON, stderr narration/errors, exit codes) is acrtac_common's.

Unlike the other bridges this one must NOT run inside the AcRTAC context
manager: __exit__ stops the CLI instance it started, and the GUI would go
down with it. The instance is started visual (start(visual=True) opens the
GUI, per SEL's submodule docs) and only a SUCCESSFUL open leaves it
running — a failed attempt tears its instance down so retries don't strand
one instance per click.
"""

import json
import sys

from selacrtac.acrtac import AcRTAC

from acrtac_common import bridge_main, login, wait_on


def already_open(cli, name):
    """Whether any running AcRTAC process already holds this project open.
    projectopenproc returns (isOpen, procAlias, procPid) and needs no
    started instance per the docs. A failed probe reads as "not open" — but
    say so on stderr, since it may instead mean the database is unreachable
    (or the probe needs a started instance after all)."""
    try:
        status = cli.projectopenproc(name)
        return bool(status[0] if isinstance(status, (list, tuple)) else status)
    except Exception as exc:
        print(f"could not check whether {name} is already open ({exc}); opening fresh.",
              file=sys.stderr)
        return False


def open_project(name):
    cli = AcRTAC()
    if already_open(cli, name):
        print(f"{name} is already open in AcRTAC.", file=sys.stderr)
        return {"name": name, "alreadyOpen": True}

    print("Starting AcSELerator RTAC…", file=sys.stderr)
    wait_on(cli.start(visual=True))
    try:
        login(cli)
        if hasattr(cli, "projectexists") and not cli.projectexists(name):
            raise RuntimeError(
                f"{name} is not in the AcRTAC database — import it first"
                " (right-click the entry > Import to AcRTAC…)."
            )
        print(f"Opening {name}…", file=sys.stderr)
        wait_on(cli.open(name))
    except BaseException:
        # SystemExit (login's exit 2) included: a failed attempt must not
        # strand the instance it just started.
        try:
            wait_on(cli.stop())
        except Exception:
            pass
        raise
    # Deliberately no stop(): the GUI must outlive this script.
    return {"name": name, "alreadyOpen": False}


def main():
    request = json.load(sys.stdin)
    bridge_main(lambda: open_project(str(request["name"])))


if __name__ == "__main__":
    main()
