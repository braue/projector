from typing import Dict
import xml.etree.ElementTree as ET
from pprint import pprint

def updatePageRows(pageRoot: ET.Element, updates: Dict[str, str]) -> None:
  for row in pageRoot.findall('.//Row'):
    for setting in row.findall('Setting'):
      # Check if the setting has a column that matches the updates
      column = setting.find('Column')
      if column is not None and column.text in updates:
        value = setting.find('Value')
        if value is not None:
          value.text = updates[column.text]



def updateSettingsPages(body: str, settings: Dict[str, Dict[str,str]]) -> str:
  tree = ET.ElementTree(ET.fromstring(body))
  root = tree.getroot()

  for settingPage in root.findall('.//SettingPage'):
    name = settingPage.find('Name')
    if name is not None and name.text in settings:
      updates = settings[name.text]
      updatePageRows(settingPage, updates)

  return ET.tostring(root, encoding='unicode', method='xml')