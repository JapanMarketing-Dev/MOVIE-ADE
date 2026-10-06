import { ArrowRight, Clock, FolderOpen, Globe, RotateCw } from 'lucide-react'
import { MOBILE_PRESET, type Viewport } from '@shared/types'
import { DEV_URL_FALLBACKS, type StartUrlChoices } from '@shared/startUrls'
import { SHORTCUTS } from '../lib/shortcut'
import { Button, EmptyState, StepsArt } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 内蔵ブラウザの置き場所。
 *
 * ふだんここには何も描かない（実際の描画は main 側の WebContentsView が重なって行う）。
 * スマホ幅のときは中央に端末幅の白い下地を出し、main 側の中央寄せと位置を合わせる。
 *
 * 空状態のときだけ、この枠の中にDOMを描く。
 * ネイティブのビューはDOMの上に必ず重なるので、呼び出し側（App）が
 * `useViewBounds(..., false)` でビューを 0 サイズにして隠してから出すこと。
 */
export type SlotEmptyReason = 'no-folder' | 'no-url' | 'load-failed'

/** 開始画面で URL を短く見せる（http:// / https:// と末尾の / を落とす） */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

export function BrowserSlot({
  viewport,
  slotRef,
  empty,
  loadError,
  onOpenFolder,
  onNavigate,
  choices
}: {
  viewport: Viewport
  slotRef: (node: HTMLElement | null) => void
  /** 空状態の理由。null のときは通常どおりビューに場所を譲る */
  empty?: SlotEmptyReason | null
  /** 'load-failed' のときに出す理由 */
  loadError?: string
  onOpenFolder?: () => void
  onNavigate?: (url: string) => void
  /**
   * 開始画面の候補（@shared/startUrls の startUrlChoices）。プロジェクトに登録した URL・最近開いた URL、
   * 登録が無いときだけ localhost の補助。省略時は localhost の補助だけ
   */
  choices?: StartUrlChoices
}) {
  const t = useT()
  if (empty) {
    return (
      <div className="browser-slot browser-slot--empty" data-testid="browser-slot">
        {empty === 'no-folder' ? (
          <EmptyState
            testId="empty-no-folder"
            className="empty--hero"
            art={<StepsArt />}
            title={t('browser.openProjectTitle')}
            actions={
              <Button
                variant="primary"
                icon={<FolderOpen size={15} strokeWidth={2} />}
                onClick={onOpenFolder}
              >
                {t('browser.openFolder')}
              </Button>
            }
            hints={
              <>
                <span className="hint">
                  <kbd className="kbd">{SHORTCUTS.openFolder()}</kbd>{t('browser.hintFolder')}
                </span>
                <span className="hint">
                  <kbd className="kbd">{SHORTCUTS.toggleMode()}</kbd>{t('browser.hintMode')}
                </span>
              </>
            }
          />
        ) : empty === 'load-failed' ? (
          <EmptyState
            testId="empty-load-failed"
            className="empty--hero"
            art={<LoadFailedArt />}
            title={t('browser.loadFailedTitle')}
            description={loadError}
            actions={
              <Button
                variant="primary"
                icon={<RotateCw size={15} strokeWidth={2} />}
                onClick={() => void window.ade.invoke('browser:reload')}
              >
                {t('browser.reloadPage')}
              </Button>
            }
            hints={
              <span className="hint">
                <kbd className="kbd">{SHORTCUTS.focusUrl()}</kbd>{t('browser.hintUrl')}
              </span>
            }
          />
        ) : (
          <EmptyState
            testId="empty-no-url"
            className="empty--hero"
            art={<StepsArt active={0} />}
            title={t('browser.noUrlTitle')}
            description={t('browser.noUrlDescription')}
            actions={<StartUrls choices={choices ?? { presets: [], recent: [], fallback: [...DEV_URL_FALLBACKS] }} onNavigate={onNavigate} />}
            hints={
              <span className="hint">
                <kbd className="kbd">{SHORTCUTS.focusUrl()}</kbd>{t('browser.hintUrl')}
              </span>
            }
          />
        )}
      </div>
    )
  }

  if (viewport === 'mobile') {
    return (
      <div className="browser-slot browser-slot--mobile" ref={slotRef} data-testid="browser-slot">
        <div className="browser-slot__phone-bg" style={{ width: MOBILE_PRESET.width }} />
      </div>
    )
  }
  return <div className="browser-slot" ref={slotRef} data-testid="browser-slot" />
}

/**
 * 開始画面の候補。登録した URL（名前つきのチップ）→ 最近開いた URL（行）→ localhost の補助（チップ）の順。
 * 登録した URL も履歴も無ければ、localhost の補助だけになる（以前と同じ見た目）
 */
function StartUrls({ choices, onNavigate }: { choices: StartUrlChoices; onNavigate?: (url: string) => void }) {
  const t = useT()
  const go = <ArrowRight className="port-chip__go" size={12} strokeWidth={2} aria-hidden="true" />
  return (
    <div className="start-urls" data-testid="start-urls">
      {choices.presets.length > 0 && (
        <section className="start-urls__group" aria-label={t('browser.start.presets')}>
          <h3 className="start-urls__head">{t('browser.start.presets')}</h3>
          <div className="port-suggestions">
            {choices.presets.map((p) => (
              <button key={p.url} type="button" className="port-chip port-chip--preset" title={p.url} onClick={() => onNavigate?.(p.url)} data-testid="start-preset">
                <Globe size={12} strokeWidth={2} aria-hidden="true" />
                <span className="port-chip__label">{p.label}</span>
                <span className="port-chip__url">{shortUrl(p.url)}</span>
                {go}
              </button>
            ))}
          </div>
        </section>
      )}
      {choices.recent.length > 0 && (
        <section className="start-urls__group" aria-label={t('browser.start.recent')}>
          <h3 className="start-urls__head">{t('browser.start.recent')}</h3>
          <ul className="start-urls__recent">
            {choices.recent.map((url) => (
              <li key={url}>
                <button type="button" className="start-urls__row" title={url} onClick={() => onNavigate?.(url)} data-testid="start-recent">
                  <Clock size={12} strokeWidth={2} aria-hidden="true" />
                  <span className="start-urls__url">{shortUrl(url)}</span>
                  {go}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {choices.fallback.length > 0 && (
        <div className="port-suggestions">
          {choices.fallback.map((url) => (
            <button key={url} type="button" className="port-chip" onClick={() => onNavigate?.(url)} data-testid="start-fallback">
              <Globe size={12} strokeWidth={2} aria-hidden="true" />
              {shortUrl(url)}
              {go}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * ページを開けなかったときの絵。使い方の3コマではなく、
 * 「切れたつながり」と警告の印で、エラーだと一目で分かるようにする。
 */
function LoadFailedArt() {
  return (
    <svg className="load-failed-art" width="152" height="104" viewBox="0 0 152 104" fill="none" aria-hidden="true">
      {/* 開けなかった画面（中身の無い窓） */}
      <rect x="10" y="10" width="112" height="78" rx="10" fill="rgb(255 255 255 / 4%)" stroke="rgb(255 255 255 / 14%)" />
      <circle cx="22" cy="21" r="2.5" fill="rgb(255 255 255 / 22%)" />
      <circle cx="30" cy="21" r="2.5" fill="rgb(255 255 255 / 22%)" />
      <circle cx="38" cy="21" r="2.5" fill="rgb(255 255 255 / 22%)" />
      <path d="M10 32h112" stroke="rgb(255 255 255 / 10%)" />
      {/* 切れたつながり */}
      <g style={{ stroke: 'var(--color-text-muted)' }} strokeWidth="3" strokeLinecap="round">
        <path d="M46 62l-6 6a7 7 0 0 1-10-10l6-6" />
        <path d="M50 52l6-6a7 7 0 0 1 10 10l-6 6" />
      </g>
      <g style={{ stroke: 'var(--color-warning)' }} strokeWidth="2.5" strokeLinecap="round">
        <path d="M44 50l-4-4" />
        <path d="M53 66l4 4" />
        <path d="M48 47v-5" />
        <path d="M49 69v5" />
      </g>
      {/* 警告の印 */}
      <path
        d="M118 50l22 38h-44z"
        strokeLinejoin="round"
        strokeWidth="2.5"
        style={{ fill: 'var(--color-warning-quiet)', stroke: 'var(--color-warning)' }}
      />
      <path d="M118 64v10" strokeWidth="3" strokeLinecap="round" style={{ stroke: 'var(--color-warning)' }} />
      <circle cx="118" cy="80.5" r="1.8" style={{ fill: 'var(--color-warning)' }} />
    </svg>
  )
}
