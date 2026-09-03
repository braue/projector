
from typing import List

from dacToSim.DataModel.FileTemplates import programTemplate
from dacToSim.constants.names.simMasterNames import SCREEN_INIT

screenInit = "HMI.AddScreen(\tName:=\tTO_STRING({enumName}.{name}),\tIndex:=\t{enumName}.{name}\t);"

genericScreenDecl = '''VAR
  Initialized : BOOL;
  i : {enumName};
END_VAR'''

genericScreenImpl = '''IF Initialized THEN RETURN; END_IF
FOR i := {enumName}.{firstScreen} TO {enumName}.{lastScreen} DO
\tInitialized S= NOT AddHmiScreen(\tName:=\tTO_STRING(i),\tIndex:=\ti\t);
END_FOR'''


def genSimInit(enumName:str, screenNames:List[str]) -> str:
  return  programTemplate.format(
        pouName=SCREEN_INIT,
        decl=genericScreenDecl.format(enumName=enumName),
        impl=genericScreenImpl.format(
            enumName=enumName,
            firstScreen=screenNames[0],
            lastScreen=screenNames[-1]
        )
    )