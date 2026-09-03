"""Bulk-export bridge between the Node backend and SEL's selacrtac library.

The Tools pane's RTAC Exporter (ported from the standalone RTAC EXPORTER
FastAPI app). Takes its whole request as a single JSON document on STDIN:

    {"command": "list"}
    {"command": "export", "projects": [...], "format": "xml"|"exp",
     "directory": ..., "projectPassword": null}

Prints one JSON document on stdout; errors go to stderr with a non-zero exit.
Session and framing live in acrtac_common.py.
"""

import json
import os
import sys
from pathlib import Path

from acrtac_common import run_session, wait_on


def cmd_list(cli, _request):
    return {"projects": sorted(p.name for p in cli.listprojects())}


def cmd_export(cli, request):
    root = Path(request["directory"])
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for name in request["projects"]:
        try:
            if request.get("format") == "exp":
                out = root / f"{name}.exp"
                wait_on(cli.exportexp(name=name, file=os.fspath(out), clean=False, verbose=False))
                output = out.name
            else:
                outdir = root / name
                outdir.mkdir(parents=True, exist_ok=True)
                wait_on(cli.exportxml(
                    directory=os.fspath(outdir),
                    name=name,
                    project_password=request.get("projectPassword"),
                ))
                output = outdir.name
            results.append({"project": name, "success": True, "output": output})
        except Exception as exc:
            results.append({"project": name, "success": False, "error": str(exc)})
    return {"results": results}


def main():
    request = json.load(sys.stdin)
    handler = {"list": cmd_list, "export": cmd_export}[request["command"]]
    run_session(lambda cli: handler(cli, request))


if __name__ == "__main__":
    main()
