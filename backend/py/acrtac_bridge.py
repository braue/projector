"""Bridge between the Node backend and SEL's selacrtac library.

Invoked per call by lib/acrtac/pythonClient.js:

    python acrtac_bridge.py list
    python acrtac_bridge.py export --name PROJECT --directory OUT_DIR

Prints one JSON document on stdout; errors go to stderr with a non-zero exit.
"""

import argparse
import json
import sys

from selacrtac.acrtac import AcRTAC


def make_client():
    cli = AcRTAC()
    cli.login("admin", "TAIL").wait()
    return cli


def cmd_list(_args):
    cli = make_client()
    available_projects = cli.listprojects()
    return {"projects": [{"name": p.name} for p in available_projects]}


def cmd_export(args):
    cli = make_client()
    cli.exportxml(directory=args.directory, name=args.name, project_password=None)
    return {"ok": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list")

    export = sub.add_parser("export")
    export.add_argument("--name", required=True)
    export.add_argument("--directory", required=True)

    args = parser.parse_args()
    handler = {"list": cmd_list, "export": cmd_export}[args.command]

    try:
        result = handler(args)
    except Exception as exc:  # surface any selacrtac failure as the process error
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
