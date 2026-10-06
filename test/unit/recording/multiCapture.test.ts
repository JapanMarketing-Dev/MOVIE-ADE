import { describe, expect, it } from 'vitest'
import {
  captureTargetLabel,
  captureTargetLines,
  resolveCaptureTarget,
  sanitizeCaptureTarget,
  targetFromParts,
  targetFromSource,
  targetIncludes,
  targetParts,
  targetSourceIds,
  toggleSourceInTarget
} from '../../../src/shared/captureTarget'
import {
  COMPOSITE_GAP,
  COMPOSITE_MAX_HEIGHT,
  COMPOSITE_MAX_WIDTH,
  MAX_COMPOSITE_SOURCES,
  compositeColumns,
  compositeLayout,
  fitInto,
  mirrorSourceParam,
  parseMirrorSourceParam,
  sourceMaxWidth
} from '../../../src/shared/captureComposite'
import { captureRequestProblem } from '../../../src/main/captureConsent'
import type { CaptureSourceInfo, CaptureTarget } from '../../../src/shared/types'
import { setLocale } from '@shared/i18n'

// 日本語の文言を確かめるテストなので、画面の言語を日本語に固定する（既定は英語）
setLocale('ja')

const screen1: CaptureSourceInfo = { id: 'screen:1:0', kind: 'screen', name: '画面 1（1512×982・メイン）', displayId: '1', thumbnail: '' }
const screen2: CaptureSourceInfo = { id: 'screen:2:0', kind: 'screen', name: '画面 2（1920×1080）', displayId: '2', thumbnail: '' }
const figma: CaptureSourceInfo = { id: 'window:101:0', kind: 'window', name: 'Figma', appName: 'Figma', thumbnail: '' }
const editor: CaptureSourceInfo = { id: 'window:202:0', kind: 'window', name: 'main.ts — acme-shop', appName: 'Code', thumbnail: '' }
const sim: CaptureSourceInfo = { id: 'window:303:0', kind: 'window', name: 'iPhone 16 Pro', appName: 'Simulator', thumbnail: '' }
/** 画面・ウインドウの対象（内蔵ブラウザではない形）として作る */
const desktop = (source: CaptureSourceInfo) => targetFromSource(source) as Extract<CaptureTarget, { kind: 'screen' | 'window' }>

describe('複数の画面・ウインドウを選ぶ（チェック）', () => {
  it('何も選んでいない・内蔵ブラウザなら、その1つだけになる（1つのときは今までと同じ形）', () => {
    expect(toggleSourceInTarget(null, screen1)).toEqual(targetFromSource(screen1))
    expect(toggleSourceInTarget({ kind: 'browser' }, figma)).toEqual(targetFromSource(figma))
    expect(targetFromSource(screen1)).not.toHaveProperty('also')
  })

  it('足すと also に並び、画面とウインドウを混ぜられる', () => {
    const two = toggleSourceInTarget(targetFromSource(screen1), screen2)
    const three = toggleSourceInTarget(two, figma)
    expect(targetSourceIds(three!)).toEqual(['screen:1:0', 'screen:2:0', 'window:101:0'])
    expect(three).toMatchObject({ kind: 'screen', sourceId: 'screen:1:0', also: [{ kind: 'screen', sourceId: 'screen:2:0' }, { kind: 'window', sourceId: 'window:101:0', appName: 'Figma' }] })
    expect(targetIncludes(three, 'window:101:0')).toBe(true)
    expect(targetIncludes(three, 'window:202:0')).toBe(false)
  })

  it('外すと残りで作り直し、最初のものを外したら次が最初になる。全部外すと null', () => {
    const two = toggleSourceInTarget(targetFromSource(screen1), figma)!
    const rest = toggleSourceInTarget(two, screen1)
    expect(rest).toEqual(targetFromSource(figma))
    expect(toggleSourceInTarget(rest, figma)).toBeNull()
  })

  it('上限を超えて足そうとすると、そのまま返す（同じオブジェクト）', () => {
    let target: CaptureTarget | null = null
    for (const s of [screen1, screen2, figma, editor]) target = toggleSourceInTarget(target, s)
    expect(targetSourceIds(target!)).toHaveLength(MAX_COMPOSITE_SOURCES)
    expect(toggleSourceInTarget(target, sim)).toBe(target)
  })

  it('最初の対象の端末の情報は、最初が変わらなければ保つ', () => {
    const withDevice: CaptureTarget = { ...desktop(sim), device: { platform: 'ios', name: 'iPhone 16 Pro' } }
    const two = toggleSourceInTarget(withDevice, figma)!
    expect(two).toMatchObject({ device: { platform: 'ios' } })
    expect(targetParts(two)[0]).not.toHaveProperty('device')
    expect(targetFromParts([])).toBeNull()
  })
})

describe('複数の対象を設定から読む', () => {
  it('also を型どおりに直し、壊れた・重複・最初と同じ・上限を超える分を捨てる', () => {
    const raw = { kind: 'screen', sourceId: 'screen:1:0', name: '画面 1', also: [
      { kind: 'screen', sourceId: 'screen:2:0', name: '画面 2', displayId: '2' },
      { kind: 'screen', sourceId: 'screen:2:0', name: '重複' },
      { kind: 'screen', sourceId: 'screen:1:0', name: '最初と同じ' },
      { kind: 'window', sourceId: 'screen:9:0', name: '種類と ID が合わない' },
      { kind: 'tab', sourceId: 'tab:1', name: '内蔵ブラウザは混ぜない' },
      null,
      { kind: 'window', sourceId: 'window:101:0', name: 'Figma', appName: 'Figma', device: { platform: 'ios' } },
      { kind: 'window', sourceId: 'window:202:0', name: 'Code' },
      { kind: 'window', sourceId: 'window:303:0', name: '上限を超える' }
    ] }
    const target = sanitizeCaptureTarget(raw)!
    expect(targetSourceIds(target)).toEqual(['screen:1:0', 'screen:2:0', 'window:101:0', 'window:202:0'])
    expect(target.kind !== 'browser' && target.also?.[1]).toEqual({ kind: 'window', sourceId: 'window:101:0', name: 'Figma', appName: 'Figma' })
  })

  it('also が空・配列でなければ付けない（1つのときは今までと同じ）', () => {
    expect(sanitizeCaptureTarget({ kind: 'window', sourceId: 'window:1:0', name: 'A', also: [] })).toEqual({ kind: 'window', sourceId: 'window:1:0', name: 'A' })
    expect(sanitizeCaptureTarget({ kind: 'window', sourceId: 'window:1:0', name: 'A', also: 'x' })).toEqual({ kind: 'window', sourceId: 'window:1:0', name: 'A' })
  })
})

describe('複数の対象を、いまの候補から探し直す', () => {
  const saved = toggleSourceInTarget(targetFromSource(screen1), figma)!

  it('ID が変わっても、画面は displayId、ウインドウは名前で1つずつ見つける', () => {
    const now = [{ ...screen1, id: 'screen:1:1' }, { ...figma, id: 'window:999:0' }]
    expect(targetSourceIds(resolveCaptureTarget(saved, now)!)).toEqual(['screen:1:1', 'window:999:0'])
  })

  it('最初の対象が無ければ見つからない。ほかが無ければ見つかった分だけ（呼ぶ側が欠けを確かめる）', () => {
    expect(resolveCaptureTarget(saved, [figma])).toBeNull()
    expect(resolveCaptureTarget(saved, [screen1])).toEqual(targetFromSource(screen1))
  })

  it('2つが同じ候補に当たらない', () => {
    const twoFigmas: CaptureTarget = { kind: 'window', sourceId: 'window:1:0', name: 'Figma', appName: 'Figma', also: [{ kind: 'window', sourceId: 'window:2:0', name: 'Figma', appName: 'Figma' }] }
    expect(targetSourceIds(resolveCaptureTarget(twoFigmas, [figma])!)).toEqual(['window:101:0'])
  })
})

describe('複数の対象の名前と指摘への添え書き', () => {
  const target = toggleSourceInTarget(toggleSourceInTarget(targetFromSource(screen1), screen2), figma)!

  it('最初の対象の名前に「ほか N 件」を付ける', () => {
    expect(captureTargetLabel(target)).toBe('画面全体（画面 1（1512×982・メイン）） ほか 2 件')
    expect(captureTargetLabel(targetFromSource(figma))).toBe('ウインドウ「Figma」')
  })

  it('feedback.md に、並べた順の対象を書く', () => {
    const lines = captureTargetLines(target)
    expect(lines[0]).toContain('ほか 2 件')
    expect(lines[1]).toBe('- 並べて録った対象: 画面全体（画面 1（1512×982・メイン）） / 画面全体（画面 2（1920×1080）） / ウインドウ「Figma」')
  })
})

describe('録画の同意（複数選んだとき）', () => {
  const chosen = toggleSourceInTarget(targetFromSource(screen1), figma)!
  const consent = { target: chosen, mic: true, systemAudio: false }

  it('選んだものと同じ並びなら録る', () => {
    expect(captureRequestProblem({ target: chosen, mic: true, systemAudio: false }, consent)).toBeNull()
  })

  it('選んでいない画面・ウインドウを足した・外した・入れ替えた求めは断る', () => {
    const added = toggleSourceInTarget(chosen, editor)!
    expect(captureRequestProblem({ target: added, mic: true, systemAudio: false }, consent)).toBe('target')
    expect(captureRequestProblem({ target: targetFromSource(screen1), mic: true, systemAudio: false }, consent)).toBe('target')
    const swapped: CaptureTarget = { ...desktop(screen1), also: [{ kind: 'window', sourceId: 'window:202:0', name: 'Figma' }] }
    expect(captureRequestProblem({ target: swapped, mic: true, systemAudio: false }, consent)).toBe('target')
  })
})

describe('1本の動画に並べる配置', () => {
  it('列の数: 1→1、2→2、3〜4→2', () => {
    expect([1, 2, 3, 4, 5].map(compositeColumns)).toEqual([1, 2, 2, 2, 3])
  })

  it('2画面は横に並べ、横幅は videoMaxWidth を超えない。枠は同じ幅で、高い方に合わせる', () => {
    const layout = compositeLayout([{ width: 3024, height: 1964 }, { width: 1920, height: 1080 }], 1600)
    expect(layout.width).toBeLessThanOrEqual(1600)
    expect(layout.cells).toHaveLength(2)
    const [a, b] = layout.cells
    expect(a!.width).toBe(b!.width)
    expect(a!.y).toBe(0)
    expect(b!.x).toBe(a!.x + a!.width + COMPOSITE_GAP)
    // 1512×982 の比（約 0.65）に合わせた高さ。1920×1080（0.5625）は収まる
    expect(a!.height).toBe(Math.floor((1964 * a!.width) / 3024))
    expect(layout.width % 2).toBe(0)
    expect(layout.height % 2).toBe(0)
  })

  it('3つは 2×2 の上に2つ、下の1つは真ん中に寄せる', () => {
    const layout = compositeLayout([{ width: 1600, height: 1000 }, { width: 1600, height: 1000 }, { width: 1600, height: 1000 }], 1600)
    const [a, b, c] = layout.cells
    expect(a!.y).toBe(b!.y)
    expect(c!.y).toBe(a!.y + a!.height + COMPOSITE_GAP)
    expect(c!.x).toBe(Math.round((a!.width + COMPOSITE_GAP) / 2))
  })

  it('原寸（0）でも上限で止め、縦長が並んでも高さの上限に収める', () => {
    const wide = compositeLayout([{ width: 5120, height: 2880 }, { width: 5120, height: 2880 }], 0)
    expect(wide.width).toBeLessThanOrEqual(COMPOSITE_MAX_WIDTH)
    const tall = compositeLayout([{ width: 1080, height: 1920 }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 }, { width: 1080, height: 1920 }], 3840)
    expect(tall.height).toBeLessThanOrEqual(COMPOSITE_MAX_HEIGHT)
    for (const cell of tall.cells) expect(cell.y + cell.height).toBeLessThanOrEqual(tall.height)
  })

  it('大きさのまだ分からない映像は 16:10 とみなす', () => {
    const layout = compositeLayout([{ width: 0, height: 0 }, { width: 0, height: 0 }], 1600)
    expect(layout.cells[0]!.height).toBe(Math.floor((layout.cells[0]!.width * 10) / 16))
  })

  it('枠の中に縦横比を保って真ん中に収める', () => {
    const cell = { x: 100, y: 0, width: 800, height: 500 }
    expect(fitInto({ width: 1920, height: 1080 }, cell)).toEqual({ x: 100, y: 25, width: 800, height: 450 })
    expect(fitInto({ width: 500, height: 1000 }, cell)).toEqual({ x: 375, y: 0, width: 250, height: 500 })
    expect(fitInto({ width: 0, height: 0 }, cell)).toEqual(cell)
  })

  it('並べるときは1つずつの取り込みを枠の幅まで小さくする（640px は残す）。1つなら変えない', () => {
    expect(sourceMaxWidth(1, 1600)).toBe(1600)
    expect(sourceMaxWidth(2, 1600)).toBe(800)
    expect(sourceMaxWidth(4, 1000)).toBe(640)
    expect(sourceMaxWidth(2, 0)).toBe(COMPOSITE_MAX_WIDTH / 2)
  })
})

describe('内蔵ブラウザの場所に並べて映す（mirror.js の source）', () => {
  it('ID を , でつなぎ、形の違うもの・上限を超える分は入れない', () => {
    expect(mirrorSourceParam(['screen:1:0', 'window:2:0'])).toBe('screen:1:0,window:2:0')
    expect(mirrorSourceParam(['screen:1:0', 'javascript:alert(1)', 'screen:1:0,window:2:0'])).toBe('screen:1:0')
    expect(parseMirrorSourceParam('screen:1:0,window:2:0,tab:3,window:4:0,window:5:0,window:6:0')).toEqual(['screen:1:0', 'window:2:0', 'window:4:0', 'window:5:0'])
    expect(parseMirrorSourceParam(mirrorSourceParam([]))).toEqual([])
  })
})
