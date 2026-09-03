import re
from pathlib import Path


def invertDict(d):
  inverted = {}
  for key, value in d.items():
    if value in inverted:
      inverted[value].append(key)
    else:
      inverted[value] = [key]
  return inverted


def stringReplaceIgnoreCase(text:str, old:str, new:str) -> str:
  """
  Replace all occurrences of 'old' with 'new' in 'text', ignoring case.
  """
  pattern = re.compile(re.escape(old), re.IGNORECASE)
  return pattern.sub(new, text)



def getRelativeToFolderName(path:Path, folderName:str) -> str:
  """
  Get the relative path to a folder name from a given path.
  """
  if not path.is_absolute():
    raise ValueError("Path must be absolute.")
  
  if path.is_file:
    path = path.parent  # If it's a file, get the parent directory

  rootPath = Path(path)
  while True:
    if rootPath.name == folderName:
      break
    rootPath = rootPath.parent
    if rootPath == rootPath.parent:  # Reached the root directory
      raise ValueError(f"Folder '{folderName}' not found in the path '{rootPath}'")
  return str(path.relative_to(rootPath)).replace('\\', '/')  # Normalize to forward slashes


  