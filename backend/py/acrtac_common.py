"""Shared plumbing for the AcRTAC bridge scripts.

Each bridge (acrtac_bridge.py, acrtac_export.py, acrtac_import.py) is one
selacrtac session doing one command; the session dance, the fixed admin/TAIL
login, the waitable-job quirk, and the stdout-JSON / stderr-error framing
that lib/acrtac/pythonClient.js parses all live here so they cannot drift
between scripts.
"""

import json
import sys

from selacrtac.acrtac import AcRTAC


def wait_on(job):
    # login() hands back a waitable job; other calls may too, and the work
    # must finish before the with-block tears the CLI process down.
    if hasattr(job, "wait"):
        job.wait()


def run_session(handler):
    """Run `handler(cli)` inside a logged-in AcRTAC session and print its
    result as one JSON document on stdout. Any failure goes to stderr with a
    non-zero exit (2 = login refused, 1 = everything else).
    """
    try:
        # AcRTAC only works as a context manager: __enter__ starts the CLI
        # process and registers its alias, __exit__ tears it down. The whole
        # command therefore runs inside the with-block — a client that
        # escapes it is talking to a process that no longer exists.
        with AcRTAC() as cli:
            wait_on(cli.login("admin", "TAIL"))
            if hasattr(cli, "is_logged_in") and not cli.is_logged_in():
                print("Failed to log in to the RTAC database.", file=sys.stderr)
                sys.exit(2)
            result = handler(cli)
    except Exception as exc:  # surface any selacrtac failure as the process error
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    json.dump(result, sys.stdout)
