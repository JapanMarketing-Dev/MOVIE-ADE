import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  deviceKindOf,
  emulatorPortOf,
  groupByApp,
  isExtraAppWindow,
  matchSimulator,
  parseAdbDevices,
  parseAndroidFocus,
  parseAvdName,
  parseMacWindowList,
  parseSimctlBooted,
  windowNumberOf,
  withAppWindows,
  type MacWindowInfo
} from '../../../src/shared/desktopApps'
import { captureTargetGap, captureTargetLabel, captureTargetLines, resolveCaptureTarget, sanitizeCaptureTarget, targetFromSource } from '../../../src/shared/captureTarget'
import { adbCandidates } from '../../../src/main/recording/devices'
import type { CaptureSourceInfo } from '../../../src/shared/types'
import { setLocale } from '@shared/i18n'

setLocale('ja')

const OWN_PID = 4242
const win = (over: Partial<MacWindowInfo>): MacWindowInfo => ({ id: 1, layer: 0, owner: 'Electron', pid: 100, name: 'Setup', width: 360, height: 240, sharing: 1, alpha: 1, ...over })

describe('macOS のウインドウの一覧を読む', () => {
  it('JXA の JSON を型どおりに読み、壊れた項目と壊れた JSON は捨てる', () => {
    const json = JSON.stringify([
      { id: 16340, layer: 3, owner: 'Electron', pid: 100, name: 'Setup', w: 360, h: 240, sharing: 1, alpha: 1 },
      { id: 'x', layer: 0 },
      null,
      { id: 7, layer: 0, owner: 'Finder', pid: 1, name: '', w: 800, h: 600 }
    ])
    expect(parseMacWindowList(json)).toEqual([
      win({ id: 16340, layer: 3 }),
      { id: 7, layer: 0, owner: 'Finder', pid: 1, name: '', width: 800, height: 600, sharing: 1, alpha: 1 }
    ])
    expect(parseMacWindowList('')).toEqual([])
    expect(parseMacWindowList('{"a":1}')).toEqual([])
  })

  it('常に手前のウインドウ（alwaysOnTop・パネル）は足す。OS の部品・自分・見せない設定・小さいもの・題名の無いものは足さない', () => {
    expect(isExtraAppWindow(win({ layer: 3 }), OWN_PID)).toBe(true)
    expect(isExtraAppWindow(win({ layer: 8, owner: 'Simulator', name: 'iPhone 16 Pro' }), OWN_PID)).toBe(true)
    // layer 0 は desktopCapturer が出す
    expect(isExtraAppWindow(win({ layer: 0 }), OWN_PID)).toBe(false)
    // Dock・メニューバー・ステータス項目・カーソル
    expect(isExtraAppWindow(win({ layer: 20 }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 25, owner: 'Control Center', name: 'Item-0' }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 3, owner: 'Window Server', name: 'Cursor' }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 3, pid: OWN_PID }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 3, sharing: 0 }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 3, alpha: 0 }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 3, width: 40, height: 30 }), OWN_PID)).toBe(false)
    expect(isExtraAppWindow(win({ layer: 3, name: ' ' }), OWN_PID)).toBe(false)
  })

  it('ウインドウの ID から CGWindowID を取る', () => {
    expect(windowNumberOf('window:16340:0')).toBe(16340)
    expect(windowNumberOf('screen:1:0')).toBeNull()
  })
})

describe('録画の候補にアプリ名を付け、手前のウインドウを足す', () => {
  const screen: CaptureSourceInfo = { id: 'screen:1:0', kind: 'screen', name: '画面 1', displayId: '1', thumbnail: '' }
  const todo: CaptureSourceInfo = { id: 'window:12:0', kind: 'window', name: 'todo.txt', thumbnail: 'data:image/png;base64,AA' }
  const sim: CaptureSourceInfo = { id: 'window:30:0', kind: 'window', name: 'iPhone 16 Pro', thumbnail: '' }
  const emu: CaptureSourceInfo = { id: 'window:31:0', kind: 'window', name: 'Android Emulator - Pixel_8_API_35:5554', thumbnail: '' }

  it('macOS: 一覧の各ウインドウにアプリ名とスマホの種類を付け、desktopCapturer が出さない手前のウインドウを後ろに足す', () => {
    const mac = [
      win({ id: 12, owner: 'TextEdit', name: 'todo.txt' }),
      win({ id: 30, owner: 'Simulator', name: 'iPhone 16 Pro' }),
      win({ id: 31, owner: 'qemu-system-aarch64', name: 'Android Emulator - Pixel_8_API_35:5554' }),
      win({ id: 16340, layer: 3, owner: 'Electron', name: 'Setup' }),
      win({ id: 99, layer: 3, owner: 'Ferret', name: 'Ferret', pid: OWN_PID }),
      win({ id: 5, layer: 25, owner: 'Control Center', name: 'Item-0', width: 38, height: 30 })
    ]
    const out = withAppWindows([screen, todo, sim, emu], mac, OWN_PID)
    expect(out).toEqual([
      screen,
      { ...todo, appName: 'TextEdit' },
      { ...sim, appName: 'Simulator', device: 'ios' },
      { ...emu, appName: 'qemu-system-aarch64', device: 'android' },
      { id: 'window:16340:0', kind: 'window', name: 'Setup', thumbnail: '', appName: 'Electron' }
    ])
  })

  it('同じウインドウを二重に足さない', () => {
    const listed: CaptureSourceInfo = { id: 'window:16340:0', kind: 'window', name: 'Setup', thumbnail: '' }
    expect(withAppWindows([listed], [win({ id: 16340, layer: 3 })], OWN_PID)).toHaveLength(1)
  })

  it('macOS 以外（一覧が空）は題名から分かる Android Emulator だけ印を付ける', () => {
    expect(withAppWindows([todo, emu], [], OWN_PID)).toEqual([todo, { ...emu, device: 'android' }])
  })

  it('同じアプリのウインドウを並べる（一覧の順を保つ）', () => {
    const a1: CaptureSourceInfo = { id: 'window:1:0', kind: 'window', name: 'A1', thumbnail: '', appName: 'A' }
    const b1: CaptureSourceInfo = { id: 'window:2:0', kind: 'window', name: 'B1', thumbnail: '', appName: 'B' }
    const a2: CaptureSourceInfo = { id: 'window:3:0', kind: 'window', name: 'A2', thumbnail: '', appName: 'A' }
    expect(groupByApp([a1, b1, a2]).map((g) => [g.appName, g.windows.map((w) => w.name)])).toEqual([['A', ['A1', 'A2']], ['B', ['B1']]])
  })
})

describe('スマホのシミュレータ／エミュレータ', () => {
  it('アプリ名と題名から種類を決める', () => {
    expect(deviceKindOf('Simulator', 'iPhone 16 Pro')).toBe('ios')
    expect(deviceKindOf(undefined, 'Android Emulator - Pixel_8_API_35:5554')).toBe('android')
    expect(deviceKindOf('qemu-system-x86_64', 'Pixel')).toBe('android')
    expect(deviceKindOf('Electron', 'Setup')).toBeUndefined()
    expect(deviceKindOf(undefined, 'Simulator')).toBeUndefined()
  })

  it('Android Emulator の題名からポートを取る', () => {
    expect(emulatorPortOf('Android Emulator - Pixel_8_API_35:5554')).toBe(5554)
    expect(emulatorPortOf('Android Emulator')).toBeNull()
  })

  it('simctl の起動中の端末を読み、題名に合う端末を選ぶ', () => {
    const json = JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
        { udid: 'A', name: 'iPhone 16', state: 'Booted' },
        { udid: 'B', name: 'iPhone 16 Pro', state: 'Booted' },
        { udid: 'C', name: 'iPad Air', state: 'Shutdown' }
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'D', name: 'Apple Watch', state: 'Booted' }]
    } })
    const booted = parseSimctlBooted(json)
    expect(booted).toEqual([
      { udid: 'A', name: 'iPhone 16', os: 'iOS 18.2' },
      { udid: 'B', name: 'iPhone 16 Pro', os: 'iOS 18.2' },
      { udid: 'D', name: 'Apple Watch', os: 'watchOS 11.0' }
    ])
    expect(matchSimulator('iPhone 16 Pro', booted)?.udid).toBe('B')
    expect(matchSimulator('iPhone 16 – iOS 18.2', booted)?.udid).toBe('A')
    expect(matchSimulator('Unknown', booted)).toBeUndefined()
    expect(matchSimulator('Unknown', booted.slice(0, 1))?.udid).toBe('A')
    expect(parseSimctlBooted('not json')).toEqual([])
  })

  it('adb の出力を読む（端末の一覧・AVD 名・前面のアプリ）', () => {
    expect(parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tunauthorized\n\n')).toEqual(['emulator-5554'])
    expect(parseAvdName('Pixel_8_API_35\r\nOK\r\n')).toBe('Pixel_8_API_35')
    expect(parseAvdName('OK\n')).toBeUndefined()
    expect(parseAndroidFocus('  mCurrentFocus=Window{1a2b3c u0 com.example.shop/com.example.shop.MainActivity}\n')).toBe('com.example.shop')
    expect(parseAndroidFocus('  mFocusedApp=ActivityRecord{9f u0 com.example.app/.Main t12}')).toBe('com.example.app')
    expect(parseAndroidFocus('mCurrentFocus=null')).toBeUndefined()
  })

  it('adb を探す場所は SDK の platform-tools の絶対パス', () => {
    expect(adbCandidates('darwin', {}, '/Users/dev')).toEqual([join('/Users/dev', 'Library', 'Android', 'sdk', 'platform-tools', 'adb')])
    expect(adbCandidates('linux', { ANDROID_HOME: '/opt/android' }, '/home/dev')).toEqual([
      join('/opt/android', 'platform-tools', 'adb'), join('/home/dev', 'Android', 'Sdk', 'platform-tools', 'adb')])
    expect(adbCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'C:\\Users\\dev')).toEqual([
      join('C:\\Users\\dev\\AppData\\Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe')])
  })
})

describe('デスクトップアプリ・スマホの録画の対象', () => {
  const setup: CaptureSourceInfo = { id: 'window:16340:0', kind: 'window', name: 'Setup', thumbnail: '', appName: 'Electron' }
  const other: CaptureSourceInfo = { id: 'window:17:0', kind: 'window', name: 'Setup', thumbnail: '', appName: 'Installer' }
  const sim: CaptureSourceInfo = { id: 'window:30:0', kind: 'window', name: 'iPhone 16 Pro', thumbnail: '', appName: 'Simulator', device: 'ios' }

  it('アプリ名と端末を覚え、壊れた端末の情報は捨てる', () => {
    expect(targetFromSource(setup)).toEqual({ kind: 'window', sourceId: 'window:16340:0', name: 'Setup', appName: 'Electron' })
    expect(sanitizeCaptureTarget({ kind: 'window', sourceId: 'window:30:0', name: 'iPhone 16 Pro', appName: 'Simulator',
      device: { platform: 'ios', name: 'iPhone 16 Pro', os: 'iOS 18.2', extra: 1 } }))
      .toEqual({ kind: 'window', sourceId: 'window:30:0', name: 'iPhone 16 Pro', appName: 'Simulator', device: { platform: 'ios', name: 'iPhone 16 Pro', os: 'iOS 18.2' } })
    expect(sanitizeCaptureTarget({ kind: 'window', sourceId: 'window:30:0', name: 'x', device: { platform: 'symbian' } }))
      .toEqual({ kind: 'window', sourceId: 'window:30:0', name: 'x' })
  })

  it('起動し直して ID が変わっても、同じアプリの同じ題名のウインドウを選ぶ（題名が同じ別アプリと取り違えない）', () => {
    const saved = { kind: 'window' as const, sourceId: 'window:1:0', name: 'Setup', appName: 'Electron' }
    expect(resolveCaptureTarget(saved, [other, setup])).toEqual(targetFromSource(setup))
  })

  it('題名が変わっても、同じアプリのウインドウが1つならそれを選ぶ。複数なら選ばない', () => {
    const saved = { kind: 'window' as const, sourceId: 'window:1:0', name: 'Old title', appName: 'Electron' }
    expect(resolveCaptureTarget(saved, [setup, other])).toEqual(targetFromSource(setup))
    const second: CaptureSourceInfo = { ...setup, id: 'window:18:0', name: 'Settings' }
    expect(resolveCaptureTarget(saved, [setup, second])).toBeNull()
  })

  it('シミュレータの端末を替えても、シミュレータのウインドウが1つならそれを選ぶ', () => {
    const saved = { kind: 'window' as const, sourceId: 'window:2:0', name: 'iPhone 15', device: { platform: 'ios' as const } }
    expect(resolveCaptureTarget(saved, [setup, sim])).toEqual(targetFromSource(sim))
  })

  it('名前と feedback.md の冒頭の行に、アプリ名・題名・端末・前面のアプリ・直すものが入る', () => {
    expect(captureTargetLabel(targetFromSource(setup))).toBe('Electron のウインドウ「Setup」')
    const device = { kind: 'window' as const, sourceId: 'window:31:0', name: 'Android Emulator - Pixel_8_API_35:5554', appName: 'qemu-system-aarch64',
      device: { platform: 'android' as const, name: 'Pixel_8_API_35', os: 'Android 15', app: 'com.example.shop' } }
    expect(captureTargetLabel(device)).toBe('Android Emulator「Pixel_8_API_35」')
    expect(captureTargetLines(device)).toEqual([
      '- 対象: Android Emulator「Pixel_8_API_35」',
      '- 端末: Pixel_8_API_35 / Android 15',
      '- 前面のアプリ: com.example.shop',
      '- 区分: スマホアプリ（Android）。このアプリのソースコードを直す。画像は端末の画面。'
    ])
    expect(captureTargetLines(targetFromSource(setup))).toEqual([
      '- 対象: Electron のウインドウ「Setup」',
      '- 区分: デスクトップアプリ。このアプリのソースコードを直す。画像はこのウインドウだけを写したもの。'
    ])
    // 端末の情報を読めなくても、シミュレータであることは書く
    expect(captureTargetLines(targetFromSource(sim))).toEqual([
      '- 対象: iOS シミュレータ「iPhone 16 Pro」',
      '- 区分: スマホアプリ（iOS）。このアプリのソースコードを直す。画像は端末の画面。'
    ])
    expect(captureTargetLines({ kind: 'browser' })).toEqual([])
    expect(captureTargetGap(targetFromSource(setup))).toContain('Electron のウインドウ「Setup」')
  })
})

describe('確認先の「録画するウインドウ」をアプリ名でも探す', () => {
  it('Simulator はアプリ名で当たる（題名は端末名）', async () => {
    const { matchWindowSource } = await import('../../../src/shared/projectTargets')
    const sim: CaptureSourceInfo = { id: 'window:30:0', kind: 'window', name: 'iPhone 16 Pro', thumbnail: '', appName: 'Simulator', device: 'ios' }
    const other: CaptureSourceInfo = { id: 'window:12:0', kind: 'window', name: 'Simulator notes.txt', thumbnail: '', appName: 'TextEdit' }
    expect(matchWindowSource([other, sim], 'Simulator')).toEqual(sim)
    expect(matchWindowSource([other, sim], 'iPhone 16')).toEqual(sim)
  })
})

describe('feedback.md の冒頭に録った対象を書く', () => {
  it('URL が無い録画では、アプリ名・端末・直すものを冒頭に書く（題名の記号は無害にする）', async () => {
    const { renderFeedbackMarkdown } = await import('../../../src/main/pipeline/feedback')
    const { assembleFromDraft } = await import('../../../src/main/pipeline/assemble')
    const { buildDraft } = await import('../../../src/main/pipeline/draft')
    const { material } = await import('../fixtures')
    const m = { ...material, meta: { ...material.meta, targetUrl: undefined }, events: material.events.filter((e) => e.type !== 'nav') }
    const doc = assembleFromDraft(m, buildDraft(m).items)
    const md = renderFeedbackMarkdown(doc, { captureTarget: { kind: 'window', sourceId: 'window:30:0', name: 'Setup `<b>`', appName: 'Electron' } })
    const head = md.split('\n').slice(0, 4).join('\n')
    expect(head).toContain('- 対象: Electron のウインドウ「Setup \\`\\<b>\\`」')
    expect(head).toContain('- 区分: デスクトップアプリ。')
    // 内蔵ブラウザの録画（URL がある）では書かない
    expect(renderFeedbackMarkdown(assembleFromDraft(material, buildDraft(material).items), { captureTarget: { kind: 'browser' } })).not.toContain('デスクトップアプリ')
  })
})

describe('ゲームのエディタ・ゲームのウインドウ', () => {
  it('Unity・Unreal・Godot のエディタをアプリ名か題名から分ける。ビルドしたゲームはエンジンを決めない', async () => {
    const { gameEngineOf } = await import('../../../src/shared/desktopApps')
    expect(gameEngineOf('Unity', 'acme-shop - SampleScene - macOS - Unity 6000.0.23f1 <Metal>')).toBe('Unity')
    expect(gameEngineOf(undefined, 'acme-shop - SampleScene - Windows - Unity 6000.0.23f1 <DX11>')).toBe('Unity')
    expect(gameEngineOf('UnrealEditor', 'acme-shop')).toBe('Unreal Engine')
    expect(gameEngineOf(undefined, 'acme-shop - Unreal Editor')).toBe('Unreal Engine')
    expect(gameEngineOf('Godot', 'acme-shop (DEBUG)')).toBe('Godot')
    expect(gameEngineOf(undefined, 'main.tscn - acme-shop - Godot Engine')).toBe('Godot')
    expect(gameEngineOf('Unity Hub', 'Unity Hub')).toBeUndefined()
    expect(gameEngineOf('AcmeGame', 'Acme Game')).toBeUndefined()
  })

  it('エディタのウインドウは feedback.md に「ゲーム（エンジンのエディタ）」と書き、ビルドしたゲームはデスクトップアプリとして書く', () => {
    expect(captureTargetLines({ kind: 'window', sourceId: 'window:5:0', name: 'acme-shop - SampleScene - macOS - Unity 6000.0.23f1 <Metal>', appName: 'Unity' })[1])
      .toBe('- 区分: ゲーム（Unity のエディタ）。このプロジェクトのゲームのコード・シーン・アセットを直す。画像はこのウインドウだけを写したもの。')
    expect(captureTargetLines({ kind: 'window', sourceId: 'window:6:0', name: 'Acme Game', appName: 'AcmeGame' })[1]).toContain('デスクトップアプリ')
  })
})
