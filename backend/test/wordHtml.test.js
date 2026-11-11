// Word documents as preview HTML: structure, and that nothing from the file
// reaches the HTML unescaped.

import assert from 'node:assert/strict';
import test from 'node:test';

import { strToU8 } from 'fflate';

import { wordHtml } from '../lib/extract/wordHtml.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function pkg(body, extra = {}) {
  return Object.fromEntries(Object.entries({
    'word/document.xml': `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<w:styles ${NS}>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="MyHead"><w:name w:val="My Head"/><w:basedOn w:val="Heading1"/></w:style>
      <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    </w:styles>`,
    'word/numbering.xml': `<w:numbering ${NS}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    </w:numbering>`,
    ...extra,
  }).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]));
}

const p = (text, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const list = (level, text) => p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`);

test('word html: headings, inherited heading styles, runs and nested lists', () => {
  const html = wordHtml(pkg([
    p('Title', '<w:pStyle w:val="Heading1"/>'),
    p('Sub', '<w:pStyle w:val="MyHead"/>'),
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bo</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ld</w:t></w:r>'
      + '<w:r><w:rPr><w:i w:val="0"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r>'
      + '<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t> new</w:t></w:r></w:ins></w:p>',
    list(0, 'a'),
    list(1, 'a1'),
    list(1, 'a2'),
    list(0, 'b'),
    p('styled item', '<w:pStyle w:val="ListBullet"/>'),
    p('after'),
  ].join('')));
  assert.equal(html, [
    '<h1>Title</h1><h1>Sub</h1>',
    '<p><strong>bold</strong><sup>2</sup> new</p>',
    '<ul><li>a<ol><li>a1</li><li>a2</li></ol></li><li>b</li><li>styled item</li></ul>',
    '<p>after</p>',
  ].join(''));
});

test('word html: merged table cells become rowspan and colspan, header rows a thead', () => {
  const tc = (text, pr = '') => `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}${p(text)}</w:tc>`;
  const html = wordHtml(pkg(`<w:tbl>
    <w:tr><w:trPr><w:tblHeader/></w:trPr>${tc('H1')}${tc('H2', '<w:gridSpan w:val="2"/>')}</w:tr>
    <w:tr>${tc('A', '<w:vMerge w:val="restart"/>')}${tc('B')}${tc('C')}</w:tr>
    <w:tr>${tc('', '<w:vMerge/>')}${tc('D')}${tc('E')}</w:tr>
    <w:tr>${tc('', '<w:vMerge/>')}${tc('F', '<w:gridSpan w:val="2"/>')}</w:tr>
  </w:tbl>`));
  assert.equal(html, '<table><thead><tr><th><p>H1</p></th><th colspan="2"><p>H2</p></th></tr></thead><tbody>'
    + '<tr><td rowspan="3"><p>A</p></td><td><p>B</p></td><td><p>C</p></td></tr>'
    + '<tr><td><p>D</p></td><td><p>E</p></td></tr>'
    + '<tr><td colspan="2"><p>F</p></td></tr></tbody></table>');
});

test('word html: document text, link targets and alt text are escaped', () => {
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rL" Type="hyperlink" Target="javascript:alert(&quot;x&quot;)&quot; onclick=&quot;x" TargetMode="External"/>
    <Relationship Id="rI" Type="image" Target="media/a.png"/>
    <Relationship Id="rE" Type="image" Target="media/b.emf"/>
  </Relationships>`;
  const html = wordHtml(pkg([
    p('&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q"'),
    '<w:p><w:hyperlink r:id="rL"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>',
    '<w:p><w:r><w:drawing><wp:inline xmlns:wp="wp"><wp:docPr id="1" descr="&quot; onerror=&quot;x"/>'
      + '<a:graphic xmlns:a="a"><a:blip r:embed="rI"/></a:graphic></wp:inline></w:drawing>'
      + '<w:drawing><a:blip xmlns:a="a" r:embed="rE"/></w:drawing></w:r></w:p>',
  ].join(''), {
    'word/_rels/document.xml.rels': rels,
    'word/media/a.png': new Uint8Array([1, 2, 3]),
    'word/media/b.emf': new Uint8Array([4]),
  }));
  assert.equal(html, [
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>',
    '<p><a data-href="javascript:alert(&quot;x&quot;)&quot; onclick=&quot;x" title="javascript:alert(&quot;x&quot;)&quot; onclick=&quot;x">link</a></p>',
    // The EMF is left out: a browser cannot draw it.
    '<p><img src="data:image/png;base64,AQID" alt="&quot; onerror=&quot;x" /></p>',
  ].join(''));
  assert.doesNotMatch(html, /<script|\shref=/);
});

test('word html: checkbox content controls become checkboxes', () => {
  const box = (checked) => `<w:sdt><w:sdtPr><w14:checkbox xmlns:w14="w14"><w14:checked w14:val="${checked}"/></w14:checkbox></w:sdtPr>`
    + `<w:sdtContent><w:r><w:t>${checked ? '☒' : '☐'}</w:t></w:r></w:sdtContent></w:sdt>`;
  const html = wordHtml(pkg(`<w:p><w:r><w:t xml:space="preserve">Sat </w:t></w:r>${box(1)}${box(0)}</w:p>`));
  assert.equal(html, '<p>Sat <input type="checkbox" checked /><input type="checkbox" /></p>');

  // A control around a whole table cell, drawn with its own declared glyph.
  const cell = wordHtml(pkg('<w:tbl><w:tr><w:sdt><w:sdtPr><w14:checkbox xmlns:w14="w14"><w14:checked w14:val="1"/>'
    + '<w14:checkedState w14:val="2713"/></w14:checkbox></w:sdtPr><w:sdtContent><w:tc>'
    + '<w:p><w:r><w:t>✓ ☐</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt></w:tr></w:tbl><w:p><w:r><w:t>☐</w:t></w:r></w:p>'));
  assert.equal(cell, '<table><tbody><tr><td><p><input type="checkbox" checked /> <input type="checkbox" checked /></p></td></tr></tbody></table><p>☐</p>');
});

test('word html: footnotes collect at the end, numbered by reference', () => {
  const notes = `<w:footnotes ${NS}><w:footnote w:id="5">${p('The note.')}</w:footnote></w:footnotes>`;
  const html = wordHtml(pkg('<w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:footnoteReference w:id="5"/></w:r></w:p>', {
    'word/footnotes.xml': notes,
  }));
  assert.equal(html, '<p>Claim<sup>[1]</sup></p><ol><li><p>The note.</p></li></ol>');
});
