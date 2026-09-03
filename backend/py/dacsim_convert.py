"""DAC->SIM converter bridge for the Tools pane.

Drives the vendored dacToSim package (from the standalone DACSIMCONVERT app)
headlessly over one run directory: request JSON on stdin ({"root": <dir with
settings.json + DAC export folders>}), progress lines on stderr (streamed
into the tool job log), and a single JSON result document on stdout.

dacToSim's own main.py is NOT used: it imports selacrtac at module level (for
its optional -i AcRTAC import), which this machine may not have. The build
pipeline below is selacrtac-free, replicating buildSimProjects() from the
original main.py. Importing the results into AcRTAC stays a manual step (or a
job for the existing acrtac bridge) by design.
"""

import builtins
import json
import sys
import traceback
from pathlib import Path


def main() -> None:
    request = json.loads(sys.stdin.read() or "{}")
    root = Path(request["root"])

    # The package narrates with print() and pauses with input() (source
    # prompts, error acknowledgements). Headless: prints stream to stderr as
    # the job log, and every input() takes the safe empty default — an
    # unconfigured feeder is scaffolded with the package's own warning note
    # instead of prompting.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    def auto_input(prompt: str = "") -> str:
        if prompt:
            print(f"{prompt} [auto: skipped]", flush=True)
        return ""

    builtins.input = auto_input

    from dacToSim.Builders import getDacProjects
    from dacToSim.Builders.Master import buildMasterProject, writeMasterProjectFiles
    from dacToSim.Builders.RemoteIO import buildRemoteIoProject, writeRemoteIoProjectFiles
    from dacToSim.DataModel.Profile.profile import importSettings
    from dacToSim.DataModel.Project import MasterProject

    profiles, root_path = importSettings(root / "settings.json")
    print(f"Loaded {len(profiles)} scheme(s) from settings.json", flush=True)

    dac_projects = getDacProjects(root_path, profiles)
    logic_project = MasterProject(root_path, profiles[0].logic.subFolder)

    remotes = 0
    built = []
    for dac_project in dac_projects:
        print(f"\nBuilding Remote IO for {dac_project.Name}", flush=True)
        rem_projects = buildRemoteIoProject(root_path, dac_project)
        writeRemoteIoProjectFiles(rem_projects)
        remotes += len(rem_projects)
        logic_project.addProjectSet(dac_project, rem_projects)
        built.append(dac_project.Name)

    print("\nRemote IO projects built; building master…", flush=True)
    buildMasterProject(logic_project)
    writeMasterProjectFiles(logic_project)
    print("Master project built", flush=True)

    json.dump(
        {
            "schemes": [profile.schemeName for profile in profiles],
            "dacProjects": built,
            "remoteProjects": remotes,
            "masterFolder": profiles[0].logic.subFolder,
        },
        real_stdout,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 — the whole traceback IS the job error
        traceback.print_exc()
        sys.exit(1)
