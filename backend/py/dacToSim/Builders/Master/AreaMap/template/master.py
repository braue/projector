template = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>{pouName}</Name>
    <POUKind>Program</POUKind>
    <ArchivedContent><![CDATA[<?xml version="1.0" encoding="utf-8"?>
<Single xml:space="preserve" Type="{{6f9dac99-8de1-4efc-8465-68ac443b7d08}}" Method="IArchivable">
  <Single Name="SpecialFunc" Type="{{0db3d7bb-cde0-4416-9a7b-ce49a0124323}}">None</Single>
  <Single Name="Implementation" Type="{{32d3375e-c010-41e2-9e43-b2fbf4f2b374}}" Method="IArchivable">
    <Single Name="Items" Type="{{cd57ba20-558b-4b98-96c1-73c6000c3087}}" Method="IArchivable">
      <List2 Name="InnerList" />
    </Single>
    <Null Name="ParameterInitializationMethodGenerator" />
    <Single Name="RoutingPathTable" Type="{{4b8bcc79-5980-4868-b49e-005a8148859b}}" Method="IArchivable">
      <Dictionary2 Name="InnerDictionary" />
    </Single>
    <Single Name="AutoSizeCanvas" Type="bool">True</Single>
    <Single Name="CanvasWidth" Type="int">0</Single>
    <Single Name="CanvasHeight" Type="int">0</Single>
    <Single Name="EditorConfiguration" Type="{{4f1e43e3-0667-4421-ad70-d7adf37c167a}}" Method="IArchivable">
      <Single Name="HideNamespaces" Type="bool">False</Single>
    </Single>
    <Single Name="AreElementsSpaceOptimized" Type="bool">False</Single>
  </Single>
  <Single Name="Interface" Type="{{a9ed5b7e-75c5-4651-af16-d2c27e98cb94}}" Method="IArchivable">
    <Single Name="TextDocument" Type="{{f3878285-8e4f-490b-bb1b-9acbb7eb04db}}" Method="IArchivable">
      <Single Name="TextBlobForSerialisation" Type="string">PROGRAM {pouName}
{declarations}
</Single>
      <Single Name="LineInfoPersistence" Type="string">71552f49-1870-48d9-9e53-7fe6f4f58ae5_Decl_LineIds</Single>
    </Single>
  </Single>
  <Single Name="UniqueIdGenerator" Type="string">4</Single>
  <Single Name="POULevel" Type="{{8e575c5b-1d37-49c6-941b-5c0ec7874787}}">Standard</Single>
  <List Name="ChildObjectGuids" Type="System.Collections.ArrayList" />
  <Single Name="AddAttributeSubsequent" Type="bool">False</Single>
</Single>]]></ArchivedContent>
  </POU>
</RTACModule>'''
