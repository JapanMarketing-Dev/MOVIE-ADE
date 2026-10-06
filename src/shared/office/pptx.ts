/**
 * PowerPoint（.pptx）のスライドを HTML にする（図形の位置と大きさ・文字・画像・表・背景・マスターの装飾）。
 * 位置はスライドの幅と高さに対する割合、文字の大きさは cqw（スライドの幅に対する割合）で出すので、
 * スクリプト無しでも画面の幅に合わせて縮む。アニメーション・グラフ・SmartArt・効果は描かない（グラフは枠だけ）。
 */
import { attr, child, children, descendants, documentElement, escapeHtml, parseRels, parseXml, path, type XmlNode } from './xml'
import { relsPathOf, resolvePartPath, type ZipArchive } from './zip'
import { emuToPx, imageDataUrl, officeHtml } from './common'

const PRESENTATION = 'ppt/presentation.xml'

const CSS = `
body{padding:20px 16px 32px}
.pptx-slide{position:relative;container-type:inline-size;width:100%;max-width:1100px;margin:0 auto 6px;background:#fff;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.2);font-family:"Calibri","Aptos","Helvetica Neue","Hiragino Sans","Yu Gothic",Meiryo,sans-serif;color:#000}
.pptx-num{max-width:1100px;margin:0 auto 18px;color:#666;font-size:12px;text-align:right}
.pptx-shape{position:absolute;display:flex;flex-direction:column;overflow:visible}
.pptx-shape p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15}
.pptx-shape img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}
.pptx-shape table{width:100%;height:100%;border-collapse:collapse;table-layout:fixed}
.pptx-shape td{border:1px solid #fff;vertical-align:top;overflow:hidden}
.pptx-chart{align-items:center;justify-content:center;border:1px dashed #b5b5b5;color:#888;background:rgba(240,240,240,.6)}
.pptx-bullet{display:inline-block;min-width:.6em}
`

interface Theme {
  colors: Map<string, string>
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 子の座標を、スライドの座標に直す（グループの中の図形） */
type Transform = (box: Box) => Box

const identity: Transform = (b) => b

interface SlideContext {
  zip: ZipArchive
  slideWidth: number
  slideHeight: number
  theme: Theme
  images: Map<string, string | null>
  chartLabel: string
}

/** 文字の既定（lvl1pPr〜lvl9pPr）を探す順（自分の lstStyle → レイアウトの同じ枠 → マスターの同じ枠 → マスターの txStyles） */
type StyleChain = (XmlNode | undefined)[]

interface Part {
  name: string
  root: XmlNode | undefined
  rels: ReturnType<typeof parseRels>
}

async function readPart(zip: ZipArchive, name: string): Promise<Part> {
  const source = await zip.text(name)
  return { name, root: source ? documentElement(parseXml(source)) : undefined, rels: parseRels(await zip.text(relsPathOf(name))) }
}

function relPart(part: Part, typeSuffix: string): string | undefined {
  const rel = [...part.rels.values()].find((r) => r.type.endsWith(`/${typeSuffix}`) && !r.external)
  return rel ? resolvePartPath(part.name, rel.target) : undefined
}

function readTheme(root: XmlNode | undefined): Theme {
  const colors = new Map<string, string>()
  const scheme = path(root, 'themeElements', 'clrScheme')
  for (const c of scheme?.children ?? []) {
    const srgb = attr(child(c, 'srgbClr'), 'val')
    const sys = attr(child(c, 'sysClr'), 'lastClr')
    const value = srgb ?? sys
    if (value && /^[0-9a-fA-F]{6}$/.test(value)) colors.set(c.name, `#${value.toLowerCase()}`)
  }
  return { colors }
}

const SCHEME_ALIASES: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

/** lumMod・lumOff・tint・shade の主なものを当てる（明るさの調整だけ。HSL を細かくは再現しない） */
function adjust(hex: string, node: XmlNode): string {
  let [r, g, b] = hexToRgb(hex)
  for (const m of node.children) {
    const v = Number(attr(m, 'val')) / 100000
    if (!Number.isFinite(v)) continue
    if (m.name === 'lumMod') [r, g, b] = [r * v, g * v, b * v]
    else if (m.name === 'lumOff') [r, g, b] = [r + 255 * v, g + 255 * v, b + 255 * v]
    else if (m.name === 'tint') [r, g, b] = [r + (255 - r) * (1 - v), g + (255 - g) * (1 - v), b + (255 - b) * (1 - v)]
    else if (m.name === 'shade') [r, g, b] = [r * v, g * v, b * v]
  }
  return rgbToHex([r, g, b])
}

/** solidFill などの中の色（srgbClr・schemeClr・sysClr・prstClr の一部） */
function colorOf(fill: XmlNode | undefined, theme: Theme): string | null {
  if (!fill) return null
  for (const c of fill.children) {
    let base: string | null = null
    if (c.name === 'srgbClr') base = /^[0-9a-fA-F]{6}$/.test(attr(c, 'val') ?? '') ? `#${attr(c, 'val')!.toLowerCase()}` : null
    else if (c.name === 'schemeClr') {
      const name = attr(c, 'val') ?? ''
      base = theme.colors.get(SCHEME_ALIASES[name] ?? name) ?? null
    } else if (c.name === 'sysClr') base = /^[0-9a-fA-F]{6}$/.test(attr(c, 'lastClr') ?? '') ? `#${attr(c, 'lastClr')!.toLowerCase()}` : null
    else if (c.name === 'prstClr') base = PRESET_COLORS[attr(c, 'val') ?? ''] ?? null
    if (base) {
      const alpha = Number(attr(child(c, 'alpha'), 'val'))
      const color = adjust(base, c)
      return Number.isFinite(alpha) && alpha < 100000 ? `${color}${Math.round((alpha / 100000) * 255).toString(16).padStart(2, '0')}` : color
    }
  }
  return null
}

const PRESET_COLORS: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080' }

function xfrmBox(xfrm: XmlNode | undefined): Box | null {
  const off = child(xfrm, 'off')
  const ext = child(xfrm, 'ext')
  if (!off || !ext) return null
  return { x: Number(attr(off, 'x') ?? 0), y: Number(attr(off, 'y') ?? 0), w: Number(attr(ext, 'cx') ?? 0), h: Number(attr(ext, 'cy') ?? 0) }
}

function placeholderOf(node: XmlNode): { type: string; idx: string | undefined } | null {
  const nv = node.children.find((c) => c.name.startsWith('nv'))
  const ph = child(child(nv, 'nvPr'), 'ph')
  if (!ph) return null
  return { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') }
}

/** レイアウト・マスターの中で、同じ枠（idx か種類）の図形 */
function findPlaceholder(root: XmlNode | undefined, ph: { type: string; idx: string | undefined }): XmlNode | undefined {
  const shapes = descendants(path(root, 'cSld', 'spTree'), 'sp')
  const sameType = (t: string) => t === ph.type || (ph.type === 'ctrTitle' && t === 'title') || (ph.type === 'subTitle' && t === 'body')
  return (ph.idx !== undefined ? shapes.find((s) => placeholderOf(s)?.idx === ph.idx) : undefined) ?? shapes.find((s) => sameType(placeholderOf(s)?.type ?? ''))
}

function isTitle(type: string): boolean {
  return type === 'title' || type === 'ctrTitle'
}

function boxCss(ctx: SlideContext, box: Box): string {
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`
  return `left:${pct(box.x, ctx.slideWidth)};top:${pct(box.y, ctx.slideHeight)};width:${pct(box.w, ctx.slideWidth)};height:${pct(box.h, ctx.slideHeight)}`
}

/** スライドの px の大きさを、スライドの幅に対する cqw に */
function cqw(ctx: SlideContext, px: number): string {
  return `${((px / emuToPx(ctx.slideWidth)) * 100).toFixed(3)}cqw`
}

function levelProps(chain: StyleChain, level: number): XmlNode[] {
  return chain.map((s) => child(s, `lvl${level + 1}pPr`)).filter((x): x is XmlNode => !!x)
}

interface TextState {
  autoNumber: Map<number, number>
}

function paragraphHtml(ctx: SlideContext, p: XmlNode, chain: StyleChain, fontScale: number, state: TextState): string {
  const pPr = child(p, 'pPr')
  const level = Number(attr(pPr, 'lvl') ?? 0)
  const inherited = levelProps(chain, level)
  const props = [pPr, ...inherited].filter((x): x is XmlNode => !!x)
  const first = (name: string) => props.map((x) => attr(x, name)).find((v) => v !== undefined)
  const defRPr = props.map((x) => child(x, 'defRPr')).filter((x): x is XmlNode => !!x)
  const css: string[] = []
  const align = first('algn')
  if (align === 'ctr') css.push('text-align:center')
  else if (align === 'r') css.push('text-align:right')
  else if (align === 'just' || align === 'dist') css.push('text-align:justify')
  const marL = Number(first('marL') ?? 0)
  const indent = Number(first('indent') ?? 0)
  if (marL) css.push(`padding-left:${cqw(ctx, emuToPx(marL))}`)
  if (indent) css.push(`text-indent:${cqw(ctx, emuToPx(indent))}`)

  const runSize = (rPr: XmlNode | undefined) => {
    const sz = Number(attr(rPr, 'sz') ?? defRPr.map((d) => attr(d, 'sz')).find((v) => v !== undefined) ?? 1800)
    return ((sz / 100) * 4) / 3 * fontScale
  }
  const runColor = (rPr: XmlNode | undefined) => colorOf(child(rPr, 'solidFill'), ctx.theme) ?? defRPr.map((d) => colorOf(child(d, 'solidFill'), ctx.theme)).find((c) => c) ?? null
  const runBold = (rPr: XmlNode | undefined) => (attr(rPr, 'b') ?? defRPr.map((d) => attr(d, 'b')).find((v) => v !== undefined)) === '1'

  let inner = ''
  let firstSize = 0
  for (const node of p.children) {
    if (node.name === 'r' || node.name === 'fld') {
      const rPr = child(node, 'rPr')
      const text = child(node, 't')?.text ?? ''
      const size = runSize(rPr)
      if (!firstSize) firstSize = size
      const style: string[] = [`font-size:${cqw(ctx, size)}`]
      const color = runColor(rPr)
      if (color) style.push(`color:${color}`)
      if (runBold(rPr)) style.push('font-weight:700')
      if (attr(rPr, 'i') === '1') style.push('font-style:italic')
      const deco = [attr(rPr, 'u') && attr(rPr, 'u') !== 'none' ? 'underline' : '', attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike' ? 'line-through' : ''].filter(Boolean)
      if (deco.length) style.push(`text-decoration:${deco.join(' ')}`)
      const baseline = Number(attr(rPr, 'baseline') ?? 0)
      if (baseline > 0) style.push('vertical-align:super')
      else if (baseline < 0) style.push('vertical-align:sub')
      const highlight = colorOf(child(rPr, 'highlight'), ctx.theme)
      if (highlight) style.push(`background:${highlight}`)
      inner += `<span style="${style.join(';')}">${escapeHtml(text)}</span>`
    } else if (node.name === 'br') inner += '\n'
  }
  const endSize = runSize(child(p, 'endParaRPr'))
  if (!firstSize) firstSize = endSize
  css.push(`font-size:${cqw(ctx, firstSize)}`)
  const hasText = inner !== '' && p.children.some((n) => (n.name === 'r' || n.name === 'fld') && (child(n, 't')?.text ?? '') !== '')

  // 箇条書きの印。buNone が先に見つかれば出さない
  let bullet = ''
  if (hasText) {
    for (const x of props) {
      if (child(x, 'buNone')) break
      const ch = attr(child(x, 'buChar'), 'char')
      if (ch !== undefined) {
        bullet = ch.length === 1 && ch.charCodeAt(0) >= 0xf000 ? '•' : ch
        break
      }
      const auto = child(x, 'buAutoNum')
      if (auto) {
        const n = (state.autoNumber.get(level) ?? Number(attr(auto, 'startAt') ?? 1) - 1) + 1
        state.autoNumber.set(level, n)
        const scheme = attr(auto, 'type') ?? 'arabicPeriod'
        const label = scheme.startsWith('alphaLc') ? String.fromCharCode(96 + n) : scheme.startsWith('alphaUc') ? String.fromCharCode(64 + n) : String(n)
        bullet = scheme.endsWith('ParenR') ? `${label})` : scheme.endsWith('ParenBoth') ? `(${label})` : `${label}.`
        break
      }
    }
  }
  const bulletColor = colorOf(child(props.find((x) => child(x, 'buClr')), 'buClr'), ctx.theme)
  // 印は「indent」の幅（ぶら下げ）に置き、文字は marL から始める
  const markCss = [bulletColor ? `color:${bulletColor}` : '', indent < 0 ? `width:${cqw(ctx, emuToPx(-indent))};text-indent:0` : ''].filter(Boolean).join(';')
  const mark = bullet ? `<span class="pptx-bullet"${markCss ? ` style="${markCss}"` : ''}>${escapeHtml(bullet)}</span>` : ''
  return `<p style="${css.join(';')}">${mark}${inner || '&#8203;'}</p>`
}

function textBodyHtml(ctx: SlideContext, txBody: XmlNode | undefined, chain: StyleChain): { html: string; anchor: string; inset: string } {
  const bodyPr = child(txBody, 'bodyPr')
  const fontScale = Number(attr(child(bodyPr, 'normAutofit'), 'fontScale') ?? 100000) / 100000
  const state: TextState = { autoNumber: new Map() }
  const html = children(txBody, 'p').map((p) => paragraphHtml(ctx, p, [child(txBody, 'lstStyle'), ...chain], fontScale, state)).join('')
  const anchor = attr(bodyPr, 'anchor') ?? 't'
  const inset = ['tIns', 'rIns', 'bIns', 'lIns'].map((k, i) => cqw(ctx, emuToPx(attr(bodyPr, k) ?? (i % 2 === 0 ? 45720 : 91440)))).join(' ')
  return { html, anchor, inset }
}

function shapeFillCss(ctx: SlideContext, spPr: XmlNode | undefined, styleNode: XmlNode | undefined): string[] {
  const css: string[] = []
  if (!spPr) return css
  const fill = child(spPr, 'solidFill')
  const fillColor = fill ? colorOf(fill, ctx.theme) : child(spPr, 'noFill') ? null : colorOf(child(styleNode, 'fillRef'), ctx.theme)
  const grad = child(spPr, 'gradFill')
  if (fillColor) css.push(`background:${fillColor}`)
  else if (grad) {
    const stops = children(child(grad, 'gsLst'), 'gs').map((gs) => `${colorOf(gs, ctx.theme) ?? '#ffffff'} ${Number(attr(gs, 'pos') ?? 0) / 1000}%`)
    if (stops.length >= 2) css.push(`background:linear-gradient(${stops.join(',')})`)
  }
  const ln = child(spPr, 'ln')
  if (ln && !child(ln, 'noFill')) {
    const lineColor = colorOf(child(ln, 'solidFill'), ctx.theme) ?? (child(ln, 'solidFill') ? null : colorOf(child(styleNode, 'lnRef'), ctx.theme))
    if (lineColor) {
      const width = Math.max(1, emuToPx(attr(ln, 'w') ?? 12700))
      css.push(`border:${cqw(ctx, width)} solid ${lineColor}`)
    }
  }
  const geom = attr(child(spPr, 'prstGeom'), 'prst')
  if (geom === 'ellipse' || geom === 'flowChartConnector') css.push('border-radius:50%')
  else if (geom === 'roundRect') css.push(`border-radius:${cqw(ctx, 12)}`)
  return css
}

/** blipFill の画像の <img>。読めない画像（EMF など）は空 */
async function blipImage(ctx: SlideContext, part: Part, blipFill: XmlNode | undefined): Promise<string> {
  const blip = descendants(blipFill, 'blip')[0]
  const id = blip?.attrs['r:embed'] ?? attr(blip, 'embed')
  const rel = id ? part.rels.get(id) : undefined
  const url = rel && !rel.external ? await imageDataUrl(ctx.zip, resolvePartPath(part.name, rel.target), ctx.images) : null
  return url ? `<img src="${url}" alt="">` : ''
}

async function pictureHtml(ctx: SlideContext, part: Part, node: XmlNode, box: Box): Promise<string> {
  const img = await blipImage(ctx, part, child(node, 'blipFill'))
  return img ? `<div class="pptx-shape" style="${boxCss(ctx, box)}">${img}</div>` : ''
}

function tableHtml(ctx: SlideContext, tbl: XmlNode): string {
  let out = '<table><tbody>'
  for (const tr of children(tbl, 'tr')) {
    const h = emuToPx(attr(tr, 'h') ?? 0)
    out += `<tr${h ? ` style="height:${cqw(ctx, h)}"` : ''}>`
    for (const tc of children(tr, 'tc')) {
      if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue
      const tcPr = child(tc, 'tcPr')
      const fill = colorOf(child(tcPr, 'solidFill'), ctx.theme)
      const span = Number(attr(tc, 'gridSpan') ?? 1)
      const rowSpan = Number(attr(tc, 'rowSpan') ?? 1)
      const text = textBodyHtml(ctx, child(tc, 'txBody'), [])
      const style = [`padding:${text.inset}`, fill ? `background:${fill}` : 'background:#e9edf4']
      out += `<td${span > 1 ? ` colspan="${span}"` : ''}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''} style="${style.join(';')}">${text.html}</td>`
    }
    out += '</tr>'
  }
  return `${out}</tbody></table>`
}

interface Layers {
  layout: Part | undefined
  master: Part | undefined
  masterStyles: XmlNode | undefined
}

async function shapesHtml(ctx: SlideContext, part: Part, tree: XmlNode | undefined, layers: Layers, onlyDecoration: boolean, transform: Transform): Promise<string> {
  let out = ''
  for (const node of tree?.children ?? []) {
    if (node.name === 'sp') {
      const ph = placeholderOf(node)
      // レイアウト・マスターの枠（「タイトルを入力」など）は出さない。飾りの図形だけ
      if (onlyDecoration && ph) continue
      const spPr = child(node, 'spPr')
      const layoutPh = ph ? findPlaceholder(layers.layout?.root, ph) : undefined
      const masterPh = ph ? findPlaceholder(layers.master?.root, ph) : undefined
      const own = xfrmBox(child(spPr, 'xfrm'))
      const box = own ?? xfrmBox(child(child(layoutPh, 'spPr'), 'xfrm')) ?? xfrmBox(child(child(masterPh, 'spPr'), 'xfrm'))
      if (!box) continue
      const txStyle = ph ? (isTitle(ph.type) ? child(layers.masterStyles, 'titleStyle') : ['body', 'subTitle', 'obj'].includes(ph.type) || ph.idx !== undefined ? child(layers.masterStyles, 'bodyStyle') : child(layers.masterStyles, 'otherStyle')) : child(layers.masterStyles, 'otherStyle')
      const chain: StyleChain = [child(child(layoutPh, 'txBody'), 'lstStyle'), child(child(masterPh, 'txBody'), 'lstStyle'), txStyle]
      const text = textBodyHtml(ctx, child(node, 'txBody'), chain)
      const fills = shapeFillCss(ctx, spPr, child(node, 'style'))
      const css = [boxCss(ctx, transform(box)), ...fills]
      const rot = Number(attr(child(spPr, 'xfrm'), 'rot') ?? 0)
      if (rot) css.push(`transform:rotate(${rot / 60000}deg)`)
      const picture = await blipImage(ctx, part, child(spPr, 'blipFill'))
      css.push(`padding:${text.inset}`, `justify-content:${text.anchor === 'ctr' ? 'center' : text.anchor === 'b' ? 'flex-end' : 'flex-start'}`)
      const hasText = descendants(child(node, 'txBody'), 't').some((t) => t.text !== '')
      if (!hasText && !picture && fills.length === 0) continue
      out += `<div class="pptx-shape" style="${css.join(';')}">${picture}${hasText ? text.html : ''}</div>`
    } else if (node.name === 'pic') {
      if (onlyDecoration && placeholderOf(node)) continue
      const box = xfrmBox(child(child(node, 'spPr'), 'xfrm'))
      if (box) out += await pictureHtml(ctx, part, node, transform(box))
    } else if (node.name === 'cxnSp') {
      const spPr = child(node, 'spPr')
      const box = xfrmBox(child(spPr, 'xfrm'))
      const color = colorOf(child(child(spPr, 'ln'), 'solidFill'), ctx.theme) ?? colorOf(child(child(node, 'style'), 'lnRef'), ctx.theme)
      if (!box || !color) continue
      const t = transform(box)
      const width = cqw(ctx, Math.max(1, emuToPx(attr(child(spPr, 'ln'), 'w') ?? 12700)))
      const line = t.h < t.w ? `border-top:${width} solid ${color}` : `border-left:${width} solid ${color}`
      out += `<div class="pptx-shape" style="${boxCss(ctx, t)};${line}"></div>`
    } else if (node.name === 'graphicFrame') {
      if (onlyDecoration && placeholderOf(node)) continue
      const box = xfrmBox(child(node, 'xfrm'))
      if (!box) continue
      const data = path(node, 'graphic', 'graphicData')
      const tbl = child(data, 'tbl')
      if (tbl) out += `<div class="pptx-shape" style="${boxCss(ctx, transform(box))}">${tableHtml(ctx, tbl)}</div>`
      else out += `<div class="pptx-shape pptx-chart" style="${boxCss(ctx, transform(box))};font-size:${cqw(ctx, 14)}">${escapeHtml(ctx.chartLabel)}</div>`
    } else if (node.name === 'grpSp') {
      const xfrm = child(child(node, 'grpSpPr'), 'xfrm')
      const outer = xfrmBox(xfrm)
      const chOff = child(xfrm, 'chOff')
      const chExt = child(xfrm, 'chExt')
      let inner = transform
      if (outer && chOff && chExt) {
        const cx = Number(attr(chOff, 'x') ?? 0)
        const cy = Number(attr(chOff, 'y') ?? 0)
        const sx = Number(attr(chExt, 'cx')) ? outer.w / Number(attr(chExt, 'cx')) : 1
        const sy = Number(attr(chExt, 'cy')) ? outer.h / Number(attr(chExt, 'cy')) : 1
        inner = (b) => transform({ x: outer.x + (b.x - cx) * sx, y: outer.y + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy })
      }
      out += await shapesHtml(ctx, part, node, layers, onlyDecoration, inner)
    } else if (node.name === 'AlternateContent') {
      const fallback = child(node, 'Fallback') ?? child(node, 'Choice')
      if (fallback) out += await shapesHtml(ctx, part, fallback, layers, onlyDecoration, transform)
    }
  }
  return out
}

async function backgroundCss(ctx: SlideContext, parts: (Part | undefined)[]): Promise<string> {
  for (const part of parts) {
    const bg = path(part?.root, 'cSld', 'bg')
    if (!bg || !part) continue
    const bgPr = child(bg, 'bgPr')
    const solid = colorOf(child(bgPr, 'solidFill'), ctx.theme)
    if (solid) return `background:${solid}`
    const grad = child(bgPr, 'gradFill')
    if (grad) {
      const stops = children(child(grad, 'gsLst'), 'gs').map((gs) => `${colorOf(gs, ctx.theme) ?? '#ffffff'} ${Number(attr(gs, 'pos') ?? 0) / 1000}%`)
      if (stops.length >= 2) return `background:linear-gradient(${stops.join(',')})`
    }
    const blip = descendants(child(bgPr, 'blipFill'), 'blip')[0]
    const id = blip?.attrs['r:embed']
    const rel = id ? part.rels.get(id) : undefined
    if (rel && !rel.external) {
      const url = await imageDataUrl(ctx.zip, resolvePartPath(part.name, rel.target), ctx.images)
      if (url) return `background:url("${url}") center/cover no-repeat`
    }
    const ref = colorOf(child(bg, 'bgRef'), ctx.theme)
    if (ref) return `background:${ref}`
  }
  return 'background:#ffffff'
}

export interface PptxLabels {
  slide: (n: number, total: number) => string
  chart: string
}

export async function renderPptx(zip: ZipArchive, title: string, labels: PptxLabels): Promise<{ html: string; slides: number }> {
  const presentation = await readPart(zip, PRESENTATION)
  if (!presentation.root) throw new Error('ppt/presentation.xml is missing')
  const size = child(presentation.root, 'sldSz')
  const slideWidth = Number(attr(size, 'cx') ?? 12192000) || 12192000
  const slideHeight = Number(attr(size, 'cy') ?? 6858000) || 6858000
  const ids = children(child(presentation.root, 'sldIdLst'), 'sldId')
  const parts = new Map<string, Part>()
  const cached = async (name: string | undefined) => {
    if (!name) return undefined
    if (!parts.has(name)) parts.set(name, await readPart(zip, name))
    return parts.get(name)
  }
  const images = new Map<string, string | null>()
  let body = ''
  let index = 0
  for (const id of ids) {
    const rel = presentation.rels.get(id.attrs['r:id'] ?? '')
    if (!rel || rel.external) continue
    index += 1
    const slide = await readPart(zip, resolvePartPath(PRESENTATION, rel.target))
    if (attr(slide.root, 'show') === '0') continue
    const layout = await cached(relPart(slide, 'slideLayout'))
    const master = layout ? await cached(relPart(layout, 'slideMaster')) : undefined
    const themePart = master ? await cached(relPart(master, 'theme')) : undefined
    const ctx: SlideContext = { zip, slideWidth, slideHeight, theme: readTheme(themePart?.root), images, chartLabel: labels.chart }
    const layers: Layers = { layout, master, masterStyles: child(master?.root, 'txStyles') }
    let content = ''
    // マスター・レイアウトの飾り（ロゴ・帯など）を後ろに敷く。showMasterSp="0" なら出さない
    if (attr(slide.root, 'showMasterSp') !== '0') {
      if (master && attr(layout?.root, 'showMasterSp') !== '0') content += await shapesHtml(ctx, master, path(master.root, 'cSld', 'spTree'), layers, true, identity)
      if (layout) content += await shapesHtml(ctx, layout, path(layout.root, 'cSld', 'spTree'), layers, true, identity)
    }
    content += await shapesHtml(ctx, slide, path(slide.root, 'cSld', 'spTree'), layers, false, identity)
    const background = await backgroundCss(ctx, [slide, layout, master])
    body += `<section class="pptx-slide" style="aspect-ratio:${slideWidth}/${slideHeight};${background}">${content}</section><div class="pptx-num">${escapeHtml(labels.slide(index, ids.length))}</div>`
  }
  return { html: officeHtml(title, CSS, body), slides: index }
}
