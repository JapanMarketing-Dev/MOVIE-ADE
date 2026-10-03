import { useState, type DragEvent } from 'react'
import { FileCode, FileText, FolderTree, Globe, ListChecks, Settings, X } from 'lucide-react'
import { applyOrder, moveItem } from '@shared/layout'
import { CountBadge, IconButton } from '../ui'
import { SHORTCUTS } from '../lib/shortcut'
import { useT } from '../lib/i18n'
import { fileTabId, type FileTabId, type OpenFile } from '../editor/useOpenFiles'
import '../styles/editor.css'

/**
 * 中央ペインに並ぶタブ。ブラウザと指摘一覧と、開いたファイルを同じ場所で切り替える。
 * ファイルは `file:<プロジェクトの根>/<相対パス>`。
 */
/** settings … 設定のページ（⌘, で開閉。開いている間だけタブを出す） */
export type CenterTab = 'browser' | 'findings' | 'settings' | FileTabId

/** タブのドラッグで運ぶデータの種類（ほかの DnD と混ざらないように） */
const DRAG_TYPE = 'application/x-ade-center-tab'

export function isFileTab(tab: CenterTab): tab is FileTabId {
  return tab.startsWith('file:')
}

/**
 * 中央ペインのタブ列（32px）。
 *
 * 選択中は「2px の下線（ブランド）＋ごく薄い地の持ち上げ」で示す。
 * 「指摘」やファイルのタブを選ぶと内蔵ブラウザのビューを隠してDOMを出すので、
 * 呼び出し側は useViewBounds の visible を false にすること。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/（MIT）の
 * 「ブラウザとファイルが同じタブ列に並び、未保存のファイルは × の代わりに点を出す（ホバーで ×）」使い心地。
 */
export function CenterTabs({
  active,
  pageTitle,
  findingCount,
  files = [],
  onChange,
  onCloseFile,
  explorerOpen,
  onToggleExplorer,
  order = [],
  onReorder,
  settingsOpen = false,
  onCloseSettings
}: {
  active: CenterTab
  /** ブラウザタブに出すページ名 */
  pageTitle: string
  findingCount: number
  /** 開いているファイル（今のプロジェクトの分） */
  files?: OpenFile[]
  onChange: (tab: CenterTab) => void
  onCloseFile?: (id: string) => void
  /** 右のファイルツリーの開閉（渡されたときだけ右端にボタンを出す） */
  explorerOpen?: boolean
  onToggleExplorer?: () => void
  /** タブの並び（ドラッグで並べ替えた順）。無いものは後ろに付く */
  order?: readonly string[]
  /** ドラッグで並べ替えたとき、新しい並びを返す */
  onReorder?: (order: CenterTab[]) => void
  /** 設定のページを開いているか（開いている間だけタブを出す） */
  settingsOpen?: boolean
  onCloseSettings?: () => void
}) {
  const t = useT()
  // Orca のタブ列と同じく、タブをドラッグして別のタブの前後へ落とすと並びが変わる
  const [drop, setDrop] = useState<{ id: CenterTab; before: boolean } | null>(null)
  const ids = applyOrder<CenterTab>(['browser', 'findings', ...(settingsOpen ? ['settings' as const] : []), ...files.map((file) => fileTabId(file.id))], order)
  const dragProps = (id: CenterTab) => onReorder ? {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(DRAG_TYPE, id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const before = e.clientX < rect.left + rect.width / 2
      if (drop?.id !== id || drop.before !== before) setDrop({ id, before })
    },
    onDragLeave: () => setDrop(null),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      const from = e.dataTransfer.getData(DRAG_TYPE) as CenterTab
      const before = drop?.before ?? true
      setDrop(null)
      if (from) onReorder(moveItem(ids, from, id, before))
    },
    onDragEnd: () => setDrop(null),
    'data-drop': drop?.id === id ? (drop.before ? 'before' : 'after') : undefined
  } : {}

  return (
    <div className="ctabs" role="tablist" aria-label={t('centerTabs.label')}>
      <div className="ctabs__files">
          {ids.map((tab) => {
            if (tab === 'browser') return (
              <button
                key={tab}
                type="button"
                role="tab"
                className="ctab ctab--page"
                aria-selected={active === 'browser'}
                onClick={() => onChange('browser')}
                data-testid="ctab-browser"
                title={pageTitle || undefined}
                {...dragProps(tab)}
              >
                <Globe size={13} strokeWidth={1.75} />
                <span className="ctab__label">{pageTitle || t('centerTabs.browser')}</span>
              </button>
            )
            if (tab === 'findings') return (
              <button
                key={tab}
                type="button"
                role="tab"
                className="ctab"
                aria-selected={active === 'findings'}
                onClick={() => onChange('findings')}
                data-testid="ctab-findings"
                {...dragProps(tab)}
              >
                <ListChecks size={13} strokeWidth={1.75} />
                <span className="ctab__label">{t('centerTabs.findings')}</span>
                <CountBadge count={findingCount} />
              </button>
            )
            if (tab === 'settings') return (
              <div
                key={tab}
                role="tab"
                tabIndex={0}
                className="ctab ctab--file"
                aria-selected={active === 'settings'}
                onClick={() => onChange('settings')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange('settings') } }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseSettings?.() } }}
                data-testid="ctab-settings"
                {...dragProps(tab)}
              >
                <Settings size={13} strokeWidth={1.75} />
                <span className="ctab__label">{t('common.settings')}</span>
                <button
                  type="button"
                  className="ctab__close"
                  aria-label={t('centerTabs.closeSettings')}
                  onClick={(e) => { e.stopPropagation(); onCloseSettings?.() }}
                  data-testid="ctab-settings-close"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            )
            const file = files.find((f) => fileTabId(f.id) === tab)
            if (!file) return null
            const Icon = file.language === 'markdown' || file.language === 'plaintext' ? FileText : FileCode
            return (
              <div
                key={file.id}
                role="tab"
                tabIndex={0}
                className={`ctab ctab--file${file.dirty ? ' is-dirty' : ''}`}
                aria-selected={active === tab}
                title={file.dirty ? t('centerTabs.unsaved', { path: file.path }) : file.path}
                onClick={() => onChange(tab)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(tab) } }}
                // 中クリックで閉じる（ブラウザ・エディタと同じ）
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseFile?.(file.id) } }}
                data-testid="ctab-file"
                data-path={file.path}
                {...dragProps(tab)}
              >
                <Icon size={13} strokeWidth={1.75} />
                <span className="ctab__label">{file.name}</span>
                <button
                  type="button"
                  className="ctab__close"
                  aria-label={t('centerTabs.close', { name: file.name })}
                  onClick={(e) => { e.stopPropagation(); onCloseFile?.(file.id) }}
                  data-testid="ctab-file-close"
                >
                  <span className="ctab__dirty" aria-hidden="true" />
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            )
          })}
      </div>

      {onToggleExplorer && (
        <div className="ctabs__end">
          <IconButton
            size="sm"
            label={t(explorerOpen ? 'centerTabs.hideExplorer' : 'centerTabs.showExplorer', { key: SHORTCUTS.toggleExplorer() })}
            icon={<FolderTree size={14} strokeWidth={1.75} />}
            selected={explorerOpen}
            onClick={onToggleExplorer}
            data-testid="toggle-explorer"
          />
        </div>
      )}
    </div>
  )
}
