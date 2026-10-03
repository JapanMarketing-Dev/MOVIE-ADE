import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Check, FileCode, FilePlus, FileText, Globe, History, Link, PencilLine, Plus, Search, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { defaultUrlLabel, isPresetableUrl } from '@shared/projectUrl'
import {
  buildTargetEntries,
  filterTargetEntries,
  isCurrentEntry,
  moveSelection,
  pushRecentUrl,
  type TargetEntry,
  type TargetEntryGroup
} from '@shared/reviewTarget'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, IconButton, useToast } from '../ui'

/**
 * フィードバックモードの右パネル（レビュー対象の一覧）。
 *
 * 登録URL（local / dev / prd）、エディタで開いているファイル、最近開いたURLを並べ、
 * 押すと内蔵ブラウザにその対象を出す。録画は止めない。
 * 対象を切り替えると、録画側の「ページが変わったら書き込みを確定して消す」流れ
 * （controller.ts）がそのまま働き、指摘はそれぞれの対象に属する（分解は pipeline/draft.ts で区切る）。
 *
 * 操作: 検索欄で絞る / ↑↓ と Enter / 一覧に焦点があるときは 1〜9 で切り替え。
 * ＋ で URL を入力して足す（プロジェクトの登録URLに保存するか選べる）、ファイルを選んで足す。
 *
 * 最近のURLと足したファイルは、プロジェクトごとにこの端末に覚える（localStorage。読めなくても動く）。
 */

const GROUP_ICON = { preset: Link, file: FileText, recent: History } as const
const GROUP_LABEL = {
  preset: 'feedbackTargets.group.preset',
  file: 'feedbackTargets.group.file',
  recent: 'feedbackTargets.group.recent'
} as const

function load(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(0, 20) : []
  } catch { // ストレージが使えない・壊れた値（想定内。既定で続ける）
    return []
  }
}
function save(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

export function ReviewTargetsPanel({
  project,
  openFiles,
  currentUrl,
  addedFile,
  onOpenUrl,
  onOpenEditor,
  onPickFile,
  onClose
}: {
  /** 今のプロジェクト（登録URL・保存先）。開いていなければ null */
  project: Project | null
  /** エディタで開いているファイル（相対パス） */
  openFiles: readonly string[]
  /** 内蔵ブラウザがいま出している URL */
  currentUrl: string
  /** 「ファイルを選ぶ」で選ばれたファイル。変わったら一覧に足して開く */
  addedFile: { path: string; at: number } | null
  onOpenUrl: (url: string) => void
  /** 「エディタで開く」。録画は止めずにエディタモードへ移る */
  onOpenEditor: (path: string) => void
  /** ファイルを選ぶ画面を開く */
  onPickFile: () => void
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const projectId = project?.id ?? 'none'
  const recentKey = `ade.feedback.recent.${projectId}`
  const filesKey = `ade.feedback.files.${projectId}`
  const [recent, setRecent] = useState<string[]>(() => load(recentKey))
  const [extraFiles, setExtraFiles] = useState<string[]>(() => load(filesKey))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(-1)
  const [adding, setAdding] = useState<{ url: string; keep: boolean } | null>(null)

  // プロジェクトを切り替えたら、そのプロジェクトの覚えを読み直す
  useEffect(() => {
    setRecent(load(recentKey))
    setExtraFiles(load(filesKey))
  }, [recentKey, filesKey])

  // 内蔵ブラウザで開いたURLを「最近」に積む（about:blank は除く）
  useEffect(() => {
    if (!currentUrl || currentUrl === 'about:blank') return
    setRecent((prev) => {
      const next = pushRecentUrl(prev, currentUrl)
      save(recentKey, next)
      return next
    })
  }, [currentUrl, recentKey])

  // ファイルを選ぶ画面で選ばれたら、一覧に足して開く
  useEffect(() => {
    if (!addedFile) return
    setExtraFiles((prev) => {
      const next = [addedFile.path, ...prev.filter((p) => p !== addedFile.path)].slice(0, 20)
      save(filesKey, next)
      return next
    })
    const entry = buildTargetEntries({ presets: [], files: [addedFile.path], recent: [] })[0]
    if (entry?.url) onOpenUrl(entry.url)
    else onOpenEditor(addedFile.path)
    // addedFile.at が変わったときだけ動かす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedFile?.at])

  const files = useMemo(() => [...new Set([...openFiles, ...extraFiles])], [openFiles, extraFiles])
  const entries = useMemo(
    () => buildTargetEntries({ presets: project?.urls ?? [], files, recent, currentUrl }),
    [project?.urls, files, recent, currentUrl]
  )
  const shown = filterTargetEntries(entries, query)

  const activate = (entry: TargetEntry | undefined) => {
    if (!entry) return
    if (entry.url) onOpenUrl(entry.url)
    else if (entry.path) onOpenEditor(entry.path)
  }

  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    const inField = event.target instanceof HTMLInputElement
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((i) => moveSelection(i, event.key === 'ArrowDown' ? 1 : -1, shown.length))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && selected >= 0) {
      event.preventDefault()
      activate(shown[selected])
    } else if (!inField && /^[1-9]$/.test(event.key)) {
      // 一覧に焦点があるとき（検索欄の外）は、数字キーで並びの番号の対象へ切り替える
      event.preventDefault()
      activate(shown[Number(event.key) - 1])
    }
  }

  const commitAdd = async () => {
    if (!adding) return
    const url = adding.url.trim()
    if (!url) return
    try {
      if (adding.keep && project && isPresetableUrl(url) && !project.urls.some((u) => u.url === url)) {
        await window.ade.invoke('project:update', { ...project, urls: [...project.urls, { id: crypto.randomUUID(), label: defaultUrlLabel(url), url }] })
      }
      onOpenUrl(url)
      setAdding(null)
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    }
  }

  let lastGroup: TargetEntryGroup | null = null
  return (
    <aside className="fb-targets" aria-label={t('feedbackTargets.title')} data-testid="feedback-targets" onKeyDown={onListKey}>
      <header className="fb-targets__head">
        <span className="fb-targets__title">{t('feedbackTargets.title')}</span>
        <IconButton size="sm" label={t('feedbackTargets.addUrl')} title={t('feedbackTargets.addUrl')} icon={<Plus size={14} />}
          onClick={() => setAdding(adding ? null : { url: '', keep: false })} data-testid="feedback-targets-add" />
        <IconButton size="sm" label={t('feedbackTargets.addFile')} title={t('feedbackTargets.addFile')} icon={<FilePlus size={14} />} onClick={onPickFile} />
        <IconButton size="sm" label={t('feedbackTargets.close')} title={t('feedbackTargets.close')} icon={<X size={14} />} onClick={onClose} />
      </header>

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

      <div className="fb-targets__search">
        <Field
          icon={<Search size={12} strokeWidth={2} />}
          type="search"
          value={query}
          placeholder={t('feedbackTargets.search')}
          aria-label={t('feedbackTargets.search')}
          onChange={(e) => { setQuery(e.target.value); setSelected(-1) }}
          data-testid="feedback-targets-search"
        />
      </div>

      <div className="fb-targets__list" role="listbox" aria-label={t('feedbackTargets.title')} tabIndex={0}>
        {shown.length === 0 && <p className="fb-targets__empty">{entries.length === 0 ? t('feedbackTargets.empty') : t('feedbackTargets.noMatch')}</p>}
        {shown.map((entry, index) => {
          const header = entry.group !== lastGroup ? GROUP_LABEL[entry.group] : null
          lastGroup = entry.group
          const Icon = entry.kind === 'file' ? (/\.(md|markdown|mdx|mmd|mermaid)$/i.test(entry.path ?? '') ? FileText : FileCode) : GROUP_ICON[entry.group]
          const current = isCurrentEntry(entry, currentUrl)
          return (
            <div key={entry.id} className="fb-targets__item-wrap">
              {header && <div className="fb-targets__group">{t(header)}</div>}
              <div
                role="option"
                aria-selected={index === selected}
                className={`fb-target${current ? ' is-current' : ''}${index === selected ? ' is-selected' : ''}`}
                title={entry.detail}
                onClick={() => { setSelected(index); activate(entry) }}
                data-testid="feedback-target"
              >
                <span className="fb-target__num" aria-hidden="true">{index < 9 ? index + 1 : ''}</span>
                <Icon className="fb-target__icon" size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="fb-target__body">
                  <span className="fb-target__title">
                    {entry.label && entry.group !== 'preset' && <span className="fb-target__env">{entry.label}</span>}
                    <span className="fb-target__name">{entry.title}</span>
                  </span>
                  <span className="fb-target__detail">{entry.detail}</span>
                </span>
                {current && <Check className="fb-target__current" size={14} strokeWidth={2} aria-label={t('feedbackTargets.current')} />}
                {entry.path && (
                  <button
                    type="button"
                    className="fb-target__editor"
                    title={t('feedbackTargets.openEditor')}
                    aria-label={t('feedbackTargets.openEditor')}
                    onClick={(e) => { e.stopPropagation(); onOpenEditor(entry.path!) }}
                  >
                    <PencilLine size={13} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="fb-targets__hint">{t('feedbackTargets.hint')}</p>
    </aside>
  )
}
