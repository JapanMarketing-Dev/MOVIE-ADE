import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  History,
  Laptop,
  ListChecks,
  ListFilter,
  PenLine,
  Pencil,
  Search,
  Send,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { ReviewSummary } from '@shared/review'
import {
  DEFAULT_REVIEW_FILTER,
  REVIEW_STATUS_FILTERS,
  filterReviews,
  formatReviewDuration,
  isEmptyDraft,
  isFilterActive,
  reviewHeading,
  reviewHost,
  reviewHosts,
  sanitizeReviewFilter,
  sortReviews,
  type ReviewFilter,
  type ReviewListEntry
} from '@shared/reviewList'
import { formatDate, formatTime, t as tNow } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT, type TFunction } from '../lib/i18n'
import { Button, Field, IconButton, useToast } from '../ui'

/**
 * サイドバーの、プロジェクトの下に入れ子で並ぶレビュー履歴（Sidebar.tsx から切り出し）。
 *
 * 試しの録画（指摘0件の下書き）が並ぶと、時刻とホストだけでは見分けが付かない。そこで:
 * - 見出しは ページのタイトル（付けた名前があればそれ。無ければURLのパス）。時刻・長さ・件数・状態は2行目
 * - 一覧の上に小さなフィルタ（検索・状態・指摘0件を隠す・アーカイブ・対象のホスト）。
 *   選んだ状態はプロジェクトごとにこの端末に覚える（localStorage。読めなくても既定で動く）
 * - 行の右クリック／… から 名前の変更・アーカイブ・削除。指摘0件の下書きはまとめて削除できる
 */

export interface ReviewSession extends ReviewListEntry {
  /** 録画した時刻（2行目に出す） */
  label: string
  /** 日付のまとまり。既存のADEが Pinned / In progress で束ねているのと同じ役目 */
  group: string
  durationMs?: number
}

const STATUS = {
  draft: { label: 'sidebar.status.draft', icon: PenLine },
  sent: { label: 'sidebar.status.sent', icon: Send },
  incomplete: { label: 'sidebar.status.incomplete', icon: History },
  broken: { label: 'sidebar.status.broken', icon: TriangleAlert }
} as const

/** 履歴の要約を一覧の1件にする（開いていないプロジェクトの履歴もこれで揃える） */
export function toReviewSession(h: ReviewSummary): ReviewSession {
  return {
    id: h.id,
    label: formatTime(new Date(h.startedAt)),
    target: h.targetUrl ?? tNow('app.reviewFallbackTitle'),
    findings: h.itemCount,
    status: h.broken ? 'broken' : h.incomplete ? 'incomplete' : h.sentAt ? 'sent' : 'draft',
    group: formatDate(new Date(h.startedAt)),
    startedAt: h.startedAt,
    durationMs: h.durationMs,
    ...(h.title ? { title: h.title } : {}),
    ...(h.name ? { name: h.name } : {}),
    ...(h.archived ? { archived: true } : {}),
    ...(h.searchText ? { searchText: h.searchText } : {})
  }
}

/** 日付のまとまりごとに切り分ける（配列の順序はそのまま使う） */
function groupSessions(sessions: ReviewSession[]): Array<[string, ReviewSession[]]> {
  const groups: Array<[string, ReviewSession[]]> = []
  for (const session of sessions) {
    const last = groups[groups.length - 1]
    if (last && last[0] === session.group) last[1].push(session)
    else groups.push([session.group, [session]])
  }
  return groups
}

/** 「2026/10/3」のような日付を、今日・昨日なら言い換える */
function groupLabel(group: string, t: TFunction): string {
  const day = (offset: number) => formatDate(Date.now() - offset * 86_400_000)
  if (group === day(0)) return t('sidebar.today')
  if (group === day(1)) return t('sidebar.yesterday')
  return group
}

/** 対象サイトの頭文字。手元の開発サーバーは文字では見分けにくいので、端末の印にする */
function monogram(host: string): ReactNode {
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    return <Laptop size={13} strokeWidth={2} />
  }
  return (host.replace(/^www\./, '').match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase()
}

// ───────────────────────── フィルタの保存 ─────────────────────────

const FILTER_KEY = 'ade.sidebar.reviewFilter'
function loadFilter(projectId: string): ReviewFilter {
  try {
    const all = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') as Record<string, unknown>
    return sanitizeReviewFilter(all?.[projectId])
  } catch {
    return { ...DEFAULT_REVIEW_FILTER }
  }
}
function saveFilter(projectId: string, filter: ReviewFilter): void {
  try {
    const all = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') as Record<string, unknown>
    localStorage.setItem(FILTER_KEY, JSON.stringify({ ...(all && typeof all === 'object' ? all : {}), [projectId]: filter }))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

// ───────────────────────── 1件 ─────────────────────────

function SessionCard({
  session,
  selected,
  onSelect,
  onMenu
}: {
  session: ReviewSession
  selected: boolean
  onSelect: () => void
  onMenu: (x: number, y: number) => void
}) {
  const t = useT()
  const host = reviewHost(session.target) || session.target
  const status = STATUS[session.status]
  const StatusIcon = status.icon
  const heading = reviewHeading(session)
  const duration = formatReviewDuration(session.durationMs)
  return (
    <div
      className="session-row"
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <button
        type="button"
        role="listitem"
        className={`session${selected ? ' is-selected' : ''}${session.archived ? ' is-archived' : ''}`}
        aria-current={selected || undefined}
        onClick={onSelect}
        title={[heading, session.target].filter((v, i, a) => a.indexOf(v) === i).join('\n')}
        data-testid={`session-${session.id}`}
      >
        <span className="session__tile" aria-hidden="true">{monogram(host)}</span>
        <span className="session__body">
          <span className="session__head">
            <span className="session__label">{heading}</span>
            {session.archived && <Archive className="session__archived" size={11} strokeWidth={2} aria-label={t('sidebar.archived')} />}
            <span className="session__count" title={t('sidebar.findingsCount', { count: session.findings })}>
              <ListChecks size={11} strokeWidth={2} aria-hidden="true" />
              {session.findings}
            </span>
          </span>
          <span className="session__meta">
            <span className="session__when">
              {session.label}
              {duration && <span title={t('sidebar.duration', { value: duration })}> · {duration}</span>}
            </span>
            {/* 幅が足りないので札はアイコンだけ。状態の名前は title と読み上げで出す（フィルタの札には文字がある） */}
            <span className={`session__status session__status--${session.status} session__status--icon`} title={t(status.label)} role="img" aria-label={t(status.label)}>
              <StatusIcon size={10} strokeWidth={2.25} aria-hidden="true" />
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="session-row__more"
        aria-label={t('sidebar.reviewMenu', { name: heading })}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(r.right, r.bottom + 2)
        }}
      >
        <Ellipsis size={14} strokeWidth={1.5} />
      </button>
    </div>
  )
}

// ───────────────────────── 一覧 ─────────────────────────

/** 右クリック／… のメニューの幅。サイドバーの中に収める（はみ出すとネイティブのビューに隠れる） */
const MENU_WIDTH = 176

export function ReviewList({
  projectId,
  folderPath,
  active,
  items,
  selectedId,
  emptyText,
  onSelect,
  onChanged
}: {
  projectId: string
  /** 開いていないプロジェクトのフォルダ。開いているプロジェクトなら undefined */
  folderPath?: string
  active: boolean
  items: ReviewSession[]
  selectedId: string | null
  emptyText: string
  onSelect: (id: string) => void
  /** 名前の変更・アーカイブ・削除のあと。消した ID を渡す */
  onChanged: (deletedIds: string[]) => void
}) {
  const t = useT()
  const toast = useToast()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>(() => loadFilter(projectId))
  const [panelOpen, setPanelOpen] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'delete'; id: string } | { kind: 'deleteEmpty' } | null>(null)

  const update = (patch: Partial<ReviewFilter>) => {
    setFilter((prev) => {
      const next = { ...prev, ...patch }
      saveFilter(projectId, next)
      return next
    })
  }

  // メニューは外側のクリックと Esc で閉じる
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.sb-menu')) setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const run = (fn: () => Promise<unknown>) => {
    void fn().catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const openMenuAt = (id: string, clientX: number, clientY: number) => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return
    const x = Math.max(0, Math.min(clientX - box.left, box.width - MENU_WIDTH))
    setMenu({ id, x, y: Math.max(0, clientY - box.top) })
  }

  const remove = (ids: string[]) => run(async () => {
    const deleted = await window.ade.invoke('review:delete', ids, folderPath)
    if (deleted.length) toast({ tone: 'success', message: t('sidebar.deleted', { count: deleted.length }) })
    onChanged(deleted)
  })

  const label = (id: string, patch: { name?: string | null; archived?: boolean }) => run(async () => {
    await window.ade.invoke('review:label', id, patch, folderPath)
    onChanged([])
  })

  const commitRename = () => {
    const current = renaming
    setRenaming(null)
    const session = items.find((s) => s.id === current?.id)
    if (!current || !session) return
    const name = current.name.trim()
    if (name === (session.name ?? '')) return
    label(current.id, { name: name || null })
  }

  if (items.length === 0) return <p className="sb-project__empty">{emptyText}</p>

  const sorted = sortReviews(items)
  const shown = filterReviews(sorted, filter)
  const emptyDrafts = items.filter(isEmptyDraft)
  const hosts = reviewHosts(items)
  const filtering = isFilterActive(filter)
  const menuSession = menu ? items.find((s) => s.id === menu.id) : undefined
  const confirmSession = confirm?.kind === 'delete' ? items.find((s) => s.id === confirm.id) : undefined

  return (
    <div className="rv-list" ref={rootRef}>
      <div className="rv-filter">
        <Field
          className="rv-filter__search"
          icon={<Search size={12} strokeWidth={2} />}
          type="search"
          value={filter.query}
          placeholder={t('sidebar.filter.search')}
          aria-label={t('sidebar.filter.search')}
          onChange={(e) => update({ query: e.target.value })}
          data-testid="review-filter-search"
        />
        <IconButton
          size="sm"
          label={t('sidebar.filter.open')}
          title={t('sidebar.filter.open')}
          className={`rv-filter__toggle${filtering ? ' is-active' : ''}`}
          selected={panelOpen}
          icon={<ListFilter size={14} strokeWidth={1.75} />}
          onClick={() => setPanelOpen((v) => !v)}
          data-testid="review-filter-toggle"
        />
      </div>

      {panelOpen && (
        <div className="rv-filter__panel" data-testid="review-filter-panel">
          <div className="rv-filter__row" role="group" aria-label={t('sidebar.filter.status')}>
            {REVIEW_STATUS_FILTERS.map((status) => {
              const on = filter.statuses.includes(status)
              return (
                <button
                  key={status}
                  type="button"
                  className="rv-chip"
                  aria-pressed={on}
                  onClick={() => update({ statuses: on ? filter.statuses.filter((s) => s !== status) : [...filter.statuses, status] })}
                >
                  {t(STATUS[status].label)}
                </button>
              )
            })}
          </div>
          <label className="rv-filter__check">
            <input type="checkbox" checked={filter.hideEmpty} onChange={(e) => update({ hideEmpty: e.target.checked })} />
            {t('sidebar.filter.hideEmpty')}
          </label>
          <label className="rv-filter__check">
            <input type="checkbox" checked={filter.showArchived} onChange={(e) => update({ showArchived: e.target.checked })} />
            {t('sidebar.filter.showArchived')}
          </label>
          <select
            className="rv-filter__select"
            aria-label={t('sidebar.filter.target')}
            value={filter.host ?? ''}
            onChange={(e) => update({ host: e.target.value || null })}
          >
            <option value="">{t('sidebar.filter.allTargets')}</option>
            {hosts.map(({ host, count }) => <option key={host} value={host}>{`${host} (${count})`}</option>)}
            {filter.host && !hosts.some((h) => h.host === filter.host) && <option value={filter.host}>{filter.host}</option>}
          </select>
          <div className="rv-filter__actions">
            <Button variant="ghost" disabled={!filtering && !filter.query} onClick={() => update({ ...DEFAULT_REVIEW_FILTER })}>
              {t('sidebar.filter.reset')}
            </Button>
            <Button variant="ghost" className="rv-filter__danger" icon={<Trash2 size={13} />} disabled={emptyDrafts.length === 0}
              onClick={() => setConfirm({ kind: 'deleteEmpty' })} data-testid="review-delete-empty">
              {t('sidebar.deleteEmpty')}
            </Button>
          </div>
        </div>
      )}

      {confirm && (
        <div className="sb-confirm">
          <span>
            {confirm.kind === 'deleteEmpty'
              ? t('sidebar.deleteEmptyConfirm', { count: emptyDrafts.length })
              : t('sidebar.deleteReviewConfirm', { name: confirmSession ? reviewHeading(confirmSession) : '' })}
          </span>
          <span className="sb-confirm__actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const ids = confirm.kind === 'deleteEmpty' ? emptyDrafts.map((s) => s.id) : [confirm.id]
                setConfirm(null)
                remove(ids)
              }}
              data-testid="review-delete-confirm"
            >
              {t('common.delete')}
            </Button>
          </span>
        </div>
      )}

      {shown.length < items.length && (
        <div className="rv-filter__count">{t('sidebar.filter.shown', { shown: shown.length, total: items.length })}</div>
      )}

      {shown.length === 0 ? (
        <p className="sb-project__empty">{t('sidebar.filter.noMatch')}</p>
      ) : (
        groupSessions(shown).map(([group, list]) => (
          <div key={group} className="sidebar__group" role="list">
            <div className="sb-group">{groupLabel(group, t)}</div>
            {list.map((session) =>
              renaming?.id === session.id ? (
                <div key={session.id} className="session-row is-editing">
                  <Field
                    autoFocus
                    aria-label={t('sidebar.reviewName')}
                    value={renaming.name}
                    placeholder={reviewHeading({ ...session, name: undefined })}
                    onChange={(e) => setRenaming({ id: session.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={commitRename}
                  />
                </div>
              ) : (
                <SessionCard
                  key={session.id}
                  session={session}
                  selected={active && session.id === selectedId}
                  onSelect={() => onSelect(session.id)}
                  onMenu={(x, y) => openMenuAt(session.id, x, y)}
                />
              )
            )}
          </div>
        ))
      )}

      {menu && menuSession && (
        <div className="sb-menu" role="menu" style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }} data-testid="review-context">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming({ id: menuSession.id, name: menuSession.name ?? '' }) }}>
            <Pencil size={13} strokeWidth={1.75} />{t('sidebar.rename')}
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); label(menuSession.id, { archived: !menuSession.archived }) }}>
            {menuSession.archived ? <ArchiveRestore size={13} strokeWidth={1.75} /> : <Archive size={13} strokeWidth={1.75} />}
            {menuSession.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          </button>
          <div className="sb-menu__sep" role="separator" />
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); setConfirm({ kind: 'delete', id: menuSession.id }) }}>
            <Trash2 size={13} strokeWidth={1.75} />{t('common.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
