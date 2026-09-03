"""Import bridge between the Node backend and SEL's selacrtac library.

The DAC SIM Converter's final step: import generated simulator projects
(folder-of-XML trees) into the AcRTAC database. One JSON request on STDIN:

    {"items": [{"path": <xml folder>, "name": <db project name>,
                "type": "3555", "version": "R151"}, ...]}

Prints one JSON document on stdout ({"results": [...]}); a whole-bridge
failure (no selacrtac, login refused) goes to stderr with a non-zero exit.
Session and framing live in acrtac_common.py.

selacrtac's importxml kwargs have drifted across releases — the docs say
importxml(type, version, file, name), the old DACSIMCONVERT called
importxml(rtac_type, version, path, name), and this machine's exportxml
takes directory=. The call below introspects the installed signature and
maps our canonical fields onto whatever the local library expects.
"""

import inspect
import json
import sys

from acrtac_common import run_session, wait_on


def import_kwargs(cli, item):
    """Map {type, version, path, name} onto the installed importxml."""
    params = set()
    try:
        params = set(inspect.signature(cli.importxml).parameters)
    except (TypeError, ValueError):
        pass

    def pick(value, *names, fallback=None):
        for name in names:
            if name in params:
                return {name: value}
        return {fallback: value} if fallback else {}

    return {
        **pick(item["type"], "type", "rtac_type", fallback="type"),
        **pick(item["version"], "version", fallback="version"),
        **pick(item["path"], "file", "path", "directory", fallback="file"),
        **pick(item["name"], "name", fallback="name"),
    }


def cmd_import(cli, request):
    results = []
    for item in request["items"]:
        try:
            wait_on(cli.importxml(**import_kwargs(cli, item)))
            results.append({"name": item["name"], "success": True})
        except Exception as exc:
            results.append({"name": item["name"], "success": False, "error": str(exc)})
    return {"results": results}


def main():
    request = json.load(sys.stdin)
    run_session(lambda cli: cmd_import(cli, request))


if __name__ == "__main__":
    main()
