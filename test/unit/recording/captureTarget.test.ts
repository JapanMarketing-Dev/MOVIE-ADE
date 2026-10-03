import { describe, expect, it } from 'vitest'
import {
  captureTargetGap,
  captureTargetLabel,
  resolveCaptureTarget,
  sanitizeCaptureTarget,
  targetFromSource
} from '../../../src/shared/captureTarget'
import type { CaptureSourceInfo } from '../../../src/shared/types'
import { setLocale } from '@shared/i18n'

// 日本語の文言を確かめるテストなので、画面の言語を日本語に固定する（既定は英語）
setLocale('ja')

const screen1: CaptureSourceInfo = { id: 'screen:1:0', kind: 'screen', name: '画面 1（1512×982・メイン）', displayId: '1', thumbnail: '' }
const screen2: CaptureSourceInfo = { id: 'screen:2:0', kind: 'screen', name: '画面 2（1920×1080）', displayId: '2', thumbnail: '' }
const figma: CaptureSourceInfo = { id: 'window:101:0', kind: 'window', name: 'Figma', thumbnail: '' }
const chrome: CaptureSourceInfo = { id: 'window:202:0', kind: 'window', name: 'Google Chrome', thumbnail: '' }

describe('録画の対象を設定から読む', () => {
  it('内蔵ブラウザ・画面・ウインドウを読める', () => {
    expect(sanitizeCaptureTarget({ kind: 'browser' })).toEqual({ kind: 'browser' })
    expect(sanitizeCaptureTarget({ kind: 'screen', sourceId: 'screen:1:0', name: '画面 1', displayId: '1' }))
      .toEqual({ kind: 'screen', sourceId: 'screen:1:0', name: '画面 1', displayId: '1' })
    expect(sanitizeCaptureTarget({ kind: 'window', sourceId: 'window:101:0', name: 'Figma' }))
      .toEqual({ kind: 'window', sourceId: 'window:101:0', name: 'Figma' })
  })

  it('壊れた値は捨てる（＝内蔵ブラウザ）', () => {
    expect(sanitizeCaptureTarget(undefined)).toBeUndefined()
    expect(sanitizeCaptureTarget('screen')).toBeUndefined()
    expect(sanitizeCaptureTarget({ kind: 'tab' })).toBeUndefined()
    expect(sanitizeCaptureTarget({ kind: 'screen' })).toBeUndefined()
    // 種類と ID の接頭辞が食い違うものは使わない
    expect(sanitizeCaptureTarget({ kind: 'screen', sourceId: 'window:101:0', name: 'x' })).toBeUndefined()
  })
})

describe('覚えていた対象を、いまの候補から探す', () => {
  const sources = [screen1, screen2, figma, chrome]

  it('内蔵ブラウザはそのまま', () => {
    expect(resolveCaptureTarget({ kind: 'browser' }, sources)).toEqual({ kind: 'browser' })
  })

  it('ID が同じものを使う', () => {
    expect(resolveCaptureTarget(targetFromSource(figma), sources)).toEqual(targetFromSource(figma))
  })

  it('画面の ID が変わっていても、同じディスプレイを使う', () => {
    const saved = { kind: 'screen' as const, sourceId: 'screen:99:0', name: '古い名前', displayId: '2' }
    expect(resolveCaptureTarget(saved, sources)).toEqual(targetFromSource(screen2))
  })

  it('ウインドウの ID が変わっていても、名前が同じものが1つなら使う', () => {
    const saved = { kind: 'window' as const, sourceId: 'window:7:0', name: 'Figma' }
    expect(resolveCaptureTarget(saved, sources)).toEqual(targetFromSource(figma))
  })

  it('名前が同じウインドウが複数あるときは、取り違えないよう見つからない扱い', () => {
    const twin = { ...figma, id: 'window:303:0' }
    const saved = { kind: 'window' as const, sourceId: 'window:7:0', name: 'Figma' }
    expect(resolveCaptureTarget(saved, [...sources, twin])).toBeNull()
  })

  it('閉じられたウインドウは見つからない', () => {
    const saved = { kind: 'window' as const, sourceId: 'window:7:0', name: 'Slack' }
    expect(resolveCaptureTarget(saved, sources)).toBeNull()
  })

  it('種類が違うものは選ばない（ウインドウの ID で画面を拾わない）', () => {
    const saved = { kind: 'screen' as const, sourceId: 'window:101:0', name: 'Figma' }
    expect(resolveCaptureTarget(saved, sources)).toBeNull()
  })
})

describe('対象の名前と、指摘に書く欠け', () => {
  it('名前', () => {
    expect(captureTargetLabel({ kind: 'browser' })).toBe('内蔵ブラウザ')
    expect(captureTargetLabel(targetFromSource(screen1))).toBe('画面全体（画面 1（1512×982・メイン））')
    expect(captureTargetLabel(targetFromSource(figma))).toBe('ウインドウ「Figma」')
  })

  it('内蔵ブラウザなら欠けは無い。画面・ウインドウなら URL・要素情報・操作ログが無いと明記する', () => {
    expect(captureTargetGap({ kind: 'browser' })).toBeNull()
    const gap = captureTargetGap(targetFromSource(figma))
    expect(gap).toContain('ウインドウ「Figma」')
    expect(gap).toContain('URL')
    expect(gap).toContain('要素情報')
    expect(gap).toContain('操作ログ')
  })
})
