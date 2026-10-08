import { ExternalDropOverlay, useExternalDrop } from '../hooks/useExternalDrop'
import { readDrop } from '../lib/externalDrop'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleSlash,
  Ellipsis,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  ListChecks,
  MessageCircleQuestionMark,
  Network,
  Pencil,
  Plus,
  Repeat,
  Settings2,
  Star,
  Trash2,
  Users
} from 'lucide-react'
import type { Project, ProjectsState } from '@shared/types'
import { formatShortcut } from '../lib/shortcut'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, EmptyState, Field, IconButton, useToast } from '../ui'
import { filterReviews, isEmptyDraft, reviewHosts, type ReviewFilter } from '@shared/reviewList'
import { ProjectEditDialog } from './ProjectTargetsEditor'
import { CreateRepoDialog } from './CreateRepoDialog'
import { AddProjectDialog, ProjectSourceIcon } from './AddProjectDialog'
import type { ProjectSource } from '@shared/projectSource'
import { sshTargetLabel } from '@shared/sshCommand'
import type { TranslationKey } from '@shared/i18n'
import { ReviewFilterBar, ReviewList, loadReviewFilter, saveReviewFilter, toReviewSession, type ReviewSession } from './ReviewList'
import { SetupProgressLink } from '../onboarding/SetupChecklist'
import { FeedbackLink } from './FeedbackDialog'
import { useProjectActivity } from '../terminal/agentActivity'
import { dropPositionAt, moveAmongVisible, stepAmongVisible, type DropPosition } from '@shared/reorder'
import { PROJECT_SORTS, editorFirst, filterProjects, memberParents, nestMembers, sanitizeProjectView, sortProjects, type ProjectListView } from '@shared/projectOrder'

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
 * プロジェクトの行はドラッグ＆ドロップ・Alt+↑↓・メニューの「上へ」「下へ」で並べ替えられる（順は settings の projects の並び）。
 * 並び順（手動・動いている順・最近使った順・名前順・追加した順）と「☆ のみ」は絞り込みのパネルで選ぶ。☆ は上にまとめる。
 * 色・グループ・Finder連携は持ち込まない。
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

/** プロジェクトの並び順と「☆ のみ」。この端末だけの好み（@shared/projectOrder） */
const VIEW_KEY = 'ade.sidebar.projectView'
function loadView(): ProjectListView {
  try {
    return sanitizeProjectView(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}'))
  } catch {
    // ストレージが使えない・壊れた値（想定内。手動の順で続ける）
    return sanitizeProjectView(null)
  }
}
function saveView(view: ProjectListView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

/** Agent が最後に動いた（作業中・確認待ちになった）時刻。「最近使った順」「動いている順」に使う */
const AGENT_AT_KEY = 'ade.sidebar.agentActiveAt'
function loadAgentActiveAt(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(AGENT_AT_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>
  } catch {
    // ストレージが使えない・壊れた値（想定内）
    return {}
  }
}

/** 右クリック／… で開くメニュー。サイドバーの中に収める（右へはみ出すとネイティブのビューに隠れる） */
const MENU_WIDTH = 188
/** メニューのおよその高さ（下端で上へ寄せるのに使う） */
const MENU_HEIGHT = 208

/**
 * プロジェクトの行を並べ替えるドラッグの型。外からのファイル（'Files'）・ファイルツリーの行（treeDrag.ts）とは別の型にして、
 * 外からのドロップ（プロジェクトの追加）やターミナル・エディタへのドロップと取り違えない
 */
const PROJECT_DRAG_TYPE = 'application/x-ferret-project'

export function Sidebar({
  projects,
  activeProjectId,
  sessions,
  selectedId,
  onSelect,
  onNewReview,
  onImportMeeting,
  onStartRound,
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
  /** 開いているプロジェクトに mtg の録画・文字起こしを取り込む（MeetingImportDialog。App が開く） */
  onImportMeeting?: () => void
  /** プロダクトの巡回を始める（録画：全プロダクトを順にレビュー／確認：確認待ちを順に。src/renderer/hooks/useProductRound.ts） */
  onStartRound?: (kind: 'record' | 'confirm') => void
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
  /** ターミナルで Agent が動いているプロジェクト（行に「実行中」の印を出す） */
  const projectActivity = useProjectActivity()
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen)
  /** 開いていないプロジェクトの履歴。開いた（展開した）ときに読み込む */
  const [others, setOthers] = useState<Record<string, ReviewSession[]>>({})
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenamingState] = useState<{ id: string; name: string } | null>(null)
  const renamingRef = useRef<{ id: string; name: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  /** 「プロジェクトを編集」で開いているプロジェクト */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 並べ替えのドラッグ中のプロジェクトと、落とす位置（線を出す行と、その上か下か） */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; position: DropPosition } | null>(null)
  /** キーボードで動かしたあと、並び直した行へフォーカスを戻す */
  const refocus = useRef<string | null>(null)
  const openEdit = (id: string | null) => {
    setEditingId(id)
    onOverlayChange?.(id !== null)
  }
  /** 「GitHub で private リポジトリを作る」を開いているプロジェクト（ダイアログの間は内蔵ブラウザのビューを隠す） */
  const [repoCreateId, setRepoCreateId] = useState<string | null>(null)
  const openRepoCreate = (id: string | null) => {
    setRepoCreateId(id)
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
    // 下端では上へ寄せる
    setMenu({ id, x, y: Math.max(4, Math.min(clientY - box.top, box.height - MENU_HEIGHT)) })
  }

  /** 並び順と「☆ のみ」。☆ はどの並び順でも上にまとめる */
  const [view, setViewState] = useState<ProjectListView>(loadView)
  const setView = (next: ProjectListView) => {
    setViewState(next)
    saveView(next)
  }
  const [agentActiveAt, setAgentActiveAt] = useState<Record<string, number>>(loadAgentActiveAt)
  useEffect(() => {
    const busy = Object.entries(projectActivity).filter(([, state]) => state === 'working' || state === 'blocked').map(([id]) => id)
    if (busy.length === 0) return
    setAgentActiveAt((prev) => {
      const next = { ...prev, ...Object.fromEntries(busy.map((id) => [id, Date.now()])) }
      try { localStorage.setItem(AGENT_AT_KEY, JSON.stringify(next)) } catch { /* 保存できなくても、この起動の間は効く */ }
      return next
    })
  }, [projectActivity])
  // 「すべてのプロジェクト」（エディタ全体）は、どの並び順でも一番上に置く
  const displayed = editorFirst(sortProjects(projects.projects, view.sort, { activity: projectActivity, agentActiveAt }))
  // オーケストレーターに入れたプロジェクトは、そのオーケストレーターのすぐ下に字下げして並べる（以前の版で入れたもの）
  const shown = nestMembers(filterProjects(displayed, view), projects.projects)
  const parentOf = memberParents(projects.projects)

  /**
   * 並べ替え。全体の並びは今の表示の順で、☆ の中・外のそれぞれの中で動かす（☆ は上にまとめるため）。
   * 手動以外の並び順で動かしたら、その時点の並びを手動の順として保存して「手動」に切り替える。
   * 並びは main が settings に保存し、projects:changed で一覧が届く
   */
  const projectIds = displayed.map((p) => p.id)
  const shownIds = shown.map((p) => p.id)
  const starredOf = (id: string) => !!projects.projects.find((p) => p.id === id)?.starred
  const sameGroup = (id: string) => (other: string) => starredOf(other) === starredOf(id)
  const reorder = (next: string[] | null) => {
    if (!next) return
    run(() => window.ade.invoke('project:reorder', next))
    if (view.sort !== 'manual') {
      setView({ ...view, sort: 'manual' })
      toast({ tone: 'info', message: t('sidebar.sort.switchedToManual') })
    }
  }
  const stepOf = (id: string, delta: -1 | 1) => stepAmongVisible(projectIds, shownIds, id, delta, sameGroup(id))
  const moveProject = (id: string, delta: -1 | 1) => reorder(stepOf(id, delta))
  const toggleStar = (project: Project) => run(() => window.ade.invoke('project:update', { id: project.id, starred: !project.starred }))
  /** 以前の版で作ったオーケストレーターをやめる（Ferret が書いた subagent などを外す。いまは「すべてのプロジェクト」を使う） */
  const stopOrchestrator = (project: Project) => run(async () => {
    await window.ade.invoke('project:orchestrator', project.id, false)
    toast({ tone: 'success', message: t('orchestrator.disabled') })
  })
  const endDrag = () => {
    setDragging(null)
    setDropAt(null)
  }
  useEffect(() => {
    const id = refocus.current
    if (!id) return
    refocus.current = null
    rootRef.current?.querySelector<HTMLElement>(`[data-project-row="${CSS.escape(id)}"]`)?.focus()
  }, [projects])

  // 足したら、種類と確認先を決めてもらうため「プロジェクトを編集」を開く
  // 「プロジェクトを追加」は、自分の PC / GitHub から取得 / SSH を選ぶダイアログ（AddProjectDialog）
  const [adding, setAdding] = useState(false)
  const addProject = () => {
    setAdding(true)
    onOverlayChange?.(true)
  }
  // 足したら、種類と確認先を決めてもらうため「プロジェクトを編集」を開く（SSH はリモートの開発サーバーが分からないので開かない。
  // オーケストレーターは確認先を持たない（レビューは下のプロダクトで行う）ので開かない）
  const onAdded = (before: ReadonlySet<string>) => (state: ProjectsState, source: ProjectSource) => {
    const added = state.projects.find((p) => !before.has(p.id))
    if (added && source !== 'ssh' && !added.orchestrator) openEdit(added.id)
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

  // 外からフォルダを落とすと、プロジェクトとして追加して開く（登録済みならそれに切り替える）。
  // ファイルだけのときは、どこを足すかを推し量らずにフォルダを落とすよう案内する
  const projectDrop = useExternalDrop((dataTransfer) => run(async () => {
    const entries = await readDrop(dataTransfer)
    const folders = entries.filter((entry) => entry.kind === 'dir')
    if (folders.length === 0) {
      toast({ tone: 'warning', message: t(entries.length > 0 ? 'drop.errors.notFolder' : 'drop.errors.unreadable') })
      return
    }
    let state: ProjectsState | null = null
    for (const folder of folders) state = await window.ade.invoke('project:addDropped', folder.path)
    if (state?.activeProjectId) setProjectOpen(state.activeProjectId, true)
  }))

  const menuProject = menu ? projects.projects.find((p) => p.id === menu.id) : undefined
  const editingProject = editingId ? projects.projects.find((p) => p.id === editingId) : undefined

  return (
    <aside className="sidebar" aria-label={t('sidebar.projects')} data-testid="sidebar" ref={rootRef} data-file-drop={projectDrop.over || undefined} {...projectDrop.props}>
      {projectDrop.over && <ExternalDropOverlay label={t('drop.sidebar.hint')} testId="sidebar-file-drop" />}
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
            projectFiltering={view.starredOnly}
            projectSection={<>
              <div className="rv-filter__label">{t('sidebar.sort.label')}</div>
              <select className="rv-filter__select" aria-label={t('sidebar.sort.label')} value={view.sort} data-testid="sidebar-project-sort"
                onChange={(e) => setView({ ...view, sort: sanitizeProjectView({ sort: e.target.value }).sort })}>
                {PROJECT_SORTS.map((sort) => <option key={sort} value={sort}>{t(`sidebar.sort.${sort}`)}</option>)}
              </select>
              <label className="rv-filter__check">
                <input type="checkbox" checked={view.starredOnly} onChange={(e) => setView({ ...view, starredOnly: e.target.checked })} data-testid="sidebar-starred-only" />
                <span>{t('sidebar.starredOnly')}</span>
              </label>
            </>}
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
            {shown.length === 0 && <p className="sb-tree__empty" data-testid="sidebar-no-starred">{t('sidebar.noStarred')}</p>}
            {shown.map((project) => {
              const active = project.id === activeProjectId
              const expanded = isOpen(project.id)
              const items = active ? sessions : others[project.id]
              return (
                <div
                  key={project.id}
                  className={`sb-project${parentOf.has(project.id) && shownIds.includes(parentOf.get(project.id)!) ? ' sb-project--member' : ''}${active ? ' is-active' : ''}${dragging === project.id ? ' is-dragging' : ''}${dropAt?.id === project.id ? ` is-drop-${dropAt.position}` : ''}`}
                  data-testid="sidebar-project"
                  onDragOver={(e) => {
                    if (!dragging || !Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_TYPE) || starredOf(dragging) !== !!project.starred) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    // 上か下かは見出しの行で決める（展開した履歴の上は「下」）
                    const row = (e.currentTarget.firstElementChild as HTMLElement | null)?.getBoundingClientRect()
                    const position = row ? dropPositionAt(e.clientY - row.top, row.height) : 'after'
                    if (dropAt?.id !== project.id || dropAt.position !== position) setDropAt({ id: project.id, position })
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropAt?.id === project.id) setDropAt(null)
                  }}
                  onDrop={(e) => {
                    if (!dragging || !Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_TYPE) || starredOf(dragging) !== !!project.starred) return
                    e.preventDefault()
                    const row = (e.currentTarget.firstElementChild as HTMLElement | null)?.getBoundingClientRect()
                    const position = row ? dropPositionAt(e.clientY - row.top, row.height) : 'after'
                    reorder(moveAmongVisible(projectIds, shownIds, dragging, project.id, position))
                    endDrag()
                  }}
                >
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
                      draggable
                      data-project-row={project.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(project.id)
                      }}
                      onDragEnd={endDrag}
                      onClick={() => (active ? setProjectOpen(project.id, !expanded) : switchTo(project))}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        // Alt+↑ / Alt+↓ で1つ上・下へ並べ替える
                        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                          e.preventDefault()
                          refocus.current = project.id
                          moveProject(project.id, e.key === 'ArrowUp' ? -1 : 1)
                          return
                        }
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
                      {project.orchestraExcluded && (
                        <span className="sb-project__starred sb-project__excluded" role="img" aria-label={t('orchestra.excludedBadge')} title={t('orchestra.excludedBadge')} data-testid="sidebar-project-excluded">
                          <CircleSlash size={11} strokeWidth={2} />
                        </span>
                      )}
                      {project.orchestrator && (
                        <span className="sb-project__starred" role="img" aria-label={t(project.editorWorkspace ? 'editorWorkspace.hint' : 'orchestrator.badge')} title={t(project.editorWorkspace ? 'editorWorkspace.hint' : 'orchestrator.badge')} data-testid={project.editorWorkspace ? 'sidebar-editor-workspace' : 'sidebar-project-orchestrator'}>
                          <Network size={11} strokeWidth={2} />
                        </span>
                      )}
                      {project.starred && (
                        <span className="sb-project__starred" role="img" aria-label={t('sidebar.starred')} title={t('sidebar.starred')} data-testid="sidebar-project-starred">
                          <Star size={11} strokeWidth={2} fill="currentColor" />
                        </span>
                      )}
                      {projectActivity[project.id] === 'working' && (
                        <span className="sb-project__working" role="img" aria-label={t('sidebar.agentWorking')} title={t('sidebar.agentWorking')} data-testid="sidebar-project-working">
                          <span /><span /><span />
                        </span>
                      )}
                      {/* Agent が確認（許可・質問）を待っている */}
                      {projectActivity[project.id] === 'blocked' && (
                        <span className="sb-project__agent sb-project__agent--blocked" role="img" aria-label={t('sidebar.agentBlocked')} title={t('sidebar.agentBlocked')} data-testid="sidebar-project-blocked">
                          <MessageCircleQuestionMark size={12} strokeWidth={2} />
                        </span>
                      )}
                      {/* Agent の作業が終わり、まだそのタブを見ていない（見ると消える） */}
                      {projectActivity[project.id] === 'done' && (
                        <span className="sb-project__agent sb-project__agent--done" role="img" aria-label={t('sidebar.agentDone')} title={t('sidebar.agentDone')} data-testid="sidebar-project-done">
                          <Check size={12} strokeWidth={2.5} />
                        </span>
                      )}
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
                          className={`sb-project__action${project.starred ? ' is-starred' : ''}`}
                          aria-label={project.starred ? t('sidebar.unstar') : t('sidebar.star')}
                          title={project.starred ? t('sidebar.unstar') : t('sidebar.star')}
                          aria-pressed={!!project.starred}
                          onClick={() => toggleStar(project)}
                          data-testid="sidebar-project-star"
                        >
                          <Star size={14} strokeWidth={1.5} fill={project.starred ? 'currentColor' : 'none'} />
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
                      {/* 全体（すべてのプロダクト）：プロダクトを順に回ってレビュー・確認する（終わったら次のプロダクトへ） */}
                      {project.editorWorkspace && onStartRound && <>
                        <button type="button" className="sb-new-review sb-new-review--round" title={t('round.startRecordTip')} disabled={recording} onClick={() => onStartRound('record')} data-testid="sidebar-round-record">
                          <Repeat size={13} strokeWidth={1.75} />
                          <span>{t('round.startRecord')}</span>
                        </button>
                        <button type="button" className="sb-new-review sb-new-review--round" title={t('round.startConfirmTip')} disabled={recording} onClick={() => onStartRound('confirm')} data-testid="sidebar-round-confirm">
                          <ListChecks size={13} strokeWidth={1.75} />
                          <span>{t('round.startConfirm')}</span>
                        </button>
                      </>}
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
                      {/* mtg の録画・文字起こしから指摘の候補を作る。取り込み先は開いているプロジェクト */}
                      {active && onImportMeeting && <button
                        type="button"
                        className="sb-new-review sb-new-review--import"
                        title={t('sidebar.importMeetingTip')}
                        disabled={recording}
                        onClick={onImportMeeting}
                        data-testid="sidebar-import-meeting"
                      >
                        <Users size={13} strokeWidth={1.75} />
                        <span>{t('sidebar.importMeeting')}</span>
                      </button>}
                      {items !== undefined && (
                        <ReviewList
                          filter={filter}
                          {...(active ? {} : { folderPath: project.folderPath })}
                          active={active}
                          items={items}
                          selectedId={selectedId}
                          {...(active ? {} : { emptyText: t('sidebar.emptyOther') })}
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
          {/* オーケストラの対象・対象外（全体の subagent・巡回・全体への依頼に巻き込まない） */}
          {!menuProject.editorWorkspace && !menuProject.orchestrator && menuProject.source !== 'ssh' && <button type="button" role="menuitem" onClick={() => { setMenu(null); run(() => window.ade.invoke('project:update', { id: menuProject.id, orchestraExcluded: !menuProject.orchestraExcluded })) }} data-testid="sidebar-project-orchestra-toggle">
            <Network size={13} strokeWidth={1.75} />{menuProject.orchestraExcluded ? t('orchestra.include') : t('orchestra.exclude')}
          </button>}
          <button type="button" role="menuitem" onClick={() => { setMenu(null); toggleStar(menuProject) }} data-testid="sidebar-project-star-menu">
            <Star size={13} strokeWidth={1.75} />{menuProject.starred ? t('sidebar.unstar') : t('sidebar.star')}
          </button>
          <button type="button" role="menuitem" disabled={!stepOf(menuProject.id, -1)} onClick={() => { setMenu(null); moveProject(menuProject.id, -1) }} data-testid="sidebar-project-move-up">
            <ArrowUp size={13} strokeWidth={1.75} />{t('sidebar.moveUp')}
          </button>
          <button type="button" role="menuitem" disabled={!stepOf(menuProject.id, 1)} onClick={() => { setMenu(null); moveProject(menuProject.id, 1) }} data-testid="sidebar-project-move-down">
            <ArrowDown size={13} strokeWidth={1.75} />{t('sidebar.moveDown')}
          </button>
          {/* SSH のプロジェクトは手元のフォルダがレビューの置き場なので出さない */}
          {menuProject.source !== 'ssh' && <>
            <div className="sb-menu__sep" role="separator" />
            {menuProject.orchestrator && !menuProject.editorWorkspace && <button type="button" role="menuitem" onClick={() => { setMenu(null); stopOrchestrator(menuProject) }} data-testid="sidebar-project-orchestrator-menu">
              <Network size={13} strokeWidth={1.75} />{t('orchestrator.off')}
            </button>}
            <button type="button" role="menuitem" onClick={() => { setMenu(null); openRepoCreate(menuProject.id) }} data-testid="sidebar-project-create-repo">
              <FolderGit2 size={13} strokeWidth={1.75} />{t('repoCreate.menu')}
            </button>
          </>}
          <div className="sb-menu__sep" role="separator" />
          {/* 「すべてのプロジェクト」は外せない（Ferret が持つエディタ全体） */}
          {!menuProject.editorWorkspace && <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); setConfirmRemove(menuProject.id) }}>
            <Trash2 size={13} strokeWidth={1.75} />{t('sidebar.removeFromList')}
          </button>}
        </div>
      )}
      {/* セットアップが全部済むまで、下に小さな進み具合（Setup n/7）を出す。済んだら消える */}
      <SetupProgressLink />
      <FeedbackLink />
      {editingProject && <ProjectEditDialog project={editingProject} onClose={() => openEdit(null)} />}
      {(() => {
        const repoProject = repoCreateId ? projects.projects.find((p) => p.id === repoCreateId) : undefined
        return repoProject ? <CreateRepoDialog project={repoProject} onClose={() => openRepoCreate(null)} /> : null
      })()}
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
