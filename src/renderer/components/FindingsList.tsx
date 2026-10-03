import { Clipboard, Code2, Flag, Globe, Play, Send, Trash2 } from 'lucide-react'
import { Button, EmptyState, IconButton, Stagger, Tooltip } from '../ui'
import { FindingsEmptyArt, NoImageArt } from './reviewArt'
import { SourceChips, hostOf } from './ReviewFindings'
import { useT } from '../lib/i18n'

/**
 * 指摘一覧の見本（REV-1 〜 REV-5 / OUT-1 〜 OUT-3）。
 *
 * 実データのレビューは ReviewFindings が描く。ここは部品見本とE2Eの撮影で
 * 見本データを出すときだけ使い、同じカードの見た目をそのまま使う。
 */

export interface Finding {
  n: number
  time: string
  title: string
  request: string
  quote: string
  url: string
  element: string
  speaker: '自分' | '相手'
  unresolved?: boolean
}

export function FindingsList({
  findings,
  /** どのレビューの指摘か。一覧の見出しに出す */
  sessionLabel
}: {
  findings: Finding[]
  sessionLabel?: string
}) {
  const t = useT()
  const sendable = findings.filter((f) => !f.unresolved).length

  // 実データが無いときは案内を出す（架空の指摘を出さない）
  if (findings.length === 0) {
    return (
      <div className="findings rv" data-testid="findings">
        <EmptyState
          testId="findings-empty"
          art={<FindingsEmptyArt />}
          title={t('review.listEmptyTitle')}
          description={t('review.listEmptyDescription')}
        />
      </div>
    )
  }

  return (
    <div className="findings rv" data-testid="findings">
      <header className="rv-head">
        <div className="rv-head__summary">
          <span className="rv-head__count"><strong>{findings.length}</strong>{t('review.findingsLabel', { count: findings.length })}</span>
          <span className="rv-head__meta">
            {sessionLabel ? `${sessionLabel} · ` : ''}{t('review.sendCount', { sendable, total: findings.length })}
          </span>
        </div>
        <div className="rv-head__actions">
          <div className="rv-head__tools">
            <Tooltip side="bottom" label={t('review.copyForAgent')}>
              <IconButton size="sm" label={t('review.copy')} icon={<Clipboard size={15} />} />
            </Tooltip>
          </div>
          <Button variant="primary" className="rv-send" icon={<Send size={14} />}>{t('review.sendToAgent')}</Button>
        </div>
      </header>

      <div className="rv-list">
        <Stagger>
          {findings.map((f) => (
            <article key={f.n} className={`rv-card${f.unresolved ? ' is-checking' : ''}`} data-testid={`finding-${f.n}`}>
              <div className="rv-card__shot">
                <NoImageArt />
                <span className="rv-card__n" aria-hidden="true">{f.n}</span>
                <span className="rv-card__time" aria-hidden="true">{f.time}</span>
              </div>
              <div className="rv-card__body">
                <div className="rv-card__top">
                  <h3 className="rv-card__title rv-card__title--static">{f.title}</h3>
                  {f.unresolved && <span className="rv-flag"><Flag size={11} />{t('review.needsCheck')}</span>}
                </div>
                <p className="rv-card__request rv-card__request--static">{f.request}</p>
                <p className="rv-card__quote">{t('review.quote', { text: f.quote })}</p>
                <div className="rv-card__foot">
                  <div className="rv-card__chips">
                    <SourceChips pen={false} voice text={false} other={f.speaker === '相手'} />
                    <span className="rv-chip" title={f.url}><Globe size={11} /><span>{hostOf(f.url)}</span></span>
                    <span className="rv-chip rv-chip--mono" title={f.element}><Code2 size={11} /><span>{f.element}</span></span>
                  </div>
                  <div className="rv-card__tools">
                    <Tooltip side="top" label={t('review.watchRecording')}><IconButton size="sm" label={t('review.playAtTime')} icon={<Play size={14} />} /></Tooltip>
                    <Tooltip side="top" label={t('review.delete')}><IconButton size="sm" className="rv-tool--danger" label={t('review.deleteThis')} icon={<Trash2 size={14} />} /></Tooltip>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </Stagger>
      </div>
    </div>
  )
}
