import {
  MessageSquareQuote,
  PanelLeft,
  PanelsTopLeft,
  Settings
} from 'lucide-react'
import type { AppMode, ProjectsState, WorkspaceState } from '@shared/types'
import { SHORTCUTS } from '../lib/shortcut'
import { IconButton, Logo, RecordButton, Segmented, Tooltip } from '../ui'
import { ProjectMenu } from './ProjectMenu'
import { useT } from '../lib/i18n'

/**
 * タイトルバー（36px）。ウィンドウをドラッグできる帯。
 *
 * 並びはベンチのADEに合わせる:
 *   左  … サイドバー開閉 / ロゴ / プロジェクト名（押すとプロジェクト一覧・切替・追加）
 *   中央… モード切替
 *   右  … ● 録画（この画面で最も目立つ主要アクション）/ 設定
 *
 * macOS の信号機ボタンぶんの余白は CSS の --titlebar-inset が持つ。
 * ツールチップは下向き（下にあるのはタブ列＝DOMなので隠れない）。
 */
export function TitleBar({
  workspace,
  projects,
  mode,
  recording,
  sidebarOpen,
  onChangeMode,
  onProjectMenuChange,
  onToggleSidebar,
  onToggleRecording,
  onOpenSettings,
  busy = false
}: {
  workspace: WorkspaceState
  projects: ProjectsState
  mode: AppMode
  recording: boolean
  sidebarOpen: boolean
  onChangeMode: (mode: AppMode) => void
  /** プロジェクト一覧の開閉。開いている間は内蔵ブラウザのビューを隠す */
  onProjectMenuChange?: (open: boolean) => void
  onToggleSidebar: () => void
  onToggleRecording: () => void
  onOpenSettings?: () => void
  busy?: boolean
}) {
  const t = useT()
  return (
    <header className="titlebar" data-testid="topbar">
      <div className="titlebar__left">
        <Tooltip label={t('titleBar.sidebar')} shortcut={SHORTCUTS.toggleSidebar()}>
          <IconButton
            label={t('titleBar.sidebar')}
            icon={<PanelLeft size={14} strokeWidth={1.75} />}
            selected={sidebarOpen}
            onClick={onToggleSidebar}
            data-testid="toggle-sidebar"
          />
        </Tooltip>

        <span className="titlebar__logo">
          <Logo size={18} />
        </span>
        <span className="titlebar__sep" aria-hidden="true" />

        <ProjectMenu workspace={workspace} projects={projects} onOpenChange={onProjectMenuChange} />
      </div>

      <div className="titlebar__center">
        <Segmented
          ariaLabel={t('titleBar.mode')}
          value={mode}
          onChange={onChangeMode}
          options={[
            {
              value: 'editor',
              label: t('titleBar.editor'),
              icon: <PanelsTopLeft size={13} strokeWidth={1.75} />,
              testId: 'mode-editor',
              title: t('titleBar.editorTitle', { key: SHORTCUTS.toggleMode() })
            },
            {
              value: 'feedback',
              label: t('titleBar.feedback'),
              icon: <MessageSquareQuote size={13} strokeWidth={1.75} />,
              testId: 'mode-feedback',
              title: t('titleBar.feedbackTitle', { key: SHORTCUTS.toggleMode() })
            }
          ]}
        />
      </div>

      <div className="titlebar__right">
        <RecordButton
          recording={recording}
          disabled={busy}
          onClick={onToggleRecording}
          data-testid="record-button"
        />
        <Tooltip label={t('common.settings')}>
          <IconButton
            label={t('common.settings')}
            icon={<Settings size={14} strokeWidth={1.75} />}
            onClick={onOpenSettings}
            data-testid="settings-button"
          />
        </Tooltip>
      </div>
    </header>
  )
}
