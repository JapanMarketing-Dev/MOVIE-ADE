import {
  PanelBottom,
  PanelBottomClose,
  PanelBottomDashed,
  PanelLeft,
  PanelLeftClose,
  PanelLeftDashed,
  PanelRight,
  PanelRightClose,
  PanelRightDashed,
  PanelTop,
  PanelTopClose,
  PanelTopDashed,
  type LucideIcon
} from 'lucide-react'
import { panelToggleOrder, togglePanel, type Dock, type PanelId } from '@shared/layout'
import { IconButton, Tooltip } from '../ui'
import { useT } from '../lib/i18n'
import { setLayout, useLayout } from '../lib/layout'
import { SHORTCUTS } from '../lib/shortcut'

/**
 * パネルの開閉ボタン（VS Code のタイトルバー右側の「レイアウトの切り替え」と同じ形）。
 *
 * - タイトルバーに、プロジェクト一覧・ファイルツリーの2つを並べる。並びとアイコンは今の置き場所に合わせる
 * - 開いているときは選択中の見た目（塗り）、閉じているときは破線のアイコン
 * - 閉じたパネルは画面に何も残さない（VS Code と同じ）。開くのはこのボタン・⌘B / ⌘⇧E・設定から
 * - ターミナルは常に表示する（ユーザーの指示：閉じる・隠す手段を持たない）ので、ここには置かない
 * 値は lib/layout.ts（Settings.layout の visible）で、ドラッグ・設定ページと同じものを使う。
 */

const ICON_OPEN: Record<Dock, LucideIcon> = { left: PanelLeft, right: PanelRight, top: PanelTop, bottom: PanelBottom }
const ICON_CLOSED: Record<Dock, LucideIcon> = { left: PanelLeftDashed, right: PanelRightDashed, top: PanelTopDashed, bottom: PanelBottomDashed }
const ICON_COLLAPSE: Record<Dock, LucideIcon> = { left: PanelLeftClose, right: PanelRightClose, top: PanelTopClose, bottom: PanelBottomClose }

/** 開閉できるパネル（ターミナルは除く）とそのキー */
type ClosablePanel = Exclude<PanelId, 'terminal'>
const SHORTCUT_OF: Record<ClosablePanel, () => string> = {
  projects: SHORTCUTS.toggleSidebar,
  files: SHORTCUTS.toggleExplorer
}

/** E2E が掴む印。プロジェクト一覧は以前のサイドバー開閉ボタンと同じ名前を引き継ぐ */
const TEST_ID: Record<ClosablePanel, string> = { projects: 'toggle-sidebar', files: 'toggle-files-panel' }

export function LayoutToggles() {
  const t = useT()
  const layout = useLayout()
  return (
    <div className="layout-toggles" role="group" aria-label={t('layout.toggle.group')}>
      {(panelToggleOrder(layout) as ClosablePanel[]).map((id) => {
        const { dock, visible } = layout.panels[id]
        const Icon = visible ? ICON_OPEN[dock] : ICON_CLOSED[dock]
        const label = t(visible ? 'layout.toggle.hide' : 'layout.toggle.show', { panel: t(`settings.layout.panel.${id}`) })
        return (
          <Tooltip key={id} label={label} shortcut={SHORTCUT_OF[id]()}>
            <IconButton
              label={label}
              icon={<Icon size={14} strokeWidth={1.75} />}
              selected={visible}
              onClick={() => setLayout((prev) => togglePanel(prev, id))}
              data-testid={TEST_ID[id]}
            />
          </Tooltip>
        )
      })}
    </div>
  )
}

/**
 * パネルの見出しの右端に置く「閉じる」（畳むアイコン）。各パネルの見出しにそのまま置ける。
 * 開き直すのはタイトルバーのボタン・ショートカット・設定から。
 */
export function PanelCloseButton({ panel }: { panel: ClosablePanel }) {
  const t = useT()
  const layout = useLayout()
  const Icon = ICON_COLLAPSE[layout.panels[panel].dock]
  const label = t('layout.close', { panel: t(`settings.layout.panel.${panel}`) })
  return (
    <IconButton
      size="sm"
      label={`${label} (${SHORTCUT_OF[panel]()})`}
      icon={<Icon size={14} strokeWidth={1.75} />}
      onClick={() => setLayout((prev) => togglePanel(prev, panel, false))}
      data-testid={`close-panel-${panel}`}
    />
  )
}
