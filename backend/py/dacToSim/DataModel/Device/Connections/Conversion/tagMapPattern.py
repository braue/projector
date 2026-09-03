pattern = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <TagList>
    <Name>{name}</Name>
    <TagListType>DNP</TagListType>
    <SettingPages>
      <SettingPage>
        <Name>Binary Inputs</Name>
        {BinaryInputs}
      </SettingPage>
      <SettingPage>
        <Name>Double Bit Inputs</Name>
        {DoubleBitInputs}
      </SettingPage>
      <SettingPage>
        <Name>Binary Outputs</Name>
        {BinaryOutputs}
      </SettingPage>
      <SettingPage>
        <Name>Counters</Name>
        {Counters}
      </SettingPage>
      <SettingPage>
        <Name>Analog Inputs</Name>
        {AnalogInputs}
      </SettingPage>
      <SettingPage>
        <Name>Analog Outputs</Name>
        {AnalogOutputs}
      </SettingPage>
      <SettingPage>
        <Name>Datasets</Name>
        {Datasets}
      </SettingPage>
    </SettingPages>
  </TagList>
</RTACModule>'''

from .helpers.updateSettingsPages import updateSettingsPages

def processPattern(name: str, **kwargs):
  results = pattern.format(
      name=name,
      **kwargs
  )

  return updateSettingsPages(results, {
    "Analog Inputs": {"Deadband": "1", "Zero Deadband": "0.5"},
    "Analog Outputs": {"Deadband": "1", "Zero Deadband": "0.5"}
  })