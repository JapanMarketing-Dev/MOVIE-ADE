import { useEffect, useState } from 'react'
import { ChevronRight, FileSearch, FileText, Folder, FolderOpen, ListCollapse, RefreshCw, Search } from 'lucide-react'
import { errorMessage } from '../lib/errors'
import { SHORTCUTS } from '../lib/shortcut'
import { PanelCloseButton } from './LayoutToggles'
import { IconButton, Spinner } from '../ui'
import { useFileTree } from './fileTree'
import { useT } from '../lib/i18n'

/**
 * 右のファイルツリー（エクスプローラ）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/right-sidebar/（MIT）
 *   - FileExplorer.tsx: フォルダは開いたときに読む。外部の変更で、読み込み済みのフォルダだけを読み直す
 *   - FileExplorerNameFilter.tsx: 名前で絞り込む欄
 *   - FileExplorerToolbar.tsx: Find files（⌘P）・再読込・すべて畳む
 * 内容検索・仮想スクロール・ドラッグ・名前の変更・削除・git の状態は持ち込まない（動画フィードバックに絞る）。
 * 変更ありの「M」は、エディタで未保存の変更があるファイルに付ける。
 */

const SEARCH_DEBOUNCE_MS = 250

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function FileExplorer({
  root,
  activePath,
  dirtyPaths,
  onOpen,
  onQuickOpen
}: {
  /** 開いているプロジェクトのフォルダ。null なら案内だけ */
  root: string | null
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  onOpen: (path: string) => void
  onQuickOpen: () => void
}) {
  const t = useT()
  // ツリーの状態（開いたときに読む・外部の変更で読み直す）はフィードバックの右パネルと共用（fileTree.tsx）
  const tree = useFileTree(root)
  const { rows, expanded, loading, toggleDir } = tree
  const [searchError, setSearchError] = useState<string | null>(null)
  const error = tree.error ?? searchError
  const [query, setQuery] = useState('')
  const [nameResults, setNameResults] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)

  // プロジェクトが変わったら絞り込みも最初から
  useEffect(() => {
    setQuery('')
    setSearchError(null)
  }, [root])

  // ファイル名で絞り込む。打ち終わるのを少し待つ
  useEffect(() => {
    const trimmed = query.trim()
    if (!root || !trimmed) { setNameResults([]); setTruncated(false); return }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      window.ade.invoke('fs:search', trimmed, 'names').then(
        (result) => {
          if (cancelled) return
          setNameResults(result.files)
          setTruncated(result.truncated)
          setSearching(false)
        },
        (err) => { if (!cancelled) { setSearchError(errorMessage(err)); setSearching(false) } }
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [root, query])

  const searchingMode = query.trim().length > 0

  return (
    <aside className="explorer" aria-label={t('fileExplorer.title')} data-testid="file-explorer">
      <header className="explorer__head">
        <span className="explorer__title">{t('fileExplorer.title')}</span>
        <span className="editor-head__spacer" />
        <IconButton size="sm" label={t('fileExplorer.quickOpen', { shortcut: SHORTCUTS.quickOpen() })} icon={<FileSearch size={14} />} onClick={onQuickOpen} disabled={!root} />
        <IconButton size="sm" label={t('fileExplorer.refresh')} icon={<RefreshCw size={13} />} disabled={!root} onClick={tree.refresh} />
        <IconButton size="sm" label={t('fileExplorer.collapseAll')} icon={<ListCollapse size={14} />} disabled={!root} onClick={tree.collapseAll} />
        {/* ファイルツリーを閉じる（layout-footer の部品。開き直すのはタイトルバー・⌘⇧E・中央のタブの右端・設定） */}
        <PanelCloseButton panel="files" />
      </header>

      {root && (
        <div className="explorer__query">
          <label className="explorer__search">
            <Search size={13} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
              placeholder={t('fileExplorer.filter')}
              aria-label={t('fileExplorer.filter')}
              data-testid="explorer-query"
            />
            {searching && <Spinner size={12} />}
          </label>
        </div>
      )}

      <div className="explorer__body">
        {!root ? (
          <p className="explorer__note">{t('fileExplorer.empty')}</p>
        ) : error ? (
          <p className="explorer__note">{error}</p>
        ) : searchingMode ? (
          <ul className="explorer__list">
            {nameResults.map((path) => (
              <li key={path}>
                <button type="button" className={`explorer__row${path === activePath ? ' is-active' : ''}`} onClick={() => onOpen(path)} title={path}>
                  <FileText size={13} aria-hidden="true" />
                  <span className="explorer__name">{path.slice(path.lastIndexOf('/') + 1)}</span>
                  <span className="explorer__dir">{parentDir(path)}</span>
                  {dirtyPaths.has(path) && <span className="explorer__badge" title={t('fileExplorer.unsaved')}>M</span>}
                </button>
              </li>
            ))}
            {!searching && nameResults.length === 0 && <p className="explorer__note">{t('fileExplorer.noMatches')}</p>}
          </ul>
        ) : (
          <ul className="explorer__list" role="tree">
            {rows.map(({ entry, depth }) => {
              const isDir = entry.kind === 'directory'
              const open = isDir && expanded.has(entry.path)
              return (
                <li key={entry.path} role="treeitem" aria-expanded={isDir ? open : undefined}>
                  <button
                    type="button"
                    className={`explorer__row${entry.path === activePath ? ' is-active' : ''}${entry.collapsed ? ' is-heavy' : ''}`}
                    style={{ '--depth': depth } as React.CSSProperties}
                    onClick={() => (isDir ? toggleDir(entry) : onOpen(entry.path))}
                    title={entry.path}
                    data-testid="explorer-row"
                    data-path={entry.path}
                  >
                    {isDir ? (
                      <>
                        <ChevronRight size={12} className={`explorer__chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
                        {open ? <FolderOpen size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
                      </>
                    ) : (
                      <>
                        <span className="explorer__chevron-space" />
                        <FileText size={13} aria-hidden="true" />
                      </>
                    )}
                    <span className="explorer__name">{entry.name}</span>
                    {loading.has(entry.path) && <Spinner size={10} />}
                    {dirtyPaths.has(entry.path) && <span className="explorer__badge" title={t('fileExplorer.unsaved')}>M</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {searchingMode && truncated && <p className="explorer__note">{t('fileExplorer.truncated')}</p>}
      </div>
    </aside>
  )
}
