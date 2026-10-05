/**
 * 操作ログから指摘の文脈を機械的に組み立てる（EXT-4）。
 * URL・ページタイトル・表示幅・指した要素・直前の操作は **LLM に書かせない**（設計5章④）。
 */
import type {
  Annotation,
  ClickEvent,
  ElementRef,
  Event,
  ItemContext,
  NavEvent,
  ViewportEvent,
} from './types'
import { activeTrackAt } from '@shared/captureTracks'
import { isAnnotation } from './types'
// 直前の操作は feedback.md に入る。時刻を t と呼ぶ関数があるので別名にする
import { t as translateMessage } from '@shared/i18n'

interface ContextOptions {
  /** 直前のクリックを要素として採用する許容幅(ms) */
  clickWindowMs: number;
  /** 「直前の操作」として拾う遡り幅(ms) */
  priorOpsWindowMs: number
}

const defaultContextOptions: ContextOptions = {
  clickWindowMs: 15_000,
  priorOpsWindowMs: 60_000,
};

/**
 * @param t 指摘の代表時刻
 * @param annotationIds 指摘に紐づくペンのID（要素の特定に優先して使う）
 */
export function buildItemContext(
  events: Event[],
  t: number,
  annotationIds: string[] = [],
  options: Partial<ContextOptions> = {},
): ItemContext {
  const opt = { ...defaultContextOptions, ...options }
  const sorted = [...events].sort((a, b) => a.t - b.t)

  // 複数の映像を録って切り替えた録画で、内蔵ブラウザ以外を映していた時刻の指摘。内蔵ブラウザの URL・要素・操作は付けない
  const track = activeTrackAt(sorted, t)
  if (track?.type === 'track' && track.kind !== 'browser') {
    return { source: { track: track.track, kind: track.kind, label: track.label } }
  }

  const nav = lastOfType(sorted, 'nav', t) as NavEvent | undefined
  const viewportEvent = lastOfType(sorted, 'viewport', t) as ViewportEvent | undefined
  const viewport = viewportEvent?.width ?? nav?.viewport

  const ctx: ItemContext = {}
  if (nav) {
    ctx.url = nav.url
    ctx.title = nav.title
  }
  if (viewport !== undefined) ctx.viewport = viewport

  const el = elementFor(sorted, t, annotationIds, opt.clickWindowMs)
  if (el) ctx.element = el

  const ops = describeRecentOps(sorted, t, opt.priorOpsWindowMs)
  if (ops) ctx.priorOps = ops

  return ctx
}

/** ペンが指した要素を優先。無ければ直前のクリック先 */
function elementFor(
  sorted: Event[],
  t: number,
  annotationIds: string[],
  clickWindowMs: number,
): ElementRef | undefined {
  for (const id of annotationIds) {
    const a = sorted.find((e): e is Annotation => isAnnotation(e) && e.id === id)
    if (a?.el) return a.el
  }
  const click = lastOfType(sorted, 'click', t) as ClickEvent | undefined
  if (click && t - click.t <= clickWindowMs && click.el) return click.el
  return undefined
}

/**
 * 「直前の操作」の文（EXT-4）。要件6章の例に合わせる:
 *   トップ →「料金」をクリック
 * クリックが無ければ遷移だけを書く。
 */
function describeRecentOps(sorted: Event[], t: number, windowMs: number): string | undefined {
  const click = lastOfType(sorted, 'click', t) as ClickEvent | undefined
  const nav = lastOfType(sorted, 'nav', t) as NavEvent | undefined

  const clickFresh = click !== undefined && t - click.t <= windowMs

  if (clickFresh && click) {
    // クリックした時点で開いていたページのタイトル
    const from = lastOfType(sorted, 'nav', click.t) as NavEvent | undefined
    const label = click.el?.text?.trim();
    // 要件6章の例「トップ →「料金」をクリック」に合わせ、カギ括弧の前には空白を入れない
    const target = label ? translateMessage('feedbackMd.op.clickLabel', { label }) : translateMessage('feedbackMd.op.clickPoint', { x: click.x, y: click.y });
    // クリック後にページが変わっていれば遷移元→遷移先が分かるように書く
    if (nav && from && nav.t > click.t) {
      return `${from.title} →${target} → ${nav.title}`
    }
    return from ? `${from.title} →${target}` : target.trim()
  }

  if (nav && t - nav.t <= windowMs) return translateMessage('feedbackMd.op.navigated', { title: nav.title })
  if (nav) return translateMessage('feedbackMd.op.viewing', { title: nav.title })
  return undefined
}

function lastOfType(sorted: Event[], type: Event['type'], t: number): Event | undefined {
  let found: Event | undefined
  for (const e of sorted) {
    if (e.t > t) break
    if (e.type === type) found = e
  }
  return found
}
