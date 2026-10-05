import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  FOOTER_ITEMS,
  FOOTER_PRIORITY,
  pickFooterTier,
  allowedDocks,
  applyOrder,
  dockFromPoint,
  dropPanel,
  dropPreviewRect,
  layoutSignature,
  layoutMinWidth,
  mainMinWidth,
  CENTER_MIN_WIDTH,
  SIDE_MIN_WIDTH,
  TERMINAL_MIN_WIDTH,
  WINDOW_MIN_WIDTH,
  panelToggleOrder,
  togglePanel,
  mainSplitGrid,
  moveItem,
  sanitizeLayout,
  withPanel,
  workspaceGrid
} from '@shared/layout'

describe('sanitizeLayout', () => {
  it('壊れた値は既定へ戻す', () => {
    expect(sanitizeLayout(undefined)).toEqual(DEFAULT_LAYOUT)
    expect(sanitizeLayout('x')).toEqual(DEFAULT_LAYOUT)
    expect(sanitizeLayout({ panels: { projects: { dock: 'middle', visible: 'no' } } }).panels.projects).toEqual({ dock: 'left', visible: true })
  })
  it('置き場所・表示・フッターの項目を残す', () => {
    const l = sanitizeLayout({
      panels: { files: { dock: 'bottom', visible: false } },
      footer: { dock: 'top', visible: false, items: { usage: false, bogus: false } }
    })
    expect(l.panels.files).toEqual({ dock: 'bottom', visible: false })
    // フッターは常に下（古い設定の top も下に戻す）
    expect(l.footer.dock).toBe('bottom')
    expect(l.footer.visible).toBe(false)
    expect(l.footer.items.usage).toBe(false)
    expect(l.footer.items.mic).toBe(true)
    expect(Object.keys(l.footer.items)).toEqual([...FOOTER_ITEMS])
  })
  it('以前の terminalDock は layout が無いときだけ引き継ぐ', () => {
    expect(sanitizeLayout(undefined, 'bottom').panels.terminal.dock).toBe('bottom')
    expect(sanitizeLayout({ panels: {} }, 'bottom').panels.terminal.dock).toBe('right')
    expect(sanitizeLayout(undefined, 'diagonal').panels.terminal.dock).toBe('right')
  })
  it('フッターは上か下だけ', () => {
    expect(sanitizeLayout({ footer: { dock: 'left' } }).footer.dock).toBe('bottom')
  })
})

describe('workspaceGrid', () => {
  it('既定はプロジェクト一覧が左、ファイルツリーが右', () => {
    expect(workspaceGrid(DEFAULT_LAYOUT)).toEqual({
      columns: 'minmax(140px, var(--sidebar-width)) minmax(606px, 1fr) minmax(140px, var(--size-sidebar))',
      rows: 'minmax(0, 1fr)',
      areas: '"projects main files"'
    })
  })
  it('隠したパネルは列を残して幅 0 にする', () => {
    const g = workspaceGrid(withPanel(DEFAULT_LAYOUT, 'projects', { visible: false }))
    expect(g.columns).toBe('0px minmax(606px, 1fr) minmax(140px, var(--size-sidebar))')
    expect(g.areas).toBe('"projects main files"')
  })
  it('上下に置いたパネルは横幅いっぱいの行になる', () => {
    const l = withPanel(withPanel(DEFAULT_LAYOUT, 'projects', { dock: 'top' }), 'files', { dock: 'bottom' })
    expect(workspaceGrid(l)).toEqual({
      columns: 'minmax(606px, 1fr)',
      rows: 'var(--size-panel-strip) minmax(0, 1fr) var(--size-panel-strip)',
      areas: '"projects" "main" "files"'
    })
  })
  it('同じ側に2つ置くと並びは プロジェクト一覧 → ファイルツリー', () => {
    const l = withPanel(DEFAULT_LAYOUT, 'files', { dock: 'left' })
    expect(workspaceGrid(l).areas).toBe('"projects files main"')
    const top = withPanel(withPanel(DEFAULT_LAYOUT, 'files', { dock: 'top' }), 'projects', { dock: 'right' })
    expect(workspaceGrid(top).areas).toBe('"files files" "main projects"')
  })
})

describe('mainSplitGrid', () => {
  const capW = 'min(var(--split-left), calc(100% - var(--size-splitter) - 240px))'
  const capH = 'min(var(--split-left), calc(100% - var(--size-splitter) - 160px))'
  const centerW = `max(360px, ${capW})`
  it('右は 中央 | 境界 | ターミナル の列', () => {
    expect(mainSplitGrid('right')).toMatchObject({
      columns: `${centerW} var(--size-splitter) minmax(0, 1fr)`,
      areas: '"center split term"',
      orientation: 'vertical',
      reverse: false
    })
  })
  it('左・上は並びを逆にし、比率の領域が後ろ側になる', () => {
    expect(mainSplitGrid('left')).toMatchObject({ columns: `minmax(0, 1fr) var(--size-splitter) ${centerW}`, areas: '"term split center"', reverse: true, orientation: 'vertical' })
    expect(mainSplitGrid('top')).toMatchObject({
      rows: `minmax(0, 1fr) var(--size-splitter) ${capH}`,
      areas: '"term" "split" "center"',
      orientation: 'horizontal',
      reverse: true
    })
  })
  it('下は行で分ける', () => {
    expect(mainSplitGrid('bottom')).toMatchObject({ columns: 'minmax(0, 1fr)', rows: `${capH} var(--size-splitter) minmax(0, 1fr)`, areas: '"center" "split" "term"', orientation: 'horizontal' })
  })
  it('ターミナルの最小（左右 240px・上下 160px）を残し、横に並べるときは中央の列も 360px を下回らない', () => {
    for (const dock of ['left', 'right', 'top', 'bottom'] as const) {
      const g = mainSplitGrid(dock)
      // 0px の列（隠れた状態）を作らない
      expect(`${g.columns} ${g.rows}`).not.toContain('0px ')
    }
    expect(mainSplitGrid('right').columns).toContain('max(360px,')
  })
})

describe('狭い窓での最小幅（中央の列を守る）', () => {
  const combos = (['left', 'right', 'top', 'bottom'] as const).flatMap((t) =>
    (['left', 'right', 'top', 'bottom'] as const).flatMap((p) =>
      (['left', 'right', 'top', 'bottom'] as const).map((f) =>
        withPanel(withPanel(withPanel(DEFAULT_LAYOUT, 'terminal', { dock: t }), 'projects', { dock: p }), 'files', { dock: f }))))
  it('窓の最小幅（900px）なら、どの配置でも中央の列 360px・ターミナル・左右のパネルの最小が収まる', () => {
    for (const l of combos) expect(layoutMinWidth(l)).toBeLessThanOrEqual(WINDOW_MIN_WIDTH)
  })
  it('既定の配置（ターミナル右・ファイル右・プロジェクト左）の最小は 140 + 140 + 360 + 6 + 240 = 886px', () => {
    expect(layoutMinWidth(DEFAULT_LAYOUT)).toBe(SIDE_MIN_WIDTH * 2 + CENTER_MIN_WIDTH + 6 + TERMINAL_MIN_WIDTH)
    expect(layoutMinWidth(DEFAULT_LAYOUT)).toBe(886)
  })
  it('本体の列の最小は、ターミナルを左右に置くと 中央＋境界＋ターミナル、上下なら中央だけ', () => {
    expect(mainMinWidth('right')).toBe(606)
    expect(mainMinWidth('bottom')).toBe(CENTER_MIN_WIDTH)
    expect(workspaceGrid(withPanel(DEFAULT_LAYOUT, 'terminal', { dock: 'bottom' })).columns).toContain('minmax(360px, 1fr)')
  })
  it('閉じたパネル・上下に置いたパネルは横の最小に数えない', () => {
    expect(layoutMinWidth(withPanel(DEFAULT_LAYOUT, 'files', { visible: false }))).toBe(SIDE_MIN_WIDTH + 606)
    expect(layoutMinWidth(withPanel(DEFAULT_LAYOUT, 'projects', { dock: 'top' }))).toBe(SIDE_MIN_WIDTH + 606)
  })
})

describe('ターミナルは常に表示（閉じる手段を持たない）', () => {
  it('古い設定でターミナルを閉じていても、読み込むと表示になる', () => {
    expect(sanitizeLayout({ panels: { terminal: { dock: 'bottom', visible: false } } }).panels.terminal).toEqual({ dock: 'bottom', visible: true })
  })
  it('ほかのパネルは閉じたまま残る', () => {
    expect(sanitizeLayout({ panels: { files: { dock: 'right', visible: false }, projects: { dock: 'left', visible: false } } }).panels)
      .toMatchObject({ files: { visible: false }, projects: { visible: false } })
  })
  it('開閉ボタンの並びにターミナルは入らない', () => {
    expect(panelToggleOrder(DEFAULT_LAYOUT)).toEqual(['projects', 'files'])
  })
  it('閉じようとしても、保存し直す（sanitize）と表示に戻る', () => {
    expect(sanitizeLayout(togglePanel(DEFAULT_LAYOUT, 'terminal')).panels.terminal.visible).toBe(true)
  })
})

describe('layoutSignature', () => {
  it('置き場所・表示が変わると変わる（内蔵ブラウザの測り直しのきっかけ）', () => {
    const a = layoutSignature(DEFAULT_LAYOUT)
    expect(layoutSignature(withPanel(DEFAULT_LAYOUT, 'terminal', { dock: 'bottom' }))).not.toBe(a)
    expect(layoutSignature(withPanel(DEFAULT_LAYOUT, 'files', { visible: false }))).not.toBe(a)
    expect(layoutSignature({ ...DEFAULT_LAYOUT, footer: { ...DEFAULT_LAYOUT.footer, dock: 'top' } })).not.toBe(a)
    expect(layoutSignature(sanitizeLayout(undefined))).toBe(a)
  })
})

describe('moveItem / applyOrder（タブの並べ替え）', () => {
  it('指定したタブの前・後ろへ動かす', () => {
    expect(moveItem(['a', 'b', 'c'], 'c', 'a', true)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 'a', 'c', false)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 'a', 'b', false)).toEqual(['b', 'a', 'c'])
  })
  it('同じタブ・無いタブはそのまま', () => {
    expect(moveItem(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 'x', 'a', true)).toEqual(['a', 'b'])
  })
  it('覚えた並びの順に並べ、覚えていないものは元の順で後ろへ', () => {
    expect(applyOrder(['browser', 'findings', 'file:a', 'file:b'], ['findings', 'file:b', 'browser'])).toEqual(['findings', 'file:b', 'browser', 'file:a'])
    expect(applyOrder(['browser', 'findings'], [])).toEqual(['browser', 'findings'])
  })
})

describe('dockFromPoint（ドラッグで落とす先）', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 500 }
  it('一番近い端を選ぶ', () => {
    expect(dockFromPoint(120, 300, rect)).toBe('left')
    expect(dockFromPoint(1080, 300, rect)).toBe('right')
    expect(dockFromPoint(600, 60, rect)).toBe('top')
    expect(dockFromPoint(600, 540, rect)).toBe('bottom')
  })
  it('距離は幅・高さに対する割合で比べる（横長でも上下を選べる）', () => {
    // 左端から 200px（20%）、上端から 50px（10%）→ 上
    expect(dockFromPoint(300, 100, rect)).toBe('top')
  })
  it('中央寄り・枠の外は null（動かさない）', () => {
    expect(dockFromPoint(600, 300, rect)).toBeNull()
    expect(dockFromPoint(50, 300, rect)).toBeNull()
    expect(dockFromPoint(600, 600, rect)).toBeNull()
    expect(dockFromPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toBeNull()
  })
  it('選べる向きだけから選ぶ（フッターは上か下）', () => {
    expect(allowedDocks('footer')).toEqual(['top', 'bottom'])
    expect(dockFromPoint(120, 300, rect, allowedDocks('footer'))).toBeNull()
    expect(dockFromPoint(120, 450, rect, allowedDocks('footer'))).toBe('bottom')
  })
})

describe('dropPreviewRect', () => {
  const rect = { left: 0, top: 0, width: 800, height: 400 }
  it('落とす端に帯を出す', () => {
    expect(dropPreviewRect('left', rect)).toEqual({ left: 0, top: 0, width: 200, height: 400 })
    expect(dropPreviewRect('right', rect)).toEqual({ left: 600, top: 0, width: 200, height: 400 })
    expect(dropPreviewRect('top', rect)).toEqual({ left: 0, top: 0, width: 800, height: 100 })
    expect(dropPreviewRect('bottom', rect)).toEqual({ left: 0, top: 300, width: 800, height: 100 })
  })
})

describe('dropPanel', () => {
  it('落とした端へ移し、隠れていたら見えるようにする', () => {
    const hidden = withPanel(DEFAULT_LAYOUT, 'terminal', { visible: false })
    expect(dropPanel(hidden, 'terminal', 'top').panels.terminal).toEqual({ dock: 'top', visible: true })
  })
  it('フッターは上か下だけ', () => {
    expect(dropPanel(DEFAULT_LAYOUT, 'footer', 'top')).toBe(DEFAULT_LAYOUT)
    expect(dropPanel(DEFAULT_LAYOUT, 'footer', 'left')).toBe(DEFAULT_LAYOUT)
  })
})

describe('togglePanel / panelToggleOrder（タイトルバーの開閉ボタン）', () => {
  it('開閉を切り替え、open を渡すとその状態にする', () => {
    expect(togglePanel(DEFAULT_LAYOUT, 'terminal').panels.terminal.visible).toBe(false)
    expect(togglePanel(togglePanel(DEFAULT_LAYOUT, 'terminal'), 'terminal').panels.terminal.visible).toBe(true)
    expect(togglePanel(DEFAULT_LAYOUT, 'files', false).panels.files.visible).toBe(false)
    expect(togglePanel(DEFAULT_LAYOUT, 'files', true).panels.files).toEqual(DEFAULT_LAYOUT.panels.files)
  })
  it('置き場所は変えない', () => {
    const l = withPanel(DEFAULT_LAYOUT, 'terminal', { dock: 'top' })
    expect(togglePanel(l, 'terminal').panels.terminal.dock).toBe('top')
  })
  it('ボタンの並びは置き場所の順（左 → 上 → 下 → 右）', () => {
    expect(panelToggleOrder(DEFAULT_LAYOUT)).toEqual(['projects', 'files'])
    const l = withPanel(withPanel(DEFAULT_LAYOUT, 'files', { dock: 'bottom' }), 'projects', { dock: 'right' })
    expect(panelToggleOrder(l)).toEqual(['files', 'projects'])
  })
})

describe('pickFooterTier（フッターが狭いときに隠す順）', () => {
  const slots = [
    { priority: 0, width: 100 },
    { priority: 1, width: 100 },
    { priority: 2, width: 100 },
    { priority: 3, width: 100 }
  ]
  it('全部収まれば全部出す', () => {
    expect(pickFooterTier(slots, 430, 10)).toBe(3)
  })
  it('足りなければ優先順位の低いものから隠す', () => {
    expect(pickFooterTier(slots, 429, 10)).toBe(2)
    expect(pickFooterTier(slots, 320, 10)).toBe(2)
    expect(pickFooterTier(slots, 319, 10)).toBe(1)
    expect(pickFooterTier(slots, 210, 10)).toBe(1)
  })
  it('優先順位 0 は収まらなくても出す（段は 0）', () => {
    expect(pickFooterTier(slots, 50, 10)).toBe(0)
  })
  it('常に出すのは録画時間・使用量・設定、最初に隠すのはページ名・整理・ターミナルの配置', () => {
    expect(FOOTER_ITEMS.filter((id) => FOOTER_PRIORITY[id] === 0)).toEqual(['usage', 'recording', 'settings'])
    expect(FOOTER_ITEMS.filter((id) => FOOTER_PRIORITY[id] === 3)).toEqual(['page', 'layout'])
  })
})
