template = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>{pouName}</Name>
    <POUKind>Program</POUKind>
    <Content>
      <Interface><![CDATA[PROGRAM {pouName}
{decl}]]></Interface>
      <Implementation><![CDATA[{impl}]]></Implementation>
    </Content>
  </POU>
</RTACModule>'''