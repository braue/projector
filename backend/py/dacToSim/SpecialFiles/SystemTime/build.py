from pathlib import Path

from .Templates import importMasterSysTime, importRemoteSysTime


def writedMasterSystemTime(systemPath: Path):
  test = importMasterSysTime()
  systemPath.mkdir(parents=True, exist_ok=True)
  
  filePath = systemPath / "System_Time_Control.xml"
  filePath.write_text(test, encoding="utf-8")


def writeRemoteIOSystemTime(systemPath: Path):
  test = importRemoteSysTime()
  systemPath.mkdir(parents=True, exist_ok=True)
  filePath = systemPath / "System_Time_Control.xml"
  filePath.write_text(test, encoding="utf-8")