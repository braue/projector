template = """<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <DataType>
    <Name>{pouName}</Name>
    <Content><![CDATA[{{attribute 'qualified_only'}}
{{attribute 'strict'}}
{{attribute 'to_string'}}
(*
	Update with the names of the different area screens. Place in order of the view frame in Main_Visu.
*)
TYPE {pouName} : (
{enums}
);
END_TYPE]]></Content>
  </DataType>
</RTACModule>"""