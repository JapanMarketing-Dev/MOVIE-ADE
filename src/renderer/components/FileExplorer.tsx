import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileSearch, FileText, Folder, FolderOpen, ListCollapse, RefreshCw, Search } from 'lucide-react'
import type { FsEntry } from '@shared/files'
import { errorMessage } from '../lib/errors'
import { SHORTCUTS } from '../lib/shortcut'
import { PanelCloseButton } from './LayoutToggles'
import { IconButton, Spinner } from '../ui'
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

type Row = { entry: FsEntry; depth: number }

/** 変更通知のまとめ待ち。Agent が続けて書くときに読み直しを1回にする */
const REFRESH_DEBOUNCE_MS = 200
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
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [nameResults, setNameResults] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const childrenRef = useRef(children)
  childrenRef.current = children

  const loadDir = useCallback(async (dir: string) => {
    setLoading((set) => new Set(set).add(dir))
    try {
      const entries = await window.ade.invoke('fs:list', dir)
      setChildren((map) => new Map(map).set(dir, entries))
      if (dir === '') setError(null)
    } catch (err) {
      // 消えたフォルダは一覧から外す。根が読めないときだけ理由を出す
      setChildren((map) => { const next = new Map(map); next.delete(dir); return next })
      if (dir === '') setError(errorMessage(err))
    } finally {
      setLoading((set) => { const next = new Set(set); next.delete(dir); return next })
    }
  }, [])

  // プロジェクトが変わったら最初から
  useEffect(() => {
    setChildren(new Map())
    setExpanded(new Set())
    setQuery('')
    setError(null)
    if (root) void loadDir('')
  }, [root, loadDir])

  // 外部の変更。読み込み済みのフォルダだけを読み直す
  useEffect(() => {
    if (!root) return
    const pending = new Set<string>()
    let timer: number | undefined
    const off = window.ade.on('fs:changed', (event) => {
      for (const path of event.paths) {
        pending.add(parentDir(path))
        pending.add(path)
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        for (const dir of pending) if (childrenRef.current.has(dir)) void loadDir(dir)
        pending.clear()
      }, REFRESH_DEBOUNCE_MS)
    })
    return () => { off(); window.clearTimeout(timer) }
  }, [root, loadDir])

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
        (err) => { if (!cancelled) { setError(errorMessage(err)); setSearching(false) } }
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [root, query])

  const toggleDir = (entry: FsEntry) => {
    const opening = !expanded.has(entry.path)
    setExpanded((set) => {
      const next = new Set(set)
      if (opening) next.add(entry.path)
      else next.delete(entry.path)
      return next
    })
    if (opening && !childrenRef.current.has(entry.path)) void loadDir(entry.path)
  }

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (dir: string, depth: number) => {
      for (const entry of children.get(dir) ?? []) {
        out.push({ entry, depth })
        if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [children, expanded])

  const searchingMode = query.trim().length > 0

  return (
    <aside className="explorer" aria-label={t('fileExplorer.title')} data-testid="file-explorer">
      <header className="explorer__head">
        <span className="explorer__title">{t('fileExplorer.title')}</span>
        <span className="editor-head__spacer" />
        <IconButton size="sm" label={t('fileExplorer.quickOpen', { shortcut: SHORTCUTS.quickOpen() })} icon={<FileSearch size={14} />} onClick={onQuickOpen} disabled={!root} />
        <IconButton size="sm" label={t('fileExplorer.refresh')} icon={<RefreshCw size={13} />} disabled={!root} onClick={() => { for (const dir of childrenRef.current.keys()) void loadDir(dir) }} />
        <IconButton size="sm" label={t('fileExplorer.collapseAll')} icon={<ListCollapse size={14} />} disabled={!root} onClick={() => setExpanded(new Set())} />
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
