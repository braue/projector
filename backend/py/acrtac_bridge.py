"""The AcRTAC database bridge: list its projects, export them, send one to an
RTAC, read one back from an RTAC.

The one bridge behind lib/acrtac/pythonClient.js createAcRtacClient — the
tree's "Download from AcRTAC", the RTAC Exporter tool, and every project
picker all come through here. One JSON request on STDIN:

    {"command": "list"}
    {"command": "export", "projects": [...], "format": "xml" | "exp",
     "directory": ..., "projectPassword": null, "flat": false}
    {"command": "upload", "project": ..., "host": "10.42.44.34"}
    {"command": "read", "host": "10.42.44.34"}

`export` writes each project into `directory` as a folder of XML (or one
.exp file), narrating on stderr; one project failing never stops the rest.
`flat` exports a single project's XML straight into `directory` (the tree's
staging folder) instead of a subfolder named after it.

Prints one JSON document on stdout; errors go to stderr with a non-zero
exit. Session and framing live in acrtac_common.py.
"""

import contextlib
import json
import os
import sys
from pathlib import Path

from acrtac_common import run_session, wait_on


def say(line):
    print(line, file=sys.stderr, flush=True)


def cmd_list(cli, _request):
    return {"projects": sorted(p.name for p in cli.listprojects())}


def export_one(cli, name, request, root):
    if request.get("format", "xml") == "xml":
        outdir = root if request.get("flat") else root / name
        outdir.mkdir(parents=True, exist_ok=True)
        wait_on(cli.exportxml(
            directory=os.fspath(outdir),
            name=name,
            project_password=request.get("projectPassword"),
        ))
        return outdir.name
    out = root / f"{name}.exp"
    # the Session quotes the name (selacrtac passes it bare)
    wait_on(cli.exportexp(name=name, file=os.fspath(out), clean=False, verbose=False))
    return out.name


def cmd_export(cli, request):
    projects = request["projects"]
    if request.get("flat") and len(projects) != 1:
        raise ValueError("a flat export takes exactly one project")
    root = Path(request["directory"])
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for n, name in enumerate(projects, 1):
        say(f"… [{n}/{len(projects)}] {name}")
        try:
            output = export_one(cli, name, request, root)
            results.append({"project": name, "success": True, "output": output})
            say(f"✓ {name}")
        except Exception as exc:  # one project's failure is its own
            results.append({"project": name, "success": False, "error": str(exc)})
            say(f"✕ {name}: {exc}")
    return {"results": results}


def cmd_upload(cli, request):
    # The Test page's per-RTAC upload: AcRTAC sends and activates the database
    # project over the RTAC's network address. The Session quotes the name.
    project, host = request["project"], request["host"]
    say(f"… {project} → {host}")
    wait_on(cli.upload(project, host, "SEL", password="SEL"))
    say(f"✓ {project} → {host}")
    return {"project": project, "host": host}


def cmd_read(cli, request):
    # The Test page's Read: pull whatever the RTAC runs into the database.
    # readasleft picks the database name itself (a free one when the RTAC's
    # project name is already taken) and returns it — or, on failure, a
    # remark in the same string; the database listing tells the two apart.
    host = request["host"]
    say(f"… reading {host}")
    result = str(cli.readasleft(host, "SEL", password="SEL") or "").strip()
    if result not in {p.name for p in cli.listprojects()}:
        raise RuntimeError(result or f"AcRTAC read nothing from {host}")
    say(f"✓ {host} → {result}")
    return {"name": result}


def main():
    request = json.load(sys.stdin)
    handler = {
        "list": cmd_list, "export": cmd_export, "upload": cmd_upload, "read": cmd_read,
    }[request["command"]]

    def run(cli):
        # selacrtac or the CLI may print; keep stdout clean for the JSON result.
        with contextlib.redirect_stdout(sys.stderr):
            return handler(cli, request)
    run_session(run)


if __name__ == "__main__":
    main()
