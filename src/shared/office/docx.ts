/**
 * Word（.docx）を読みやすい HTML にする（見出し・文字の飾り・箇条書き・表・画像）。
 * 書式を完全には再現しない（ヘッダー・フッター・脚注・テキストボックスの位置は出さない）。
 * 変更履歴は、取り込んだ後の内容（削除は出さず、挿入は出す）で見せる。
 */
import { attr, child, children, descendants, documentElement, escapeHtml, parseRels, parseXml, type XmlNode } from './xml'
import { relsPathOf, resolvePartPath, type ZipArchive } from './zip'
import { emuToPx, hexColor, imageDataUrl, imagePlaceholder, officeHtml } from './common'

const DOCUMENT = 'word/document.xml'

const CSS = `
.docx-page{background:#fff;margin:24px auto;box-shadow:0 1px 4px rgba(0,0,0,.18);font-family:"Calibri","Aptos","Helvetica Neue","Hiragino Sans","Yu Gothic",Meiryo,sans-serif;font-size:14.6px;line-height:1.45;overflow-wrap:anywhere}
.docx-page p{margin:0 0 6px;min-height:1em;white-space:pre-wrap}
.docx-page h1,.docx-page h2,.docx-page h3,.docx-page h4,.docx-page h5,.docx-page h6{margin:14px 0 6px;line-height:1.25;white-space:pre-wrap}
.docx-page h1{font-size:24px}.docx-page h2{font-size:19px}.docx-page h3{font-size:16px}.docx-page h4,.docx-page h5,.docx-page h6{font-size:15px}
.docx-page .docx-title{font-size:30px;font-weight:600;margin:0 0 10px}
.docx-page table{border-collapse:collapse;margin:6px 0 10px;max-width:100%}
.docx-page td{border:1px solid #bfbfbf;padding:4px 6px;vertical-align:top}
.docx-page td p{margin:0}
.docx-page .docx-li{display:flex;gap:6px}
.docx-page .docx-marker{flex:none;min-width:1.2em}
.docx-page .docx-link{color:#1155cc;text-decoration:underline}
.docx-page hr.docx-break{border:0;border-top:1px dashed #c8c8c8;margin:16px 0}
@media (max-width:860px){.docx-page{margin:0;box-shadow:none;width:auto!important;padding:20px!important}}
`

interface DocxContext {
  zip: ZipArchive
  rels: ReturnType<typeof parseRels>
  /** styleId → 見出しの段（0 は表題）。見出しでない段落の書式は持たない */
  headings: Map<string, number>
  /** styleId → スタイルが持つ箇条書き（「List Bullet」など、段落ではなくスタイルに番号を付けたもの） */
  styleLists: Map<string, { numId: string; ilvl: number }>
  numbering: Numbering
  counters: Map<string, number[]>
  images: Map<string, string | null>
  missingImage: string
}

interface LevelFormat {
  format: string
  text: string
  start: number
  indentPx: number
}
type Numbering = Map<string, Map<number, LevelFormat>>

function twipsToPx(value: string | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n / 15 : 0
}

function readStyles(source: string | null): { headings: Map<string, number>; lists: Map<string, { numId: string; ilvl: number }> } {
  const map = new Map<string, number>()
  const lists = new Map<string, { numId: string; ilvl: number }>()
  if (!source) return { headings: map, lists }
  for (const style of children(documentElement(parseXml(source)), 'style')) {
    const id = attr(style, 'styleId')
    const name = (attr(child(style, 'name'), 'val') ?? '').toLowerCase()
    if (!id) continue
    const numPr = path2(style, 'pPr', 'numPr')
    const numId = attr(child(numPr, 'numId'), 'val')
    if (numId) lists.set(id, { numId, ilvl: Number(attr(child(numPr, 'ilvl'), 'val') ?? 0) })
    const heading = /^heading\s*([1-9])$/.exec(name)
    if (heading) map.set(id, Math.min(6, Number(heading[1])))
    else if (name === 'title') map.set(id, 0)
    else {
      // outlineLvl を持つ独自の見出し
      const outline = attr(path2(style, 'pPr', 'outlineLvl'), 'val')
      if (outline !== undefined && Number(outline) < 9) map.set(id, Math.min(6, Number(outline) + 1))
    }
  }
  return { headings: map, lists }
}

function path2(node: XmlNode | undefined, a: string, b: string): XmlNode | undefined {
  return child(child(node, a), b)
}

function readNumbering(source: string | null): Numbering {
  const result: Numbering = new Map()
  if (!source) return result
  const root = documentElement(parseXml(source))
  const abstracts = new Map<string, Map<number, LevelFormat>>()
  for (const abs of children(root, 'abstractNum')) {
    const levels = new Map<number, LevelFormat>()
    for (const lvl of children(abs, 'lvl')) {
      levels.set(Number(attr(lvl, 'ilvl') ?? 0), {
        format: attr(child(lvl, 'numFmt'), 'val') ?? 'decimal',
        text: attr(child(lvl, 'lvlText'), 'val') ?? '',
        start: Number(attr(child(lvl, 'start'), 'val') ?? 1),
        indentPx: twipsToPx(attr(path2(lvl, 'pPr', 'ind'), 'left') ?? attr(path2(lvl, 'pPr', 'ind'), 'start'))
      })
    }
    const id = attr(abs, 'abstractNumId')
    if (id !== undefined) abstracts.set(id, levels)
  }
  for (const num of children(root, 'num')) {
    const id = attr(num, 'numId')
    const abs = attr(child(num, 'abstractNumId'), 'val')
    if (id !== undefined && abs !== undefined && abstracts.has(abs)) result.set(id, abstracts.get(abs)!)
  }
  return result
}

function toRoman(n: number): string {
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [value, letters] of table) {
    while (n >= value) {
      out += letters
      n -= value
    }
  }
  return out
}

function formatNumber(n: number, format: string): string {
  switch (format) {
    case 'lowerLetter': return String.fromCharCode(97 + ((n - 1) % 26))
    case 'upperLetter': return String.fromCharCode(65 + ((n - 1) % 26))
    case 'lowerRoman': return toRoman(n)
    case 'upperRoman': return toRoman(n).toUpperCase()
    case 'decimalZero': return String(n).padStart(2, '0')
    case 'decimalFullWidth':
    case 'decimalFullWidth2': return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)))
    case 'aiueoFullWidth':
    case 'aiueo': return 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン'[(n - 1) % 46]!
    case 'ideographTraditional': return '甲乙丙丁戊己庚辛壬癸'[(n - 1) % 10]!
    default: return String(n)
  }
}

/** 箇条書きの印（「1.」「a)」「•」など）。数えるのは numId ごと */
function listMarker(ctx: DocxContext, numId: string, level: number): { marker: string; indentPx: number } | null {
  const levels = ctx.numbering.get(numId)
  const format = levels?.get(level)
  if (!levels || !format || format.format === 'none') return null
  const counts = ctx.counters.get(numId) ?? []
  counts[level] = (counts[level] ?? format.start - 1) + 1
  // 下の段の数は、上の段が進んだら最初から
  counts.length = level + 1
  ctx.counters.set(numId, counts)
  if (format.format === 'bullet') {
    const glyph = format.text && /[^-]/.test(format.text) ? format.text : '•'
    return { marker: glyph, indentPx: format.indentPx }
  }
  const marker = format.text.replace(/%([1-9])/g, (_, d: string) => {
    const lvl = Number(d) - 1
    const f = levels.get(lvl)
    return formatNumber(counts[lvl] ?? f?.start ?? 1, f?.format ?? 'decimal')
  })
  return { marker, indentPx: format.indentPx }
}

function runStyle(rPr: XmlNode | undefined): string {
  if (!rPr) return ''
  const css: string[] = []
  const on = (name: string) => {
    const node = child(rPr, name)
    if (!node) return false
    const v = attr(node, 'val')
    return v === undefined || (v !== '0' && v !== 'false' && v !== 'none')
  }
  if (on('b')) css.push('font-weight:700')
  if (on('i')) css.push('font-style:italic')
  const deco: string[] = []
  if (on('u')) deco.push('underline')
  if (on('strike') || on('dstrike')) deco.push('line-through')
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`)
  const color = hexColor(attr(child(rPr, 'color'), 'val'))
  if (color) css.push(`color:${color}`)
  const size = Number(attr(child(rPr, 'sz'), 'val'))
  if (Number.isFinite(size) && size > 0) css.push(`font-size:${Math.min(144, size / 2)}pt`)
  const highlight = attr(child(rPr, 'highlight'), 'val')
  if (highlight && highlight !== 'none') css.push(`background:${HIGHLIGHT[highlight] ?? '#ffff00'}`)
  const shade = hexColor(attr(child(rPr, 'shd'), 'fill'))
  if (shade && !highlight) css.push(`background:${shade}`)
  const vert = attr(child(rPr, 'vertAlign'), 'val')
  if (vert === 'superscript') css.push('vertical-align:super;font-size:smaller')
  if (vert === 'subscript') css.push('vertical-align:sub;font-size:smaller')
  if (on('caps')) css.push('text-transform:uppercase')
  if (on('vanish')) css.push('display:none')
  return css.join(';')
}

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff'
}

async function drawingHtml(ctx: DocxContext, node: XmlNode): Promise<string> {
  const extent = descendants(node, 'extent')[0]
  const width = emuToPx(attr(extent, 'cx'))
  const height = emuToPx(attr(extent, 'cy'))
  const blip = descendants(node, 'blip')[0] ?? descendants(node, 'imagedata')[0]
  const id = blip ? (blip.attrs['r:embed'] ?? blip.attrs['r:id'] ?? attr(blip, 'embed')) : undefined
  const rel = id ? ctx.rels.get(id) : undefined
  if (!rel || rel.external) return width > 0 ? imagePlaceholder(width, height, ctx.missingImage) : ''
  const url = await imageDataUrl(ctx.zip, resolvePartPath(DOCUMENT, rel.target), ctx.images)
  if (!url) return imagePlaceholder(width || 120, height || 80, ctx.missingImage)
  const size = width > 0 && height > 0 ? ` width="${Math.round(width)}" height="${Math.round(height)}" style="height:auto"` : ''
  return `<img src="${url}" alt=""${size}>`
}

async function runsHtml(ctx: DocxContext, parent: XmlNode): Promise<string> {
  let out = ''
  for (const node of parent.children) {
    switch (node.name) {
      case 'r': {
        let inner = ''
        for (const part of node.children) {
          if (part.name === 't') inner += escapeHtml(part.text)
          else if (part.name === 'tab') inner += '\t'
          else if (part.name === 'br' || part.name === 'cr') inner += '\n'
          else if (part.name === 'noBreakHyphen') inner += '‑'
          else if (part.name === 'sym') {
            const code = parseInt(attr(part, 'char') ?? '', 16)
            if (Number.isFinite(code) && code >= 0x20 && !(code >= 0xf000 && code <= 0xf0ff)) inner += escapeHtml(String.fromCodePoint(code))
          } else if (part.name === 'drawing' || part.name === 'pict' || part.name === 'object') inner += await drawingHtml(ctx, part)
          else if (part.name === 'AlternateContent') {
            const fallback = child(part, 'Choice') ?? child(part, 'Fallback')
            if (fallback) inner += await drawingHtml(ctx, fallback)
          }
        }
        const style = runStyle(child(node, 'rPr'))
        out += style && inner ? `<span style="${style}">${inner}</span>` : inner
        break
      }
      case 'hyperlink': {
        const id = node.attrs['r:id']
        const target = id ? ctx.rels.get(id)?.target : undefined
        const inner = await runsHtml(ctx, node)
        out += `<span class="docx-link"${target ? ` title="${escapeHtml(target)}"` : ''}>${inner}</span>`
        break
      }
      // 挿入・フィールド・タグなどは中身だけ出す。削除（del）は出さない
      case 'ins':
      case 'fldSimple':
      case 'smartTag':
      case 'customXml':
      case 'bdo':
      case 'dir':
        out += await runsHtml(ctx, node)
        break
      case 'sdt':
        out += await runsHtml(ctx, child(node, 'sdtContent') ?? node)
        break
      default:
        break
    }
  }
  return out
}

async function paragraphHtml(ctx: DocxContext, p: XmlNode): Promise<string> {
  const pPr = child(p, 'pPr')
  const styleId = attr(child(pPr, 'pStyle'), 'val')
  const heading = styleId !== undefined ? ctx.headings.get(styleId) : undefined
  const css: string[] = []
  const jc = attr(child(pPr, 'jc'), 'val')
  if (jc === 'center') css.push('text-align:center')
  else if (jc === 'right' || jc === 'end') css.push('text-align:right')
  else if (jc === 'both' || jc === 'distribute') css.push('text-align:justify')
  const ind = child(pPr, 'ind')
  const left = twipsToPx(attr(ind, 'left') ?? attr(ind, 'start'))
  const shade = hexColor(attr(child(pPr, 'shd'), 'fill'))
  if (shade) css.push(`background:${shade}`)
  const inner = await runsHtml(ctx, p)
  const pageBreak = descendants(p, 'br').some((br) => attr(br, 'type') === 'page')
  const numPr = child(pPr, 'numPr')
  const styleList = styleId !== undefined ? ctx.styleLists.get(styleId) : undefined
  const numId = attr(child(numPr, 'numId'), 'val') ?? styleList?.numId
  const ilvl = Number(attr(child(numPr, 'ilvl'), 'val') ?? styleList?.ilvl ?? 0)
  const list = numId && numId !== '0' ? listMarker(ctx, numId, ilvl) : null
  if (list) {
    css.push(`margin-left:${Math.max(0, Math.round(list.indentPx || left) - 18)}px`)
    return `<p class="docx-li" style="${css.join(';')}"><span class="docx-marker">${escapeHtml(list.marker)}</span><span>${inner}</span></p>`
  }
  if (left > 0) css.push(`margin-left:${Math.round(left)}px`)
  const style = css.length ? ` style="${css.join(';')}"` : ''
  const block = heading === 0 ? `<p class="docx-title"${style}>${inner}</p>` : heading ? `<h${heading}${style}>${inner}</h${heading}>` : `<p${style}>${inner}</p>`
  return pageBreak ? `${block}<hr class="docx-break">` : block
}

async function tableHtml(ctx: DocxContext, tbl: XmlNode): Promise<string> {
  interface Cell { node: XmlNode; col: number; span: number; rowspan: number; skip: boolean }
  const rows: Cell[][] = []
  for (const tr of children(tbl, 'tr')) {
    let col = 0
    const row: Cell[] = []
    for (const tc of children(tr, 'tc')) {
      const tcPr = child(tc, 'tcPr')
      const span = Math.max(1, Number(attr(child(tcPr, 'gridSpan'), 'val') ?? 1) || 1)
      const vMerge = child(tcPr, 'vMerge')
      const cell: Cell = { node: tc, col, span, rowspan: 1, skip: false }
      if (vMerge && attr(vMerge, 'val') !== 'restart') {
        // 上の行で同じ列から始まるセルへつなぐ
        for (let r = rows.length - 1; r >= 0; r -= 1) {
          const above = rows[r]!.find((c) => c.col === col && !c.skip)
          if (above) {
            above.rowspan += 1
            cell.skip = true
            break
          }
        }
      }
      row.push(cell)
      col += span
    }
    rows.push(row)
  }
  let out = '<table><tbody>'
  for (const row of rows) {
    out += '<tr>'
    for (const cell of row) {
      if (cell.skip) continue
      const shade = hexColor(attr(child(child(cell.node, 'tcPr'), 'shd'), 'fill'))
      const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}${shade ? ` style="background:${shade}"` : ''}`
      out += `<td${attrs}>${await blocksHtml(ctx, cell.node)}</td>`
    }
    out += '</tr>'
  }
  return `${out}</tbody></table>`
}

async function blocksHtml(ctx: DocxContext, parent: XmlNode): Promise<string> {
  let out = ''
  for (const node of parent.children) {
    if (node.name === 'p') out += await paragraphHtml(ctx, node)
    else if (node.name === 'tbl') out += await tableHtml(ctx, node)
    else if (node.name === 'sdt') out += await blocksHtml(ctx, child(node, 'sdtContent') ?? node)
    else if (node.name === 'customXml' || node.name === 'ins') out += await blocksHtml(ctx, node)
  }
  return out
}

export interface DocxLabels {
  missingImage: string
}

export async function renderDocx(zip: ZipArchive, title: string, labels: DocxLabels): Promise<string> {
  const source = await zip.text(DOCUMENT)
  if (source === null) throw new Error('word/document.xml is missing')
  const body = child(documentElement(parseXml(source)), 'body')
  const styles = readStyles(await zip.text('word/styles.xml'))
  const ctx: DocxContext = {
    zip,
    rels: parseRels(await zip.text(relsPathOf(DOCUMENT))),
    headings: styles.headings,
    styleLists: styles.lists,
    numbering: readNumbering(await zip.text('word/numbering.xml')),
    counters: new Map(),
    images: new Map(),
    missingImage: labels.missingImage
  }
  const sect = child(body, 'sectPr')
  const pageWidth = twipsToPx(attr(child(sect, 'pgSz'), 'w')) || 816
  const margin = child(sect, 'pgMar')
  const padX = twipsToPx(attr(margin, 'left')) || 96
  const padY = twipsToPx(attr(margin, 'top')) || 96
  const content = body ? await blocksHtml(ctx, body) : ''
  const page = `<div class="docx-page" style="width:${Math.round(Math.min(1400, pageWidth))}px;padding:${Math.round(Math.min(200, padY))}px ${Math.round(Math.min(200, padX))}px">${content}</div>`
  return officeHtml(title, CSS, page)
}
