import { useMemo, useState } from 'react'
import { ImageOff, Maximize2, X } from 'lucide-react'
import { afterImageUrl, cardShots, sanitizeAfterPath, sanitizeDecisionScore, scoreSummary, type DecisionScore } from '@shared/afterShot'
import type { ReviewData } from '@shared/review'
import { IconButton, Modal } from '../ui'
import { useT } from '../lib/i18n'
import { NoImageArt } from './reviewArt'
import '../styles/reviewShots.css'

/**
 * Findings のカードの画像。録画時の静止画（BEFORE）と、Agent が直したあとに localhost で撮った画面（AFTER）。
 * AFTER があれば2枚を並べ、押すと大きく並べて比べる（人が一目で直ったか分かるように）。
 * AFTER が無いうちは今までどおり BEFORE だけで、押すと拡大（onZoom。カードの既存の拡大）。
 * 確認待ち・完了なのに AFTER が無ければ「AFTER がありません」と出す。判定モデルのスコアがあれば小さく出す。
 * Ferret は直ったかを判定しない。スコアは Agent が書いた、人の判断の材料。
 */
export function ReviewShots({ before, after, progress, n, time, score, onZoom, onCompare }: {
  /** BEFORE の画像（data: URL） */
  before?: string
  /** AFTER の画像（ade-media:// の URL。@shared/afterShot の afterImageUrl） */
  after?: string
  /** 指摘の進み具合（@shared/findingProgress） */
  progress: string
  n: number
  /** 指摘の時刻（「00:14」） */
  time: string
  score?: DecisionScore
  /** BEFORE だけのときの拡大。省略すると、この部品のモーダルで拡大する */
  onZoom?: (src: string) => void
  /** AFTER があるときの「大きく比べる」。省略すると、この部品のモーダルで比べる（渡すと一覧側の比べる画面で判定・前後の移動ができる） */
  onCompare?: () => void
}) {
  const t = useT()
  const [zoomed, setZoomed] = useState<string | null>(null)
  const zoom = onZoom ?? setZoomed
  // AFTER のファイルが消えた・読めないときは、AFTER が無いものとして扱う
  const [broken, setBroken] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const shots = cardShots({ before, after: after && after !== broken ? after : undefined, progress: progress === 'human_review' ? 'done' : progress })

  const single = <button type="button" className="rv-card__shot" aria-label={t('review.zoomImage', { n })} disabled={!shots.before}
    onClick={() => shots.before && zoom(shots.before)}>
    {shots.before ? <img src={shots.before} alt={t('review.imageAlt', { n })} /> : <NoImageArt />}
    <span className="rv-card__n" aria-hidden="true">{n}</span>
    <span className="rv-card__time" aria-hidden="true">{time}</span>
    {shots.before && <span className="rv-card__zoom" aria-hidden="true"><Maximize2 size={13} /></span>}
  </button>

  return <div className="rv-shots" data-testid={`review-shots-${n}`}>
    {shots.after
      ? <button type="button" className="rv-shots__pair" aria-label={t('review.shots.compare', { n })} onClick={() => onCompare ? onCompare() : setComparing(true)} data-testid="review-shots-compare">
        <span className="rv-shots__frame">
          {shots.before ? <img src={shots.before} alt={t('review.imageAlt', { n })} /> : <NoImageArt />}
          <span className="rv-shots__tag">{t('review.shots.before')}</span>
          <span className="rv-card__n" aria-hidden="true">{n}</span>
        </span>
        <span className="rv-shots__frame rv-shots__frame--after">
          <img src={shots.after} alt={t('review.shots.afterAlt', { n })} onError={() => setBroken(after ?? null)} />
          <span className="rv-shots__tag rv-shots__tag--after">{t('review.shots.after')}</span>
          <span className="rv-card__zoom" aria-hidden="true"><Maximize2 size={13} /></span>
        </span>
      </button>
      : single}
    {shots.missingAfter && <span className="rv-shots__missing" data-testid="review-shots-missing"><ImageOff size={11} aria-hidden="true" />{t('review.shots.missingAfter')}</span>}
    {score && <span className="rv-shots__score" title={t('review.shots.scoreTitle')} data-testid="review-shots-score">
      {scoreSummary(score!, t)}
    </span>}

    {zoomed && <Modal className="rv-modal" label={t('review.findingScreen')} onClose={() => setZoomed(null)}>
      <div className="rv-modal__media">
        <IconButton className="rv-modal__close" label={t('common.close')} icon={<X size={16} />} autoFocus onClick={() => setZoomed(null)} />
        <img src={zoomed} alt={t('review.zoomedAlt')} />
        <span className="rv-modal__caption"><span className="rv-card__n rv-card__n--inline">{n}</span>{t('review.findingN', { n })}</span>
      </div>
    </Modal>}

    {comparing && shots.after && <Modal className="rv-modal" label={t('review.shots.compareTitle', { n })} onClose={() => setComparing(false)}>
      <div className="rv-modal__media rv-shots__modal">
        <IconButton className="rv-modal__close" label={t('common.close')} icon={<X size={16} />} autoFocus onClick={() => setComparing(false)} />
        <div className="rv-shots__big">
          <figure>
            {shots.before ? <img src={shots.before} alt={t('review.imageAlt', { n })} /> : <NoImageArt />}
            <figcaption>{t('review.shots.before')}</figcaption>
          </figure>
          <figure>
            <img src={shots.after} alt={t('review.shots.afterAlt', { n })} />
            <figcaption className="rv-shots__caption--after">{t('review.shots.after')}</figcaption>
          </figure>
        </div>
        <span className="rv-modal__caption"><span className="rv-card__n rv-card__n--inline">{n}</span>{t('review.shots.compareTitle', { n })}</span>
      </div>
    </Modal>}
  </div>
}

const clock = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`

/**
 * レビューと指摘から ReviewShots を組み立てる（Findings のカードと確認モードで共通）。
 * AFTER と score は progress.json の値（Agent が書く）を、ここでもう一度確かめてから使う
 */
export function FindingShots({ review, item, n, onZoom, onCompare }: {
  review: Pick<ReviewData, 'id' | 'images' | 'progress'>
  item: ReviewData['document']['items'][number]
  n: number
  onZoom?: (src: string) => void
  onCompare?: () => void
}) {
  const { before, after, progress, score } = useFindingShots(review, item)
  return <ReviewShots before={before} after={after}
    progress={progress} n={n} time={clock(item.t)} {...(score ? { score } : {})} {...(onZoom ? { onZoom } : {})} {...(onCompare ? { onCompare } : {})} />
}

/**
 * 指摘の BEFORE・AFTER の画像の URL と進み具合・スコア（カードと比べる画面で共通）。
 * AFTER と score は progress.json の値（Agent が書く）を、ここでもう一度確かめてから使う
 */
export function useFindingShots(review: Pick<ReviewData, 'id' | 'images' | 'progress'>, item: ReviewData['document']['items'][number]) {
  const entry = review.progress?.[item.id] as { status?: string; after?: unknown; score?: unknown } | undefined
  const rel = sanitizeAfterPath(entry?.after)
  // progress.json が変わるたびに読み直す（同じファイル名に撮り直されても新しい画像を出す）
  const version = useMemo(() => Date.now(), [review.progress])
  const shown = item.images.find((name) => review.images[name])
  return {
    before: shown ? review.images[shown] : undefined,
    after: rel ? afterImageUrl(review.id, rel, version) : undefined,
    progress: entry?.status ?? 'todo',
    score: sanitizeDecisionScore(entry?.score)
  }
}
