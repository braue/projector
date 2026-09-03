from abc import ABC, abstractmethod
from typing import List,Dict, Any



class nameSpace(ABC):
    """
    An abstract base class for objects that can provide a namespace.
    """
    @property
    @abstractmethod
    def qualifiedName(self) -> str:
        """
        Returns a dictionary representing the namespace of the object.
        """
        pass

    @property
    @abstractmethod
    def unQualifiedName(self) -> str:
        """
        Returns a dictionary representing the namespace of the object.
        """
        pass


def GetItemFullNameSpace(items :List[nameSpace]) -> Dict[str,nameSpace]:
  fullyQualified : Dict[str,nameSpace] = {}
  unqualifiedMaster : Dict[str,nameSpace] = {}

  unqualifiedFiltered : Dict[str,nameSpace] = {}

  for item in items:
    fullyQualified[item.qualifiedName.upper()] = item

    
    if item.unQualifiedName.upper() not in unqualifiedMaster:
      unqualifiedFiltered[item.unQualifiedName.upper()] = item
      unqualifiedMaster[item.unQualifiedName.upper()] = item
    else:
      if item.unQualifiedName.upper() in unqualifiedFiltered:
        # If the unqualified name is already in the filtered list, remove it
        # This ensures we only keep unique unqualified names
        unqualifiedFiltered.pop(item.unQualifiedName.upper())

  result = {}
  result.update(fullyQualified)
  result.update(unqualifiedFiltered)
  return result


