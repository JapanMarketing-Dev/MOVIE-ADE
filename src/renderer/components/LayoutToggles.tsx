import {
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelLeftDashed,
  PanelRight,
  PanelRightDashed,
  type LucideIcon
} from 'lucide-react'
import { CLOSABLE_PANELS, type ClosablePanel } from '@shared/layout'
import { IconButton, Tooltip } from '../ui'
import { useT } from '../lib/i18n'
import { setBrowserFocus, togglePanelShown, useBrowserFocus, useLayout } from '../lib/layout'
import { SHORTCUTS } from '../lib/shortcut'

/**
 * パネルの開閉ボタン（VS Code のタイトルバー右側の「レイアウトの切り替え」と同じ形）。パネルの開閉はここに集める。
 *
 * - 左のパネル（プロジェクト一覧）・右のパネル（ファイルツリー）の2つを、画面の並びのとおり左 → 右に並べる
 * - 開いているときは選択中の見た目（塗り）、閉じているときは破線のアイコン
 * - 閉じたパネルは画面に何も残さない（VS Code と同じ）。開くのはこのボタン・⌘⇧E（ファイルツリー）・設定から
 * - 最後に「ブラウザに集中」。ブラウザ以外のパネル（ターミナルも）を隠し、もう一度押すと元の配置に戻る（保存しない）
 * - ターミナルは常に表示する（ユーザーの指示：閉じる・隠す手段を持たない）ので、単独の開閉ボタンは置かない
 * 値は lib/layout.ts（Settings.layout の visible）で、設定ページと同じものを使う。
 */

const ICON_OPEN: Record<ClosablePanel, LucideIcon> = { projects: PanelLeft, files: PanelRight }
const ICON_CLOSED: Record<ClosablePanel, LucideIcon> = { projects: PanelLeftDashed, files: PanelRightDashed }

/** ショートカットのあるもの（プロジェクト一覧には無い） */
const SHORTCUT_OF: Partial<Record<ClosablePanel, () => string>> = {
  files: SHORTCUTS.toggleExplorer
}

/** E2E が掴む印 */
const TEST_ID: Record<ClosablePanel, string> = { projects: 'toggle-projects-panel', files: 'toggle-files-panel' }

export function LayoutToggles({ onFocusBrowser }: {
  /** ブラウザに集中し始めたとき（App が中央のタブをブラウザへ切り替える） */
  onFocusBrowser?: () => void
}) {
  const t = useT()
  const layout = useLayout()
  const focus = useBrowserFocus()
  const focusLabel = t(focus ? 'layout.focus.exit' : 'layout.focus.enter')
  return (
    <div className="layout-toggles" role="group" aria-label={t('layout.toggle.group')}>
      {CLOSABLE_PANELS.map((id) => {
        // 集中している間は、見た目どおり閉じているものとして出す（押すと集中をやめて開く）
        const visible = layout.panels[id].visible && !focus
        const Icon = visible ? ICON_OPEN[id] : ICON_CLOSED[id]
        const label = t(visible ? 'layout.toggle.hide' : 'layout.toggle.show', { panel: t(`settings.layout.panel.${id}`) })
        return (
          <Tooltip key={id} label={label} shortcut={SHORTCUT_OF[id]?.()}>
            <IconButton
              label={label}
              icon={<Icon size={14} strokeWidth={1.75} />}
              selected={visible}
              onClick={() => togglePanelShown(id)}
              data-testid={TEST_ID[id]}
            />
          </Tooltip>
        )
      })}
      <Tooltip label={focusLabel}>
        <IconButton
          label={focusLabel}
          icon={focus ? <Minimize2 size={14} strokeWidth={1.75} /> : <Maximize2 size={14} strokeWidth={1.75} />}
          selected={focus}
          onClick={() => {
            if (!focus) onFocusBrowser?.()
            setBrowserFocus(!focus)
          }}
          data-testid="toggle-browser-focus"
        />
      </Tooltip>
    </div>
  )
}
