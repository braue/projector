// A hand-rolled minimal SCL: RELAY_1 publishes one GOOSE dataset (with a
// wire address on subnetwork S1); RTU_1 subscribes to it with one bound
// ExtRef plus one unbound template slot. Exercises fast-xml-parser's
// single-element collapse everywhere.

const MINI_SCL = `<?xml version="1.0" encoding="utf-8"?>
<SCL xmlns="http://www.iec.ch/61850/2003/SCL" version="2007" revision="B">
  <Header id="mini" version="1" toolID="hand-rolled" />
  <Communication>
    <SubNetwork name="S1" type="8-MMS">
      <ConnectedAP iedName="RELAY_1" apName="S1">
        <Address>
          <P type="IP">10.0.0.5</P>
          <P type="IP-SUBNET">255.255.255.0</P>
        </Address>
        <PhysConn type="Connection"><P type="Port">Port 5</P></PhysConn>
        <GSE ldInst="CFG" cbName="GPub01">
          <Address>
            <P type="MAC-Address">01-0C-CD-01-00-01</P>
            <P type="APPID">1001</P>
          </Address>
        </GSE>
      </ConnectedAP>
    </SubNetwork>
  </Communication>
  <IED name="RELAY_1" type="TEST" manufacturer="SEL">
    <AccessPoint name="S1">
      <Server>
        <LDevice inst="CFG">
          <LN0 lnClass="LLN0" inst="" lnType="T0">
            <DataSet name="GPDSet01"><FCDA ldInst="CFG" lnClass="GGIO" doName="Ind001" fc="ST" /></DataSet>
            <GSEControl name="GPub01" datSet="GPDSet01" appID="Bay1" confRev="1" />
            <ReportControl name="BRep01" datSet="GPDSet01" rptID="BRep01" buffered="true" confRev="1" />
          </LN0>
          <LN lnClass="GGIO" inst="1" lnType="T1" />
        </LDevice>
      </Server>
    </AccessPoint>
  </IED>
  <IED name="RTU_1" type="TEST" manufacturer="SEL">
    <AccessPoint name="S1">
      <Server>
        <LDevice inst="ANN">
          <LN0 lnClass="LLN0" inst="" lnType="T0">
            <Inputs>
              <ExtRef iedName="RELAY_1" serviceType="GOOSE" ldInst="CFG" lnClass="GGIO" lnInst="1"
                      doName="Ind001" daName="stVal" srcLDInst="CFG" srcLNClass="LLN0" srcCBName="GPub01"
                      intAddr="SPS001.stVal" />
              <ExtRef serviceType="GOOSE" intAddr="SPS002.stVal" />
            </Inputs>
          </LN0>
        </LDevice>
      </Server>
    </AccessPoint>
  </IED>
</SCL>`;

export { MINI_SCL };
