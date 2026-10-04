/**
 * 画面の配置（どのパネルをどこに置き、出すか出さないか）。設定に保存し、App が CSS グリッドへ変換する。
 *
 * 考え方は VS Code と Orca にならう。
 *   - 中央（ブラウザ・指摘・ファイルのタブ群）は固定で、ほかのパネルがその周りに付く
 *   - パネルごとに 左・右・上・下 を選べ、隠しても状態は残す（幅・高さを 0 にするだけで、外さない）
 *   - ターミナルだけは中央との境界をドラッグで動かせる（splitRatio）
 * 隠すときに外さないのは、ターミナルのPTY（起動中のAgent）とサイドバーの状態を失わないため。
 */

export type PanelId = 'projects' | 'terminal' | 'files'
export type Dock = 'left' | 'right' | 'top' | 'bottom'
export type FooterDock = 'top' | 'bottom'

export const PANEL_IDS: readonly PanelId[] = ['projects', 'terminal', 'files']
/** 開閉できるパネル。ターミナルは常に表示する（ユーザーの指示：閉じる・隠す手段を持たない） */
const CLOSABLE_PANELS: readonly PanelId[] = ['projects', 'files']
export const DOCKS: readonly Dock[] = ['left', 'right', 'top', 'bottom']

/** フッターの項目。並びはフッターでの左からの順 */
export const FOOTER_ITEMS = [
  'usage',
  'apiUsage',
  'recording',
  'mic',
  'transcription',
  'organizer',
  'resources',
  'github',
  'page',
  'layout',
  'version',
  'theme',
  'settings'
] as const
export type FooterItemId = (typeof FOOTER_ITEMS)[number]

interface PanelPlacement {
  dock: Dock
  visible: boolean
}

export interface LayoutPrefs {
  panels: Record<PanelId, PanelPlacement>
  footer: {
    dock: FooterDock
    visible: boolean
    items: Record<FooterItemId, boolean>
  }
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  panels: {
    projects: { dock: 'left', visible: true },
    terminal: { dock: 'right', visible: true },
    files: { dock: 'right', visible: true }
  },
  footer: {
    dock: 'bottom',
    visible: true,
    items: Object.fromEntries(FOOTER_ITEMS.map((id) => [id, true])) as Record<FooterItemId, boolean>
  }
}

const isDock = (v: unknown): v is Dock => v === 'left' || v === 'right' || v === 'top' || v === 'bottom'

/**
 * 保存された値を型どおりに直す。壊れた値は既定へ戻す。
 * 以前の設定（terminalDock だけ）があれば、ターミナルの置き場所として引き継ぐ。
 */
export function sanitizeLayout(raw: unknown, legacyTerminalDock?: unknown): LayoutPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { panels?: Record<string, unknown>; footer?: Record<string, unknown> }
  const panels = {} as Record<PanelId, PanelPlacement>
  for (const id of PANEL_IDS) {
    const p = (r.panels?.[id] && typeof r.panels[id] === 'object' ? r.panels[id] : {}) as Partial<PanelPlacement>
    const fallback = id === 'terminal' && !r.panels && isDock(legacyTerminalDock) ? legacyTerminalDock : DEFAULT_LAYOUT.panels[id].dock
    // ターミナルは常に表示する（ユーザーの指示：閉じる手段を持たない）。古い設定で閉じたままにしない
    panels[id] = { dock: isDock(p.dock) ? p.dock : fallback, visible: id === 'terminal' || p.visible !== false }
  }
  const f = (r.footer ?? {}) as { dock?: unknown; visible?: unknown; items?: Record<string, unknown> }
  const items = {} as Record<FooterItemId, boolean>
  for (const id of FOOTER_ITEMS) items[id] = f.items?.[id] !== false
  return {
    panels,
    footer: { dock: f.dock === 'top' ? 'top' : 'bottom', visible: f.visible !== false, items }
  }
}

/** 1つのパネルの置き場所・表示を変えた配置を返す */
export function withPanel(layout: LayoutPrefs, id: PanelId, patch: Partial<PanelPlacement>): LayoutPrefs {
  return { ...layout, panels: { ...layout.panels, [id]: { ...layout.panels[id], ...patch } } }
}

interface GridTemplate {
  columns: string
  rows: string
  areas: string
}

/** 横に置いたときの幅・縦に置いたときの高さ。CSS の変数で持つ */
/**
 * 狭い窓での最小の大きさ（px）。足りないときは、左右のパネルが先に縮み、中央の列は CENTER_MIN_WIDTH を守る。
 * 窓の最小幅（main の minWidth: 900）で、左右のパネルを両方開き、ターミナルを左右に置いても収まる値にする
 * （SIDE_MIN_WIDTH×2 ＋ 境界 ＋ TERMINAL_MIN_WIDTH ＋ CENTER_MIN_WIDTH ≦ 900）。
 * 値を変えるときは test/unit/layout.test.ts と e2e/layout.spec.ts（900×650 で中央 360px・ターミナル 240px 以上）も一緒に直す。
 */
export const CENTER_MIN_WIDTH = 360
export const TERMINAL_MIN_WIDTH = 240
const TERMINAL_MIN_HEIGHT = 160
export const SIDE_MIN_WIDTH = 140
const SPLITTER_SIZE = 6
/** 窓の最小幅（src/main/index.ts の BrowserWindow の minWidth と同じ値） */
export const WINDOW_MIN_WIDTH = 900

/**
 * 配置ごとの最小の横幅（px）。左右に開いたパネルの最小 ＋ 本体の最小（中央の列 ＋ ターミナルを左右に置くなら境界とターミナル）。
 * 窓がこれより狭くならなければ、中央の列は CENTER_MIN_WIDTH を下回らない（単体テストで確かめる）。
 */
export function layoutMinWidth(layout: LayoutPrefs): number {
  const sides = (['projects', 'files'] as const).filter((id) => {
    const p = layout.panels[id]
    return p.visible && (p.dock === 'left' || p.dock === 'right')
  }).length
  return sides * SIDE_MIN_WIDTH + mainMinWidth(layout.panels.terminal.dock)
}

/** 本体（中央の列とターミナル）の最小の横幅（px） */
export function mainMinWidth(terminalDock: Dock): number {
  return terminalDock === 'left' || terminalDock === 'right'
    ? CENTER_MIN_WIDTH + SPLITTER_SIZE + TERMINAL_MIN_WIDTH
    : CENTER_MIN_WIDTH
}

const SIDE_SIZE: Record<'projects' | 'files', { width: string; height: string }> = {
  projects: { width: 'var(--sidebar-width)', height: 'var(--size-panel-strip)' },
  files: { width: 'var(--size-sidebar)', height: 'var(--size-panel-strip)' }
}

/**
 * ワークスペース（プロジェクト一覧・ファイルツリー・本体）のグリッド。
 * 左右のパネルは本体の行だけを、上下のパネルは横幅いっぱいを占める。
 * 隠したパネルも列・行は残して大きさを 0 にする（中身を外さず、開閉を滑らかにする）。
 */
export function workspaceGrid(layout: LayoutPrefs): GridTemplate {
  const sides: Array<'projects' | 'files'> = ['projects', 'files']
  const on = (dock: Dock) => sides.filter((id) => layout.panels[id].dock === dock)
  const left = on('left')
  const right = on('right')
  const top = on('top')
  const bottom = on('bottom')
  const size = (id: 'projects' | 'files', axis: 'width' | 'height') => (layout.panels[id].visible ? SIDE_SIZE[id][axis] : '0px')
  // 左右のパネルは、足りなければ SIDE_MIN_WIDTH まで縮む（本体の最小幅を先に取り、残りを左右へ配る。CSS グリッドの minmax の動き）
  const sideColumn = (id: 'projects' | 'files') => (layout.panels[id].visible ? `minmax(${SIDE_MIN_WIDTH}px, ${SIDE_SIZE[id].width})` : '0px')
  const mainColumn = `minmax(${mainMinWidth(layout.panels.terminal.dock)}px, 1fr)`

  const middle = [...left, 'main', ...right]
  const row = (names: string[]) => `"${names.join(' ')}"`
  return {
    columns: [...left.map(sideColumn), mainColumn, ...right.map(sideColumn)].join(' '),
    rows: [...top.map((id) => size(id, 'height')), 'minmax(0, 1fr)', ...bottom.map((id) => size(id, 'height'))].join(' '),
    areas: [
      ...top.map((id) => row(middle.map(() => id))),
      row(middle),
      ...bottom.map((id) => row(middle.map(() => id)))
    ].join(' ')
  }
}

/**
 * 本体（中央のタブ群とターミナル）のグリッド。中央の大きさは --split-left（splitRatio）で決める。
 * ターミナルが左・上なら並びを逆にする。
 * ターミナルは常に表示する（閉じる手段を持たない）。境界をドラッグしても実質隠れないよう、
 * 中央の大きさを「全体 − 境界 − ターミナルの最小（左右 240px・上下 160px）」で頭打ちにする。
 * 横に並べるときは、中央の列も CENTER_MIN_WIDTH（360px）を下回らない（ワークスペース側で本体にその分の幅を先に取る）。
 */
export function mainSplitGrid(dock: Dock): GridTemplate & { orientation: 'vertical' | 'horizontal'; reverse: boolean } {
  const horizontal = dock === 'left' || dock === 'right'
  const reverse = dock === 'left' || dock === 'top'
  const min = `${horizontal ? TERMINAL_MIN_WIDTH : TERMINAL_MIN_HEIGHT}px`
  // 上限：ターミナルの最小を残す。下限：横に並べるときは中央の列の最小（ドラッグで寄せても下回らない）
  const capped = `min(var(--split-left), calc(100% - var(--size-splitter) - ${min}))`
  const center = horizontal ? `max(${CENTER_MIN_WIDTH}px, ${capped})` : capped
  const split = 'var(--size-splitter)'
  const term = 'minmax(0, 1fr)'
  const tracks = reverse ? [term, split, center] : [center, split, term]
  const names = reverse ? ['term', 'split', 'center'] : ['center', 'split', 'term']
  return horizontal
    ? { columns: tracks.join(' '), rows: 'minmax(0, 1fr)', areas: `"${names.join(' ')}"`, orientation: 'vertical', reverse }
    : { columns: 'minmax(0, 1fr)', rows: tracks.join(' '), areas: names.map((n) => `"${n}"`).join(' '), orientation: 'horizontal', reverse }
}

/** 配置の変化を1語にまとめる（内蔵ブラウザの位置を測り直すきっかけ = layoutKey に入れる） */
export function layoutSignature(layout: LayoutPrefs): string {
  const p = PANEL_IDS.map((id) => `${id[0]}${layout.panels[id].dock[0]}${layout.panels[id].visible ? 1 : 0}`).join('')
  return `${p}f${layout.footer.dock[0]}${layout.footer.visible ? 1 : 0}`
}

/**
 * タブの並べ替え。from を to の前（before）か後ろへ動かした新しい並びを返す。
 * どちらかが並びに無ければそのまま返す。
 */
export function moveItem<T>(order: readonly T[], from: T, to: T, before: boolean): T[] {
  if (from === to || !order.includes(from) || !order.includes(to)) return [...order]
  const rest = order.filter((x) => x !== from)
  const at = rest.indexOf(to) + (before ? 0 : 1)
  return [...rest.slice(0, at), from, ...rest.slice(at)]
}

/** 今あるタブを、覚えている並びの順に並べる。覚えていないもの（新しく開いたファイル）は後ろへ */
export function applyOrder<T extends string>(ids: readonly T[], order: readonly string[]): T[] {
  const rank = (id: T) => {
    const i = order.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((x) => x.id)
}

/** ドラッグで動かせるもの。フッターは上か下だけ */
export type DragPanel = PanelId | 'footer'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 端からこの割合より内側（中央寄り）で離したら、動かさない（VS Code と同じく中央は「取りやめ」） */
const DROP_EDGE_RATIO = 0.35

/**
 * ドラッグ中のポインターの位置から、落とす先（上下左右）を決める。
 * 枠の外・中央寄り・選べない向きは null（動かさない）。
 * 端までの距離は枠の幅・高さで割って比べる（横長の画面でも上下の端を選びやすくする）。
 */
export function dockFromPoint(x: number, y: number, rect: Rect, allowed: readonly Dock[] = DOCKS): Dock | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null
  const distance: Record<Dock, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  let best: Dock | null = null
  for (const dock of allowed) if (best === null || distance[dock] < distance[best]) best = dock
  return best !== null && distance[best] <= DROP_EDGE_RATIO ? best : null
}

/** 落とす先の向き。フッターは上か下だけ */
export function allowedDocks(panel: DragPanel): readonly Dock[] {
  return panel === 'footer' ? ['top', 'bottom'] : DOCKS
}

/** 落とす先を半透明で示す矩形（枠の中の座標）。その端に、枠の size の割合の帯を出す */
export function dropPreviewRect(dock: Dock, rect: Rect, size = 0.25): Rect {
  const w = Math.round(rect.width * size)
  const h = Math.round(rect.height * size)
  switch (dock) {
    case 'left': return { left: 0, top: 0, width: w, height: rect.height }
    case 'right': return { left: rect.width - w, top: 0, width: w, height: rect.height }
    case 'top': return { left: 0, top: 0, width: rect.width, height: h }
    case 'bottom': return { left: 0, top: rect.height - h, width: rect.width, height: h }
  }
}

/** 落としたあとの配置。動かしたパネルは見えるようにする */
export function dropPanel(layout: LayoutPrefs, panel: DragPanel, dock: Dock): LayoutPrefs {
  if (panel === 'footer') {
    return dock === 'top' || dock === 'bottom' ? { ...layout, footer: { ...layout.footer, dock, visible: true } } : layout
  }
  return withPanel(layout, panel, { dock, visible: true })
}

/** パネルの開閉（タイトルバーのボタン・見出しの閉じるボタン・⌘B / ⌘⇧E で共通）。open を渡すとその状態にする。ターミナルは閉じない（sanitizeLayout が表示に戻す） */
export function togglePanel(layout: LayoutPrefs, id: PanelId, open?: boolean): LayoutPrefs {
  return withPanel(layout, id, { visible: open ?? !layout.panels[id].visible })
}

/** タイトルバーの開閉ボタンの並び。画面の左にあるものから順に（VS Code と同じく、置き場所が見た目の順になる） */
export function panelToggleOrder(layout: LayoutPrefs): PanelId[] {
  const rank: Record<Dock, number> = { left: 0, top: 1, bottom: 2, right: 3 }
  return [...CLOSABLE_PANELS].sort((a, b) => rank[layout.panels[a].dock] - rank[layout.panels[b].dock])
}

/**
 * フッターの項目の優先順位（Orca の useStatusBarDensity / VS Code のステータスバーと同じ考え方）。
 * 幅が足りないときは数の大きいものから隠し、隠したものは右端の「…」メニューにまとめる。
 *   0 … 常に出す（録画時間・使用量・設定）
 *   1 … マイク・文字起こし・GitHub のブランチ
 *   2 … Resource Manager・バージョン・配色
 *   3 … 最初に隠す（ページ名・整理の方式・ターミナルの配置）
 * 使用量の段階的な短縮（UsageMeter）は、ここで隠せるものを隠したあとに効く。
 */
export const FOOTER_PRIORITY: Record<FooterItemId, 0 | 1 | 2 | 3> = {
  recording: 0,
  usage: 0,
  settings: 0,
  // 従量課金の API（判定モデルなど）の使用量。Agent の使用量のすぐ下の優先順位
  apiUsage: 1,
  mic: 1,
  transcription: 1,
  github: 1,
  resources: 2,
  version: 2,
  theme: 2,
  page: 3,
  organizer: 3,
  layout: 3
}

/**
 * 空きの幅に収まる、いちばん多く出せる段（出す項目の優先順位の上限）を選ぶ。
 * slots は出す設定になっている項目とその「全部出したときの幅」。優先順位 0 は収まらなくても出す。
 * 項目のあいだには gap ずつ隙間が入る。
 */
export function pickFooterTier(slots: ReadonlyArray<{ priority: number; width: number }>, available: number, gap: number): number {
  for (let tier = 3; tier > 0; tier -= 1) {
    const shown = slots.filter((s) => s.priority <= tier)
    const total = shown.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, shown.length - 1)
    if (total <= available) return tier
  }
  return 0
}
