import { describe, expect, it } from 'vitest'
import {
  activeTrackAt,
  isTrackId,
  matchWatchedWindow,
  MAX_CAPTURE_TRACKS,
  nextTrackId,
  planWatch,
  shortTrackLabel,
  trackLabel,
  waitingWindows,
  watchedWindows,
  watchUnavailable,
  windowMatchQuery,
  type WatchedWindow
} from '@shared/captureTracks'
import { sanitizeProjectTargets, updateTarget, addTarget } from '@shared/projectTargets'
import { groupByTarget } from '@shared/reviewTarget'
import { parseMacWindowList, withAppWindows } from '@shared/desktopApps'
import { SETTINGS_SCHEMA } from '@shared/settingsSchema'
import { buildItemContext } from '../../src/main/pipeline/context'
import { buildTargetIndex } from '../../src/main/pipeline/organize/targets'
import type { Event, FeedbackDocument, FeedbackItem } from '../../src/main/pipeline/types'
import type { CaptureSourceInfo } from '@shared/types'
import { setLocale } from '@shared/i18n'

/**
 * 1本の録画で複数の映像（内蔵ブラウザ・デスクトップアプリのウインドウ）を同時に録り、切り替える。
 * 待ち受け（録画中に開いたら録る）の照合と判断、切り替えの時刻から指摘の対象を引く処理を確かめる（Electron なしの純粋な処理）。
 */

setLocale('en')

const win = (id: number, name: string, over: Partial<CaptureSourceInfo> = {}): CaptureSourceInfo => ({ id: `window:${id}:0`, kind: 'window', name, thumbnail: '', ...over })
const watch = (id: string, match: string, mode: WatchedWindow['mode'] = 'record'): WatchedWindow => ({ id, label: id, match, mode })

describe('待ち受けの名前の書き方', () => {
  it('アプリ名・題名の一部はそのまま、アプリや実行ファイルのパスは名前だけ、バンドル ID は ID と最後の語', () => {
    expect(windowMatchQuery('  Figma ')).toEqual({ text: 'Figma' })
    expect(windowMatchQuery('/Applications/My App.app')).toEqual({ text: 'My App' })
    expect(windowMatchQuery('/Applications/My App.app/Contents/MacOS/My App')).toEqual({ text: 'My App' })
    expect(windowMatchQuery('C:\\Program Files\\Acme\\Acme.exe')).toEqual({ text: 'Acme' })
    expect(windowMatchQuery('/usr/bin/acme-desktop')).toEqual({ text: 'acme-desktop' })
    expect(windowMatchQuery('Acme.AppImage')).toEqual({ text: 'Acme' })
    expect(windowMatchQuery('com.acme.Desktop')).toEqual({ text: 'Desktop', bundleId: 'com.acme.Desktop' })
    // ドメインのような2語は バンドル ID と見なさない
    expect(windowMatchQuery('example.com')).toEqual({ text: 'example.com' })
    expect(windowMatchQuery('')).toEqual({ text: '' })
  })

  it('バンドル ID が分かる（macOS）ならそれで選び、名前の似た別のアプリは選ばない', () => {
    const sources = [win(1, 'Desktop', { appName: 'Other', bundleId: 'com.other.Desktop' }), win(2, 'Main window', { appName: 'Acme', bundleId: 'com.acme.Desktop' })]
    expect(matchWatchedWindow(sources, 'com.acme.Desktop')?.id).toBe('window:2:0')
    expect(matchWatchedWindow(sources, 'com.missing.App')).toBeNull()
  })

  it('バンドル ID が分からない（Windows・Linux）ときは、題名に名前が含まれるウインドウを選ぶ。画面全体は選ばない', () => {
    const sources: CaptureSourceInfo[] = [{ id: 'screen:1:0', kind: 'screen', name: 'Acme', thumbnail: '' }, win(3, 'Acme - Settings'), win(4, 'Notes')]
    expect(matchWatchedWindow(sources, 'C:\\Apps\\Acme.exe')?.id).toBe('window:3:0')
    expect(matchWatchedWindow(sources, 'com.acme.Acme')?.id).toBe('window:3:0')
    expect(matchWatchedWindow(sources, 'Missing')).toBeNull()
  })
})

describe('録画中の待ち受けの判断', () => {
  it('現れたウインドウを録り、録っているウインドウが消えたら閉じる。main は閉じない', () => {
    const actions = planWatch({
      watched: [watch('acme', 'Acme', 'switch')],
      tracks: [
        { id: 'main', live: true, closable: false, sourceId: 'window:9:0' },
        { id: 't2', live: true, closable: true, sourceId: 'window:5:0' }
      ],
      sources: [win(3, 'Acme')]
    })
    expect(actions).toEqual([
      { type: 'close', trackId: 't2' },
      { type: 'open', watch: watch('acme', 'Acme', 'switch'), source: win(3, 'Acme') }
    ])
  })

  it('同じ確認先をもう録っていれば足さず、ほかのトラックが録っているウインドウも選ばない', () => {
    const sources = [win(3, 'Acme'), win(4, 'Acme Preferences')]
    expect(planWatch({ watched: [watch('acme', 'Acme')], tracks: [{ id: 't2', live: true, closable: true, sourceId: 'window:3:0', watchId: 'acme' }], sources })).toEqual([])
    const second = planWatch({ watched: [watch('prefs', 'Acme')], tracks: [{ id: 't2', live: true, closable: true, sourceId: 'window:3:0' }], sources })
    expect(second).toEqual([{ type: 'open', watch: watch('prefs', 'Acme'), source: win(4, 'Acme Preferences') }])
  })

  it('閉じたあとにまた開いたら、新しいトラックとして録り直す', () => {
    const tracks = [{ id: 't2', live: false, closable: true, sourceId: 'window:3:0', watchId: 'acme' }]
    expect(planWatch({ watched: [watch('acme', 'Acme')], tracks, sources: [win(7, 'Acme')] })).toEqual([{ type: 'open', watch: watch('acme', 'Acme'), source: win(7, 'Acme') }])
  })

  it(`同時に録るのは ${MAX_CAPTURE_TRACKS} 本まで。閉じて空いた分は同じ回で使える`, () => {
    const full = Array.from({ length: MAX_CAPTURE_TRACKS }, (_, i) => ({ id: i === 0 ? 'main' : `t${i + 1}`, live: true, closable: i > 0, sourceId: `window:${100 + i}:0` }))
    const present = full.map((track) => win(Number(track.sourceId.split(':')[1]), `w${track.id}`))
    expect(planWatch({ watched: [watch('acme', 'Acme')], tracks: full, sources: [...present, win(3, 'Acme')] })).toEqual([])
    const withoutOne = present.slice(0, -1)
    const actions = planWatch({ watched: [watch('acme', 'Acme')], tracks: full, sources: [...withoutOne, win(3, 'Acme')] })
    expect(actions.map((a) => a.type)).toEqual(['close', 'open'])
  })

  it('まだ現れていない待ち受けを並べる', () => {
    const watched = [watch('a', 'A'), watch('b', 'B')]
    expect(waitingWindows(watched, [{ watchId: 'a', live: true }])).toEqual([{ id: 'b', label: 'b' }])
    expect(waitingWindows(watched, [{ watchId: 'a', live: false }])).toEqual([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }])
  })

  it('Wayland ではウインドウの一覧を取るたびに OS が選択を出すので待たない。macOS は画面収録の許可が要る', () => {
    expect(watchUnavailable('linux', { XDG_SESSION_TYPE: 'wayland' }, 'granted')).toBe('wayland')
    expect(watchUnavailable('linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'granted')).toBe('wayland')
    expect(watchUnavailable('linux', { XDG_SESSION_TYPE: 'x11' }, 'granted')).toBeNull()
    expect(watchUnavailable('darwin', {}, 'denied')).toBe('permission')
    expect(watchUnavailable('darwin', {}, 'granted')).toBeNull()
    expect(watchUnavailable('win32', {}, 'granted')).toBeNull()
  })
})

describe('確認先の watch（settings.json）', () => {
  it('ウインドウの名前がある確認先だけ watch を持ち、知らない値は捨てる', () => {
    const targets = sanitizeProjectTargets([
      { id: 'a', label: 'app', windowMatch: 'Acme', watch: 'switch' },
      { id: 'b', label: 'web', url: 'http://localhost:3000', watch: 'record' },
      { id: 'c', label: 'x', windowMatch: 'X', watch: 'always' }
    ])
    expect(targets).toEqual([
      { id: 'a', label: 'app', windowMatch: 'Acme', watch: 'switch' },
      { id: 'b', label: 'web', url: 'http://localhost:3000' },
      { id: 'c', label: 'x', windowMatch: 'X' }
    ])
  })

  it('ウインドウの名前を消すと watch も消え、足すときにも残る', () => {
    const [target] = sanitizeProjectTargets([{ id: 'a', label: 'app', windowMatch: 'Acme', watch: 'record' }])
    expect(updateTarget([target!], 'a', { windowMatch: '' })[0]).toEqual({ id: 'a', label: 'app' })
    expect(updateTarget([target!], 'a', { watch: undefined })[0]).toEqual({ id: 'a', label: 'app', windowMatch: 'Acme' })
    expect(addTarget([], 'desktop', { label: 'x', windowMatch: 'X', watch: 'switch' }, 'n')[0]).toEqual({ id: 'n', label: 'x', windowMatch: 'X', watch: 'switch' })
  })

  it('待ち受けるのはウインドウの欄を出す種類のプロジェクトだけ', () => {
    const targets = [{ id: 'a', label: 'App', windowMatch: 'Acme', watch: 'switch' as const }, { id: 'b', label: 'B', windowMatch: 'B' }]
    expect(watchedWindows(targets, 'desktop')).toEqual([{ id: 'a', label: 'App', match: 'Acme', mode: 'switch' }])
    expect(watchedWindows(targets, 'web')).toEqual([])
  })

  it('設定の JSON Schema に watch がある', () => {
    const schema = SETTINGS_SCHEMA as unknown as { properties: { projects: { items: { properties: { urls: { items: { properties: Record<string, { enum?: string[] }> } } } } } } }
    expect(schema.properties.projects.items.properties.urls.items.properties.watch?.enum).toEqual(['record', 'switch'])
  })
})

describe('macOS のバンドル ID', () => {
  it('ウインドウの一覧のバンドル ID を読み、候補に付ける。形の合わない値は捨てる', () => {
    const list = parseMacWindowList(JSON.stringify([
      { id: 5, layer: 0, owner: 'Acme', pid: 10, name: 'Main', w: 800, h: 600, bundle: 'com.acme.Desktop' },
      { id: 6, layer: 0, owner: 'Bad', pid: 11, name: 'X', w: 800, h: 600, bundle: 'rm -rf /' }
    ]))
    expect(list[0]?.bundle).toBe('com.acme.Desktop')
    expect(list[1]).not.toHaveProperty('bundle')
    const [source] = withAppWindows([win(5, 'Main')], list, 1)
    expect(source).toMatchObject({ appName: 'Acme', bundleId: 'com.acme.Desktop' })
  })
})

describe('トラックの名前と id', () => {
  it('待ち受けは確認先の名前、ウインドウはアプリ名（無ければ題名）', () => {
    expect(trackLabel({ kind: 'window', sourceId: 'window:1:0', name: 'Doc — Acme', appName: 'Acme' })).toBe('Acme')
    expect(trackLabel({ kind: 'window', sourceId: 'window:1:0', name: 'Doc — Acme' })).toBe('Doc — Acme')
    expect(trackLabel({ kind: 'window', sourceId: 'window:1:0', name: 'Doc', appName: 'Acme' }, 'Desktop app')).toBe('Desktop app')
    expect(trackLabel({ kind: 'browser' })).toBe('Built-in browser')
  })

  it('id は t2 から空いている番号。IPC で届く値は形を確かめる', () => {
    expect(nextTrackId(['main'])).toBe('t2')
    expect(nextTrackId(['main', 't2', 't4'])).toBe('t3')
    expect(isTrackId('main')).toBe(true)
    expect(isTrackId('t12')).toBe(true)
    expect(isTrackId('../x')).toBe(false)
    expect(isTrackId(3)).toBe(false)
    expect(shortTrackLabel('A very long window title here')).toBe('A very long windo…')
  })
})

/** 内蔵ブラウザで Web アプリ → デスクトップアプリが開いて切り替え → 内蔵ブラウザへ戻る、の操作ログ */
const switching: Event[] = [
  { t: 0, type: 'track', track: 'main', kind: 'browser', label: 'built-in browser', video: 'recording.webm' },
  { t: 100, type: 'nav', url: 'http://localhost:3000/login', title: 'Login' },
  { t: 2_000, type: 'click', x: 10, y: 10, el: { selector: '#open-app', text: 'Open app' } },
  { t: 3_000, type: 'track', track: 't2', kind: 'window', label: 'Acme', video: 'tracks/t2.webm' },
  { t: 4_000, type: 'pen', id: 'p1', t_end: 4_500, bbox: [0, 0, 10, 10] },
  { t: 8_000, type: 'track', track: 'main', kind: 'browser', label: 'built-in browser', video: 'recording.webm' },
  { t: 9_000, type: 'nav', url: 'http://localhost:3000/done', title: 'Done' }
]

describe('切り替えの時刻から指摘の対象を引く', () => {
  it('その時刻に映していたトラック。1本だけの録画では null', () => {
    expect(activeTrackAt(switching, 1_000)).toMatchObject({ track: 'main' })
    expect(activeTrackAt(switching, 5_000)).toMatchObject({ track: 't2', label: 'Acme' })
    expect(activeTrackAt(switching, 8_500)).toMatchObject({ track: 'main' })
    expect(activeTrackAt([switching[0]!, switching[1]!], 1_000)).toBeNull()
  })

  it('デスクトップアプリを映していた指摘には、内蔵ブラウザの URL・要素・操作を付けず、映していたものを付ける', () => {
    expect(buildItemContext(switching, 4_500, ['p1'])).toEqual({ source: { track: 't2', kind: 'window', label: 'Acme' } })
    expect(buildItemContext(switching, 2_500)).toMatchObject({ url: 'http://localhost:3000/login' })
    expect(buildItemContext(switching, 9_500)).toMatchObject({ url: 'http://localhost:3000/done' })
  })

  it('1本だけの録画（切り替えなし）は今までどおり', () => {
    const single = switching.filter((e) => !(e.type === 'track' && e.track === 't2'))
    expect(buildItemContext(single, 4_500)).not.toHaveProperty('source')
  })

  it('整理（LLM）に渡す対象の区切りに、映していたウインドウも入れる', () => {
    const index = buildTargetIndex(switching, { durationMs: 12_000 })
    expect(index.spans.map((s) => [s.kind, s.label])).toEqual([['url', 'localhost:3000/login'], ['window', 'Acme'], ['url', 'localhost:3000/done']])
    expect(index.at(5_000)).toBe('T2')
    expect(index.at(8_500)).toBe('T1')
    expect(index.at(9_500)).toBe('T3')
  })

  it('指摘をまとめるとき、映していたウインドウの指摘はウインドウの対象にまとめる', () => {
    const items = [{ url: 'http://localhost:3000/login' }, { source: { label: 'Acme' } }, { source: { label: 'Acme' } }]
    const groups = groupByTarget(items, (it) => it.url, [], (it) => it.source)
    expect(groups.map((g) => [g.target.kind, g.target.name, g.items.length])).toEqual([['url', '/login', 1], ['window', 'Acme', 2]])
  })
})

describe('feedback.md', () => {
  it('ウインドウの指摘は対象の節に分け、映していたものを書く', async () => {
    const { renderFeedbackMarkdown } = await import('../../src/main/pipeline/feedback')
    const item = (n: number, context: FeedbackItem['context']): FeedbackItem => ({ id: `i${n}`, index: n, t: n * 1000, title: `Finding ${n}`, request: `Fix ${n}`, status: 'decided', quotes: [],
      images: [], frameTimes: [], contextTime: n * 1000, context, draftIds: [], annotationIds: [], include: true })
    const doc: FeedbackDocument = { meta: { id: '20261005-100000', startedAt: '2026-10-05T10:00:00+09:00', durationMs: 12_000, targetUrl: 'http://localhost:3000/login', twoSpeakers: false },
      items: [item(1, { url: 'http://localhost:3000/login' }), item(2, { source: { track: 't2', kind: 'window', label: 'Acme `x`' } })], dropped: [], organizedByLlm: true }
    const md = renderFeedbackMarkdown(doc, { locale: 'en' })
    expect(md).toContain('## Target 2: Acme')
    expect(md).toContain('- Kind: an app window or screen recorded alongside the built-in browser.')
    expect(md).toContain('- Shown: Acme')
    expect(md).not.toContain('`x`')
  })
})
