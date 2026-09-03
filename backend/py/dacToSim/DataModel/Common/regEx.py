import re
from dacToSim.constants.regEx import defaultFlags


#                                  1        2       3               4                   5
GET_PARAMETERS_COMMENTS_STRIPPED = re.compile(r'(\w+)\s*(:=|=>)\s*(\S.*?)\s*?(?:,|\n|$)', re.DOTALL)

#                                        1               2         3               4                   5
GET_PROPERTY_CALL = re.compile(r'\b((?:\w+\.){1,10})(\w+)\s*:=\s*(\w+)(?:\s*//\s*(.*))?(?:\s*\(\*\s*(.*?)\s*\*\))?', re.DOTALL)

#                                   1           2                      3              
GET_DECLARATION = re.compile(r'\s*(\w+)\s*:\s*(.*?)\s*(?::=|=>|;)\s*(.*?)\s*(?:;|,|\n|$)', re.DOTALL)


#                                         (1)                   (2)
GET_CALLS = re.compile(r'(?:^|\n)\s*((?:\w+(?:\.|)){1,10})\(((?:\n|.)*?)\);', re.DOTALL)

#                            (1)        (2)            (3) 
GET_DEV_DEF = re.compile(r'(\w+)\s*:\s*(\w+)\s*:=\s*\((.*?)\);', re.DOTALL)


def removeComments(text:str) -> str:
  """
  Remove comments from the given text.
  Comments are denoted by '//' and continue to the end of the line.
  """
  # Remove single line comments
  workingText = re.sub(r'//.*', '', text)  # Remove comments

  # Remove multi-line comments (* ... *)
  workingText = re.sub(r'(\*.*?\*)', '', workingText, flags=re.DOTALL)  # Remove multi-line comments

  return workingText

if __name__ == "__main__":
  DeclarationTests = [
    '\tF1178_A : REFERENCE TO typeEquipmentLink := ;',
    '\tF1178_A : POINTER TO typeEquipmentLink := ;',
    '\tF1178_A : typeEquipmentLink := ;',

    '\tF1178_A : REFERENCE TO typeEquipmentLink := T1178;',
    '\tF1178_A : POINTER TO typeEquipmentLink := ADR(T1178);',
    '\tF1178_A : typeEquipmentLink := T1178;',
    '\tT2533 : typeEquipmentLink;'
  ]

  for test in DeclarationTests:
    match = GET_DECLARATION.match(test)
    if match:
      print(f"Match: {match.groups()}")
    else:
      print(f"No match for: {test}")
