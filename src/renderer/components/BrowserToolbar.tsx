import { AppWindow, Globe, MessageSquarePlus, Monitor, Smartphone } from 'lucide-react'
import { MOBILE_PRESET, type BrowserState, type CaptureTarget, type Project, type Viewport } from '@shared/types'
import { captureTargetLabel } from '@shared/captureTarget'
import { SHORTCUTS } from '../lib/shortcut'
import { Button, Segmented, Tooltip } from '../ui'
import { NavControls } from './NavControls'
import { UrlPresets } from './UrlPresets'
import { useT } from '../lib/i18n'

/**
 * エディタモードの内蔵ブラウザのツールバー（WS-2 / WS-3）。
 *
 * ツールチップは上向き。このツールバーの真下はネイティブのビューで、
 * 下向きに出すとビューの下に隠れて見えない（上は上部バー＝DOMなので見える）。
 */
export function BrowserToolbar({
  state,
  urlInputRef,
  project = null,
  onOverlayChange,
  onSelectWindow,
  shownTarget,
  onShowBrowser,
  noteMode = false,
  noteDisabled = false,
  onToggleNote
}: {
  state: BrowserState
  urlInputRef: React.RefObject<HTMLInputElement | null>
  /** 開いているプロジェクト。URLプリセット（local / dev / prd）をチップで並べる */
  project?: Project | null
  /** URLの登録・編集ダイアログの開閉。開いている間は内蔵ブラウザのビューを隠す */
  onOverlayChange?: (open: boolean) => void
  /** 確認先がウインドウのとき、録画の対象に選ぶ（UrlPresets から） */
  onSelectWindow?: (windowMatch: string, launched: boolean) => void
  /** 内蔵ブラウザの場所に映しているウインドウ（デスクトップアプリ・シミュレータ・ゲームなど）。映していなければ省く */
  shownTarget?: CaptureTarget
  /** 映すのをやめて内蔵ブラウザへ戻す。録画中は省く（録画の対象は変えない） */
  onShowBrowser?: () => void
  /** 文字で指摘（枠を引いて指示を打つ。録画しない）が入か */
  noteMode?: boolean
  /** 文字で指摘を使えない（録画中・ページが無い） */
  noteDisabled?: boolean
  /** 文字で指摘の入・切。省けばボタンを出さない */
  onToggleNote?: () => void
}) {
  const t = useT()
  const setViewport = (viewport: Viewport) => {
    void window.ade.invoke('browser:setViewport', viewport)
  }

  return (
    <div className="browser-toolbar" data-testid="browser-toolbar">
      <NavControls state={state} urlInputRef={urlInputRef} tooltipSide="top" />
      <UrlPresets project={project} currentUrl={state.url} onOverlayChange={onOverlayChange} onSelectWindow={onSelectWindow} />
      {shownTarget && shownTarget.kind !== 'browser' && (
        <span className="browser-toolbar__shown" data-testid="browser-shown-target">
          <AppWindow size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="browser-toolbar__shown-name">{t('browser.showingTarget', { target: captureTargetLabel(shownTarget) })}</span>
          {onShowBrowser && <Button variant="ghost" icon={<Globe size={13} strokeWidth={1.75} />} data-testid="browser-show-browser" onClick={onShowBrowser}>{t('browser.backToBrowser')}</Button>}
        </span>
      )}
      {onToggleNote && (
        <Tooltip label={noteMode ? t('textNote.button.stopTitle') : t('textNote.button.title')} side="top">
          <Button
            variant="ghost"
            className="browser-toolbar__note"
            icon={<MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden="true" />}
            selected={noteMode}
            disabled={noteDisabled && !noteMode}
            data-testid="browser-text-note"
            onClick={onToggleNote}
          >
            {t('textNote.button.label')}
          </Button>
        </Tooltip>
      )}
      <Segmented
        ariaLabel={t('browser.viewport')}
        value={state.viewport}
        onChange={setViewport}
        options={[
          {
            value: 'desktop',
            label: t('browser.desktop'),
            icon: <Monitor size={14} strokeWidth={1.75} />,
            testId: 'viewport-desktop',
            title: t('browser.desktopTitle', { key: SHORTCUTS.toggleViewport() })
          },
          {
            value: 'mobile',
            label: t('browser.mobile'),
            icon: <Smartphone size={14} strokeWidth={1.75} />,
            testId: 'viewport-mobile',
            title: t('browser.mobileTitle', { label: MOBILE_PRESET.label, width: MOBILE_PRESET.width, height: MOBILE_PRESET.height, key: SHORTCUTS.toggleViewport() })
          }
        ]}
      />
    </div>
  )
}
