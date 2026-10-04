import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronRight, FilePlus, FileSearch, FileText, Folder, FolderOpen, FolderPlus, ListCollapse, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react'
import { ENTRY_NAME_PROBLEM_KEYS, entryNameProblem, isSameOrUnder, type FsEntry } from '@shared/files'
import { errorMessage } from '../lib/errors'
import { SHORTCUTS, formatShortcut } from '../lib/shortcut'
import { PanelCloseButton } from './LayoutToggles'
import { Button, IconButton, Modal, Spinner } from '../ui'
import { useFileTree, type FileTreeRow } from './fileTree'
import { useT } from '../lib/i18n'

/**
 * 右のファイルツリー（エクスプローラ）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/right-sidebar/（MIT）
 *   - FileExplorer.tsx: フォルダは開いたときに読む。外部の変更で、読み込み済みのフォルダだけを読み直す
 *   - FileExplorerNameFilter.tsx: 名前で絞り込む欄
 *   - FileExplorerToolbar.tsx: Find files（⌘P）・再読込・すべて畳む
 * 内容検索・仮想スクロール・ドラッグ・git の状態は持ち込まない（動画フィードバックに絞る）。
 * 変更ありの「M」は、エディタで未保存の変更があるファイルに付ける。
 *
 * 作成・名前の変更・削除（VS Code と同じ感覚）:
 *   - 新しいファイル / フォルダ: ツリーの上のボタンか右クリック。名前はツリーの中のその場の欄に打つ
 *   - 名前の変更: F2（macOS は ↩ も）か右クリック
 *   - 削除: Delete（macOS は ⌘⌫ も）か右クリック。アプリ内の確認を出してゴミ箱へ送る。⌘ / Ctrl・Shift で複数を選べる
 * パスと名前の検査は main（src/main/fileOps.ts）が最終的に行う。ここでの検査は打っている間の案内だけ。
 */

const SEARCH_DEBOUNCE_MS = 250

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function isMac(): boolean {
  return window.ade?.platform === 'darwin'
}

/** ツリーの中のその場の名前の欄。create は parent の中に新しく、rename は path の名前を変える */
type Editing =
  | { mode: 'create'; parent: string; kind: FsEntry['kind'] }
  | { mode: 'rename'; path: string; kind: FsEntry['kind'] }

/** 削除の確認に出す名前の数（多いときは先頭だけ） */
const MAX_LISTED_DELETE_NAMES = 5

export function FileExplorer({
  root,
  activePath,
  dirtyPaths,
  onOpen,
  onQuickOpen,
  onRenamed,
  onDeleted
}: {
  /** 開いているプロジェクトのフォルダ。null なら案内だけ */
  root: string | null
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  onOpen: (path: string) => void
  onQuickOpen: () => void
  /** 名前を変えた（開いているタブを追従させる） */
  onRenamed?: (from: string, to: string) => void
  /** ゴミ箱へ送った（開いているタブを閉じる） */
  onDeleted?: (paths: string[]) => void
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

  const ops = useTreeOperations({ root, tree, rows, dirtyPaths, onOpen, onRenamed, onDeleted })

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
        <IconButton size="sm" label={t('fileExplorer.newFile')} icon={<FilePlus size={14} />} disabled={!root} onClick={() => ops.startCreate('file', ops.targetDir(null))} data-testid="explorer-new-file" />
        <IconButton size="sm" label={t('fileExplorer.newFolder')} icon={<FolderPlus size={14} />} disabled={!root} onClick={() => ops.startCreate('directory', ops.targetDir(null))} data-testid="explorer-new-folder" />
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
          <ul
            className="explorer__list explorer__list--tree"
            role="tree"
            aria-multiselectable="true"
            onKeyDown={ops.onTreeKeyDown}
            onContextMenu={(e) => ops.openMenu(e, null)}
            data-testid="explorer-tree"
          >
            {ops.editing?.mode === 'create' && ops.editing.parent === '' && <NameInput ops={ops} depth={0} />}
            {rows.map(({ entry, depth }) => {
              const isDir = entry.kind === 'directory'
              const open = isDir && expanded.has(entry.path)
              const selected = ops.selected.has(entry.path)
              const renaming = ops.editing?.mode === 'rename' && ops.editing.path === entry.path
              return (
                <Fragment key={entry.path}>
                <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={selected}>
                  {renaming ? <NameInput ops={ops} depth={depth} entry={entry} /> : (
                  <button
                    type="button"
                    className={`explorer__row${entry.path === activePath ? ' is-active' : ''}${selected ? ' is-selected' : ''}${entry.collapsed ? ' is-heavy' : ''}`}
                    style={{ '--depth': depth } as React.CSSProperties}
                    onClick={(e) => ops.onRowClick(e, entry, () => (isDir ? toggleDir(entry) : onOpen(entry.path)))}
                    onContextMenu={(e) => ops.openMenu(e, entry)}
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
                  )}
                </li>
                {ops.editing?.mode === 'create' && isDir && ops.editing.parent === entry.path && open && <NameInput ops={ops} depth={depth + 1} />}
                </Fragment>
              )
            })}
          </ul>
        )}
        {searchingMode && truncated && <p className="explorer__note">{t('fileExplorer.truncated')}</p>}
        {!searchingMode && ops.actionError && <p className="explorer__note explorer__note--error" role="alert" data-testid="explorer-error">{ops.actionError}</p>}
      </div>

      {ops.menu && <TreeMenu ops={ops} />}
      {ops.confirmDelete && <DeleteDialog paths={ops.confirmDelete} dirty={[...dirtyPaths].filter((p) => ops.confirmDelete!.some((d) => isSameOrUnder(p, d)))} onCancel={() => ops.setConfirmDelete(null)} onConfirm={() => ops.trash(ops.confirmDelete!)} />}
    </aside>
  )
}

type TreeOps = ReturnType<typeof useTreeOperations>

/** 作成・名前の変更・削除と、選択・右クリックのメニュー */
function useTreeOperations({
  root,
  tree,
  rows,
  dirtyPaths,
  onOpen,
  onRenamed,
  onDeleted
}: {
  root: string | null
  tree: ReturnType<typeof useFileTree>
  rows: FileTreeRow[]
  dirtyPaths: ReadonlySet<string>
  onOpen: (path: string) => void
  onRenamed?: (from: string, to: string) => void
  onDeleted?: (paths: string[]) => void
}) {
  const t = useT()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [value, setValue] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** 操作のあとで、このパスの行にフォーカスを戻す（ツリーが読み直されてから） */
  const focusAfter = useRef<string | null>(null)

  // プロジェクトが変わったら選択と入力を捨てる
  useEffect(() => {
    setSelected(new Set())
    anchor.current = null
    setEditing(null)
    setActionError(null)
    setMenu(null)
    setConfirmDelete(null)
  }, [root])

  // 消えた行は選択から外す
  useEffect(() => {
    const visible = new Set(rows.map((r) => r.entry.path))
    setSelected((set) => ([...set].every((p) => visible.has(p)) ? set : new Set([...set].filter((p) => visible.has(p)))))
    const path = focusAfter.current
    if (path && visible.has(path)) {
      focusAfter.current = null
      document.querySelector<HTMLElement>(`[data-testid="explorer-row"][data-path="${CSS.escape(path)}"]`)?.focus()
    }
  }, [rows])

  // メニューは外側のクリックと Esc で閉じる
  useEffect(() => {
    if (!menu) return
    const close = (event: globalThis.MouseEvent) => { if (!(event.target as HTMLElement).closest('.explorer-menu')) setMenu(null) }
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', () => setMenu(null), { once: true })
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [menu])

  const entryOf = (path: string): FsEntry | undefined => rows.find((r) => r.entry.path === path)?.entry

  /** 新しく作る場所。フォルダならその中、ファイルならその親、何も無ければ根 */
  const targetDir = (entry: FsEntry | null): string => {
    const base = entry ?? (selected.size === 1 ? entryOf([...selected][0]!) : undefined) ?? null
    if (!base) return ''
    return base.kind === 'directory' ? base.path : parentDir(base.path)
  }

  const siblingsOf = (dir: string): FsEntry[] => rows.map((r) => r.entry).filter((e) => parentDir(e.path) === dir)

  const startCreate = (kind: FsEntry['kind'], parent: string) => {
    setMenu(null)
    setActionError(null)
    if (parent) tree.expandDir(parent)
    setEditing({ mode: 'create', parent, kind })
    setValue('')
    setInputError(null)
  }

  const startRename = (entry: FsEntry) => {
    setMenu(null)
    setActionError(null)
    setEditing({ mode: 'rename', path: entry.path, kind: entry.kind })
    setValue(entry.name)
    setInputError(null)
  }

  const askDelete = (paths: string[]) => {
    setMenu(null)
    setActionError(null)
    if (paths.length > 0) setConfirmDelete(paths)
  }

  /** 打っている間の案内（使えない名前・同じフォルダに同じ名前）。最終的な検査は main */
  const hintFor = (name: string): string | null => {
    if (!editing || name === '') return null
    const problem = entryNameProblem(name)
    if (problem) return t(ENTRY_NAME_PROBLEM_KEYS[problem])
    const dir = editing.mode === 'create' ? editing.parent : parentDir(editing.path)
    const self = editing.mode === 'rename' ? editing.path : null
    const clash = siblingsOf(dir).find((e) => e.path !== self && e.name.toLowerCase() === name.toLowerCase())
    return clash ? t('files.errors.exists', { name: clash.name }) : null
  }

  const cancelEdit = () => {
    const back = editing?.mode === 'rename' ? editing.path : null
    setEditing(null)
    setInputError(null)
    if (back) focusAfter.current = back
  }

  /** 入力を確定する。keepOpen なら失敗しても欄を残して直してもらう（Enter）。欄から離れたときは閉じて知らせる */
  const commit = async (keepOpen: boolean) => {
    if (!editing || busy) return
    const name = value
    const unchanged = editing.mode === 'rename' && name === baseName(editing.path)
    if (name.trim() === '' || unchanged) { cancelEdit(); return }
    setBusy(true)
    try {
      if (editing.mode === 'create') {
        const created = await window.ade.invoke('fs:create', editing.parent, name, editing.kind)
        tree.reloadDir(editing.parent)
        setEditing(null)
        setSelected(new Set([created]))
        anchor.current = created
        focusAfter.current = created
        if (editing.kind === 'file') onOpen(created)
      } else {
        const from = editing.path
        const to = await window.ade.invoke('fs:rename', from, name)
        if (editing.kind === 'directory') tree.moveDir(from, to)
        tree.reloadDir(parentDir(from))
        onRenamed?.(from, to)
        setEditing(null)
        setSelected(new Set([to]))
        anchor.current = to
        focusAfter.current = to
      }
      setInputError(null)
    } catch (err) {
      if (keepOpen) setInputError(errorMessage(err))
      else { setEditing(null); setInputError(null); setActionError(errorMessage(err)) }
    } finally {
      setBusy(false)
    }
  }

  const trash = async (paths: string[]) => {
    setConfirmDelete(null)
    setBusy(true)
    try {
      const trashed = await window.ade.invoke('fs:trash', paths)
      onDeleted?.(trashed)
      setSelected(new Set())
      // 消したものの隣の行へフォーカスを移す
      const firstIndex = rows.findIndex((r) => trashed.includes(r.entry.path))
      const next = rows.slice(firstIndex + 1).find((r) => !trashed.some((p) => isSameOrUnder(r.entry.path, p)))
        ?? rows.slice(0, Math.max(0, firstIndex)).reverse().find((r) => !trashed.some((p) => isSameOrUnder(r.entry.path, p)))
      if (next) focusAfter.current = next.entry.path
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
      for (const dir of new Set(paths.map(parentDir))) tree.reloadDir(dir)
    }
  }

  const onRowClick = (event: MouseEvent, entry: FsEntry, activate: () => void) => {
    setActionError(null)
    const toggle = isMac() ? event.metaKey : event.ctrlKey
    if (toggle) {
      setSelected((set) => { const next = new Set(set); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
      anchor.current = entry.path
      return
    }
    if (event.shiftKey && anchor.current) {
      const paths = rows.map((r) => r.entry.path)
      const a = paths.indexOf(anchor.current)
      const b = paths.indexOf(entry.path)
      if (a !== -1 && b !== -1) {
        setSelected(new Set(paths.slice(Math.min(a, b), Math.max(a, b) + 1)))
        return
      }
    }
    setSelected(new Set([entry.path]))
    anchor.current = entry.path
    activate()
  }

  const openMenu = (event: MouseEvent, entry: FsEntry | null) => {
    event.preventDefault()
    event.stopPropagation()
    if (!root) return
    if (entry && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      anchor.current = entry.path
    }
    // 窓の端では内側へ寄せる（メニューの幅はおよそ 220px、高さは 150px）
    const x = Math.max(4, Math.min(event.clientX, window.innerWidth - 224))
    const y = Math.max(4, Math.min(event.clientY, window.innerHeight - 154))
    setMenu({ x, y, entry })
  }

  /** 削除の対象。フォーカスのある行が選択の中なら選択全部、外ならその行だけ */
  const deleteTargets = (focused: string | null): string[] => {
    if (focused && !selected.has(focused)) return [focused]
    return [...selected]
  }

  const onTreeKeyDown = (event: KeyboardEvent) => {
    if (editing || (event.target as HTMLElement).tagName === 'INPUT') return
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-testid="explorer-row"]')?.dataset.path ?? null
    const mac = isMac()
    const renameKey = event.key === 'F2' || (mac && event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
    if (renameKey) {
      const entry = focused ? entryOf(focused) : selected.size === 1 ? entryOf([...selected][0]!) : undefined
      if (!entry) return
      event.preventDefault()
      setSelected(new Set([entry.path]))
      startRename(entry)
      return
    }
    const deleteKey = (event.key === 'Delete' && !event.altKey) || (mac && event.key === 'Backspace' && event.metaKey)
    if (deleteKey) {
      const targets = deleteTargets(focused)
      if (targets.length === 0) return
      event.preventDefault()
      askDelete(targets)
      return
    }
    if (event.key === 'Escape' && selected.size > 0) setSelected(new Set())
  }

  return {
    root, selected, editing, value, setValue, inputError, setInputError, actionError, menu, confirmDelete, setConfirmDelete, busy,
    targetDir, startCreate, startRename, askDelete, hintFor, cancelEdit, commit, trash, onRowClick, openMenu, onTreeKeyDown, entryOf, dirtyPaths
  }
}

/** ツリーの中のその場の名前の欄 */
function NameInput({ ops, depth, entry }: { ops: TreeOps; depth: number; entry?: FsEntry }) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const kind = ops.editing?.kind ?? 'file'
  const hint = ops.inputError ?? ops.hintFor(ops.value)

  // 名前の変更では拡張子の手前までを選ぶ（VS Code と同じ）
  useEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    if (entry) {
      const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
    }
  }, [entry])

  const field = (
    <div className="explorer__row explorer__row--input" style={{ '--depth': depth } as React.CSSProperties}>
      <span className="explorer__chevron-space" />
      {kind === 'directory' ? <Folder size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
      <span className="explorer__input-wrap">
        <input
          ref={ref}
          className={`explorer__input${hint ? ' is-invalid' : ''}`}
          value={ops.value}
          spellCheck={false}
          autoComplete="off"
          aria-label={entry ? `${t('fileExplorer.rename')}: ${entry.name}` : `${kind === 'directory' ? t('fileExplorer.newFolder') : t('fileExplorer.newFile')}: ${t('fileExplorer.nameLabel')}`}
          aria-invalid={hint ? true : undefined}
          readOnly={ops.busy}
          onChange={(e) => { ops.setValue(e.target.value); ops.setInputError(null) }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void ops.commit(true) }
            if (e.key === 'Escape') { e.preventDefault(); ops.cancelEdit() }
          }}
          onBlur={() => { if (!ops.busy) void ops.commit(false) }}
          data-testid="explorer-name-input"
        />
        {hint && <span className="explorer__input-hint" role="alert" data-testid="explorer-name-hint">{hint}</span>}
      </span>
    </div>
  )
  // 名前の変更は行（li）の中に、作成は新しい行として出す
  return entry ? field : <li role="treeitem" aria-selected="true">{field}</li>
}

/** 右クリックのメニュー */
function TreeMenu({ ops }: { ops: TreeOps }) {
  const t = useT()
  const menu = ops.menu!
  const mac = isMac()
  const entry = menu.entry
  const targets = entry ? (ops.selected.has(entry.path) ? [...ops.selected] : [entry.path]) : []
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  return (
    <div
      ref={ref}
      className="sb-menu explorer-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      data-testid="explorer-menu"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }}
    >
      <button type="button" role="menuitem" onClick={() => ops.startCreate('file', ops.targetDir(entry))} data-testid="explorer-menu-new-file">
        <FilePlus size={13} strokeWidth={1.75} />{t('fileExplorer.newFile')}
      </button>
      <button type="button" role="menuitem" onClick={() => ops.startCreate('directory', ops.targetDir(entry))} data-testid="explorer-menu-new-folder">
        <FolderPlus size={13} strokeWidth={1.75} />{t('fileExplorer.newFolder')}
      </button>
      {entry && (
        <>
          <div className="sb-menu__sep" role="separator" />
          <button type="button" role="menuitem" disabled={targets.length !== 1} onClick={() => ops.startRename(entry)} data-testid="explorer-menu-rename">
            <Pencil size={13} strokeWidth={1.75} />{t('fileExplorer.rename')}
            <span className="explorer-menu__key">{mac ? '↩' : 'F2'}</span>
          </button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => ops.askDelete(targets)} data-testid="explorer-menu-delete">
            <Trash2 size={13} strokeWidth={1.75} />{t('common.delete')}
            <span className="explorer-menu__key">{mac ? formatShortcut('Mod', 'Backspace') : 'Delete'}</span>
          </button>
        </>
      )}
    </div>
  )
}

/** 削除の確認（アプリ内のモーダル。ネイティブの確認は出さない） */
function DeleteDialog({ paths, dirty, onCancel, onConfirm }: { paths: string[]; dirty: string[]; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  const heading = paths.length === 1 ? t('fileExplorer.deleteHeading', { name: baseName(paths[0]!) }) : t('fileExplorer.deleteHeadingMany', { count: paths.length })
  const listed = paths.slice(0, MAX_LISTED_DELETE_NAMES)
  return (
    <Modal className="rv-modal" label={heading} onClose={onCancel}>
      <div className="rv-modal__panel unsaved-dialog" data-testid="explorer-delete-dialog">
        <header className="rv-modal__head">
          <h2><Trash2 size={15} aria-hidden="true" />{heading}</h2>
        </header>
        {paths.length > 1 && (
          <ul className="explorer-delete__list">
            {listed.map((p) => <li key={p}>{p}</li>)}
            {paths.length > listed.length && <li>…</li>}
          </ul>
        )}
        <p className="unsaved-dialog__body">{window.ade?.platform === 'win32' ? t('fileExplorer.deleteBodyWin') : t('fileExplorer.deleteBody')}</p>
        {dirty.length > 0 && (
          <p className="unsaved-dialog__body explorer-delete__warn" data-testid="explorer-delete-unsaved">
            {t('fileExplorer.deleteUnsaved', { names: dirty.map(baseName).join(', ') })}
          </p>
        )}
        <div className="unsaved-dialog__actions">
          <span className="editor-head__spacer" />
          <Button variant="ghost" onClick={onCancel} data-testid="explorer-delete-cancel">{t('common.cancel')}</Button>
          <Button variant="danger" onClick={onConfirm} data-testid="explorer-delete-confirm">{t('common.delete')}</Button>
        </div>
      </div>
    </Modal>
  )
}
