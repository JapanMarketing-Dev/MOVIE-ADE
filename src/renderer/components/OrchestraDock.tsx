import { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useT } from '../lib/i18n'
import { OrchestraComposer } from './OrchestraComposer'

export interface DockTarget {
  /** 確認リストの番号（B1 など）。プロジェクトの確認先は空 */
  key: string
  label: string
  url: string
}

/**
 * 全体のフィードバックの画面の帯（上の帯とブラウザの間）。確認リスト（human.md）とプロジェクトの確認先を並べ、押すとそのページへ移る。
 * 録画は止めないので、1回のフィードバックで全部のプロダクトを確かめられる（どのプロダクトの指摘かは、全体の Agent が URL で見分ける）。
 * 確認リストを順に開いている間は「前へ・次へ」と何番目かを出す。右端は全体への指示の欄
 */
export function OrchestraDock({ targets, currentUrl, onOpen, tour, onPrev, onNext, onEndTour }: {
  targets: readonly DockTarget[]
  currentUrl: string
  onOpen: (url: string) => void
  tour: { index: number; total: number } | null
  onPrev: () => void
  onNext: () => void
  onEndTour: () => void
}) {
  const t = useT()
  const same = (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, '')
  // 札が多いときは横に流す。開いているページの札が見えるように寄せる
  const chipsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    chipsRef.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentUrl])
  return <div className="orchestra-dock" data-testid="orchestra-dock">
    {tour && <div className="orchestra-dock__tour" data-testid="orchestra-tour">
      <button type="button" className="round-bar__btn" disabled={tour.index === 0} onClick={onPrev} aria-label={t('orchestra.tourPrev')} data-testid="orchestra-tour-prev"><ChevronLeft size={12} /></button>
      <span className="round-bar__pos" data-testid="orchestra-tour-position">{tour.index + 1}/{tour.total}</span>
      <button type="button" className="round-bar__btn" onClick={onNext} data-testid="orchestra-tour-next">{t(tour.index + 1 < tour.total ? 'orchestra.tourNext' : 'orchestra.tourFinish')}<ChevronRight size={12} /></button>
      <button type="button" className="round-bar__btn round-bar__btn--quiet" onClick={onEndTour} aria-label={t('orchestra.tourEnd')} title={t('orchestra.tourEnd')} data-testid="orchestra-tour-end"><X size={12} /></button>
    </div>}
    <div ref={chipsRef} className="orchestra-dock__chips" role="toolbar" aria-label={t('orchestra.dockLabel')}>
      {targets.map((target) => (
        <button key={target.url} type="button" className={`orchestra-dock__chip${target.key ? '' : ' orchestra-dock__chip--project'}${same(target.url, currentUrl) ? ' is-current' : ''}`} title={target.url}
          onClick={() => onOpen(target.url)} data-testid={`orchestra-chip-${target.key || target.url}`}>
          {target.key && <span className="orchestra-dock__key">{target.key}</span>}
          <span className="orchestra-dock__label">{target.label}</span>
        </button>
      ))}
    </div>
    <OrchestraComposer compact />
  </div>
}
