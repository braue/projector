from typing import Dict
from dacToSim.constants.names import folders, fileNames
from dacToSim.common import writeFile
from pathlib import Path

from .templates import libraryTemplate


class Library:    
    def __init__(self, name: str, company: str, title:str, version: str):
        self.name = name
        self.company = company
        self.title = title
        self.version = version

    @property
    def fileName(self) -> str:
        """
        Returns the file name for the library.
        """
        return f"{self.name}.xml"


def buildLibrary(library: Library) -> bytes:
    """
    Build a library file from the given Library object.
    """
    body = libraryTemplate.format(
        name=library.name,
        company=library.company,
        title=library.title,
        version=library.version
    )
    return body