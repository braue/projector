// A hand-rolled minimal SCL: RELAY_1 publishes one GOOSE dataset (with a
// wire address on subnetwork S1); RTU_1 subscribes to it with one bound
// ExtRef plus one unbound template slot. Exercises fast-xml-parser's
// single-element collapse everywhere, plus the Architect-workbook details the
// parser resolves: DAI sAddr source mapping (with an imm: immediate to
// filter), units SDIs, SEL GOOSE TX privates, and report trigger/option
// elements.

const MINI_SCL = `<?xml version="1.0" encoding="utf-8"?>
<SCL xmlns="http://www.iec.ch/61850/2003/SCL" xmlns:esel="http://www.selinc.com/2006/61850" version="2007" revision="B">
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
            <P type="VLAN-ID">014</P>
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
            <DataSet name="GPDSet01">
              <FCDA ldInst="CFG" lnClass="GGIO" lnInst="1" doName="Ind001" daName="stVal" fc="ST" />
              <FCDA ldInst="CFG" prefix="MET" lnClass="GGIO" lnInst="2" doName="AnIn001" fc="MX" />
              <FCDA ldInst="CFG" prefix="MET" lnClass="GGIO" lnInst="2" doName="AnIn001" daName="instMag.f" fc="MX" />
            </DataSet>
            <GSEControl name="GPub01" datSet="GPDSet01" appID="Bay1" confRev="1">
              <Private type="SEL_GOOSETXAddress">
                <esel:Address>
                  <esel:P type="MAC-Address">01-0C-CD-01-00-01</esel:P>
                  <esel:P type="APPID">1001</esel:P>
                  <esel:P type="VLAN-ID">001</esel:P>
                  <esel:P type="VLAN-PRIORITY">4</esel:P>
                </esel:Address>
              </Private>
              <Private type="SEL_GOOSETXMinTime"><esel:MinTime>4</esel:MinTime></Private>
              <Private type="SEL_GOOSETXMaxTime"><esel:MaxTime>1000</esel:MaxTime></Private>
            </GSEControl>
            <ReportControl name="BRep01" datSet="GPDSet01" rptID="BRep01" buffered="true" bufTime="500" confRev="1">
              <TrgOps dchg="true" qchg="true" period="true" intgPd="60000" />
              <OptFields seqNum="true" timeStamp="true" reasonCode="true" />
              <RptEnabled max="2" />
            </ReportControl>
          </LN0>
          <LN lnClass="GGIO" inst="1" lnType="T1">
            <DOI name="Ind001">
              <DAI name="stVal" sAddr="db:IN101" />
            </DOI>
          </LN>
          <LN prefix="MET" lnClass="GGIO" inst="2" lnType="T2">
            <DOI name="AnIn001">
              <SDI name="instMag">
                <DAI name="f" sAddr="db:VBAT" />
              </SDI>
              <SDI name="units">
                <DAI name="SIUnit"><Val>V</Val></DAI>
                <DAI name="multiplier"><Val /></DAI>
              </SDI>
              <DAI name="db" sAddr="imm:100"><Val>1000</Val></DAI>
            </DOI>
          </LN>
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
