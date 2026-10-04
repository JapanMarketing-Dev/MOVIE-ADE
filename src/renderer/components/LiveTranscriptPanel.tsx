import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDown } from 'lucide-react'
import {
  formatLiveTime, liveStatusLine, liveTranscriptProblem,
  type LiveTranscriptSegment, type LiveTranscriptStatus
} from '@shared/liveTranscript'
import { useT } from '../lib/i18n'
import { Segmented, Spinner } from '../ui'

export type FeedbackSideTab = 'targets' | 'transcript'

/**
 * フィードバックの右パネルの上のタブ（レビュー対象 | 文字起こし）。
 * 文字起こしに問題があれば、タブに警告の印を付ける
 */
export function FeedbackSideTabs({ value, onChange, alert }: { value: FeedbackSideTab; onChange: (tab: FeedbackSideTab) => void; alert: boolean }) {
  const t = useT()
  return <Segmented<FeedbackSideTab>
    className="fb-side-tabs"
    ariaLabel={t('liveTranscript.tabs')}
    value={value}
    onChange={onChange}
    options={[
      { value: 'targets', label: t('feedbackTargets.title'), testId: 'feedback-side-tab-targets' },
      { value: 'transcript', label: t('liveTranscript.tab'), testId: 'feedback-side-tab-transcript',
        ...(alert ? { icon: <AlertTriangle className="fb-side-tabs__alert" size={12} strokeWidth={2} aria-label={t('liveTranscript.alert')} />, title: t('liveTranscript.alert') } : {}) }
    ]}
  />
}

/**
 * 録画中の文字起こし（右パネルの「文字起こし」タブ）。
 * 上の1行で今の状態（文字起こし中・◯件待ち・止まっています: 理由）を出し、下に発話を時刻つきで並べる。
 * 一番下を見ている間は新しい発話へ自動で送る。上へ戻って読んでいる間は送らず「最新へ」を出す
 */
export function LiveTranscriptPanel({ status, segments, head, hidden }: {
  status: LiveTranscriptStatus
  segments: readonly LiveTranscriptSegment[]
  /** パネルの頭（タブ） */
  head: ReactNode
  hidden?: boolean
}) {
  const t = useT()
  const list = useRef<HTMLOListElement>(null)
  const [follow, setFollow] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const count = useRef(0)

  // 一番下にいれば新しい発話へ送る
  useLayoutEffect(() => {
    const grew = segments.length > count.current
    count.current = segments.length
    const el = list.current
    if (!el || !grew) return
    if (follow) el.scrollTop = el.scrollHeight
    else setUnseen(true)
  }, [segments, follow])
  // 隠れている間に増えた分は、見えたときに一番下へ
  useEffect(() => {
    if (!hidden && follow && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [hidden, follow])

  const onScroll = () => {
    const el = list.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setFollow(atBottom)
    if (atBottom) setUnseen(false)
  }
  const jump = () => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
    setFollow(true)
    setUnseen(false)
  }

  const { line, tone } = liveStatusLine(status)
  const lineText = line === 'working' ? t('liveTranscript.status.working', { n: status.pending })
    : line === 'error' ? t('liveTranscript.status.error', { message: status.message ?? '' })
    : line === 'unavailable' ? t('liveTranscript.status.unavailable', { message: status.message ?? '' })
    : line === 'done' ? t('liveTranscript.status.done', { n: status.done })
    : t(`liveTranscript.status.${line}`)
  const problem = liveTranscriptProblem(status)
  const warning = problem === 'stalled' || problem === 'micSilent' ? t(`liveTranscript.warning.${problem}`) : null

  return (
    <aside className="fb-targets fb-live" aria-label={t('liveTranscript.tab')} data-testid="live-transcript" hidden={hidden}>
      <header className="fb-targets__head">{head}</header>
      <div className={`fb-live__status fb-live__status--${tone}`} role="status" aria-live="polite" data-testid="live-transcript-status">
        {tone === 'busy' ? <Spinner size={12} /> : <span className="fb-live__dot" aria-hidden="true" />}
        <span className="fb-live__status-text">{lineText}</span>
      </div>
      {status.failed > 0 && <p className="fb-live__alert" data-testid="live-transcript-failed">{t('liveTranscript.failed', { n: status.failed })}</p>}
      {warning && <p className="fb-live__alert" role="alert" data-testid="live-transcript-warning"><AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />{warning}</p>}
      <ol className="fb-live__list" ref={list} onScroll={onScroll} data-testid="live-transcript-list">
        {segments.length === 0 && <li className="fb-live__empty">{status.active ? t('liveTranscript.empty') : t('liveTranscript.status.off')}</li>}
        {segments.map((seg) => (
          <li key={`${seg.source}-${seg.t0}-${seg.text.length}`} className="fb-live__seg" data-source={seg.source}>
            <span className="fb-live__meta">
              <time className="fb-live__time">{formatLiveTime(seg.t0)}</time>
              {status.twoSpeakers && <span className="fb-live__who">{t(seg.source === 'system' ? 'feedbackMd.speaker.other' : 'feedbackMd.speaker.self')}</span>}
            </span>
            <span className="fb-live__text">{seg.text}</span>
          </li>
        ))}
      </ol>
      {unseen && !follow && <button type="button" className="fb-live__jump" onClick={jump}><ArrowDown size={12} aria-hidden="true" />{t('liveTranscript.jumpLatest')}</button>}
    </aside>
  )
}
