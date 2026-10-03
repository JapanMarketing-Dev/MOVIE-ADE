import type { ClickEvent, ElementRef, EraseEvent, Event, PenEvent, ScrollEvent } from '../pipeline/types'

/**
 * 注入スクリプトから届いた生のデータを、pipeline の操作ログ（`Event`）へ直す。
 *
 * Electron に依存しない純粋な処理だけを置く。IPCの受け口は controller.ts。
 * 注入側は自分のプロセスの `Date.now()` で時刻を付けるので、ここで
 * 「録画開始からのミリ秒」へ直す（`toClock`）。
 */

/** 注入スクリプトが送ってくる形。時刻は epoch ms */
export interface RawReviewEvent {
  at: number
  view?: { width: number; height: number }
  /** ペンの書き始め（書き終わりは `at`） */
  atStart?: number
  /**
   * left はページ移動に伴う確定が済んだ返事（操作ログには残さない）。
   * 画面に文字を置く機能（旧 text）は廃止した。古い注入スクリプトから届いても捨てる
   */
  type: 'click' | 'scroll' | 'pen' | 'erase' | 'pointer' | 'left'
  x?: number
  y?: number
  id?: string
  bbox?: [number, number, number, number]
  /** 四角の枠のとき 'rect' */
  shape?: unknown
  /** 動かした・元に戻した書き込みのとき、置き換える前の ID */
  replaces?: unknown
  /** erase のとき、元に戻した書き込みの ID */
  ids?: unknown
  el?: ElementRef
}

/*
 * ページから届く値の大きさの上限。クラス名や表示テキストはページが自由に決められるので、
 * 長いまま操作ログ・feedback.md・LLM の入力へ流さない（注入側でも切っている）。
 */
export const MAX_SELECTOR_LENGTH = 300
export const MAX_ELEMENT_TEXT_LENGTH = 200
export const MAX_ANNOTATION_ID_LENGTH = 80
/** erase 1件で取り消せる書き込みの数 */
export const MAX_ERASE_IDS = 50
/** 座標・大きさの絶対値の上限(px)。画面の外の極端な値で bbox を壊さない */
const MAX_COORDINATE = 100_000

function sanitizeElement(el: unknown): ElementRef | undefined {
  if (typeof el !== 'object' || el === null) return undefined
  const value = el as Partial<ElementRef>
  if (typeof value.selector !== 'string' || value.selector.length === 0) return undefined
  const selector = value.selector.slice(0, MAX_SELECTOR_LENGTH)
  if (value.sensitive) return { selector, sensitive: true }
  const text = typeof value.text === 'string' && value.text.length > 0 ? value.text.slice(0, MAX_ELEMENT_TEXT_LENGTH) : undefined
  return text ? { selector, text } : { selector }
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value))) : fallback
}

function annotationId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ANNOTATION_ID_LENGTH ? value : undefined
}

/**
 * 1件ぶんを変換する。形が合わないものは null を返して捨てる
 * （注入先はレビュー対象のページなので、壊れた値が来てもログを壊さない）。
 *
 * @param toClock epoch ms を「録画開始からのミリ秒」へ直す関数
 */
export function toLogEvent(raw: RawReviewEvent, toClock: (epochMs: number) => number): Event | null {
  if (typeof raw?.at !== 'number' || !Number.isFinite(raw.at)) return null
  const t = toClock(raw.at)
  const el = sanitizeElement(raw.el)

  switch (raw.type) {
    case 'click': {
      const event: ClickEvent = { t, type: 'click', x: number(raw.x), y: number(raw.y) }
      return el ? { ...event, el } : event
    }
    case 'scroll': {
      const event: ScrollEvent = { t, type: 'scroll', y: number(raw.y) }
      return event
    }
    case 'pen': {
      const id = annotationId(raw.id)
      if (!id || !Array.isArray(raw.bbox) || raw.bbox.length !== 4) return null
      const replaces = annotationId(raw.replaces)
      const event: PenEvent = {
        // 線は「書き始め」が指摘の時刻、「書き終わり」が画像にする時刻（EXT-3）
        t: toClock(typeof raw.atStart === 'number' && Number.isFinite(raw.atStart) ? Math.min(raw.atStart, raw.at) : raw.at),
        type: 'pen',
        id,
        t_end: t,
        bbox: [number(raw.bbox[0]), number(raw.bbox[1]), number(raw.bbox[2]), number(raw.bbox[3])],
        ...(raw.shape === 'rect' ? { shape: 'rect' as const } : {}),
        ...(replaces && replaces !== id ? { replaces } : {})
      }
      return el ? { ...event, el } : event
    }
    case 'erase': {
      const ids = Array.isArray(raw.ids) ? raw.ids.slice(0, MAX_ERASE_IDS).map(annotationId).filter((id): id is string => id !== undefined) : []
      if (ids.length === 0) return null
      const event: EraseEvent = { t, type: 'erase', ids }
      return event
    }
    default:
      return null
  }
}

/** 操作ログ1行ぶんのJSON Lines。追記のみで書く */
export function toJsonLine(event: Event): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * 画像を撮り直すべきイベントか（設計4章「ペンの確定時＋クリック時」）。
 * スクロールと遷移は定期撮影に任せる。
 */
export function shouldCaptureStill(event: Event): boolean {
  return event.type === 'click' || event.type === 'pen'
}
