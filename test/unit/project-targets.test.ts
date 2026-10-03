import { describe, expect, it, vi } from 'vitest'
import type { CaptureSourceInfo, ProjectTarget } from '@shared/types'
import {
  addTarget,
  matchWindowSource,
  moveTarget,
  removeTarget,
  sanitizeProjectKind,
  sanitizeProjectTargets,
  suggestTargetLabel,
  targetAction,
  updateTarget,
  urlTargets
} from '@shared/projectTargets'
import { matchPresetUrl, presetTarget } from '@shared/projectUrl'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))
const { sanitize } = await import('../../src/main/settings')

let seq = 0
const newId = () => `gen-${++seq}`

describe('確認先の移行と読み込み', () => {
  it('local / dev / prd の URL だけの設定は、何も失わずにそのまま読める（種類は web）', () => {
    const legacy = [
      { id: 'u1', label: 'local', url: 'http://localhost:3000' },
      { id: 'u2', label: 'dev', url: 'https://dev.example.com' },
      { id: 'u3', label: 'prd', url: 'https://example.com' }
    ]
    const s = sanitize({ projects: [{ id: 'p', name: 'app', folderPath: '/work/app', urls: legacy }] })
    expect(s.projects[0]!.kind).toBe('web')
    expect(s.projects[0]!.urls).toEqual(legacy)
  })

  it('種類ごとに読み込める。知らない種類は web、壊れた要素・中身の無い要素は捨て、id が無ければ振る', () => {
    expect(sanitizeProjectKind('desktop')).toBe('desktop')
    expect(sanitizeProjectKind('mobile')).toBe('mobile')
    expect(sanitizeProjectKind('other')).toBe('other')
    expect(sanitizeProjectKind('tv')).toBe('web')
    const targets = sanitizeProjectTargets([
      { id: 'a', label: 'dev', launchCommand: ' pnpm tauri dev ', windowMatch: 'MyApp', url: 'http://localhost:1420' },
      { label: 'iOS sim', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' },
      { id: 'a', windowMatch: 'Other' },
      { id: 'b', label: '空' },
      'x', null
    ], newId)
    expect(targets).toEqual([
      { id: 'a', label: 'dev', url: 'http://localhost:1420', launchCommand: 'pnpm tauri dev', windowMatch: 'MyApp' },
      { id: 'gen-1', label: 'iOS sim', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' },
      { id: 'gen-2', label: 'Other', windowMatch: 'Other' }
    ])
  })

  it('種類を変えても確認先の項目は消えない（画面が出す欄だけが変わる）', () => {
    const s = sanitize({ projects: [{ id: 'p', folderPath: '/w', kind: 'web', urls: [{ id: 'a', label: 'app', url: 'http://x', windowMatch: 'App' }] }] })
    expect(s.projects[0]!.urls[0]).toEqual({ id: 'a', label: 'app', url: 'http://x', windowMatch: 'App' })
  })
})

describe('確認先の追加・並べ替え（件数の上限なし）', () => {
  it('名前の候補は web なら local → dev → prd → staging → preview、使い切ったら番号を付ける', () => {
    let list: ProjectTarget[] = []
    for (let i = 0; i < 7; i++) list = addTarget(list, 'web', { url: `http://localhost:${3000 + i}` }, `t${i}`)
    expect(list.map((t) => t.label)).toEqual(['local', 'dev', 'prd', 'staging', 'preview', 'local 2', 'local 3'])
    expect(suggestTargetLabel('mobile', [])).toBe('iOS sim')
    expect(addTarget([], 'desktop', { label: 'preview-PR-12', launchCommand: '  ' }, 'x')).toEqual([{ id: 'x', label: 'preview-PR-12' }])
  })

  it('並べ替え・名前の変更・削除ができ、空にした欄は消える', () => {
    const list: ProjectTarget[] = [
      { id: 'a', label: 'local', url: 'http://a' },
      { id: 'b', label: 'dev', url: 'http://b' },
      { id: 'c', label: 'prd', url: 'http://c' }
    ]
    expect(moveTarget(list, 2, 0).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    expect(moveTarget(list, 0, 99).map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(moveTarget(list, 5, 0)).toEqual(list)
    expect(updateTarget(list, 'b', { label: 'staging', url: '' })[1]).toEqual({ id: 'b', label: 'staging' })
    expect(removeTarget(list, 'a').map((t) => t.id)).toEqual(['b', 'c'])
  })
})

describe('確認先のボタンの動き', () => {
  it('URL だけなら開く。起動コマンドやウインドウがあればウインドウとして扱い、URL も一緒に開く', () => {
    expect(targetAction({ id: 'a', label: 'local', url: 'http://localhost:3000' }, 'web')).toEqual({ kind: 'url', url: 'http://localhost:3000' })
    expect(targetAction({ id: 'b', label: 'dev', launchCommand: 'pnpm tauri dev', windowMatch: 'MyApp', url: 'http://localhost:1420' }, 'desktop'))
      .toEqual({ kind: 'window', launchCommand: 'pnpm tauri dev', windowMatch: 'MyApp', url: 'http://localhost:1420' })
    expect(targetAction({ id: 'c', label: 'iOS', windowMatch: 'Simulator' }, 'mobile')).toEqual({ kind: 'window', windowMatch: 'Simulator' })
    expect(targetAction({ id: 'd', label: '書きかけ' }, 'other')).toEqual({ kind: 'none' })
  })

  it('web のプロジェクトでは、隠れている起動コマンドやウインドウは使わず URL として開く', () => {
    expect(targetAction({ id: 'a', label: 'app', url: 'http://x', windowMatch: 'App', launchCommand: 'run' }, 'web')).toEqual({ kind: 'url', url: 'http://x' })
  })

  it('URL を持たない確認先は、表示中の URL の判定と同じパスでの切り替えに混ざらない', () => {
    const list: ProjectTarget[] = [{ id: 'w', label: 'app', windowMatch: 'App' }, { id: 'l', label: 'local', url: 'http://localhost:3000' }, { id: 'd', label: 'dev', url: 'https://dev.example.com' }]
    expect(matchPresetUrl(list, 'http://localhost:3000/x')?.id).toBe('l')
    expect(urlTargets(list).map((t) => t.id)).toEqual(['l', 'd'])
    expect(presetTarget(list, 'http://localhost:3000/x', { id: 'd', label: 'dev', url: 'https://dev.example.com' })).toBe('https://dev.example.com/x')
  })
})

describe('録画するウインドウの選び方', () => {
  const sources: CaptureSourceInfo[] = [
    { id: 'screen:1', kind: 'screen', name: 'Simulator Display', thumbnail: '' },
    { id: 'window:1', kind: 'window', name: 'iPhone 16 Pro – Simulator', thumbnail: '' },
    { id: 'window:2', kind: 'window', name: 'Simulator', thumbnail: '' },
    { id: 'window:3', kind: 'window', name: 'MyApp - Settings', thumbnail: '' },
    { id: 'window:4', kind: 'window', name: 'qemu-system-aarch64', thumbnail: '' }
  ]

  it('完全一致 → 前方一致 → 部分一致の順で選び、画面全体は選ばない。大文字小文字は問わない', () => {
    expect(matchWindowSource(sources, 'simulator')?.id).toBe('window:2')
    expect(matchWindowSource(sources, 'myapp')?.id).toBe('window:3')
    expect(matchWindowSource(sources, 'QEMU')?.id).toBe('window:4')
    expect(matchWindowSource(sources, 'iPhone')?.id).toBe('window:1')
  })

  it('見つからない・空のときは null', () => {
    expect(matchWindowSource(sources, 'scrcpy')).toBeNull()
    expect(matchWindowSource(sources, '  ')).toBeNull()
    expect(matchWindowSource([], 'Simulator')).toBeNull()
  })
})
