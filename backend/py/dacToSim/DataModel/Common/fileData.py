from pathlib import Path
import copy


class FileData:
  def __init__(self,path:Path):
    self.name:str = path.stem
    self.path:Path = path
    self.relPath:Path = path

  def __deepcopy__(self, memo):
    if id(self) in memo:
      return memo[id(self)]
    cls = self.__class__
    result = cls.__new__(cls)
    memo[id(self)] = result
    for k, v in self.__dict__.items():
      setattr(result, k, copy.deepcopy(v, memo))
    return result
  

  def setRelPath(self, basePath:Path):
    """
    Sets the relative path of the file.
    """
    self.relPath = self.path.relative_to(basePath)

  def __lt__(self, other):
      if not isinstance(other, FileData):
        return NotImplemented
      return self.name < other.name

  def __eq__(self, other):
    if not isinstance(other, FileData):
      return NotImplemented
    return self.name == other.name and self.path == other.path and self.relPath == other.relPath