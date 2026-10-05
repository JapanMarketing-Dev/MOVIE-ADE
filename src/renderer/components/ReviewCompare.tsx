import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ReviewData } from '@shared/review'
import type { ProgressEntry, ReviewVerdict } from '@shared/findingProgress'
import type { CompareNav } from '@shared/compareNav'
import { Button, IconButton, Modal, Tooltip } from '../ui'
import { useT } from '../lib/i18n'
import { NoImageArt } from './reviewArt'
import { useFindingShots } from './ReviewShots'
import { VerdictPanel } from './FindingProgress'

type FeedbackItem = ReviewData['document']['items'][number]

/**
 * 「指摘 n: BEFORE と AFTER」を大きく比べる画面。確認待ち（human_review）なら画像の下で OK / NG / コメントを付けられ、
 * 付けると次の確認待ちへ進む（進め方は ReviewFindings と @shared/compareNav）。前後へは ← / → でも動ける。
 * キー: ← / ↑ / k = 前、→ / ↓ / j = 次、O = OK、N = コメント欄へ（Enter・⌘/Ctrl+Enter で NG として Agent へ送る）、Esc = 閉じる（入力欄では抜けるだけ）。入力中はキーを奪わない
 */
export function ReviewCompare({ review, item, n, nav, awaiting, busy, onGo, onVerdict, onClose }: {
  review: Pick<ReviewData, 'id' | 'images' | 'progress'>
  item: FeedbackItem
  n: number
  nav: CompareNav
  /** この指摘が確認待ちか（判定の欄を出すか） */
  awaiting: boolean
  busy: boolean
  onGo: (id: string) => void
  /** sendNow: NG をその場で Agent へ送る（Enter） */
  onVerdict: (verdict: ReviewVerdict, text?: string, sendNow?: boolean) => Promise<boolean>
  onClose: () => void
}) {
  const t = useT()
  const shots = useFindingShots(review, item)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const entry = review.progress?.[item.id] as ProgressEntry | undefined
  const showVerdict = awaiting && !!entry
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'k') && nav.prev) { e.preventDefault(); onGo(nav.prev) }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'j') && nav.next) { e.preventDefault(); onGo(nav.next) }
      else if (e.key === 'o' && showVerdict && !busy) { e.preventDefault(); void onVerdict('ok') }
      else if (e.key === 'n' && showVerdict) { e.preventDefault(); inputRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const position = nav.index >= 0 && nav.list.length > 1
    ? t(nav.awaiting ? 'review.compare.positionAwaiting' : 'review.compare.position', { index: nav.index + 1, total: nav.list.length })
    : null
  return <Modal className="rv-modal" label={t('review.shots.compareTitle', { n })} onClose={onClose}>
    <div className="rv-modal__media rv-shots__modal rv-compare" data-testid="review-compare">
      <IconButton className="rv-modal__close" label={t('common.close')} icon={<X size={16} />} autoFocus onClick={onClose} />
      <div className="rv-shots__big">
        <figure>
          {shots.before ? <img src={shots.before} alt={t('review.imageAlt', { n })} /> : <NoImageArt />}
          <figcaption>{t('review.shots.before')}</figcaption>
        </figure>
        <figure>
          {shots.after ? <img src={shots.after} alt={t('review.shots.afterAlt', { n })} /> : <NoImageArt />}
          <figcaption className="rv-shots__caption--after">{t('review.shots.after')}</figcaption>
        </figure>
      </div>
      <div className="rv-compare__bar">
        <Tooltip side="top" label={t('review.compare.prev')}>
          <IconButton label={t('review.compare.prev')} icon={<ChevronLeft size={16} />} disabled={!nav.prev} data-testid="review-compare-prev" onClick={() => nav.prev && onGo(nav.prev)} />
        </Tooltip>
        <span className="rv-modal__caption"><span className="rv-card__n rv-card__n--inline">{n}</span>{t('review.shots.compareTitle', { n })}</span>
        {position && <span className="rv-compare__position" data-testid="review-compare-position">{position}</span>}
        <Tooltip side="top" label={t('review.compare.next')}>
          <IconButton label={t('review.compare.next')} icon={<ChevronRight size={16} />} disabled={!nav.next} data-testid="review-compare-next" onClick={() => nav.next && onGo(nav.next)} />
        </Tooltip>
      </div>
      {/* 確認待ちのときだけ判定の欄を出す。指摘が変わったら入力を空にする（key） */}
      {showVerdict && <div className="rv-compare__verdict">
        <VerdictPanel key={item.id} n={n} entry={entry} busy={busy} onVerdict={onVerdict} inputRef={inputRef} />
      </div>}
      <span className="rv-compare__keys">{t('review.compare.keys')}</span>
    </div>
  </Modal>
}

/** 確認待ちをすべて片付けたあと。閉じるだけ */
export function ReviewCompareDone({ onClose }: { onClose: () => void }) {
  const t = useT()
  return <Modal className="rv-modal" label={t('review.compare.done')} onClose={onClose}>
    <div className="rv-modal__panel rv-compare__done" role="status" data-testid="review-compare-done">
      <p className="rv-modal__empty">{t('review.compare.done')}</p>
      <Button variant="default" autoFocus data-testid="review-compare-done-close" onClick={onClose}>{t('common.close')}</Button>
    </div>
  </Modal>
}
