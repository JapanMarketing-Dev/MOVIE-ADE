import { describe, expect, it } from 'vitest'
import { fakeCapturePath, parseFakeCapture } from '../../src/main/recording/fakeCapture'

/**
 * E2E の偽の画面・ウインドウ（src/main/recording/fakeCapture.ts）。
 * 製品の起動（ADE_E2E が無い）では決して有効にならず、OS の画面収録の代わりに使う一覧の形を確かめる
 */
describe('fakeCapturePath', () => {
  it('ADE_E2E=1 と ADE_E2E_FAKE_CAPTURE の両方があるときだけパスを返す', () => {
    expect(fakeCapturePath({ ADE_E2E: '1', ADE_E2E_FAKE_CAPTURE: '/tmp/x.json' })).toBe('/tmp/x.json')
    expect(fakeCapturePath({ ADE_E2E_FAKE_CAPTURE: '/tmp/x.json' })).toBeNull()
    expect(fakeCapturePath({ ADE_E2E: '0', ADE_E2E_FAKE_CAPTURE: '/tmp/x.json' })).toBeNull()
    expect(fakeCapturePath({ ADE_E2E: '1', ADE_E2E_FAKE_CAPTURE: '  ' })).toBeNull()
    expect(fakeCapturePath({ ADE_E2E: '1' })).toBeNull()
  })
})

describe('parseFakeCapture', () => {
  it('許可と画面・ウインドウを読む。サムネイルは付けない', () => {
    const parsed = parseFakeCapture(JSON.stringify({ screenAccess: 'denied', sources: [
      { id: 'window:9001:0', kind: 'window', name: 'Acme Desktop', appName: 'Acme', bundleId: 'com.acme.Desktop', thumbnail: 'data:x' },
      { id: 'screen:1:0', kind: 'screen', name: 'Screen 1' }
    ] }))
    expect(parsed.screenAccess).toBe('denied')
    expect(parsed.sources).toEqual([
      { id: 'window:9001:0', kind: 'window', name: 'Acme Desktop', thumbnail: '', appName: 'Acme', bundleId: 'com.acme.Desktop' },
      { id: 'screen:1:0', kind: 'screen', name: 'Screen 1', thumbnail: '' }
    ])
  })

  it('形の違う ID・種類は落とし、壊れた JSON・知らない許可は「許可あり・何も無い」', () => {
    expect(parseFakeCapture(JSON.stringify({ sources: [{ id: 'tab:1', kind: 'window', name: 'x' }, { id: 'window:1:0', kind: 'tab', name: 'y' }, null] })))
      .toEqual({ screenAccess: 'granted', sources: [] })
    expect(parseFakeCapture('{"sources": [')).toEqual({ screenAccess: 'granted', sources: [] })
    expect(parseFakeCapture(JSON.stringify({ screenAccess: 'maybe' })).screenAccess).toBe('granted')
  })
})
