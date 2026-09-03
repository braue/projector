from importlib import resources

def importMasterSysTime() -> str:
  ''' Reads the contents of the master.xml in local folder and returns it as a string '''
  return resources.files(__package__).joinpath("master.xml").read_text(encoding="utf-8")


def importRemoteSysTime() -> str:
  ''' Reads the contents of the RemoteSystemTime.xml in local folder and returns it as a string '''
  return resources.files(__package__).joinpath("remote.xml").read_text(encoding="utf-8")