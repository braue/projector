

UNIQUE_NAME = "{schemeName}_{name}"


DEV_DEC = "{schemeName}_{name}"
DEV_DEC_SOURCES = "{schemeName}_DevDec_Source"
DEV_DEF = "{schemeName}_{name}"
INIT = "{schemeName}_{name}"
INIT_REMOTE_IO = "{schemeName}_RemoteIo"
INIT_XFMR = "{schemeName}_Init_Xfmr"
SCHEME_AREAMAP = "{schemeName}_AreaMap"
GLOBAL_AREAMAP = "AreaMap"
DEVICE_DECLARATION = "{schemeName}_DevDec"


ENUM_VISU = "enumVisu"
MAIN_VISU = "Main_Visu"
SCREEN_INIT = "ScreenInit"
BLANK_VISU = "{schemeName}_Visu"



class REMOTE_IO_ID:
  def format(schemeName: str, index:int=0) -> str:
    ioId : str = f'_{index}' if index != 0 else ''

    return f'REM_{schemeName}{ioId}'
  