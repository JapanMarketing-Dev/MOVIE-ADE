import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { openZip, resolvePartPath, relsPathOf } from '@shared/office/zip'
import { parseXml, attr, documentElement } from '@shared/office/xml'
import { isLegacyOffice, officeKindOf, renderOffice, type OfficeLabels } from '@shared/office'
import { columnName, formatNumber, isDateFormat, parseCellRef } from '@shared/office/xlsx'

/** テスト用の ZIP（偶数番目は無圧縮、奇数番目は deflate） */
function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  Object.entries(files).forEach(([name, content], index) => {
    const data = Buffer.from(content)
    const method = index % 2 === 1 ? 8 : 0
    const stored = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    chunks.push(local, nameBytes, stored)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(stored.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + stored.length
  })
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cd, end]))
}

const labels: OfficeLabels = {
  missingImage: 'image',
  chart: 'Chart',
  slide: (n, total) => `${n} / ${total}`,
  sheetTruncated: 'Only the first rows are shown.'
}

// 1x1 の PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
const REL = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`

describe('zip', () => {
  it('reads stored and deflated entries', async () => {
    const zip = openZip(makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'こんにちは'.repeat(50) }))
    expect(zip.names()).toEqual(['a.txt', 'dir/b.txt'])
    expect(await zip.text('a.txt')).toBe('hello')
    expect(await zip.text('dir/b.txt')).toBe('こんにちは'.repeat(50))
    expect(await zip.text('missing')).toBeNull()
  })

  it('rejects data that is not a zip', () => {
    expect(() => openZip(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('resolves relationship targets', () => {
    expect(resolvePartPath('word/document.xml', 'media/image1.png')).toBe('word/media/image1.png')
    expect(resolvePartPath('ppt/slides/slide1.xml', '../slideLayouts/slideLayout2.xml')).toBe('ppt/slideLayouts/slideLayout2.xml')
    expect(resolvePartPath('xl/workbook.xml', '/xl/worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml')
    expect(relsPathOf('word/document.xml')).toBe('word/_rels/document.xml.rels')
  })
})

describe('xml', () => {
  it('keeps local names, attributes, entities and quoted >', () => {
    const root = documentElement(parseXml('<?xml version="1.0"?><w:p a="x &gt; y" b=\'1\'><!-- c --><w:t xml:space="preserve"> A &amp; B &#x3042;</w:t><![CDATA[<raw>]]></w:p>'))!
    expect(root.name).toBe('p')
    expect(attr(root, 'a')).toBe('x > y')
    expect(root.children[0]!.text).toBe(' A & B あ')
    expect(root.text).toBe('<raw>')
  })

  it('does not expand DTD entities', () => {
    const root = documentElement(parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>'))!
    expect(root.text).toBe('&e;')
  })
})

describe('file kinds', () => {
  it('maps extensions', () => {
    expect(officeKindOf('a/report.DOCX')).toBe('docx')
    expect(officeKindOf('book.xlsm')).toBe('xlsx')
    expect(officeKindOf('deck.ppsx')).toBe('pptx')
    expect(officeKindOf('notes.txt')).toBeNull()
    expect(isLegacyOffice('old.xls')).toBe(true)
    expect(isLegacyOffice('new.xlsx')).toBe(false)
  })
})

describe('docx', () => {
  const docx = (body: string, extra: Record<string, string | Uint8Array> = {}) => makeZip({
    'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906"/><w:pgMar w:top="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `<w:styles ${W}><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="a5"><w:name w:val="Title"/></w:style></w:styles>`,
    'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    ...extra
  })

  it('renders headings, styled runs, lists and escapes text', async () => {
    const body = [
      '<w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>見出し</w:t></w:r></w:p>',
      '<w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> &lt;script&gt;x&lt;/script&gt;</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>dot</w:t></w:r></w:p>',
      '<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>'
    ].join('')
    const result = await renderOffice('docx', docx(body), 'doc', labels)
    if (result.kind !== 'document') throw new Error('kind')
    expect(result.html).toContain('<p class="docx-title">Plan</p>')
    expect(result.html).toContain('<h1>見出し</h1>')
    expect(result.html).toContain('font-weight:700;color:#ff0000">bold</span>')
    expect(result.html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(result.html).not.toContain('<script>')
    expect(result.html).toContain('>1.</span><span>one')
    expect(result.html).toContain('>2.</span><span>two')
    expect(result.html).toContain('>•</span><span>dot')
    expect(result.html).toContain('added')
    expect(result.html).not.toContain('gone')
    expect(result.html).toContain("default-src 'none'")
  })

  it('renders tables with merged cells and embedded images', async () => {
    const body = [
      '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc></w:tr>',
      '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>tall</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>',
      '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
      '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:blip r:embed="rId6"/></wp:inline></w:drawing></w:r></w:p>'
    ].join('')
    const zip = docx(body, {
      'word/_rels/document.xml.rels': `<Relationships>${REL('rId5', 'image', 'media/image1.png')}${REL('rId6', 'image', 'https://example.com/x.png', true)}</Relationships>`,
      'word/media/image1.png': PNG
    })
    const result = await renderOffice('docx', zip, 'doc', labels)
    if (result.kind !== 'document') throw new Error('kind')
    expect(result.html).toContain('<td colspan="2"><p>wide</p></td>')
    expect(result.html).toContain('<td rowspan="2"><p>tall</p></td>')
    expect(result.html).toContain('src="data:image/png;base64,')
    expect(result.html).toContain('width="100" height="50"')
    // 外の画像は読みに行かない
    expect(result.html).not.toContain('example.com/x.png')
  })
})

describe('xlsx', () => {
  const xlsx = () => makeZip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="売上" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `<Relationships>${REL('rId1', 'worksheet', 'worksheets/sheet1.xml')}${REL('rId2', 'worksheet', 'worksheets/sheet2.xml')}${REL('rId3', 'sharedStrings', 'sharedStrings.xml')}${REL('rId4', 'styles', 'styles.xml')}</Relationships>`,
    'xl/sharedStrings.xml': '<sst><si><t>商品</t></si><si><r><t>A&amp;</t></r><r><t>B</t></r></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><fonts><font/><font><b/><color rgb="FFFF0000"/></font></fonts><fills><fill/><fill/></fills><cellXfs><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="0"/><xf numFmtId="3" fontId="1"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><cols><col min="1" max="1" width="20"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>46301</v></c><c r="B2" s="2"><v>1234567</v></c><c r="C2" s="3"><v>0.256</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="inlineStr"><is><t>&lt;b&gt;</t></is></c></row></sheetData><mergeCells><mergeCell ref="A4:C5"/></mergeCells></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>'
  })

  it('renders cells with shared strings, formats, merges and styles', async () => {
    const result = await renderOffice('xlsx', xlsx(), 'book', labels)
    if (result.kind !== 'sheets') throw new Error('kind')
    expect(result.sheets.map((s) => [s.name, s.hidden])).toEqual([['売上', false], ['Hidden', true]])
    const html = await result.sheets[0]!.render()
    expect(html).toContain('>商品</td>')
    expect(html).toContain('>A&amp;B</td>')
    expect(html).toContain('>2026-10-06</td>')
    expect(html).toContain('style="font-weight:700;color:#ff0000">1,234,567</td>')
    expect(html).toContain('>25.60%</td>')
    expect(html).toContain('>TRUE</td>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('colspan="3" rowspan="2"')
    expect(html).toContain('<col style="width:145px">')
  })

  it('formats numbers and cell references', () => {
    expect(parseCellRef('AB12')).toEqual({ col: 27, row: 11 })
    expect(columnName(27)).toBe('AB')
    expect(columnName(0)).toBe('A')
    expect(isDateFormat('yyyy/mm/dd')).toBe(true)
    expect(isDateFormat('#,##0.00')).toBe(false)
    expect(isDateFormat('"m"0')).toBe(false)
    expect(formatNumber(0.5, 'h:mm')).toBe('12:00')
    expect(formatNumber(1234.5, '#,##0.00')).toBe('1,234.50')
    expect(formatNumber(-5, '#,##0;(#,##0)')).toBe('(5)')
    expect(formatNumber(12345, '0.00E+00')).toBe('1.23E+04')
    expect(formatNumber(0.1 + 0.2, 'General')).toBe('0.3')
    // 1900 年の仕組みの 60 番（1900-02-29）より前と後
    expect(formatNumber(59, 'yyyy-mm-dd')).toBe('1900-02-28')
    expect(formatNumber(61, 'yyyy-mm-dd')).toBe('1900-03-01')
  })
})

describe('pptx', () => {
  const P = 'xmlns:p="p" xmlns:a="a" xmlns:r="r"'
  const pptx = () => makeZip({
    'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${REL('rId2', 'slide', 'slides/slide1.xml')}${REL('rId3', 'slide', 'slides/slide2.xml')}</Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld ${P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:r><a:rPr lang="ja"/><a:t>四半期の計画</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="3429000"/><a:ext cx="6096000" cy="1371600"/></a:xfrm><a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2400" b="1"/><a:t>&lt;img onerror&gt;</a:t></a:r></a:p></p:txBody></p:sp>
      <p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr></p:pic>
      <p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
    </p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships>${REL('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')}${REL('rId9', 'image', '../media/image1.png')}</Relationships>`,
    'ppt/slides/slide2.xml': `<p:sld ${P}><p:cSld><p:spTree/></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships>${REL('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')}</Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="9753600" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Click to add title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<Relationships>${REL('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')}</Relationships>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="6400800"/><a:ext cx="12192000" cy="457200"/></a:xfrm><a:solidFill><a:srgbClr val="FF8800"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<Relationships>${REL('rId1', 'theme', '../theme/theme1.xml')}</Relationships>`,
    'ppt/theme/theme1.xml': '<a:theme xmlns:a="a"><a:themeElements><a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>',
    'ppt/media/image1.png': PNG
  })

  it('renders slides with inherited placeholder positions, theme colors and master decoration', async () => {
    const result = await renderOffice('pptx', pptx(), 'deck', labels)
    if (result.kind !== 'slides') throw new Error('kind')
    expect(result.slides).toBe(2)
    const html = result.html
    expect(html.match(/class="pptx-slide"/g)).toHaveLength(2)
    expect(html).toContain('background:#112233')
    // タイトルはレイアウトの位置を受け継ぐ（10% / 10%）。レイアウトの「Click to add title」は出さない
    expect(html).toContain('left:10.000%;top:10.000%;width:80.000%')
    expect(html).toContain('四半期の計画')
    expect(html).not.toContain('Click to add title')
    // マスターの帯
    expect(html).toContain('background:#ff8800')
    expect(html).toContain('background:#4472c4')
    expect(html).toContain('border-radius:50%')
    expect(html).toContain('&lt;img onerror&gt;')
    expect(html).not.toContain('<img onerror')
    expect(html).toContain('>•</span>')
    expect(html).toContain('font-weight:700')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain('>cell</span>')
    expect(html).toContain('1 / 2')
  })

  it('refuses encrypted documents', async () => {
    await expect(renderOffice('docx', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'x', labels)).rejects.toThrow()
  })
})
