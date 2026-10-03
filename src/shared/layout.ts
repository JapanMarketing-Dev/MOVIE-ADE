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
export const DOCKS: readonly Dock[] = ['left', 'right', 'top', 'bottom']

/** フッターの項目。並びはフッターでの左からの順 */
export const FOOTER_ITEMS = [
  'usage',
  'recording',
  'mic',
  'transcription',
  'organizer',
  'resources',
  'page',
  'layout',
  'version',
  'theme',
  'settings'
] as const
export type FooterItemId = (typeof FOOTER_ITEMS)[number]

export interface PanelPlacement {
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
    panels[id] = { dock: isDock(p.dock) ? p.dock : fallback, visible: p.visible !== false }
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

export interface GridTemplate {
  columns: string
  rows: string
  areas: string
}

/** 横に置いたときの幅・縦に置いたときの高さ。CSS の変数で持つ */
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

  const middle = [...left, 'main', ...right]
  const row = (names: string[]) => `"${names.join(' ')}"`
  return {
    columns: [...left.map((id) => size(id, 'width')), 'minmax(0, 1fr)', ...right.map((id) => size(id, 'width'))].join(' '),
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
 * ターミナルが左・上なら並びを逆にする。隠したときは境界とターミナルを 0 にする。
 */
export function mainSplitGrid(dock: Dock, visible: boolean): GridTemplate & { orientation: 'vertical' | 'horizontal'; reverse: boolean } {
  const horizontal = dock === 'left' || dock === 'right'
  const reverse = dock === 'left' || dock === 'top'
  const center = visible ? 'var(--split-left)' : 'minmax(0, 1fr)'
  const split = visible ? 'var(--size-splitter)' : '0px'
  const term = visible ? 'minmax(0, 1fr)' : '0px'
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
export const DROP_EDGE_RATIO = 0.35

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
