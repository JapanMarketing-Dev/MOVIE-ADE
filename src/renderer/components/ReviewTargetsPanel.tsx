import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AppWindow, BookmarkPlus, Check, ChevronRight, Clock, FileCode, FileText, Folder, FolderOpen, Globe, Link, PencilLine, Plus, Search, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { expandedStorageKey } from '@shared/fileTreeState'
import { pageKey } from '@shared/page'
import { previewPathFromUrl } from '@shared/preview'
import { isPresetableUrl } from '@shared/projectUrl'
import { sanitizeProjectKind, urlTarget } from '@shared/projectTargets'
import { searchReviewPanel, splitHighlight, type PanelSearchHit, type PanelSearchSource } from '@shared/reviewPanelSearch'
import {
  buildTargetEntries,
  buildUrlTree,
  fileTargetEntry,
  isCurrentEntry,
  moveSelection,
  type TargetEntry,
  type UrlTreeGroup,
  type UrlTreeNode
} from '@shared/reviewTarget'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { requestTerminalCommand } from '../lib/terminalCommand'
import { Button, Field, IconButton, Spinner, useToast } from '../ui'
import { useFileTree, VirtualRows, type FileTreeRow } from './fileTree'
import { TargetPurposeIcon } from './TargetPurposeIcon'

/**
 * フィードバックモードの右パネル（レビュー対象）。
 *
 * 事前に設定したものが最初から全部並んでいて、1クリックで切り替えられる（1件ずつ足す必要はない）。
 *   - 確認先: プロジェクトの確認先（local / dev / prd・自由な名前・ウインドウ）。URL の確認先の下には、
 *     このプロジェクトで見たページをパスの木にして並べる（URL ツリー。shared/reviewTarget.ts の buildUrlTree）
 *   - ファイル: プロジェクトのフォルダツリー（右の Files パネルと同じ状態・同じ絞り込み。fileTree.tsx）。
 *     押すと ade-preview:// で開く（md / Mermaid は描画、それ以外のテキストは読み取り専用のコード）
 * 検索欄は1つで、確認先・ページ・ファイルをまとめて ⌘P と同じあいまい一致で探す（一致した文字を強調）。
 * ↑↓ と Enter、一覧に焦点があるときは 1〜9（見えている先頭の対象）で切り替える。録画は止めない。
 *
 * 対象を切り替えると、録画側の「ページが変わったら書き込みを確定して消す」流れ（controller.ts）がそのまま働き、
 * 指摘はそれぞれの対象に属する（分解は pipeline/draft.ts、整理は organize/targets.ts で区切る）。
 * 確認先に無い一度きりの URL は、確認先の末尾の「URL を開く…」から開ける（プロジェクトに保存もできる）。
 * 登録した URL（確認先）とは別に、「最近開いた URL」を新しい順に並べる。行の右の印でそのまま登録できる。
 *
 * 大きなリポジトリでも固まらないよう、フォルダは開いたときに読み、一覧は見えている行だけを描く。
 */

const ROW_HEIGHT = 28
/** 「最近開いた URL」に並べる件数 */
const RECENT_LIMIT = 15

/** 最近開いた URL の行の表示。パス（無ければ /）とホスト */
function recentParts(url: string): { name: string; detail: string } {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return { name: parsed.pathname.split('/').pop() || parsed.pathname, detail: parsed.pathname }
    return { name: `${parsed.pathname}${parsed.search}${parsed.hash}` || '/', detail: parsed.host }
  } catch {
    // 読めない値は履歴の側で弾いているが、念のためそのまま出す
    return { name: url, detail: '' }
  }
}

type PanelRow =
  | { type: 'section'; id: string; label: string }
  | { type: 'target'; id: string; entry: TargetEntry; registered: boolean }
  | { type: 'page'; id: string; node: UrlTreeNode }
  | { type: 'recent'; id: string; url: string; saved: boolean }
  | { type: 'add'; id: string }
  | { type: 'file'; id: string; row: FileTreeRow }
  | { type: 'hit'; id: string; hit: PanelSearchHit }
  | { type: 'note'; id: string; text: string }

const selectable = (row: PanelRow) => row.type !== 'section' && row.type !== 'note'
/** 押すと対象を開く行（1〜9 の番号を振るもの）。フォルダと「URL を開く…」は開かない */
const openable = (row: PanelRow) => row.type === 'target' || row.type === 'page' || row.type === 'recent' || row.type === 'hit' || (row.type === 'file' && row.row.entry.kind === 'file')

export function ReviewTargetsPanel({
  project,
  root,
  currentUrl,
  history,
  onOpenUrl,
  onOpenEditor,
  onSelectWindow,
  recording = false,
  onClose
}: {
  /** 今のプロジェクト（確認先・保存先）。開いていなければ null */
  project: Project | null
  /** プロジェクトのフォルダ（ファイルツリーの根） */
  root: string | null
  /** 内蔵ブラウザがいま出している URL */
  currentUrl: string
  /** このプロジェクトで開いた URL（新しい順。lib/urlHistory.ts）。配列でなくても buildUrlTree が直す */
  history?: unknown
  onOpenUrl: (url: string) => void
  /** 「エディタで開く」。録画は止めずにエディタモードへ移る */
  onOpenEditor: (path: string) => void
  /** ウインドウの確認先を録画の対象に選ぶ（App の selectWindowTarget。許可の確認と照合を済ませる） */
  onSelectWindow?: (windowMatch: string, launched: boolean) => void
  /** 録画中か。録画中は録画の対象（ウインドウ）を切り替えられない */
  recording?: boolean
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(-1)
  const [adding, setAdding] = useState<{ url: string; keep: boolean } | null>(null)
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  const tree = useFileTree(root, { expandedKey: project ? expandedStorageKey('feedbackTree', project.id) : null })

  // 検索に使うファイルの一覧（⌘P と同じ fs:files）。探し始めたときに1度だけ読む
  useEffect(() => setAllFiles(null), [root])
  useEffect(() => {
    if (!root || !query.trim() || allFiles) return
    let cancelled = false
    window.ade.invoke('fs:files').then((list) => { if (!cancelled) setAllFiles(list.files) }, () => { if (!cancelled) setAllFiles([]) })
    return () => { cancelled = true }
  }, [root, query, allFiles])

  const presets = project?.urls ?? []
  const kind = project?.kind
  const targets = useMemo(() => buildTargetEntries({ presets, ...(kind ? { projectKind: kind } : {}), files: [], recent: [] }), [presets, kind])
  const groups = useMemo(() => buildUrlTree(presets, history, kind), [presets, history, kind])
  const currentPath = previewPathFromUrl(currentUrl)

  // 確認先ごとに、その下の URL ツリーを並べる。ウインドウの確認先は木を持たない
  const targetRows = useMemo(() => {
    const rows: PanelRow[] = []
    const byId = new Map(groups.map((g) => [g.id, g]))
    const pushGroup = (group: UrlTreeGroup | undefined) => {
      for (const node of group?.nodes ?? []) rows.push({ type: 'page', id: `page:${node.key}`, node })
    }
    for (const entry of targets) {
      rows.push({ type: 'target', id: entry.id, entry, registered: true })
      const presetId = presets.find((p) => entry.id === `target:${p.id}` || (p.url && entry.url === p.url))?.id
      pushGroup(presetId ? byId.get(presetId) : undefined)
    }
    return rows
  }, [targets, groups, presets])

  // 最近開いた URL（新しい順）。登録した確認先とは別に、そのまま押して開ける
  const recentRows = useMemo<PanelRow[]>(() => {
    const list = Array.isArray(history) ? history.filter((u): u is string => typeof u === 'string' && u.length > 0) : []
    return list.slice(0, RECENT_LIMIT).map((url) => ({
      type: 'recent' as const,
      id: `recent:${url}`,
      url,
      saved: presets.some((p) => p.url && pageKey(p.url) === pageKey(url))
    }))
  }, [history, presets])

  const searchSources = useMemo<PanelSearchSource[]>(() => [...targetRows, ...recentRows].flatMap((row): PanelSearchSource[] => {
    if (row.type === 'target') return [{ id: row.id, kind: 'target', text: `${row.entry.title} ${row.entry.detail}` }]
    if (row.type === 'recent') return [{ id: row.id, kind: 'url', text: row.url }]
    if (row.type === 'page') {
      const group = groups.find((g) => row.node.key.startsWith(`${g.id}:`))
      return [{ id: row.id, kind: 'url', text: `${group?.label ?? ''} ${row.node.path}` }]
    }
    return []
  }), [targetRows, recentRows, groups])

  const searching = query.trim().length > 0
  const rows = useMemo<PanelRow[]>(() => {
    if (searching) {
      const hits = searchReviewPanel(query, searchSources, allFiles ?? [])
      if (hits.length === 0) return [{ type: 'note', id: 'note', text: allFiles ? t('feedbackTargets.noMatch') : t('feedbackTargets.loading') }]
      return hits.map((hit) => ({ type: 'hit', id: `hit:${hit.id}`, hit }))
    }
    const out: PanelRow[] = [{ type: 'section', id: 's:targets', label: t('feedbackTargets.group.saved') }]
    if (targetRows.length === 0) out.push({ type: 'note', id: 'n:targets', text: t('feedbackTargets.noSaved') })
    out.push(...targetRows, { type: 'add', id: 'add' })
    out.push({ type: 'section', id: 's:recent', label: t('feedbackTargets.group.recent') })
    if (recentRows.length === 0) out.push({ type: 'note', id: 'n:recent', text: t('feedbackTargets.noRecent') })
    else out.push(...recentRows)
    out.push({ type: 'section', id: 's:files', label: t('feedbackTargets.group.file') })
    if (!root) out.push({ type: 'note', id: 'n:files', text: t('fileExplorer.empty') })
    else if (tree.error) out.push({ type: 'note', id: 'n:files', text: tree.error })
    else out.push(...tree.rows.map((row) => ({ type: 'file' as const, id: `file:${row.entry.path}`, row })))
    return out
  }, [searching, query, searchSources, allFiles, targetRows, recentRows, root, tree.error, tree.rows, t])

  // 1〜9 は、見えている先頭の「開く行」に振る
  const numbers = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      if (map.size >= 9) break
      if (openable(row)) map.set(row.id, map.size + 1)
    }
    return map
  }, [rows])

  useEffect(() => setSelected(-1), [query])

  /** ウインドウ・起動コマンドの確認先。ツールバーの確認先（UrlPresets）と同じ順に動かす */
  const runWindowTarget = (entry: TargetEntry) => {
    let launched = false
    if (entry.launchCommand) {
      // ターミナルを開いていなければ、コマンドを知らせるだけにする（勝手に別の場所では走らせない）
      launched = requestTerminalCommand({ command: entry.launchCommand, title: entry.title })
      toast(launched
        ? { tone: 'info', message: t('projectTargets.launched', { command: entry.launchCommand }) }
        : { tone: 'warning', message: t('projectTargets.launchNoTerminal', { command: entry.launchCommand }) })
    }
    if (entry.url) onOpenUrl(entry.url)
    if (!entry.windowMatch) return
    // 録画の対象は録画を始めるときに決まるので、録画中は切り替えない
    if (recording) toast({ tone: 'warning', message: t('feedbackTargets.windowWhileRecording', { window: entry.windowMatch }) })
    else onSelectWindow?.(entry.windowMatch, launched)
  }

  const openFile = (path: string) => {
    const entry = fileTargetEntry(path)
    if (entry.url) onOpenUrl(entry.url)
  }

  const activate = (row: PanelRow | undefined) => {
    if (!row) return
    switch (row.type) {
      case 'target':
        if (row.entry.kind === 'window') runWindowTarget(row.entry)
        else if (row.entry.url) onOpenUrl(row.entry.url)
        return
      case 'page':
        onOpenUrl(row.node.url)
        return
      case 'recent':
        onOpenUrl(row.url)
        return
      case 'add':
        setAdding({ url: '', keep: false })
        return
      case 'file':
        if (row.row.entry.kind === 'directory') tree.toggleDir(row.row.entry)
        else openFile(row.row.entry.path)
        return
      case 'hit': {
        if (row.hit.kind === 'file') return openFile(row.hit.text)
        activate([...targetRows, ...recentRows].find((r) => r.id === row.hit.id))
        return
      }
    }
  }

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    const inField = event.target instanceof HTMLInputElement
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const pickable = rows.map((row, i) => (selectable(row) ? i : -1)).filter((i) => i >= 0)
      const at = pickable.indexOf(selected)
      const next = moveSelection(at, event.key === 'ArrowDown' ? 1 : -1, pickable.length)
      setSelected(next < 0 ? -1 : pickable[next]!)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      const target = rows[selected] ?? (inField ? rows.find(openable) : undefined)
      if (!target) return
      event.preventDefault()
      activate(target)
    } else if (!inField && /^[1-9]$/.test(event.key)) {
      // 一覧に焦点があるとき（検索欄の外）は、数字キーで番号の対象へ切り替える
      const id = [...numbers].find(([, n]) => n === Number(event.key))?.[0]
      if (!id) return
      event.preventDefault()
      activate(rows.find((r) => r.id === id))
    }
  }

  const commitAdd = async () => {
    if (!adding) return
    const url = adding.url.trim()
    if (!url) return
    try {
      if (adding.keep && project && isPresetableUrl(url) && !project.urls.some((u) => u.url === url)) {
        await window.ade.invoke('project:update', { ...project, urls: [...project.urls, urlTarget(url, sanitizeProjectKind(project.kind), project.urls)] })
      }
      onOpenUrl(url)
      setAdding(null)
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    }
  }

  /** 最近開いた URL を、そのままプロジェクトの確認先に登録する */
  const saveRecent = async (url: string) => {
    if (!project || !isPresetableUrl(url) || project.urls.some((u) => u.url && pageKey(u.url) === pageKey(url))) return
    try {
      await window.ade.invoke('project:update', { ...project, urls: [...project.urls, urlTarget(url, sanitizeProjectKind(project.kind), project.urls)] })
      toast({ tone: 'success', message: t('feedbackTargets.savedUrl', { url }) })
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    }
  }

  const isCurrent = (row: PanelRow): boolean => {
    if (row.type === 'target') return row.entry.kind === 'url' ? isCurrentEntry(row.entry, currentUrl) : false
    if (row.type === 'page') return !!currentUrl && pageKey(row.node.url) === pageKey(currentUrl)
    if (row.type === 'recent') return !!currentUrl && pageKey(row.url) === pageKey(currentUrl)
    if (row.type === 'file') return row.row.entry.path === currentPath
    if (row.type === 'hit') return row.hit.kind === 'file' ? row.hit.text === currentPath : isCurrent([...targetRows, ...recentRows].find((r) => r.id === row.hit.id) ?? row)
    return false
  }

  const renderRow = (row: PanelRow, index: number): ReactNode => {
    if (row.type === 'section') return <div className="fb-targets__group">{row.label}</div>
    if (row.type === 'note') return <p className="fb-targets__empty" title={row.text}>{row.text}</p>
    const current = isCurrent(row)
    const num = numbers.get(row.id)
    const className = `fb-target${current ? ' is-current' : ''}${index === selected ? ' is-selected' : ''}`
    const common = {
      role: 'option',
      'aria-selected': index === selected,
      className,
      onClick: () => { setSelected(index); activate(row) },
      'data-testid': 'feedback-target'
    } as const
    const tail = current ? <Check className="fb-target__current" size={13} strokeWidth={2} aria-label={t('feedbackTargets.current')} /> : null
    const numCell = <span className="fb-target__num" aria-hidden="true">{num ?? ''}</span>

    if (row.type === 'target') {
      const Icon = row.entry.kind === 'window' ? AppWindow : row.registered ? Link : Globe
      // デザイン・設計書の確認先は区分のアイコン（ツールバーと同じ）
      const purpose = row.entry.purpose
      return <div {...common} title={purpose ? `${t(`projectTargets.purpose.${purpose}`)} · ${row.entry.detail}` : row.entry.detail} data-purpose={purpose ?? 'app'}>
        {numCell}
        {purpose ? <TargetPurposeIcon purpose={purpose} className="fb-target__icon" size={14} /> : <Icon className="fb-target__icon" size={14} strokeWidth={1.75} aria-hidden="true" />}
        <span className="fb-target__name">{row.entry.title}</span>
        <span className="fb-target__detail">{row.entry.detail}</span>
        {tail}
      </div>
    }
    if (row.type === 'page') {
      return <div {...common} title={row.node.url} style={{ '--depth': row.node.depth + 1 } as React.CSSProperties}>
        {numCell}
        <span className="fb-target__indent" aria-hidden="true" />
        <span className={`fb-target__name fb-target__name--page${row.node.visited ? '' : ' is-folder'}`}>{row.node.visited ? row.node.name : `${row.node.name}/`}</span>
        {tail}
      </div>
    }
    if (row.type === 'recent') {
      const { name, detail } = recentParts(row.url)
      const canSave = !row.saved && !!project && isPresetableUrl(row.url)
      return <div {...common} title={row.url}>
        {numCell}
        <Clock className="fb-target__icon" size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="fb-target__name">{name}</span>
        <span className="fb-target__detail">{detail}</span>
        {tail}
        {canSave && (
          <button type="button" className="fb-target__editor" title={t('feedbackTargets.saveUrl')} aria-label={t('feedbackTargets.saveUrl')}
            onClick={(e) => { e.stopPropagation(); void saveRecent(row.url) }}>
            <BookmarkPlus size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>
    }
    if (row.type === 'add') {
      return <div {...common} className={`${className} fb-target--add`}>
        {numCell}
        <Plus className="fb-target__icon" size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="fb-target__name">{t('feedbackTargets.addUrl')}</span>
      </div>
    }
    if (row.type === 'file') {
      const { entry, depth } = row.row
      const isDir = entry.kind === 'directory'
      const open = isDir && tree.expanded.has(entry.path)
      return <div {...common} aria-expanded={isDir ? open : undefined} title={entry.path} style={{ '--depth': depth } as React.CSSProperties}>
        {numCell}
        <span className="fb-target__indent" aria-hidden="true" />
        {isDir ? <ChevronRight size={12} className={`fb-target__chevron${open ? ' is-open' : ''}`} aria-hidden="true" /> : <span className="fb-target__chevron-space" />}
        {isDir ? (open ? <FolderOpen className="fb-target__icon" size={14} aria-hidden="true" /> : <Folder className="fb-target__icon" size={14} aria-hidden="true" />)
          : <FileIcon path={entry.path} />}
        <span className="fb-target__name">{entry.name}</span>
        {tree.loading.has(entry.path) && <Spinner size={10} />}
        {tail}
        {!isDir && <EditorButton onClick={() => onOpenEditor(entry.path)} label={t('feedbackTargets.openEditor')} />}
      </div>
    }
    // 検索の結果。一致した文字を強調する
    const { hit } = row
    const Icon = hit.kind === 'file' ? null : hit.kind === 'target' ? Link : Globe
    return <div {...common} title={hit.text}>
      {numCell}
      {Icon ? <Icon className="fb-target__icon" size={14} strokeWidth={1.75} aria-hidden="true" /> : <FileIcon path={hit.text} />}
      <span className="fb-target__name fb-target__name--hit">
        {splitHighlight(hit.text, hit.indices).map((part, i) => part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)}
      </span>
      {tail}
      {hit.kind === 'file' && <EditorButton onClick={() => onOpenEditor(hit.text)} label={t('feedbackTargets.openEditor')} />}
    </div>
  }

  return (
    <aside className="fb-targets" aria-label={t('feedbackTargets.title')} data-testid="feedback-targets" onKeyDown={onKey}>
      <header className="fb-targets__head">
        <span className="fb-targets__title">{t('feedbackTargets.title')}</span>
        <IconButton size="sm" label={t('feedbackTargets.close')} title={t('feedbackTargets.close')} icon={<X size={14} />} onClick={onClose} />
      </header>

      <div className="fb-targets__search">
        <Field
          icon={<Search size={12} strokeWidth={2} />}
          type="search"
          value={query}
          placeholder={t('feedbackTargets.search')}
          aria-label={t('feedbackTargets.search')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
          data-testid="feedback-targets-search"
        />
      </div>

      {adding && (
        <form className="fb-targets__add" onSubmit={(e) => { e.preventDefault(); void commitAdd() }}>
          <Field
            autoFocus
            icon={<Globe size={12} />}
            value={adding.url}
            placeholder="https://"
            aria-label={t('feedbackTargets.addUrl')}
            onChange={(e) => setAdding({ ...adding, url: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') setAdding(null) }}
          />
          <label className="fb-targets__keep">
            <input type="checkbox" checked={adding.keep} disabled={!project} onChange={(e) => setAdding({ ...adding, keep: e.target.checked })} />
            <span>{t('feedbackTargets.keepInProject')}</span>
          </label>
          <div className="fb-targets__add-actions">
            <Button variant="ghost" onClick={() => setAdding(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!adding.url.trim()} onClick={() => void commitAdd()}>{t('feedbackTargets.open')}</Button>
          </div>
        </form>
      )}

      <VirtualRows
        className="fb-targets__list"
        role="listbox"
        ariaLabel={t('feedbackTargets.title')}
        items={rows}
        rowHeight={ROW_HEIGHT}
        scrollTo={selected}
        render={renderRow}
      />
      <p className="fb-targets__hint">{t('feedbackTargets.hint')}</p>
    </aside>
  )
}

function FileIcon({ path }: { path: string }) {
  const Icon = /\.(md|markdown|mdx|mmd|mermaid)$/i.test(path) ? FileText : FileCode
  return <Icon className="fb-target__icon" size={14} strokeWidth={1.75} aria-hidden="true" />
}

function EditorButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="fb-target__editor" title={label} aria-label={label} onClick={(e) => { e.stopPropagation(); onClick() }}>
      <PencilLine size={13} strokeWidth={1.75} />
    </button>
  )
}
