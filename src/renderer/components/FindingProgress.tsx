import { useState } from 'react'
import { Ban, CheckCircle2, Circle, CircleDot, MessageCircleQuestion, Send } from 'lucide-react'
import { countProgress, type FindingProgress, type ProgressEntry, type ProgressMap } from '@shared/findingProgress'
import { REPLY_MAX } from '@shared/agentPrompt'
import type { TranslationKey } from '@shared/i18n'
import { Button, Tooltip } from '../ui'
import { useT } from '../lib/i18n'

/**
 * Findings の進み具合（未対応・対応中・完了・確認待ち）。ReviewFindings から使う。
 * 値は progress.json（Agent と利用者のどちらも書く。@shared/findingProgress）。旗（要確認）とは別物
 */

const LABEL: Record<FindingProgress, TranslationKey> = {
  todo: 'review.progress.todo',
  in_progress: 'review.progress.inProgress',
  done: 'review.progress.done',
  needs_human: 'review.progress.needsHuman'
}
const ICON = { todo: Circle, in_progress: CircleDot, done: CheckCircle2, needs_human: MessageCircleQuestion } as const

/** カードの見出しの横。押すと 未対応 → 対応中 → 完了 → 未対応（確認待ちは対応中へ） */
export function ProgressToggle({ n, progress, disabled, onChange }: {
  n: number
  progress: FindingProgress
  disabled?: boolean
  onChange: () => void
}) {
  const t = useT()
  const Icon = ICON[progress]
  const state = t(LABEL[progress])
  return <Tooltip side="top" label={t('review.progress.toggle', { n, state })}>
    <button type="button" className={`rv-progress rv-progress--${progress}`} disabled={disabled} data-testid={`review-progress-${n}`}
      aria-label={t('review.progress.toggle', { n, state })} onClick={onChange}>
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" />{state}
    </button>
  </Tooltip>
}

/** ヘッダーの「2 / 5 done · 1 needs you」と細い進捗バー。Agent へ送る指摘だけを数える */
export function ProgressSummary({ items, progress }: {
  items: ReadonlyArray<{ id: string; include: boolean }>
  progress: ProgressMap | undefined
}) {
  const t = useT()
  const count = countProgress(items, progress)
  if (count.total === 0) return null
  const pct = (n: number) => `${Math.round((n / count.total) * 100)}%`
  return <Tooltip side="bottom" label={t('review.progress.summaryTip')}>
    <span className={`rv-progress-sum${count.done === count.total ? ' is-complete' : ''}`} data-testid="review-progress-summary">
      <span className="rv-progress-sum__text">{t('review.progress.summary', { done: count.done, total: count.total })}</span>
      {count.needsHuman > 0 && <span className="rv-progress-sum__ask" data-testid="review-progress-needs-human">
        <MessageCircleQuestion size={12} strokeWidth={2.25} aria-hidden="true" />{t('review.progress.summaryNeedsHuman', { count: count.needsHuman })}
      </span>}
      <span className="rv-progress-sum__bar" role="progressbar" aria-valuemin={0} aria-valuemax={count.total} aria-valuenow={count.done}
        aria-label={t('review.progress.summary', { done: count.done, total: count.total })}>
        <span className="rv-progress-sum__done" style={{ width: pct(count.done) }} />
        <span className="rv-progress-sum__doing" style={{ width: pct(count.inProgress) }} />
        <span className="rv-progress-sum__ask-bar" style={{ width: pct(count.needsHuman) }} />
      </span>
    </span>
  </Tooltip>
}

/**
 * 「Agent から確認があります」。Agent が前提違い（録画が古い・要素が無い・矛盾・判断が要る）で人間へ戻した指摘に出す。
 * 人間はここで決める: 返答して送り直す／取り下げる（Send to Agent から外す）／撮り直す（このレビューに追加で録画）
 */
export function NeedsHumanPanel({ n, entry, busy, onReply, onWithdraw, onRerecord }: {
  n: number
  entry: ProgressEntry
  busy?: boolean
  onReply: (reply: string) => Promise<boolean>
  onWithdraw: () => void
  onRerecord?: () => void
}) {
  const t = useT()
  const [reply, setReply] = useState('')
  return <div className="rv-ask" role="group" aria-label={t('review.needsHuman.title')} data-testid={`review-needs-human-${n}`}>
    <p className="rv-ask__title"><MessageCircleQuestion size={14} strokeWidth={2.25} aria-hidden="true" />{t('review.needsHuman.title')}</p>
    <p className="rv-ask__note">{entry.note ?? t('review.needsHuman.noNote')}</p>
    {entry.reply && <p className="rv-ask__last">{t('review.needsHuman.lastReply', { reply: entry.reply })}</p>}
    <textarea className="rv-ask__reply" aria-label={t('review.needsHuman.replyLabel', { n })} placeholder={t('review.needsHuman.replyPlaceholder')}
      value={reply} maxLength={REPLY_MAX} rows={2} disabled={busy} onChange={(e) => setReply(e.target.value)}
      onKeyDown={(e) => {
        // ⌘Enter / Ctrl+Enter で送る
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim()) { e.preventDefault(); void onReply(reply.trim()).then((ok) => ok && setReply('')) }
      }} />
    <div className="rv-ask__actions">
      <Button variant="default" icon={<Send size={13} />} disabled={busy || !reply.trim()} data-testid={`review-needs-human-send-${n}`}
        onClick={() => void onReply(reply.trim()).then((ok) => ok && setReply(''))}>{t('review.needsHuman.send')}</Button>
      <Tooltip side="bottom" label={t('review.needsHuman.withdrawTip')}>
        <Button variant="ghost" icon={<Ban size={13} />} disabled={busy} data-testid={`review-needs-human-withdraw-${n}`} onClick={onWithdraw}>{t('review.needsHuman.withdraw')}</Button>
      </Tooltip>
      {onRerecord && <Tooltip side="bottom" label={t('review.needsHuman.rerecordTip')}>
        <Button variant="ghost" icon={<Circle size={10} fill="currentColor" strokeWidth={0} />} disabled={busy} onClick={onRerecord}>{t('review.needsHuman.rerecord')}</Button>
      </Tooltip>}
    </div>
  </div>
}
