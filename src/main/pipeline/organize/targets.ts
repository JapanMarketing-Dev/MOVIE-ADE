/**
 * 整理（LLM）に渡す「対象ごとの区切り」と、出力の対象の検査。
 *
 * 1本の録画の中で対象（URL・ファイル）を切り替えたとき、②の下書きは対象ごとに分けている（draft.ts）。
 * ③の整理でも、違う対象の発話・書き込みを1件にまとめさせないために、
 *   - 入力の各発話・書き込み・下書きに対象の ID（T1, T2 …）を付け、targets に ID とラベルを並べる
 *   - 出力の各指摘に target（対象の ID）を必ず書かせる
 *   - 検証では、指摘の根拠（引用の時刻・書き込み）がどの対象にあるかを時刻から引き直し、
 *     target が欠けている・知らない・根拠と食い違う・根拠が複数の対象にまたがる場合は、元の区切りに戻す
 * 対象が1つだけの録画（切り替えなし・画面全体の録画）では何もしない（プロンプトも変えない）。
 */
import { targetHeading, targetOfSource, targetOfUrl, type ReviewTarget } from '@shared/reviewTarget'
import type { Event, NavEvent, SessionMeta, TrackEvent } from '../types'

interface TargetSpan {
  /** LLM に見せる ID（T1, T2 …。最初に出てきた順） */
  id: string
  /** 同じ対象かの鍵（shared/reviewTarget.ts の key） */
  key: string
  /** 人が読めるラベル（「dev · example.com/pricing」「docs/a.md」） */
  label: string
  kind: 'url' | 'file' | 'window'
  /** この対象を開いていた時間帯 [始まり, 終わり)（ms）。行き来すると複数になる */
  ranges: Array<[number, number]>
}

export interface TargetIndex {
  spans: TargetSpan[]
  /** その時刻に開いていた対象の ID。対象が1つ以下なら常に null */
  at(t: number): string | null
}

const NONE: TargetIndex = { spans: [], at: () => null }

/**
 * 遷移の記録から対象の区間を作る。最初の遷移より前（録画開始の直後）は最初の対象に含める。
 * 対象が1つ以下なら区切りは要らないので空を返す。
 */
export function buildTargetIndex(events: readonly Event[], meta: Pick<SessionMeta, 'durationMs' | 'urlPresets'>): TargetIndex {
  // 複数の映像を録って切り替えた録画では、映していたもの（track）も対象の区切りにする（内蔵ブラウザへ戻ったら直前のページ）
  const multiTrack = new Set(events.filter((e) => e.type === 'track').map((e) => (e as TrackEvent).track)).size > 1
  const timeline = events.filter((e): e is NavEvent | TrackEvent => e.type === 'nav' || (multiTrack && e.type === 'track')).sort((a, b) => a.t - b.t)
  if (timeline.length === 0) return NONE
  const spans: TargetSpan[] = []
  const byKey = new Map<string, TargetSpan>()
  const segments: Array<{ start: number; id: string }> = []
  const enter = (target: ReviewTarget, t: number): void => {
    if (target.kind === 'none') return
    let span = byKey.get(target.key)
    if (!span) {
      span = { id: `T${spans.length + 1}`, key: target.key, label: targetHeading(target), kind: target.kind, ranges: [] }
      byKey.set(target.key, span)
      spans.push(span)
    }
    const last = segments[segments.length - 1]
    if (last?.id === span.id) return
    segments.push({ start: segments.length === 0 ? 0 : t, id: span.id })
  }
  let page: ReviewTarget | null = null
  let onWindow = false
  for (const e of timeline) {
    if (e.type === 'nav') {
      page = targetOfUrl(e.url, meta.urlPresets ?? [])
      // ウインドウを映している間の内蔵ブラウザの遷移は、映していたものの区切りにしない
      if (!onWindow) enter(page, e.t)
    } else if (e.kind === 'browser') {
      onWindow = false
      if (page) enter(page, e.t)
    } else {
      onWindow = true
      enter(targetOfSource(e), e.t)
    }
  }
  if (spans.length <= 1) return NONE

  const end = Math.max(meta.durationMs, timeline[timeline.length - 1]!.t + 1)
  segments.forEach((segment, i) => {
    const until = segments[i + 1]?.start ?? end
    spans.find((s) => s.id === segment.id)!.ranges.push([segment.start, until])
  })
  return {
    spans,
    at(t: number) {
      let id = segments[0]!.id
      for (const segment of segments) {
        if (segment.start > t) break
        id = segment.id
      }
      return id
    }
  }
}
