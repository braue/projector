template = '''<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <Visualization>
    <Name>{name}</Name>
    <ArchivedContent><![CDATA[<?xml version="1.0" encoding="utf-8"?>
<Single xml:space="preserve" Type="{{f18bec89-9fef-401d-9953-2f11739a6808}}" Method="IArchivable">
  <Null Name="LastVisuLanguageModelEntry" />
  <Single Name="UniqueIdGenerator" Type="string">6</Single>
  <Single Name="VisualElemList" Type="{{f285c9a3-7019-446b-b98c-ccec3a0af8fa}}" Method="IArchivable">
    <List Name="VisualElementList" Type="{{ef9d0b20-c96e-48db-b361-2ded4063150e}}" />
    <Single Name="BackgroundBitmapId" Type="string"></Single>
    <Single Name="BackgroundColor" Type="int">16777215</Single>
    <Single Name="Background" Type="{{1038f12c-dd4b-4f96-87a3-a350fe8f3552}}" Method="IArchivable">
      <Null Name="BgGradient" />
      <Null Name="BgNamedColor" />
      <Single Name="BgBmpId" Type="string"></Single>
      <Single Name="BgUseBmp" Type="bool">False</Single>
      <Single Name="BgColor" Type="bool">False</Single>
      <Single Name="BgUseColor" Type="int">16777215</Single>
      <Single Name="BgUseGradient" Type="bool">False</Single>
    </Single>
  </Single>
  <Single Name="GeneratedLMMDescriptions" Type="{{703465dc-4679-4ff2-bcc3-c57d0a204da3}}" Method="IArchivable">
    <Single Name="GeneratedVisuFbDescription" Type="{{40d6dd8d-dfd0-493a-8e29-c9a35e1e6539}}" Method="IArchivable">
      <Dictionary Type="{{7df88604-7ac5-4e36-91c4-55e4fdad3e68}}" Name="FbMethods">
        <Entry>
          <Key>
            <Single Type="string">HasVisibilityAccess</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">be76671f-b304-4fa6-a75d-a20994725cfa</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ContainsPoint</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">3844ec87-a1e5-4871-94c1-c7b1b6d701d7</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">HasInputAccess</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">73699cde-ef21-494b-a168-222c10061a55</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">Update</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">30f983e1-ca85-4f03-9e7d-8035229939d9</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetTooltip</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">7ccbb410-8472-45c1-8529-696b515ba011</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetDialogInterfaceSize</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">2643b9ff-ad9f-452b-87c3-86c416a307ce</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetUpdateRects</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">d94911b0-670e-4244-9729-1fe0cb21dc41</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetNamespace</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">d41a3f23-9946-4ee6-93b1-ba6e4dcb356a</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">SetResult</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">f67075c8-eb62-4266-9061-d648bc269cea</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetTranslator</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">6d743221-9268-40dd-b8d8-fc616602220e</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">SetClientData</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">b820332c-fd99-4b8c-8786-52cd64767f85</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">HasVisibilityAccessIntern</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">a1800829-e7da-581c-9de3-aba742624f6d</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetInstance</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">92d276f0-6315-4f16-8d89-28329170b7c5</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetClientData</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">57bf5bab-dc2e-4abf-a2f9-606e65e5274e</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">Paint</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">b8050608-d84b-4e3a-a432-e9a03548f93c</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetElementArray</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">16c3306c-7821-4cec-bfb2-0b81dbff2ace</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">SetVisuFlagsInternal</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">cf5b23cd-eb47-45f0-b7ed-c5f753256208</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetText</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">03300575-76b9-45f8-9a03-f80594223e81</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetTextProperties</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">117763ba-77e9-4e12-9c6f-92b40d3a6ab6</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">IsAntialiasingInactive</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">2e443792-b89a-473e-9e4e-443e0daab0c9</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">HasInputAccessIntern</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">6452a83a-59bf-548c-b1a5-381be3d4b07d</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">Initialize</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">2793f5fe-de06-44fc-8dd0-3d88af61ac04</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">Destruct</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">929b1ea1-ec7c-46b9-846c-fd9eedef8cb3</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">SetStaticState</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">1ac28266-a13f-4130-96dd-e8c8ec626dda</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetSurroundingRect</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">5aeb68c9-3eb5-4e55-90d8-21bf5b6b9209</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetResult</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">3325830c-5725-4ff0-a2b8-7d6d5d1f1b9e</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetLocalUsergroup</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">92183523-a977-4987-80fc-6a3801805f32</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetName</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">e2fd3500-69e7-4c48-afad-7419692aa623</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetSize</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">73fd1590-2123-4c9f-b14d-99b180c416c8</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">SetDialogInterface</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">616f9ffa-fef9-4ac0-88d8-114bc6445289</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">FB_Reinit</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">02c39afc-5bfc-4fd3-9973-d91f4b3edca1</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">FB_Exit</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">caf045a9-d819-4e7a-ba7a-019a8d63d5f5</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetInitializeVersion</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">49a6827f-d7e4-45c1-89e1-a02d4bb20fe9</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetDialogInterface</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">397013be-c2d5-4009-8693-e4b97ad96da0</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetElementIdArray</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">1c687bfd-09f8-4766-8cee-e0cecc01df78</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">HandleInput</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">7abe9409-b3e5-4c19-995f-2a50b0833325</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ElementInfo</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">13dedbfd-b29e-493b-a82e-6b394a8f4f14</Single>
          </Value>
        </Entry>
      </Dictionary>
      <Single Name="FbName" Type="string">NotImportant</Single>
      <Single Name="FbGuid" Type="System.Guid">78fcb8e8-4a2a-4473-a237-e8028b75bb32</Single>
    </Single>
    <Single Name="GeneratedGlobalVisuVarsGuid" Type="System.Guid">4e874ecc-cb77-40dd-b86e-4e8e0c7d3c8e</Single>
    <Single Name="GeneratedGlobalTheVisuVarlistGuid" Type="System.Guid">94319dd2-d1a5-480b-827e-a8516383af90</Single>
    <Single Name="GeneratedGlobalVisuConstants" Type="System.Guid">bc2c8fdc-04e4-444f-8213-bdd674881991</Single>
    <Dictionary Type="System.Collections.Hashtable" Name="GeneratedAllElementsEntries" />
    <Single Name="VisuRegDesc" Type="{{40d6dd8d-dfd0-493a-8e29-c9a35e1e6539}}" Method="IArchivable">
      <Dictionary Type="{{7df88604-7ac5-4e36-91c4-55e4fdad3e68}}" Name="FbMethods">
        <Entry>
          <Key>
            <Single Type="string">FB_Init</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">6d894737-0dcc-472a-82ca-446d9470e537</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">FB_Exit</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">45a624c6-26ce-41d4-83c7-3e4dde18aa18</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">FB_Reinit</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">95af70f2-a1e7-4e71-a412-0385e1454896</Single>
          </Value>
        </Entry>
      </Dictionary>
      <Single Name="FbName" Type="string">NotImportant</Single>
      <Single Name="FbGuid" Type="System.Guid">70a02648-3adf-4a11-8009-ddadb449e564</Single>
    </Single>
    <Single Name="VisuRegisterGvl" Type="System.Guid">191e18fe-3e51-4758-9c86-9bdba7507efc</Single>
    <Null Name="SettingsPou" />
    <Null Name="MemManPou" />
    <Single Name="InputsPou" Type="{{40d6dd8d-dfd0-493a-8e29-c9a35e1e6539}}" Method="IArchivable">
      <Dictionary Type="{{7df88604-7ac5-4e36-91c4-55e4fdad3e68}}" Name="FbMethods">
        <Entry>
          <Key>
            <Single Type="string">ExecuteLooseCapture</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">1f4e6b00-81f4-4a58-b78b-1903c316e827</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseDblClick</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">3eb2fe73-0851-486c-b5be-bcaad660caa3</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseDown</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">a0930938-eee4-44c2-b1f4-e1df625c6394</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseUp</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">11826ba9-4e2e-4b3e-8f8f-d9de2ef5c0dd</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">GetElementInfo</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">018b12cd-bdfc-463d-adee-fcd55ad29ad0</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">abstrGetDefaultCursor</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">6af1bab0-fde0-461f-ba2a-c65e72780352</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteDialogClosed</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">b4b32368-63d4-4201-93e1-f7797e3f518c</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteKeyUp</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">3bd90531-0a1d-4781-8eb5-a726750a57cb</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteKeyDown</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">a572d740-9921-460f-9506-205850eb96ad</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseMove</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">b5527228-020b-432e-ac3d-10f29e68817f</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">Initialize</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">5884957a-76bd-4637-857c-59411d737462</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteValueChanged</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">5cdc904f-318f-40fc-a27e-aae46c0b90a2</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseEnter</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">0dc64d9d-e60f-4bca-9bae-42e77044f5b2</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseLeave</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">34b04ddb-42f5-438c-8246-83372b92b003</Single>
          </Value>
        </Entry>
        <Entry>
          <Key>
            <Single Type="string">ExecuteMouseClick</Single>
          </Key>
          <Value>
            <Single Type="System.Guid">b4a384d2-ae52-4402-82ca-30e2f256e107</Single>
          </Value>
        </Entry>
      </Dictionary>
      <Single Name="FbName" Type="string">NotImportant</Single>
      <Single Name="FbGuid" Type="System.Guid">8ab592cc-8680-487c-9e95-55775ac51d60</Single>
    </Single>
    <Single Name="DialogDut" Type="System.Guid">111449f0-f7f2-4dcd-a670-3b7b562ea14e</Single>
  </Single>
  <Single Name="LastUsedIdForIdentifier" Type="int">0</Single>
  <Single Name="TextDocument" Type="{{f3878285-8e4f-490b-bb1b-9acbb7eb04db}}" Method="IArchivable">
    <Single Name="TextBlobForSerialisation" Type="string">VAR_IN_OUT
	
END_VAR</Single>
    <Null Name="LineInfoPersistence" />
  </Single>
  <Single Name="GvlCreated" Type="bool">False</Single>
  <Null Name="LMEntry" />
  <Single Name="ProfileCompatibilityId" Type="long">4140216668</Single>
  <Single Name="LMVerMinor" Type="int">0</Single>
  <Single Name="LMVerMajor" Type="int">1</Single>
  <Single Name="Hotkeys" Type="{{6b108d46-58af-4e41-a3f4-174d8f160cc4}}" Method="IArchivable">
    <Single Name="IdMin" Type="long">481037385728</Single>
    <Single Name="IdMax" Type="long">549755813887</Single>
    <Single Name="Id" Type="long">481037385728</Single>
    <Single Name="IdMask" Type="long">549754765312</Single>
    <Single Name="IdStep" Type="long">1048576</Single>
    <List2 Name="Inputs" />
  </Single>
  <Null Name="VisuSizeManager" />
</Single>]]></ArchivedContent>
  </Visualization>
</RTACModule>'''