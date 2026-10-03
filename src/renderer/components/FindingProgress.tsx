import { useState, type Ref } from 'react'
import { Ban, Check, CheckCircle2, Circle, CircleDot, Eye, MessageCircleQuestion, MessageSquare, Send, X } from 'lucide-react'
import { countProgress, lastVerdict, type FindingProgress, type ProgressEntry, type ProgressMap, type ReviewVerdict } from '@shared/findingProgress'
import { REPLY_MAX } from '@shared/agentPrompt'
import type { TranslationKey } from '@shared/i18n'
import { Button, Tooltip } from '../ui'
import { useT } from '../lib/i18n'

/**
 * Findings の進み具合（未対応・対応中・人の確認待ち・完了・Agent からの確認）。ReviewFindings から使う。
 * 値は progress.json（Agent と利用者のどちらも書く。@shared/findingProgress）。旗（要確認）とは別物
 */

const LABEL: Record<FindingProgress, TranslationKey> = {
  todo: 'review.progress.todo',
  in_progress: 'review.progress.inProgress',
  done: 'review.progress.done',
  needs_human: 'review.progress.needsHuman',
  human_review: 'review.progress.humanReview'
}
const ICON = { todo: Circle, in_progress: CircleDot, done: CheckCircle2, needs_human: MessageCircleQuestion, human_review: Eye } as const

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

/** ヘッダーの「2 / 5 done · 3 to review · 1 needs you」と細い進捗バー。Agent へ送る指摘だけを数え、done は人が OK したものだけ */
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
      {count.humanReview > 0 && <span className="rv-progress-sum__review" data-testid="review-progress-human-review">
        <Eye size={12} strokeWidth={2.25} aria-hidden="true" />{t('review.progress.summaryHumanReview', { count: count.humanReview })}
      </span>}
      {count.needsHuman > 0 && <span className="rv-progress-sum__ask" data-testid="review-progress-needs-human">
        <MessageCircleQuestion size={12} strokeWidth={2.25} aria-hidden="true" />{t('review.progress.summaryNeedsHuman', { count: count.needsHuman })}
      </span>}
      <span className="rv-progress-sum__bar" role="progressbar" aria-valuemin={0} aria-valuemax={count.total} aria-valuenow={count.done}
        aria-label={t('review.progress.summary', { done: count.done, total: count.total })}>
        <span className="rv-progress-sum__done" style={{ width: pct(count.done) }} />
        <span className="rv-progress-sum__review-bar" style={{ width: pct(count.humanReview) }} />
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

const VERDICT_LABEL: Record<ReviewVerdict, TranslationKey> = { ok: 'review.verdict.ok', ng: 'review.verdict.ng', comment: 'review.verdict.comment' }

/**
 * 「Agent が直しました。確認してください」（human_review）。人が OK（完了）/ NG（コメントつきで差し戻し）/ Comment（判断せずにメモ）を付ける。
 * NG と Comment は本文が必須。⌘Enter / Ctrl+Enter は Comment ではなく NG（差し戻し）として送る。BEFORE / AFTER の画像は ReviewShots が出す
 */
export function VerdictPanel({ n, entry, busy, onVerdict, inputRef }: {
  n: number
  entry: ProgressEntry
  busy?: boolean
  onVerdict: (verdict: ReviewVerdict, text?: string) => Promise<boolean>
  /** 確認モードで N を押したときに、ここへ入力を移す */
  inputRef?: Ref<HTMLTextAreaElement>
}) {
  const t = useT()
  const [body, setBody] = useState('')
  const last = entry.history?.at(-1)
  const submit = (verdict: ReviewVerdict) => void onVerdict(verdict, verdict === 'ok' ? body.trim() || undefined : body.trim()).then((ok) => ok && setBody(''))
  return <div className="rv-verdict" role="group" aria-label={t('review.verdict.title')} data-testid={`review-verdict-${n}`}>
    <p className="rv-verdict__title"><Eye size={14} strokeWidth={2.25} aria-hidden="true" />{t('review.verdict.title')}</p>
    {entry.note && <p className="rv-verdict__note">{entry.note}</p>}
    {last && <p className="rv-verdict__last">{t('review.verdict.last', { verdict: t(VERDICT_LABEL[last.verdict]) })}{last.text ? ` — ${last.text}` : ''}</p>}
    <textarea ref={inputRef} className="rv-verdict__input" aria-label={t('review.verdict.label', { n })} placeholder={t('review.verdict.placeholder')}
      value={body} maxLength={REPLY_MAX} rows={2} disabled={busy} onChange={(e) => setBody(e.target.value)} data-testid={`review-verdict-input-${n}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) { e.preventDefault(); submit('ng') }
        // 確認モードの Esc（終了）より先に、入力欄から抜けるだけにする
        if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur() }
      }} />
    <div className="rv-verdict__actions">
      <Tooltip side="bottom" label={t('review.verdict.okTip')}>
        <Button variant="default" className="rv-verdict__ok" icon={<Check size={13} />} disabled={busy} data-testid={`review-verdict-ok-${n}`} onClick={() => submit('ok')}>{t('review.verdict.ok')}</Button>
      </Tooltip>
      <Tooltip side="bottom" label={t('review.verdict.ngTip')}>
        <Button variant="default" className="rv-verdict__ng" icon={<X size={13} />} disabled={busy || !body.trim()} data-testid={`review-verdict-ng-${n}`} onClick={() => submit('ng')}>{t('review.verdict.ng')}</Button>
      </Tooltip>
      <Tooltip side="bottom" label={t('review.verdict.commentTip')}>
        <Button variant="ghost" icon={<MessageSquare size={13} />} disabled={busy || !body.trim()} data-testid={`review-verdict-comment-${n}`} onClick={() => submit('comment')}>{t('review.verdict.comment')}</Button>
      </Tooltip>
    </div>
  </div>
}

/** NG を付けて、まだ Agent へ送っていない指摘。コメントを見せ、この1件だけ送る操作を置く（まとめて送るのはヘッダー） */
export function QueuedPanel({ n, entry, busy, onSendOne }: {
  n: number
  entry: ProgressEntry
  busy?: boolean
  onSendOne: () => void
}) {
  const t = useT()
  const comment = lastVerdict(entry) === 'ng' ? entry.history?.filter((e) => e.verdict === 'ng').at(-1)?.text : undefined
  return <div className="rv-queued" data-testid={`review-queued-${n}`}>
    <span className="rv-queued__label">{t('review.verdict.queued')}</span>
    {comment && <span className="rv-queued__text">{comment}</span>}
    <Button variant="ghost" icon={<Send size={13} />} disabled={busy} data-testid={`review-queued-send-${n}`} onClick={onSendOne}>{t('review.verdict.sendOne')}</Button>
  </div>
}

/** ヘッダーの「確認する（n）」（確認待ちだけを順に見る）と「NG をまとめて送る（n）」 */
export function ReviewActions({ humanReview, queued, reviewMode, busy, onToggleReviewMode, onSendQueued }: {
  humanReview: number
  queued: number
  reviewMode: boolean
  busy?: boolean
  onToggleReviewMode: () => void
  onSendQueued: () => void
}) {
  const t = useT()
  if (!humanReview && !queued && !reviewMode) return null
  return <div className="rv-review-actions">
    {(humanReview > 0 || reviewMode) && <Tooltip side="bottom" label={t('review.reviewMode.tip')}>
      <Button variant={reviewMode ? 'default' : 'ghost'} icon={<Eye size={13} />} aria-pressed={reviewMode} data-testid="review-mode-toggle" onClick={onToggleReviewMode}>
        {reviewMode ? t('review.reviewMode.exit') : t('review.reviewMode.open', { count: humanReview })}
      </Button>
    </Tooltip>}
    {queued > 0 && <Tooltip side="bottom" label={t('review.verdict.sendBatchTip')}>
      <Button variant="default" icon={<Send size={13} />} disabled={busy} data-testid="review-send-ng" onClick={onSendQueued}>{t('review.verdict.sendBatch', { count: queued })}</Button>
    </Tooltip>}
  </div>
}

