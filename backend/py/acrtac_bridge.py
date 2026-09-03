"""Bridge between the Node backend and SEL's selacrtac library.

Invoked per call by lib/acrtac/pythonClient.js:

    python acrtac_bridge.py list
    python acrtac_bridge.py export --name PROJECT --directory OUT_DIR

Prints one JSON document on stdout; errors go to stderr with a non-zero exit.
Session and framing live in acrtac_common.py.
"""

import argparse

from acrtac_common import run_session, wait_on


def cmd_list(cli, _args):
    available_projects = cli.listprojects()
    return {"projects": [{"name": p.name} for p in available_projects]}


def cmd_export(cli, args):
    wait_on(cli.exportxml(directory=args.directory, name=args.name, project_password=None))
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
    run_session(lambda cli: handler(cli, args))


if __name__ == "__main__":
    main()
