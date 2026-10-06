import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  FOOTER_ITEMS,
  FOOTER_PRIORITY,
  pickFooterOverflow,
  applyOrder,
  browserFocusLayout,
  layoutSignature,
  layoutMinWidth,
  mainMinWidth,
  CENTER_MIN_WIDTH,
  SIDE_MIN_WIDTH,
  TERMINAL_MIN_WIDTH,
  WINDOW_MIN_WIDTH,
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
  it('表示・フッターの項目を残す', () => {
    const l = sanitizeLayout({
      panels: { files: { dock: 'right', visible: false } },
      footer: { dock: 'top', visible: false, items: { usage: false, bogus: false } }
    })
    expect(l.panels.files).toEqual({ dock: 'right', visible: false })
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
  it('ドラッグで動かしていた古い置き場所は既定へ戻す（プロジェクト一覧は左・ファイルツリーは右・ターミナルは右か下）', () => {
    const l = sanitizeLayout({
      panels: { projects: { dock: 'bottom', visible: false }, files: { dock: 'left', visible: true }, terminal: { dock: 'top', visible: true } }
    })
    expect(l.panels).toEqual({
      projects: { dock: 'left', visible: false },
      files: { dock: 'right', visible: true },
      terminal: { dock: 'right', visible: true }
    })
    expect(sanitizeLayout({ panels: { terminal: { dock: 'bottom' } } }).panels.terminal.dock).toBe('bottom')
    expect(sanitizeLayout({ panels: { terminal: { dock: 'left' } } }).panels.terminal.dock).toBe('right')
  })
  it('withPanel でも左右のパネルの置き場所・ターミナルの左・上は変わらない', () => {
    expect(withPanel(DEFAULT_LAYOUT, 'files', { dock: 'bottom' }).panels.files.dock).toBe('right')
    expect(withPanel(DEFAULT_LAYOUT, 'projects', { dock: 'right' }).panels.projects.dock).toBe('left')
    expect(withPanel(DEFAULT_LAYOUT, 'terminal', { dock: 'top' }).panels.terminal.dock).toBe('right')
    expect(withPanel(DEFAULT_LAYOUT, 'terminal', { dock: 'bottom' }).panels.terminal.dock).toBe('bottom')
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
    const g = workspaceGrid(withPanel(DEFAULT_LAYOUT, 'files', { visible: false }))
    expect(g.columns).toBe('minmax(140px, var(--sidebar-width)) minmax(606px, 1fr) 0px')
    expect(g.areas).toBe('"projects main files"')
  })
  it('プロジェクト一覧も閉じられる（幅 0）', () => {
    expect(workspaceGrid(togglePanel(DEFAULT_LAYOUT, 'projects')).columns).toBe('0px minmax(606px, 1fr) minmax(140px, var(--size-sidebar))')
  })
})

describe('browserFocusLayout（ブラウザに集中）', () => {
  it('ブラウザ以外のパネルを全部隠し、中央の列だけにする', () => {
    const l = browserFocusLayout(DEFAULT_LAYOUT)
    expect(Object.values(l.panels).map((p) => p.visible)).toEqual([false, false, false])
    expect(workspaceGrid(l).columns).toBe('0px minmax(360px, 1fr) 0px')
    expect(mainSplitGrid(l.panels.terminal.dock, l.panels.terminal.visible)).toMatchObject({ columns: 'minmax(0, 1fr)', rows: 'minmax(0, 1fr)', areas: '"center"' })
    expect(layoutMinWidth(l)).toBe(CENTER_MIN_WIDTH)
  })
  it('元の配置は変えない（もう一度押すと元の配置で描く）', () => {
    const base = togglePanel(DEFAULT_LAYOUT, 'files')
    const copy = JSON.parse(JSON.stringify(base))
    browserFocusLayout(base)
    expect(base).toEqual(copy)
    expect(browserFocusLayout(base).panels.terminal.dock).toBe('right')
  })
  it('配置の印が変わる（内蔵ブラウザの位置を測り直す）', () => {
    expect(layoutSignature(browserFocusLayout(DEFAULT_LAYOUT))).not.toBe(layoutSignature(DEFAULT_LAYOUT))
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
  const combos = (['right', 'bottom'] as const).flatMap((t) =>
    [true, false].flatMap((p) => [true, false].map((f) =>
      withPanel(withPanel(withPanel(DEFAULT_LAYOUT, 'terminal', { dock: t }), 'projects', { visible: p }), 'files', { visible: f }))))
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
  it('閉じたパネルは横の最小に数えない', () => {
    expect(layoutMinWidth(withPanel(DEFAULT_LAYOUT, 'files', { visible: false }))).toBe(SIDE_MIN_WIDTH + 606)
    expect(layoutMinWidth(withPanel(DEFAULT_LAYOUT, 'projects', { visible: false }))).toBe(SIDE_MIN_WIDTH + 606)
  })
})

describe('ターミナルは常に表示（閉じる手段を持たない）', () => {
  it('古い設定でターミナルを閉じていても、読み込むと表示になる', () => {
    expect(sanitizeLayout({ panels: { terminal: { dock: 'bottom', visible: false } } }).panels.terminal).toEqual({ dock: 'bottom', visible: true })
  })
  it('プロジェクト一覧とファイルツリーは閉じたまま残る（タイトルバーのボタンで開閉する）', () => {
    expect(sanitizeLayout({ panels: { files: { dock: 'right', visible: false }, projects: { dock: 'left', visible: false } } }).panels)
      .toMatchObject({ files: { visible: false }, projects: { visible: false } })
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

describe('togglePanel（タイトルバーの開閉ボタン）', () => {
  it('開閉を切り替え、open を渡すとその状態にする', () => {
    expect(togglePanel(DEFAULT_LAYOUT, 'files').panels.files.visible).toBe(false)
    expect(togglePanel(togglePanel(DEFAULT_LAYOUT, 'files'), 'files').panels.files.visible).toBe(true)
    expect(togglePanel(DEFAULT_LAYOUT, 'files', false).panels.files.visible).toBe(false)
    expect(togglePanel(DEFAULT_LAYOUT, 'files', true).panels.files).toEqual(DEFAULT_LAYOUT.panels.files)
    expect(togglePanel(DEFAULT_LAYOUT, 'projects').panels.projects).toEqual({ dock: 'left', visible: false })
  })
  it('置き場所は変えない', () => {
    const l = withPanel(DEFAULT_LAYOUT, 'terminal', { dock: 'bottom' })
    expect(togglePanel(l, 'terminal').panels.terminal.dock).toBe('bottom')
  })
})

describe('pickFooterOverflow（フッターが狭いときに「…」へ移す項目）', () => {
  // 並びはフッターでの順。priority 0 は常に出す。数の大きいものほど先に移す
  const slots = [
    { id: 'usage', priority: 0, width: 100 },
    { id: 'mic', priority: 1, width: 100 },
    { id: 'page', priority: 3, width: 100 },
    { id: 'version', priority: 2, width: 100 }
  ] as const
  const gap = 10
  const more = 20

  it('全部収まれば何も移さない（「…」も出さない）', () => {
    expect(pickFooterOverflow(slots, 430, gap, more)).toEqual([])
  })
  it('足りなければ優先順位の低いものから1つずつ移し、「…」の幅も空ける', () => {
    // 100+10+100+10+100 + 10 + 20 = 350 で usage・mic・version と「…」
    expect(pickFooterOverflow(slots, 429, gap, more)).toEqual(['page'])
    expect(pickFooterOverflow(slots, 350, gap, more)).toEqual(['page'])
    expect(pickFooterOverflow(slots, 349, gap, more)).toEqual(['page', 'version'])
    expect(pickFooterOverflow(slots, 240, gap, more)).toEqual(['page', 'version'])
    expect(pickFooterOverflow(slots, 239, gap, more)).toEqual(['mic', 'page', 'version'])
  })
  it('段でまとめず、1つずつ移す（同じくらいの優先順位でも入るものは出したまま）', () => {
    const many = [
      { id: 'a', priority: 1, width: 50 },
      { id: 'b', priority: 2, width: 50 },
      { id: 'c', priority: 3, width: 50 },
      { id: 'd', priority: 4, width: 50 }
    ]
    // 全部で 50*4+10*3 = 230。「…」込みで 3 つなら 50*3+10*3+20 = 200
    expect(pickFooterOverflow(many, 229, gap, more)).toEqual(['d'])
    expect(pickFooterOverflow(many, 200, gap, more)).toEqual(['d'])
    expect(pickFooterOverflow(many, 199, gap, more)).toEqual(['c', 'd'])
  })
  it('優先順位の高い大きな項目が入らなくても、後ろの小さな項目は入れば出す', () => {
    const mixed = [
      { id: 'usage', priority: 0, width: 100 },
      { id: 'github', priority: 1, width: 300 },
      { id: 'layout', priority: 2, width: 22 }
    ]
    // usage 100 + 隙間 10 + 「…」20 = 130。github は入らず、layout（22+10）は入る
    expect(pickFooterOverflow(mixed, 200, gap, more)).toEqual(['github'])
  })
  it('優先順位 0 は収まらなくても出す', () => {
    expect(pickFooterOverflow(slots, 50, gap, more)).toEqual(['mic', 'page', 'version'])
  })
  it('常に出すのは録画時間・使用量・設定、ほかは1つずつ違う順位で、最後に移すのはマイク', () => {
    expect(FOOTER_ITEMS.filter((id) => FOOTER_PRIORITY[id] === 0)).toEqual(['usage', 'recording', 'settings'])
    const ranked = FOOTER_ITEMS.filter((id) => FOOTER_PRIORITY[id] > 0)
    expect(new Set(ranked.map((id) => FOOTER_PRIORITY[id])).size).toBe(ranked.length)
    expect([...ranked].sort((a, b) => FOOTER_PRIORITY[a] - FOOTER_PRIORITY[b])[0]).toBe('mic')
  })
})
