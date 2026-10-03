import { Monitor, Smartphone } from 'lucide-react'
import { MOBILE_PRESET, type BrowserState, type Project, type Viewport } from '@shared/types'
import { SHORTCUTS } from '../lib/shortcut'
import { Segmented } from '../ui'
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
  onSelectWindow
}: {
  state: BrowserState
  urlInputRef: React.RefObject<HTMLInputElement | null>
  /** 開いているプロジェクト。URLプリセット（local / dev / prd）をチップで並べる */
  project?: Project | null
  /** URLの登録・編集ダイアログの開閉。開いている間は内蔵ブラウザのビューを隠す */
  onOverlayChange?: (open: boolean) => void
  /** 確認先がウインドウのとき、録画の対象に選ぶ（UrlPresets から） */
  onSelectWindow?: (windowMatch: string, launched: boolean) => void
}) {
  const t = useT()
  const setViewport = (viewport: Viewport) => {
    void window.ade.invoke('browser:setViewport', viewport)
  }

  return (
    <div className="browser-toolbar" data-testid="browser-toolbar">
      <NavControls state={state} urlInputRef={urlInputRef} tooltipSide="top" />
      <UrlPresets project={project} currentUrl={state.url} onOverlayChange={onOverlayChange} onSelectWindow={onSelectWindow} />
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
