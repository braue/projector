"""Import bridge between the Node backend and SEL's selacrtac library.

The DAC SIM Converter's final step: import generated simulator projects
(folder-of-XML trees) into the AcRTAC database. One JSON request on STDIN:

    {"items": [{"path": <xml folder>, "name": <db project name>,
                "type": "3555", "version": "R151"}, ...]}

Prints one JSON document on stdout ({"results": [...]}); a whole-bridge
failure (no selacrtac, login refused) goes to stderr with a non-zero exit.

selacrtac's importxml kwargs have drifted across releases — the docs say
importxml(type, version, file, name), the old DACSIMCONVERT called
importxml(rtac_type, version, path, name), and this machine's exportxml
takes directory=. The call below introspects the installed signature and
maps our canonical fields onto whatever the local library expects.
"""

import inspect
import json
import sys

from selacrtac.acrtac import AcRTAC


def wait_on(job):
    if hasattr(job, "wait"):
        job.wait()


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


def main():
    request = json.load(sys.stdin)
    results = []
    try:
        with AcRTAC() as cli:
            cli.login("admin", "TAIL").wait()
            if hasattr(cli, "is_logged_in") and not cli.is_logged_in():
                print("Failed to log in to the RTAC database.", file=sys.stderr)
                sys.exit(2)
            for item in request["items"]:
                try:
                    wait_on(cli.importxml(**import_kwargs(cli, item)))
                    results.append({"name": item["name"], "success": True})
                except Exception as exc:
                    results.append({"name": item["name"], "success": False, "error": str(exc)})
    except Exception as exc:  # no selacrtac / CLI failed to start / login died
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
