/**
 * ポップアップの上の書き込み（@shared/popupAnnotation）。拡張機能のポップアップの座標をビューへ直す・閉じるか・注入スクリプトを入れるか・
 * IPC の送り主の面・ログインのポップアップから戻る先と、配線（controller・browser・index・textNotes）の不変条件を確かめる
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  annotatingNow,
  extensionPopupGetsReviewPreload,
  mapPopupBox,
  popupHost,
  popupReturnTrack,
  reviewSurfaceOf,
  shouldCloseExtensionPopup,
  type AnnotationActivity
} from '@shared/popupAnnotation'

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8')
const idle: AnnotationActivity = { capturing: false, mode: 'off', note: false }

describe('ポップアップの座標をビューの座標へ', () => {
  // ビュー 1000×700 の右上（x 672..992, y 0..240）に 320×240 のポップアップ
  const rect = { x: 672 / 1000, y: 0, width: 320 / 1000, height: 240 / 700 }

  it('ページの大きさが分からなければ、ポップアップと同じ倍率として割合から求める', () => {
    expect(mapPopupBox([10, 20, 100, 50], { width: 320, height: 240 }, rect)).toEqual({ bbox: [682, 20, 100, 50], view: { width: 1000, height: 700 } })
  })

  it('ページの大きさ（CSS px）が分かれば、その座標へ伸び縮みさせる（ページを拡大しているとき）', () => {
    expect(mapPopupBox([0, 0, 320, 240], { width: 320, height: 240 }, rect, { width: 500, height: 350 })).toEqual({ bbox: [336, 0, 160, 120], view: { width: 500, height: 350 } })
  })

  it('壊れた値は null', () => {
    expect(mapPopupBox([1, 2, 3], { width: 320, height: 240 }, rect)).toBeNull()
    expect(mapPopupBox([1, 2, 3, Number.NaN], { width: 320, height: 240 }, rect)).toBeNull()
    expect(mapPopupBox('x', { width: 320, height: 240 }, rect)).toBeNull()
    expect(mapPopupBox([1, 2, 3, 4], undefined, rect)).toBeNull()
    expect(mapPopupBox([1, 2, 3, 4], { width: 0, height: 240 }, rect)).toBeNull()
    expect(mapPopupBox([1, 2, 3, 4], { width: 320, height: 240 }, { ...rect, width: 0 })).toBeNull()
  })
})

describe('拡張機能のポップアップを閉じるか・注入スクリプトを入れるか', () => {
  it('ふだんはページ・アプリの画面・Esc で閉じる（Chrome と同じ）', () => {
    for (const cause of ['escape', 'page', 'app'] as const) expect(shouldCloseExtensionPopup(cause, idle)).toBe(true)
  })

  it('録画中に道具を選んでいる・文字で指摘の間は閉じない', () => {
    const pen = { capturing: true, mode: 'pen' as const, note: false }
    const note = { ...idle, note: true }
    for (const activity of [pen, { ...pen, mode: 'rect' as const }, note]) {
      expect(annotatingNow(activity)).toBe(true)
      for (const cause of ['escape', 'page', 'app'] as const) expect(shouldCloseExtensionPopup(cause, activity)).toBe(false)
    }
  })

  it('録画中で道具が off なら、ページと Esc では閉じ、アプリの画面（ツールバー）では閉じない', () => {
    const off = { capturing: true, mode: 'off' as const, note: false }
    expect(annotatingNow(off)).toBe(false)
    expect(shouldCloseExtensionPopup('page', off)).toBe(true)
    expect(shouldCloseExtensionPopup('escape', off)).toBe(true)
    expect(shouldCloseExtensionPopup('app', off)).toBe(false)
  })

  it('録画していない道具の値だけでは書き込み中にしない', () => {
    expect(annotatingNow({ capturing: false, mode: 'pen', note: false })).toBe(false)
  })

  it('注入スクリプトは録画中・文字で指摘の間に開いたものにだけ入れる', () => {
    expect(extensionPopupGetsReviewPreload(idle)).toBe(false)
    expect(extensionPopupGetsReviewPreload({ capturing: true, note: false })).toBe(true)
    expect(extensionPopupGetsReviewPreload({ capturing: false, note: true })).toBe(true)
  })
})

describe('書き込みの IPC の送り主', () => {
  const review = { id: 'review' }
  const overlay = { id: 'overlay' }
  it('いま書き込みを受けている面だけ', () => {
    expect(reviewSurfaceOf(review, { review, overlay })).toBe('review')
    expect(reviewSurfaceOf(overlay, { review, overlay })).toBe('overlay')
    expect(reviewSurfaceOf({ id: 'other' }, { review, overlay })).toBeNull()
    expect(reviewSurfaceOf(overlay, { review, overlay: null })).toBeNull()
    expect(reviewSurfaceOf(null, { review: null, overlay: null })).toBeNull()
    expect(reviewSurfaceOf(undefined, { review: null, overlay: null })).toBeNull()
  })
})

describe('ログインのポップアップのトラック', () => {
  it('名前はホスト名だけ（パス・クエリのログインの値を入れない）。http(s) 以外は空', () => {
    expect(popupHost('https://accounts.google.com/o/oauth2/auth?client_id=secret&state=x')).toBe('accounts.google.com')
    expect(popupHost('http://localhost:3000/login')).toBe('localhost')
    expect(popupHost('about:blank')).toBe('')
    expect(popupHost('javascript:alert(1)')).toBe('')
    expect(popupHost('not a url')).toBe('')
  })

  it('戻る先は切り替える前に映していたもの（録り続けていれば）、無ければ main', () => {
    expect(popupReturnTrack('t2', ['main', 't2'])).toBe('t2')
    expect(popupReturnTrack('t2', ['main'])).toBe('main')
    expect(popupReturnTrack(null, ['main', 't2'])).toBe('main')
  })
})

describe('配線の不変条件', () => {
  it('controller は書き込みの IPC を、いま書き込みを受けている面からだけ受ける', () => {
    const src = read('src/main/recording/controller.ts')
    for (const ch of ['ready', 'history', 'shortcut', 'event']) {
      const start = src.indexOf(`ipcMain.on(REVIEW_CHANNELS.${ch},`)
      expect(start, ch).toBeGreaterThan(0)
      expect(src.slice(start, start + 200), ch).toMatch(/this\.surfaceOf\(event\.sender\)/)
    }
    expect(src).not.toMatch(/event\.sender !== this\.reviewContents/)
    // ポップアップからは書き込みだけを、ビューの座標へ直し、要素情報を外して残す
    const overlay = src.slice(src.indexOf('private recordOverlayInjected('))
    expect(overlay).toMatch(/if \(raw\.type !== 'pen' && raw\.type !== 'erase'\) return/)
    expect(overlay).toMatch(/el: undefined/)
    expect(overlay).toMatch(/mapPopupBox\(/)
  })

  it('ログインのポップアップは同じ sandbox の窓で、内蔵ブラウザのページと同じ注入スクリプトだけを持つ', () => {
    const src = read('src/main/browser.ts')
    const options = src.slice(src.indexOf('function popupWindowOptions('), src.indexOf('/** 表示中のページが別のアプリ'))
    expect(options).toMatch(/preload: join\(__dirname, '\.\.\/preload\/review\.js'\)/)
    expect(options).toMatch(/sandbox: true/)
    expect(options).toMatch(/contextIsolation: true/)
    expect(options).toMatch(/nodeIntegration: false/)
    expect(options).toMatch(/nodeIntegrationInSubFrames: false/)
    // ポップアップの入力からページのコピーの許可は作らない（security-5 [14]）
    expect((src.match(/pageClipboard\.noteGesture\(/g) ?? []).length).toBe(1)
  })

  it('拡張機能のポップアップの注入スクリプトは、録画中・文字で指摘の間だけ index.ts が渡す', () => {
    const src = read('src/main/index.ts')
    expect(src).toMatch(/reviewPreload: \(\) => \(extensionPopupGetsReviewPreload\(annotationActivity\(\)\) \? join\(__dirname, '\.\.\/preload\/review\.js'\) : null\)/)
    expect(src).not.toMatch(/\?\.closePopup\(\) \}\)/)
  })

  it('文字で指摘はポップアップからも、焦点のあるもの（いま打っているもの）からだけ受ける', () => {
    const src = read('src/main/textNotes.ts')
    expect(src).toMatch(/const focused = popups\.find\(\(wc\) => !wc\.isDestroyed\(\) && wc\.isFocused\(\)\)/)
    expect(src).toMatch(/if \(!this\.active \|\| this\.deps\.recording\(\) \|\| sender !== this\.current\(\)\)/)
  })
})
