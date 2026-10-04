import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Ellipsis,
  History,
  Laptop,
  ListChecks,
  ListFilter,
  Eye,
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
  isFilterActive,
  reviewHeading,
  reviewHost,
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
 * - 絞り込み（検索・状態・指摘0件を隠す・アーカイブ・対象のホスト）は ReviewFilterBar。
 *   「Projects」の見出しの下に1つだけ置き、全プロジェクトの履歴に同じ条件で効く
 * - 行の右クリック／… から 名前の変更・アーカイブ・削除。指摘0件の下書きは ReviewFilterBar からまとめて削除できる
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
    ...(h.includedCount ? { progress: { done: Math.min(h.doneCount ?? 0, h.includedCount), total: h.includedCount, ...(h.humanReviewCount ? { humanReview: h.humanReviewCount } : {}) } } : {}),
    status: h.broken ? 'broken' : h.incomplete ? 'incomplete' : h.sentAt ? 'sent' : 'draft',
    group: formatDate(new Date(h.startedAt)),
    startedAt: h.startedAt,
    durationMs: h.durationMs,
    ...(h.title ? { title: h.title } : {}),
    ...(h.name ? { name: h.name } : {}),
    ...(h.autoName ? { autoName: h.autoName } : {}),
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

/** 全プロジェクト共通で1つ。この端末だけの好みなので localStorage に置く（読めなくても既定で動く） */
const FILTER_KEY = 'ade.sidebar.reviewFilter.all'
export function loadReviewFilter(): ReviewFilter {
  try {
    return sanitizeReviewFilter(JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null'))
  } catch { // ストレージが使えない・壊れた値（想定内。既定で続ける）
    return { ...DEFAULT_REVIEW_FILTER }
  }
}
export function saveReviewFilter(filter: ReviewFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter))
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
            {/* 送る指摘があれば「完了数/対象数」（progress.json）。すべて完了なら緑のチェック */}
            {session.progress
              ? <span className={`session__count${session.progress.done === session.progress.total ? ' is-complete' : ''}`} data-testid={`session-progress-${session.id}`}
                title={t('sidebar.progress', { done: session.progress.done, total: session.progress.total })}>
                {session.progress.done === session.progress.total
                  ? <CheckCircle2 size={11} strokeWidth={2} aria-hidden="true" />
                  : <ListChecks size={11} strokeWidth={2} aria-hidden="true" />}
                {session.progress.done}/{session.progress.total}
              </span>
              : <span className="session__count" title={t('sidebar.findingsCount', { count: session.findings })}>
                <ListChecks size={11} strokeWidth={2} aria-hidden="true" />
                {session.findings}
              </span>}
          </span>
          <span className="session__meta">
            <span className="session__when">
              {session.label}
              {duration && <span title={t('sidebar.duration', { value: duration })}> · {duration}</span>}
            </span>
            {/* Agent が直して人の確認を待っている指摘（human_review）があれば青の印と件数 */}
            {session.progress?.humanReview ? <span className="session__review" data-testid={`session-human-review-${session.id}`}
              title={t('sidebar.progressHumanReview', { count: session.progress.humanReview })} role="img" aria-label={t('sidebar.progressHumanReview', { count: session.progress.humanReview })}>
              <Eye size={11} strokeWidth={2.25} aria-hidden="true" />{session.progress.humanReview}
            </span> : null}
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

// ───────────────────────── 共通のフィルタ ─────────────────────────

/**
 * サイドバーの「Projects」の見出しのすぐ下に1つだけ置く絞り込み。すべてのプロジェクトの履歴に効く。
 * パネルはサイドバーの幅の中に収める（はみ出すとネイティブのビューに隠れ、見た目も崩れる）。
 */
export function ReviewFilterBar({
  filter,
  onChange,
  open,
  onOpenChange,
  hosts,
  emptyDraftCount,
  onDeleteEmpty,
  projectSection,
  projectFiltering = false
}: {
  filter: ReviewFilter
  onChange: (next: ReviewFilter) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 全プロジェクトから集めた対象のホスト */
  hosts: Array<{ host: string; count: number }>
  /** 読み込んだ全プロジェクトの、指摘0件の下書きの数 */
  emptyDraftCount: number
  onDeleteEmpty: () => void
  /** パネルの先頭に置く、プロジェクトの並び順と「☆ のみ」（Sidebar.tsx） */
  projectSection?: ReactNode
  /** プロジェクトを絞り込んでいる（☆ のみ）。漏斗のボタンを強調する */
  projectFiltering?: boolean
}) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const update = (patch: Partial<ReviewFilter>) => onChange({ ...filter, ...patch })
  const filtering = isFilterActive(filter)
  return (
    <div className="rv-filter-wrap">
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
          className={`rv-filter__toggle${filtering || projectFiltering ? ' is-active' : ''}`}
          selected={open}
          icon={<ListFilter size={14} strokeWidth={1.75} />}
          onClick={() => onOpenChange(!open)}
          data-testid="review-filter-toggle"
        />
      </div>

      {open && (
        <div className="rv-filter__panel" data-testid="review-filter-panel">
          {projectSection}
          <div className="rv-filter__label">{t('sidebar.filter.status')}</div>
          <div className="rv-filter__chips" role="group" aria-label={t('sidebar.filter.status')}>
            {REVIEW_STATUS_FILTERS.map((status) => {
              const on = filter.statuses.includes(status)
              return (
                <button
                  key={status}
                  type="button"
                  className="rv-filter__chip"
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
            <span>{t('sidebar.filter.hideEmpty')}</span>
          </label>
          <label className="rv-filter__check">
            <input type="checkbox" checked={filter.showArchived} onChange={(e) => update({ showArchived: e.target.checked })} />
            <span>{t('sidebar.filter.showArchived')}</span>
          </label>
          <div className="rv-filter__label">{t('sidebar.filter.target')}</div>
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
          {confirming ? (
            <div className="sb-confirm rv-filter__confirm">
              <span>{t('sidebar.deleteEmptyConfirm', { count: emptyDraftCount })}</span>
              <span className="sb-confirm__actions">
                <Button variant="ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
                <Button variant="danger" onClick={() => { setConfirming(false); onDeleteEmpty() }} data-testid="review-delete-confirm">
                  {t('common.delete')}
                </Button>
              </span>
            </div>
          ) : (
            <div className="rv-filter__actions">
              <Button variant="ghost" disabled={!filtering && !filter.query} onClick={() => onChange({ ...DEFAULT_REVIEW_FILTER })}>
                {t('sidebar.filter.reset')}
              </Button>
              <Button variant="ghost" className="rv-filter__danger" icon={<Trash2 size={13} />} disabled={emptyDraftCount === 0}
                onClick={() => setConfirming(true)} data-testid="review-delete-empty">
                {t('sidebar.deleteEmpty')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ───────────────────────── 一覧 ─────────────────────────

/** 右クリック／… のメニューの幅。サイドバーの中に収める（はみ出すとネイティブのビューに隠れる） */
const MENU_WIDTH = 176

export function ReviewList({
  folderPath,
  active,
  items,
  filter,
  selectedId,
  emptyText,
  onSelect,
  onChanged
}: {
  /** 開いていないプロジェクトのフォルダ。開いているプロジェクトなら undefined */
  folderPath?: string
  active: boolean
  items: ReviewSession[]
  /** 全プロジェクト共通の絞り込み（ReviewFilterBar） */
  filter: ReviewFilter
  selectedId: string | null
  emptyText: string
  onSelect: (id: string) => void
  /** 名前の変更・アーカイブ・削除のあと。消した ID を渡す */
  onChanged: (deletedIds: string[]) => void
}) {
  const t = useT()
  const toast = useToast()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

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

  const shown = filterReviews(sortReviews(items), filter)
  const menuSession = menu ? items.find((s) => s.id === menu.id) : undefined
  const confirmSession = confirmId ? items.find((s) => s.id === confirmId) : undefined

  return (
    <div className="sb-reviews" ref={rootRef}>
      {confirmSession && (
        <div className="sb-confirm">
          <span>{t('sidebar.deleteReviewConfirm', { name: reviewHeading(confirmSession) })}</span>
          <span className="sb-confirm__actions">
            <Button variant="ghost" onClick={() => setConfirmId(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmId(null)
                remove([confirmSession.id])
              }}
              data-testid="review-delete-confirm"
            >
              {t('common.delete')}
            </Button>
          </span>
        </div>
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
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); setConfirmId(menuSession.id) }}>
            <Trash2 size={13} strokeWidth={1.75} />{t('common.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
