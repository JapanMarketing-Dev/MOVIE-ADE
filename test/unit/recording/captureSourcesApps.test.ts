import { describe, expect, it } from 'vitest'
import { displayIdOfScreen, sortScreensByDisplay, withMissingDisplays } from '../../../src/shared/captureSources'
import {
  appNameFromPath,
  dedupeApps,
  filterApps,
  isStartMenuNoise,
  macOpenArgs,
  matchLaunchedWindow,
  parseBundleId,
  parseDesktopEntry,
  plutilBundleIdArgs
} from '../../../src/shared/desktopAppCatalog'
import type { CaptureSourceInfo, DesktopAppInfo } from '../../../src/shared/types'

const display = (id: number, width = 1920, height = 1080) => ({ id, size: { width, height } })
const screenSource = (id: string, displayId?: string): CaptureSourceInfo => ({ id, kind: 'screen', name: 'Entire Screen', thumbnail: 'data:x', ...(displayId ? { displayId } : {}) })
const win = (id: number, name: string, extra: Partial<CaptureSourceInfo> = {}): CaptureSourceInfo => ({ id: `window:${id}:0`, kind: 'window', name, thumbnail: '', ...extra })

describe('画面の候補とディスプレイの対応付け', () => {
  it('display_id があればそれ、macOS は ID の数字（CGDirectDisplayID）からも分かる', () => {
    expect(displayIdOfScreen('screen:5:0', '5', 'win32')).toBe('5')
    expect(displayIdOfScreen('screen:69733382:0', undefined, 'darwin')).toBe('69733382')
    // Windows・Linux の ID は並びの番号で Display.id とは別なので決めない
    expect(displayIdOfScreen('screen:0:0', undefined, 'win32')).toBeUndefined()
    expect(displayIdOfScreen('screen:-1:0', undefined, 'darwin')).toBeUndefined()
  })

  it('macOS で一覧にメインの画面しか無ければ、ほかのディスプレイを ID から作って足す（2画面で「画面 1」しか出ない報告）', () => {
    const sources = [screenSource('screen:1:0', '1'), win(10, 'Figma')]
    const out = withMissingDisplays(sources, [display(1, 1512, 982), display(2)], 'darwin', '画面')
    expect(out.map((s) => s.id)).toEqual(['screen:1:0', 'screen:2:0', 'window:10:0'])
    expect(out[1]).toEqual({ id: 'screen:2:0', kind: 'screen', name: '画面', displayId: '2', thumbnail: '' })
  })

  it('全部あれば何も足さない。macOS 以外は足さない', () => {
    const sources = [screenSource('screen:1:0', '1'), screenSource('screen:2:0', '2')]
    expect(withMissingDisplays(sources, [display(1), display(2)], 'darwin', '画面')).toEqual(sources)
    expect(withMissingDisplays([screenSource('screen:0:0', '1')], [display(1), display(2)], 'win32', '画面')).toHaveLength(1)
  })

  it('画面はディスプレイの並び（画面 1, 2 の番号）に揃え、分からないものは後ろ、ウインドウはその後', () => {
    const sources = [win(10, 'A'), screenSource('screen:x', undefined), screenSource('screen:2:0', '2'), screenSource('screen:1:0', '1')]
    expect(sortScreensByDisplay(sources, [display(1), display(2)]).map((s) => s.id)).toEqual(['screen:1:0', 'screen:2:0', 'screen:x', 'window:10:0'])
  })
})

describe('入れてあるデスクトップアプリの一覧', () => {
  it('パスから名前を取る（.app・.lnk・.desktop、/ と \\ のどちらでも）', () => {
    expect(appNameFromPath('/Applications/Visual Studio Code.app')).toBe('Visual Studio Code')
    expect(appNameFromPath('/Applications/Utilities/Terminal.app/')).toBe('Terminal')
    expect(appNameFromPath('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Figma.lnk')).toBe('Figma')
    expect(appNameFromPath('/usr/share/applications/org.gnome.Calculator.desktop')).toBe('org.gnome.Calculator')
  })

  it('スタートメニューのアンインストール・説明書は出さない', () => {
    expect(isStartMenuNoise('Uninstall Foo')).toBe(true)
    expect(isStartMenuNoise('Foo アンインストール')).toBe(true)
    expect(isStartMenuNoise('Foo Release Notes')).toBe(true)
    expect(isStartMenuNoise('Figma')).toBe(false)
  })

  it('.desktop: 地域の名前を先に使い、隠すもの・端末で動くもの・アプリ以外は出さない', () => {
    const entry = ['[Desktop Entry]', 'Type=Application', 'Name=Calculator', 'Name[ja]=電卓', 'Exec=gnome-calculator', '', '[Desktop Action new]', 'Name=New'].join('\n')
    expect(parseDesktopEntry(entry, 'ja')).toEqual({ name: '電卓' })
    expect(parseDesktopEntry(entry, 'en')).toEqual({ name: 'Calculator' })
    expect(parseDesktopEntry('[Desktop Entry]\nName=Foo\nName[pt_BR]=Fu\nName[pt]=Fo', 'pt-BR')).toEqual({ name: 'Fu' })
    expect(parseDesktopEntry('[Desktop Entry]\nName=Hidden\nNoDisplay=true')).toBeNull()
    expect(parseDesktopEntry('[Desktop Entry]\nName=Gone\nHidden=true')).toBeNull()
    expect(parseDesktopEntry('[Desktop Entry]\nName=htop\nTerminal=true')).toBeNull()
    expect(parseDesktopEntry('[Desktop Entry]\nType=Link\nName=Docs')).toBeNull()
    expect(parseDesktopEntry('Name=No section')).toBeNull()
  })

  it('同じ名前は最初のものだけにして、名前の順に並べる', () => {
    const apps: DesktopAppInfo[] = [
      { id: '/Applications/Zed.app', name: 'Zed', path: '/Applications/Zed.app' },
      { id: '/Applications/figma.app', name: 'Figma', path: '/Applications/figma.app' },
      { id: '/Users/taro/Applications/Figma.app', name: 'figma', path: '/Users/taro/Applications/Figma.app' },
      { id: '', name: '', path: '' }
    ]
    expect(dedupeApps(apps).map((a) => a.id)).toEqual(['/Applications/figma.app', '/Applications/Zed.app'])
  })

  it('検索欄の語がすべて名前かパスに含まれるもの。名前の前方一致を先に', () => {
    const apps: DesktopAppInfo[] = ['Visual Studio Code', 'Xcode', 'Code Runner', 'Figma'].map((name) => ({ id: name, name, path: `/Applications/${name}.app` }))
    expect(filterApps(apps, '').map((a) => a.name)).toEqual(['Visual Studio Code', 'Xcode', 'Code Runner', 'Figma'])
    expect(filterApps(apps, 'code').map((a) => a.name)).toEqual(['Code Runner', 'Visual Studio Code', 'Xcode'])
    expect(filterApps(apps, 'studio CODE').map((a) => a.name)).toEqual(['Visual Studio Code'])
    expect(filterApps(apps, 'applications fig').map((a) => a.name)).toEqual(['Figma'])
  })
})

describe('アプリの起動とウインドウの照合', () => {
  it('macOS は open -a <.app> を引数の配列で（空白入りのパスも1つの引数）', () => {
    expect(macOpenArgs('/Applications/Visual Studio Code.app')).toEqual(['-a', '/Applications/Visual Studio Code.app'])
    expect(plutilBundleIdArgs('/Applications/A.app/Contents/Info.plist')).toEqual(['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/A.app/Contents/Info.plist'])
  })

  it('バンドル ID の形だけ受け取る', () => {
    expect(parseBundleId('com.microsoft.VSCode\n')).toBe('com.microsoft.VSCode')
    expect(parseBundleId('')).toBeUndefined()
    expect(parseBundleId('No value at that key path')).toBeUndefined()
    expect(parseBundleId('com.example; rm -rf /')).toBeUndefined()
  })

  it('バンドル ID が分かればそれで探す（アプリ名とウインドウの名前が違っても当たる）', () => {
    const sources = [win(1, 'main.ts — acme-shop', { appName: 'Code', bundleId: 'com.microsoft.VSCode' }), win(2, 'Visual Studio Code Docs', { appName: 'Safari', bundleId: 'com.apple.Safari' })]
    expect(matchLaunchedWindow(sources, { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' })?.id).toBe('window:1:0')
  })

  it('バンドル ID の分かるウインドウがあるのに当たらなければ、名前では選ばない', () => {
    const sources = [win(2, 'Visual Studio Code Docs', { appName: 'Safari', bundleId: 'com.apple.Safari' })]
    expect(matchLaunchedWindow(sources, { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' })).toBeNull()
  })

  it('バンドル ID が無ければ（Windows・Linux）名前で探す。画面は選ばない', () => {
    const sources: CaptureSourceInfo[] = [{ id: 'screen:1:0', kind: 'screen', name: 'Figma', thumbnail: '' }, win(3, 'Untitled - Figma')]
    expect(matchLaunchedWindow(sources, { name: 'Figma' })?.id).toBe('window:3:0')
    expect(matchLaunchedWindow(sources, { name: 'Blender' })).toBeNull()
  })

  it('起動する前からあったウインドウより、新しく開いたものを先にする。ほかに無ければ前からあるもの', () => {
    const old = win(4, 'Figma')
    const fresh = win(5, 'Figma — Design')
    expect(matchLaunchedWindow([old, fresh], { name: 'Figma' }, new Set([old.id]))?.id).toBe('window:5:0')
    expect(matchLaunchedWindow([old], { name: 'Figma' }, new Set([old.id]))?.id).toBe('window:4:0')
  })
})
