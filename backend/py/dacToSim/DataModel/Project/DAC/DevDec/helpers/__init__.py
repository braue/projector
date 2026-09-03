import re



def updateVarName(old, schemeName):
  if schemeName.upper() not in old.upper():
    return f'{schemeName}_{old}'
  else:
    temp = re.sub(f'{schemeName}_','',old, flags= re.MULTILINE|re.IGNORECASE)
    return f'{schemeName}_{temp}'


def splitDeclaration(line):
  lineCheck = re.match(r'(.*?):\s*(\w+)', line, flags= re.MULTILINE|re.IGNORECASE)

  instances = lineCheck.group(1)
  varNames = []
  varType = lineCheck.group(2)

  instanceResults = re.finditer(r'(\w+)', instances, flags= re.MULTILINE|re.IGNORECASE)
  for instanceResult in instanceResults:
    varNames.append(instanceResult[1]) 

  return varNames, varType


def getNamesToUpdate(devDecDict):
  return [k for k,v in devDecDict.items() if v['makeMasterUnique']]







