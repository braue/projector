"""Shared plumbing for the AcRTAC bridge scripts.

Each bridge (acrtac_bridge.py, acrtac_export.py, acrtac_import.py,
acrtac_open.py) is one selacrtac session doing one command; the session
dance, the fixed admin/TAIL login, the waitable-job quirk, and the
stdout-JSON / stderr-error framing that lib/acrtac/pythonClient.js parses
all live here so they cannot drift between scripts.
"""

import json
import sys

from selacrtac.acrtac import AcRTAC


def cli_name(name):
    r"""Quote a project name for selacrtac's command builder.

    selacrtac interpolates the project name into the AcRtacCmd.exe command
    line as a bare positional argument -- it quotes `file` and not `name` --
    so a name containing a space arrives as several arguments and the CLI
    rejects the extras:

        AcRtacCmd.exe ExportEXP --alias pyE9CNX --file "C:\...\plain.exp" 033314.000.00_Cloud HQ_LC2_...
        exportexp:2:syntax error

    Quoting it here is what the library should be doing. Confirmed on
    AcRTAC 2026-09: the same export passes with the name quoted and fails
    without it, while a name with no spaces passes either way. `clean=True`
    does not help -- it leaves the name untouched.

    EXPORTEXP ONLY. exportxml builds `--name "<name>" "<directory>"` and
    quotes both itself, so it handles spaced names as they come and needs
    nothing from here (verified on the same project, same session: it passes
    either way, and a pre-quoted name reaches it as the same command string).

    Names that already carry a double quote are left alone: there is no
    correct wrapping for them, and none has ever been seen in a database.
    """
    text = str(name)
    if " " not in text or '"' in text:
        return text
    return f'"{text}"'


def wait_on(job):
    # login() hands back a waitable job; other calls may too, and the work
    # must finish before the session tears the CLI process down.
    if hasattr(job, "wait"):
        job.wait()


def login(cli):
    """The fixed database login and its exit-code contract: a refused login
    prints to stderr and exits 2 (pythonClient.js keys on that)."""
    wait_on(cli.login("admin", "TAIL"))
    if hasattr(cli, "is_logged_in") and not cli.is_logged_in():
        print("Failed to log in to the RTAC database.", file=sys.stderr)
        sys.exit(2)


def bridge_main(run):
    """Frame one bridge command: `run()` returns the result dict, printed as
    one JSON document on stdout. Any failure goes to stderr with exit 1
    (login's refusal keeps its own exit 2 via SystemExit)."""
    try:
        result = run()
    except Exception as exc:  # surface any selacrtac failure as the process error
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    json.dump(result, sys.stdout)


def run_session(handler):
    """Run `handler(cli)` inside a logged-in AcRTAC session and print its
    result as one JSON document on stdout (via bridge_main's framing)."""
    def run():
        # AcRTAC only works as a context manager: __enter__ starts the CLI
        # process and registers its alias, __exit__ tears it down. The whole
        # command therefore runs inside the with-block — a client that
        # escapes it is talking to a process that no longer exists.
        with AcRTAC() as cli:
            login(cli)
            return handler(cli)
    bridge_main(run)
