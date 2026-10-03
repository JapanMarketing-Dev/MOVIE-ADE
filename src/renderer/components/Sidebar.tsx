import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  ChevronDown,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Settings2,
  Trash2
} from 'lucide-react'
import type { Project, ProjectsState } from '@shared/types'
import { formatShortcut } from '../lib/shortcut'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, EmptyState, Field, IconButton, useToast } from '../ui'
import { filterReviews, isEmptyDraft, reviewHosts, type ReviewFilter } from '@shared/reviewList'
import { PanelCloseButton } from './LayoutToggles'
import { ProjectEditDialog } from './ProjectTargetsEditor'
import { AddProjectDialog, ProjectSourceIcon } from './AddProjectDialog'
import type { ProjectSource } from '@shared/projectSource'
import { sshTargetLabel } from '@shared/sshCommand'
import type { TranslationKey } from '@shared/i18n'
import { ReviewFilterBar, ReviewList, loadReviewFilter, saveReviewFilter, toReviewSession, type ReviewSession } from './ReviewList'
import { SetupProgressLink } from '../onboarding/SetupChecklist'
import { FeedbackLink } from './FeedbackDialog'

export { toReviewSession, type ReviewSession }

/**
 * 左サイドバー（240px）。登録したプロジェクトの一覧と、その下に入れ子でレビュー履歴。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/sidebar/ の Projects 節（MIT）。
 *   - 節の見出し「Projects」と右端の ＋（SidebarHeader.tsx）
 *   - プロジェクトの行: 色つきのアイコン・太字の名前・触れたときだけ出る … と折りたたみ
 *     （worktree-list/rows/SectionHeader.tsx, ProjectHeaderActions.tsx）
 *   - 子の行を1段（18px）字下げして並べる（worktree-list/rows/indentation.ts の SIDEBAR_TREE_INDENT）
 *   - 右クリック／… のメニュー（repo-header-project-actions.tsx）。名前の変更と登録解除だけ
 * Orca で worktree が並ぶ位置に、このアプリではレビュー履歴を置く。
 * 動画フィードバックに集中するため、並べ替え・色・グループ・Finder連携は持ち込まない。
 *
 * レビュー履歴の一覧（フィルタ・1件の行・名前の変更／アーカイブ／削除）は ReviewList.tsx。
 */

/** 折りたたみの状態はこの端末だけの好みなので localStorage に置く（読めなくても既定で動く） */
const OPEN_KEY = 'ade.sidebar.openProjects'
function loadOpen(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
  } catch {
    // ストレージが使えない・壊れた値（想定内。既定で続ける）
    return {}
  }
}
function saveOpen(open: Record<string, boolean>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

/** 右クリック／… で開くメニュー。サイドバーの中に収める（右へはみ出すとネイティブのビューに隠れる） */
const MENU_WIDTH = 188

export function Sidebar({
  projects,
  activeProjectId,
  sessions,
  selectedId,
  onSelect,
  onNewReview,
  recording = false,
  onHistoryChanged,
  onOverlayChange
}: {
  projects: ProjectsState
  /** 開いているプロジェクト。sessions はこのプロジェクトの履歴 */
  activeProjectId: string | null
  sessions: ReviewSession[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** そのプロジェクトで新しいレビュー（録画）を始める。開いていなければ切り替えてから（App が行う） */
  onNewReview: (projectId: string) => void
  /** 録画中は ＋ を押せなくする（⌘⇧R と違い、＋ で録画を止めないため） */
  recording?: boolean
  /** 開いているプロジェクトの履歴を名前の変更・アーカイブ・削除したあと。消した ID を渡す */
  onHistoryChanged?: (deletedIds: string[]) => void
  /** 「プロジェクトを編集」のダイアログの開閉。開いている間は内蔵ブラウザのビューを隠す */
  onOverlayChange?: (open: boolean) => void
}) {
  const recordKey = formatShortcut('Mod', 'Shift', 'R')
  const toast = useToast()
  const t = useT()
  const rootRef = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen)
  /** 開いていないプロジェクトの履歴。開いた（展開した）ときに読み込む */
  const [others, setOthers] = useState<Record<string, ReviewSession[]>>({})
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenamingState] = useState<{ id: string; name: string } | null>(null)
  const renamingRef = useRef<{ id: string; name: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  /** 「プロジェクトを編集」で開いているプロジェクト */
  const [editingId, setEditingId] = useState<string | null>(null)
  const openEdit = (id: string | null) => {
    setEditingId(id)
    onOverlayChange?.(id !== null)
  }

  const setRenaming = (next: { id: string; name: string } | null) => {
    renamingRef.current = next
    setRenamingState(next)
  }

  const run = useCallback((fn: () => Promise<unknown>) => {
    void fn().catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, [toast])

  // 既定では、開いているプロジェクトだけ展開する
  const isOpen = (id: string) => open[id] ?? id === activeProjectId
  const setProjectOpen = (id: string, next: boolean) => {
    setOpen((prev) => {
      const updated = { ...prev, [id]: next }
      saveOpen(updated)
      return updated
    })
  }
  // 切り替えたら、前のプロジェクトの履歴は畳み、今のプロジェクトを開く（どれが今のプロジェクトか分かるように）
  const previousActive = useRef(activeProjectId)
  useEffect(() => {
    const prev = previousActive.current
    previousActive.current = activeProjectId
    if (prev === activeProjectId || !activeProjectId) return
    setOpen((state) => {
      const updated = { ...state, [activeProjectId]: true, ...(prev ? { [prev]: false } : {}) }
      saveOpen(updated)
      return updated
    })
  }, [activeProjectId])

  /** 開いていないプロジェクトの履歴を読み直す（名前の変更・削除のあと） */
  const reloadOther = (project: Project) => run(async () => {
    const list = await window.ade.invoke('review:list', project.folderPath)
    setOthers((prev) => ({ ...prev, [project.id]: list.map(toReviewSession) }))
  })

  /** 全プロジェクト共通の絞り込み（「Projects」の見出しの下）。保存も全体で1つ */
  const [filter, setFilterState] = useState<ReviewFilter>(loadReviewFilter)
  const [filterOpen, setFilterOpen] = useState(false)
  const setFilter = (next: ReviewFilter) => {
    setFilterState(next)
    saveReviewFilter(next)
  }
  /** 読み込んだ履歴（まだ読んでいないプロジェクトは undefined） */
  const historyOf = (project: Project) => (project.id === activeProjectId ? sessions : others[project.id])
  const loaded = projects.projects.flatMap((p) => historyOf(p) ?? [])

  /** 指摘0件の下書きを、読み込んだ全プロジェクトからまとめて消す */
  const deleteEmptyDrafts = () => run(async () => {
    let total = 0
    for (const project of projects.projects) {
      const ids = (historyOf(project) ?? []).filter(isEmptyDraft).map((s) => s.id)
      if (ids.length === 0) continue
      const active = project.id === activeProjectId
      const deleted = await window.ade.invoke('review:delete', ids, active ? undefined : project.folderPath)
      total += deleted.length
      if (active) onHistoryChanged?.(deleted)
      else reloadOther(project)
    }
    if (total > 0) toast({ tone: 'success', message: t('sidebar.deleted', { count: total }) })
  })

  // 展開している「開いていないプロジェクト」の履歴を読む。一覧が変わったら読み直す。
  // 絞り込みのパネルを開いたときは、対象の候補と件数を全プロジェクトから集めるため全部読む
  const openIds = projects.projects.filter((p) => p.id !== activeProjectId && (isOpen(p.id) || filterOpen)).map((p) => p.id).join(',')
  useEffect(() => {
    if (!openIds) return
    let cancelled = false
    for (const id of openIds.split(',')) {
      const folder = projects.projects.find((p) => p.id === id)?.folderPath
      if (!folder) continue
      void window.ade.invoke('review:list', folder).then((list) => {
        if (!cancelled) setOthers((prev) => ({ ...prev, [id]: list.map(toReviewSession) }))
      // 失敗は main の IPC が Sentry へ送る
      }).catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [openIds, projects])

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

  const openMenuAt = (id: string, clientX: number, clientY: number) => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return
    const x = Math.max(4, Math.min(clientX - box.left, box.width - MENU_WIDTH - 4))
    // 下端では上へ寄せる（メニューの高さはおよそ 110px）
    setMenu({ id, x, y: Math.max(4, Math.min(clientY - box.top, box.height - 116)) })
  }

  // 足したら、種類と確認先を決めてもらうため「プロジェクトを編集」を開く
  // 「プロジェクトを追加」は、自分の PC / GitHub から取得 / SSH を選ぶダイアログ（AddProjectDialog）
  const [adding, setAdding] = useState(false)
  const addProject = () => {
    setAdding(true)
    onOverlayChange?.(true)
  }
  // 足したら、種類と確認先を決めてもらうため「プロジェクトを編集」を開く（SSH はリモートの開発サーバーが分からないので開かない）
  const onAdded = (before: ReadonlySet<string>) => (state: ProjectsState, source: ProjectSource) => {
    const added = state.projects.find((p) => !before.has(p.id))
    if (added && source !== 'ssh') openEdit(added.id)
  }

  const switchTo = (project: Project) => run(async () => {
    await window.ade.invoke('project:switch', project.id)
    setProjectOpen(project.id, true)
  })

  /** 開いていないプロジェクトの履歴を選んだら、そのプロジェクトへ切り替えてから開く */
  const selectSession = (project: Project, id: string) => {
    if (project.id === activeProjectId) return onSelect(id)
    run(async () => {
      await window.ade.invoke('project:switch', project.id)
      onSelect(id)
    })
  }

  const commitRename = (project: Project) => {
    const current = renamingRef.current
    setRenaming(null)
    const name = current?.id === project.id ? current.name.trim() : ''
    if (!name || name === project.name) return
    run(() => window.ade.invoke('project:update', { ...project, name }))
  }

  const menuProject = menu ? projects.projects.find((p) => p.id === menu.id) : undefined
  const editingProject = editingId ? projects.projects.find((p) => p.id === editingId) : undefined

  return (
    <aside className="sidebar" aria-label={t('sidebar.projects')} data-testid="sidebar" ref={rootRef}>
      <div className="sidebar__list">
        <div className="sb-head">
          <span className="sb-head__title">{t('sidebar.projects')}</span>
          {/* Tooltip はサイドバーの右端からはみ出して横スクロールを生むので、OS標準の title にする */}
          <IconButton
            size="sm"
            label={t('sidebar.addProject')}
            title={t('sidebar.addProject')}
            icon={<Plus size={14} strokeWidth={1.5} />}
            onClick={addProject}
            data-testid="sidebar-add-project"
          />
          {/* プロジェクト一覧を閉じる（開き直すのはタイトルバー右の開閉ボタン・⌘B・設定ページ） */}
          <PanelCloseButton panel="projects" />
        </div>

        {projects.projects.length > 0 && (
          <ReviewFilterBar
            filter={filter}
            onChange={setFilter}
            open={filterOpen}
            onOpenChange={setFilterOpen}
            hosts={reviewHosts(loaded)}
            emptyDraftCount={loaded.filter(isEmptyDraft).length}
            onDeleteEmpty={deleteEmptyDrafts}
          />
        )}

        {projects.projects.length === 0 ? (
          <EmptyState
            size="sm"
            testId="sidebar-empty"
            art={<EmptyStackArt />}
            title={t('sidebar.emptyTitle')}
            description={t('sidebar.emptyStartReviewing')}
            actions={<Button icon={<FolderPlus size={14} />} onClick={addProject}>{t('sidebar.addProject')}</Button>}
          />
        ) : (
          <div className="sb-tree" role="tree" aria-label={t('sidebar.projects')}>
            {projects.projects.map((project) => {
              const active = project.id === activeProjectId
              const expanded = isOpen(project.id)
              const items = active ? sessions : others[project.id]
              return (
                <div key={project.id} className={`sb-project${active ? ' is-active' : ''}`} data-testid="sidebar-project">
                  {renaming?.id === project.id ? (
                    <div className="sb-project__row is-editing">
                      <Field
                        autoFocus
                        aria-label={t('sidebar.projectName')}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: project.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename(project)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => commitRename(project)}
                      />
                    </div>
                  ) : (
                    <div
                      role="treeitem"
                      tabIndex={0}
                      aria-selected={active}
                      aria-expanded={expanded}
                      className="sb-project__row"
                      title={project.source === 'ssh' && project.ssh ? sshTargetLabel(project.ssh) : project.folderPath}
                      onClick={() => (active ? setProjectOpen(project.id, !expanded) : switchTo(project))}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (active) setProjectOpen(project.id, !expanded)
                          else switchTo(project)
                        }
                        if (e.key === 'ArrowRight') setProjectOpen(project.id, true)
                        if (e.key === 'ArrowLeft') setProjectOpen(project.id, false)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openMenuAt(project.id, e.clientX, e.clientY)
                      }}
                      data-testid={`sidebar-project-${project.id}`}
                    >
                      <span className="sb-project__icon" aria-hidden="true" title={t(`projectSource.source.${project.source ?? 'local'}` as TranslationKey)}>
                        {project.source && project.source !== 'local'
                          ? <ProjectSourceIcon project={project} />
                          : active ? <FolderOpen size={14} strokeWidth={1.5} /> : <Folder size={14} strokeWidth={1.5} />}
                      </span>
                      <span className="sb-project__name" title={project.name}>{project.name}</span>
                      {items && items.length > 0 && (() => {
                        // 絞り込みで隠れている分があれば「表示中/全体」
                        const shown = filterReviews(items, filter).length
                        return (
                          <span className="sidebar__section-count sb-project__count" title={t('sidebar.filter.shown', { shown, total: items.length })}>
                            {shown < items.length ? `${shown}/${items.length}` : items.length}
                          </span>
                        )
                      })()}
                      <span className="sb-project__actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="sb-project__action"
                          aria-label={t('sidebar.newReviewIn', { name: project.name })}
                          title={t('sidebar.newReviewIn', { name: project.name })}
                          disabled={recording}
                          onClick={() => onNewReview(project.id)}
                          data-testid="sidebar-project-new-review"
                        >
                          <Plus size={14} strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          className="sb-project__action"
                          aria-label={t('sidebar.projectMenu', { name: project.name })}
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect()
                            openMenuAt(project.id, r.right - MENU_WIDTH, r.bottom + 2)
                          }}
                          data-testid="sidebar-project-menu"
                        >
                          <Ellipsis size={14} strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          className="sb-project__action"
                          aria-label={expanded ? t('sidebar.collapseHistory') : t('sidebar.expandHistory')}
                          onClick={() => setProjectOpen(project.id, !expanded)}
                        >
                          <ChevronDown size={14} strokeWidth={1.5} className={expanded ? '' : 'is-collapsed'} />
                        </button>
                      </span>
                    </div>
                  )}

                  {confirmRemove === project.id && (
                    <div className="sb-confirm">
                      <span>{t('sidebar.removeConfirm', { name: project.name })}</span>
                      <span className="sb-confirm__actions">
                        <Button variant="ghost" onClick={() => setConfirmRemove(null)}>{t('sidebar.keep')}</Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            setConfirmRemove(null)
                            run(() => window.ade.invoke('project:remove', project.id))
                          }}
                          data-testid="sidebar-project-remove-confirm"
                        >
                          {t('sidebar.remove')}
                        </Button>
                      </span>
                    </div>
                  )}

                  {expanded && (
                    <div className="sb-project__children" role="group">
                      {/* このプロジェクトで新しいレビューを始める。開いているプロジェクトには ⌘⇧R も出す */}
                      <button
                        type="button"
                        className="sb-new-review"
                        title={t('sidebar.newReviewIn', { name: project.name })}
                        disabled={recording}
                        onClick={() => onNewReview(project.id)}
                        data-testid={active ? 'sidebar-new-review' : `sidebar-new-review-${project.id}`}
                      >
                        <Plus size={13} strokeWidth={1.75} />
                        <span>{t('sidebar.newReview')}</span>
                        {active && <kbd className="sb-new-review__key">{recordKey}</kbd>}
                      </button>
                      {items !== undefined && (
                        <ReviewList
                          filter={filter}
                          {...(active ? {} : { folderPath: project.folderPath })}
                          active={active}
                          items={items}
                          selectedId={selectedId}
                          emptyText={active ? t('sidebar.emptyActive') : t('sidebar.emptyOther')}
                          onSelect={(id) => selectSession(project, id)}
                          onChanged={(deleted) => (active ? onHistoryChanged?.(deleted) : reloadOther(project))}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {menu && menuProject && (
        <div className="sb-menu" role="menu" style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }} data-testid="sidebar-project-context">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming({ id: menuProject.id, name: menuProject.name }) }}>
            <Pencil size={13} strokeWidth={1.75} />{t('sidebar.rename')}
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); openEdit(menuProject.id) }} data-testid="sidebar-project-edit">
            <Settings2 size={13} strokeWidth={1.75} />{t('projectTargets.edit')}
          </button>
          <div className="sb-menu__sep" role="separator" />
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); setConfirmRemove(menuProject.id) }}>
            <Trash2 size={13} strokeWidth={1.75} />{t('sidebar.removeFromList')}
          </button>
        </div>
      )}
      {/* セットアップが全部済むまで、下に小さな進み具合（Setup n/7）を出す。済んだら消える */}
      <SetupProgressLink />
      <FeedbackLink />
      {editingProject && <ProjectEditDialog project={editingProject} onClose={() => openEdit(null)} />}
      {adding && <AddProjectDialog
        onClose={() => { setAdding(false); onOverlayChange?.(false) }}
        onAdded={onAdded(new Set(projects.projects.map((p) => p.id)))}
      />}
    </aside>
  )
}

/** 空のときの絵。重なったカードに、ペンの輪 */
function EmptyStackArt() {
  const id = useId()
  return (
    <svg
      className="sidebar__empty-art"
      width="96"
      height="64"
      viewBox="0 0 96 64"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--brand-rose)" />
          <stop offset="1" stopColor="var(--brand-iris)" />
        </linearGradient>
      </defs>
      <rect x="22" y="6" width="56" height="16" rx="5" className="steps__card" opacity="0.5" />
      <rect x="16" y="16" width="64" height="18" rx="6" className="steps__card" opacity="0.75" />
      <rect x="10" y="28" width="76" height="28" rx="7" className="steps__card" />
      <rect x="18" y="36" width="12" height="12" rx="3" className="steps__ink steps__ink--strong" />
      <rect x="36" y="37" width="26" height="4" rx="2" className="steps__ink steps__ink--strong" />
      <rect x="36" y="45" width="18" height="3" rx="1.5" className="steps__ink" />
      <path
        className="steps__draw"
        d="M70 36c4 1 7 4 6 8-1 5-8 7-12 4-4-2-3-9 2-11"
        stroke={`url(#${id})`}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
