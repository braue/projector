seed='''<Single Type="{{c694e3a2-5c0b-4177-ab35-cb06bd5a6a02}}" Method="IArchivable">
  <Single Name="Id" Type="long">{uniqueId}</Single>
  <Single Name="Value" Type="{{f8db32ff-bdd5-49e9-9014-6d9a6dea5d8c}}" Method="IArchivable">
    <Single Name="VisuNodeReferenceGuid" Type="System.Guid">00000000-0000-0000-0000-000000000000</Single>
    <Null Name="VisuNodeReference" />
    <Single Name="VisNodeRefs33" Type="string">{visuName}</Single>
    <List Name="TypeNodeChildren" Type="System.Collections.ArrayList" />
    <Single Name="TypeNodeType" Type="{{b12a9636-e818-4598-ae0d-fb6a2446102c}}" Method="IArchivable">
      <Single Name="TypeClass" Type="{{16f7aa24-038f-444e-9d81-b001bc091d35}}">Userdef</Single>
      <Single Name="QualifiedName" Type="string">IVisualisation</Single>
      <Single Name="Name" Type="string">IVisualisation</Single>
    </Single>
    <Single Name="TypeNodeName" Type="string">[{index}]</Single>
    <Single Name="TypeNodeAttributes" Type="{{c1464dbe-c10d-4717-be8f-63efe8638434}}" Method="IArchivable">
      <Single Name="AttrFlags" Type="ulong">0</Single>
      <Dictionary Type="System.Collections.Hashtable" Name="TypeNodeAttributesData">
        <Entry>
          <Key>
            <Single Type="string">ieccodeconversion_useexistinginterface</Single>
          </Key>
          <Value>
            <Single Type="string">_3S.CoDeSys.VisuGenerated.IVisualisationIEC</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">conditionalshow</Single>
          </Key>
          <Value>
            <Single Type="string">visu_elemdev</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">''NORMAL__COMMENT</Single>
          </Key>
          <Value>
            <Single Type="string"> interface contains additional methods to IVisualElement</Single>
          </Value>
        </Entry>
      </Dictionary>
      <Single Name="ConvDone" Type="bool">True</Single>
    </Single>
    <Single Name="TypeNodeId" Type="short">1</Single>
    <Single Name="TypeNodeIdLong" Type="long">{uniqueId}</Single>
    <Null Name="LibraryId" />
    <Null Name="ElementId" />
    <Null Name="DisplayTextId" />
    <Null Name="DescriptionTextID" />
    <Single Name="DescriptionUseParent" Type="bool">False</Single>
  </Single>
</Single>'''

def genChildProperty(visuName, index, uniqueId):
    """
    Generates a child property XML string based on the provided parameters.
    
    :param visuName: The name of the visualization node.
    :param index: The index of the node.
    :param uniqueId: A unique identifier for the node.
    :return: A formatted XML string with the provided parameters.
    """
    return seed.format(visuName=visuName, index=index, uniqueId=uniqueId)
