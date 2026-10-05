import { defaultLaunchAgent } from '@shared/sendTarget'
import { Fragment, useEffect, useState, useRef, type DragEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clipboard,
  Code2,
  FileText,
  Flag,
  GripVertical,
  FolderOpen,
  Globe,
  Images,
  Mic,
  PenLine,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  X
} from 'lucide-react'
import { isUnsentTake, playbackAt, takeAt, type ReviewData, type ReviewEdit, type ReviewFrame } from '@shared/review'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, RECOMMENDED_ORGANIZE_PROVIDER, isOrganizeRunnerId, providerLabel, type LlmApiProvider, type OrganizeRunnerId } from '@shared/aiProviders'
import { organizeModelChoice, organizeModelPatch, organizeRunnerSummary, type OrganizerModelPrefs } from '@shared/organizeModels'
import { notifyOrganizerChanged, onOrganizerChanged } from '../lib/organizerEvents'
import { Button, EmptyState, IconButton, Modal, Tooltip, useToast } from '../ui'
import { FindingsEmptyArt } from './reviewArt'
import { FindingShots } from './ReviewShots'
import { errorMessage } from '../lib/errors'
import { TargetPurposeIcon } from './TargetPurposeIcon'
import { useT } from '../lib/i18n'
import { groupByTarget, targetHeading, type ReviewTarget } from '@shared/reviewTarget'
import { reportHandled } from '@shared/report'
import { agentLabel } from '@shared/agentCatalog'
import type { TuiAgent } from '@shared/types'
import { loadSendTargets, rememberedSendTarget, resolveRememberedTarget, sendReviewToAgent } from '../lib/sendReview'
import { SendTargetButton } from './SendTargetButton'
import { ProgressSummary, ProgressToggle, QueuedPanel, ReviewActions, StatusFilterBar, VerdictPanel } from './FindingProgress'
import { countByStatus, isStatusShown, sanitizeHiddenStatuses } from '@shared/findingStatusFilter'
import { countProgress, nextProgress, pendingIds, progressOf, type FindingProgress, type ReviewVerdict } from '@shared/findingProgress'
import { dropPositionAt, moveAmongVisible, stepAmongVisible, type DropPosition } from '@shared/reorder'
import { reviewFirst, sortByStatus } from '@shared/findingStatusFilter'

type FeedbackItem = ReviewData['document']['items'][number]

/** 進み具合の絞り込み（隠す進み具合）。全レビュー共通で1つ。この端末だけの好みなので localStorage に置く（読めなくても既定で動く） */
const STATUS_FILTER_KEY = 'ade.findings.hiddenStatuses'
function loadHiddenStatuses(): FindingProgress[] {
  try {
    return sanitizeHiddenStatuses(JSON.parse(localStorage.getItem(STATUS_FILTER_KEY) ?? '[]'))
  } catch { // ストレージが使えない・壊れた値（想定内。すべて表示で続ける）
    return []
  }
}
/** 並び順「確認待ちを上に」（表示だけ）。既定は入（保存が無ければ入） */
const REVIEW_FIRST_KEY = 'ade.findings.reviewFirst'
function loadReviewFirst(): boolean {
  try {
    return localStorage.getItem(REVIEW_FIRST_KEY) !== 'false'
  } catch { // ストレージが使えない（想定内。既定の入で続ける）
    return true
  }
}
function saveReviewFirst(on: boolean): void {
  try {
    localStorage.setItem(REVIEW_FIRST_KEY, String(on))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}
function saveHiddenStatuses(hidden: readonly FindingProgress[]): void {
  try {
    localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(hidden))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

/**
 * 指摘を並べ替えるドラッグの型。外からのファイル（'Files'）・ファイルツリーの行（treeDrag.ts）とは別の型にして、
 * 外からのドロップやターミナル・エディタへのドロップと取り違えない
 */
const FINDING_DRAG_TYPE = 'application/x-ferret-finding'
/** 整理のモデルの選択の「その他（設定で指定）」。モデル名には使えない文字で始める */
const OTHER_MODEL = '\u0000other'

const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`

export function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url } // 入力の検証。読めない URL は想定内
}

/** 指摘がどこから来たか。ペン・声・文字のどれで残したかを色付きのアイコンで示す */
export function SourceChips({ pen, voice, text, other }: { pen: boolean; voice: boolean; text: boolean; other?: boolean }) {
  const t = useT()
  return <span className="rv-sources">
    {pen && <span className="rv-src rv-src--pen" role="img" aria-label={t('review.source.pen')} title={t('review.source.pen')}><PenLine size={11} strokeWidth={2.25} /></span>}
    {voice && <span className="rv-src rv-src--voice" role="img" aria-label={t(other ? 'review.source.otherVoice' : 'review.source.voice')} title={t(other ? 'review.source.otherVoice' : 'review.source.voice')}><Mic size={11} strokeWidth={2.25} /></span>}
    {text && <span className="rv-src rv-src--text" role="img" aria-label={t('review.source.text')} title={t('review.source.text')}><Type size={11} strokeWidth={2.25} /></span>}
  </span>
}

/** 句読点と空白の違いだけなら同じ文とみなす */
const normalize = (text: string) => text.replace(/[\s、。,.！!？?]/g, '')
const same = (a: string, b: string) => normalize(a) !== '' && normalize(a) === normalize(b)

function sourcesOf(item: FeedbackItem) {
  const typed = item.quotes.filter((q) => q.source === 'text')
  const spoken = item.quotes.filter((q) => q.source !== 'text')
  return {
    text: typed.length > 0,
    voice: spoken.length > 0,
    other: spoken.some((q) => q.speaker === 'other'),
    pen: item.annotationIds.length > typed.length
  }
}

/** アイコンだけの操作。名前は読み上げ用に固定し、見た目の説明はツールチップに出す */
function Tool({ tip, side = 'top', ...props }: Parameters<typeof IconButton>[0] & { tip: string; side?: 'top' | 'bottom' }) {
  return <Tooltip label={tip} side={side}><IconButton size="sm" {...props} /></Tooltip>
}

function ModalClose({ onClose }: { onClose: () => void }) {
  const t = useT()
  return <IconButton className="rv-modal__close" label={t('common.close')} icon={<X size={16} />} autoFocus onClick={onClose} />
}

/** 対象の名前（ファイルは相対パス、URL は環境のラベル＋ホストとパス） */
function TargetName({ target }: { target: ReviewTarget }) {
  const t = useT()
  if (target.kind === 'none') return <span className="rv-target__name">{t('review.targets.none')}</span>
  const Icon = target.kind === 'file' ? FileText : Globe
  // デザイン・設計書で撮った指摘は、区分のアイコンと名前を出す（Agent にもコードではなくそれらを直すよう伝わる）。
  // 参考（外部サイト）は「参考」の札を出し、そのサイトは直さず自分のアプリへの参考として渡ることを添える
  return <>
    {target.purpose ? <TargetPurposeIcon purpose={target.purpose} size={12} /> : <Icon size={12} aria-hidden="true" />}
    {target.purpose && <span className="rv-target__env" data-testid="review-target-purpose" data-purpose={target.purpose}
      title={target.purpose === 'reference' ? t('projectTargets.purposeHint.reference') : undefined}>{t(`projectTargets.purpose.${target.purpose}`)}</span>}
    {target.label && <span className="rv-target__env">{target.label}</span>}
    <span className="rv-target__name">{target.kind === 'file' ? target.name : targetHeading({ ...target, label: undefined })}</span>
  </>
}

/** 「削れなかった」を知らせ済みのレビュー（アプリを開いているあいだ、1レビューにつき一度だけ） */
const trimNoticeShown = new Set<string>()

export function ReviewFindings({ review, onUpdate, terminalId, onRecord, recording = false }: {
  terminalId: string | null
  review: ReviewData
  onUpdate: (data: ReviewData) => void
  /**
   * 今の対象でフィードバックの録画を始める。'append' はこのレビューの末尾に足す（既定）、
   * 'new' は新しいレビューを作る（⌘⇧R と同じ）
   */
  onRecord?: (mode: 'append' | 'new') => void
  recording?: boolean
}) {
  // 既定はおすすめの Ollama（端末内・キー不要）。選び直した人の選択は settings に残る
  const [runner, setRunner] = useState<OrganizeRunnerId>(`api:${RECOMMENDED_ORGANIZE_PROVIDER}`)
  /** Agent がどこにも居ないときに起動するもの（設定の startupAgents の先頭） */
  const [defaultAgent, setDefaultAgent] = useState<TuiAgent>('claude')
  /** 送り先を覚える単位（開いているプロジェクト） */
  const [projectKey, setProjectKey] = useState('default')
  /** API キーで直接呼べる提供元（設定の「指摘の整理」でキーと接続先が揃ったもの） */
  const [apiReady, setApiReady] = useState<LlmApiProvider[]>([])
  /** 整理のモデルの設定（settings.json の organizer。設定の「指摘の整理」と同じ値）と、この PC に合う Ollama のモデル */
  const [organizerPrefs, setOrganizerPrefs] = useState<OrganizerModelPrefs | undefined>(undefined)
  const [localOrganizeModel, setLocalOrganizeModel] = useState<string | undefined>(undefined)
  useEffect(() => {
    void Promise.all([window.ade.invoke('app:settings'), window.ade.invoke('capture:availability')]).then(([s, a]) => {
      if (isOrganizeRunnerId(s.organizer?.runner)) setRunner(s.organizer.runner)
      setOrganizerPrefs(s.organizer)
      setLocalOrganizeModel(a.localModels?.organize)
      setDefaultAgent(defaultLaunchAgent(s.agents?.startupAgents ?? [], s.agents?.disabledAgents ?? []))
      if (s.activeProjectId) setProjectKey(s.activeProjectId)
      setApiReady(LLM_API_PROVIDERS.filter((p) => a.llm[p]))
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }, [])
  // 設定の画面・settings.json の書き換えで変えた提供元とモデルを、ここの選択にも映す
  useEffect(() => {
    const apply = (s: { organizer?: OrganizerModelPrefs & { runner?: unknown } }) => {
      if (isOrganizeRunnerId(s.organizer?.runner)) setRunner(s.organizer.runner)
      setOrganizerPrefs(s.organizer)
    }
    const offFile = window.ade.on('settings:changed', apply)
    const offApp = onOrganizerChanged(() => void window.ade.invoke('app:settings').then(apply).catch(() => undefined)) // 失敗は main の IPC が Sentry へ送る
    return () => { offFile(); offApp() }
  }, [])
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<{ src: string; n: number } | null>(null)
  const [frames, setFrames] = useState<{ itemId: string; n: number; current: number[]; options: ReviewFrame[] } | null>(null)
  /** 再生する動画と、その動画の中の開始時刻（追記した録画は takes ごとに別の動画） */
  const [playing, setPlaying] = useState<{ url: string; t: number; label: number; take: number | null } | null>(null)
  const videoTime = playing?.t ?? null
  const videoRef = useRef<HTMLVideoElement>(null)
  const probingDuration = useRef(false)
  const queue = useRef(Promise.resolve())
  const sending = useRef(false)
  const pending = useRef(0)
  const toast = useToast()
  const t = useT()
  // 何もない時間を削れなかった録画は元の動画で再生する。作業は止めず、控えめに一度だけ知らせる
  useEffect(() => {
    if (!review.trimSkipped || trimNoticeShown.has(review.id)) return
    trimNoticeShown.add(review.id)
    toast({ tone: 'info', message: t('review.trimSkipped') })
  }, [review.id, review.trimSkipped, toast, t])
  /** 「整理」の提供元の隣のモデルの選択。一覧は設定の「指摘の整理」と同じ推奨＋設定したモデル。選び直すと settings.json に書く */
  const organizeModelSelect = () => {
    const choice = organizeModelChoice(runner, organizerPrefs, localOrganizeModel)
    const provider = runner.startsWith('api:') ? runner.slice(4) as LlmApiProvider : null
    const name = provider ? providerLabel(LLM_PROVIDER_PRESETS[provider], t) : runner === 'codex' ? 'Codex' : 'Claude Code'
    const label = (id: string, recommended?: boolean) => {
      const text = id || (provider ? t('review.organizeModelUnset') : t('review.organizeModelCliDefault', { name }))
      return recommended && id ? t('onboarding.decision.recommendedOption', { label: text }) : text
    }
    return <Tooltip side="bottom" label={t('review.organizeModelTip', { summary: choice.current ? organizeRunnerSummary(name, choice.current) : name })}><span className="rv-select"><select className="rv-organize__runner rv-organize__model" aria-label={t('review.organizeModel')} value={choice.current} disabled={busy} data-testid="organize-model" onChange={(e) => {
      if (e.target.value === OTHER_MODEL) {
        // 一覧に無いモデルは設定の「指摘の整理」で入れる（今の提供元の欄を開く）
        window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'organize' } }))
        return
      }
      const patch = organizeModelPatch(runner, organizerPrefs, e.target.value, choice.defaultModel)
      setOrganizerPrefs((prev) => ({ ...prev, ...patch }))
      void window.ade.invoke('settings:organizer', patch).then(notifyOrganizerChanged).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    }}>
      {!choice.options.some((o) => o.id === choice.current) && <option value={choice.current}>{label(choice.current)}</option>}
      {choice.options.map((o) => <option key={o.id} value={o.id}>{label(o.id, o.recommended)}</option>)}
      {choice.otherInSettings && <option value={OTHER_MODEL}>{t('review.organizeModelOther')}</option>}
    </select></span></Tooltip>
  }
  const action = (fn: () => Promise<void>) => {
    pending.current++
    setBusy(true)
    const next = queue.current.then(fn).catch((err) => {
      // IPC の失敗は main が送り済み（reportHandled が見分ける）。renderer の処理の失敗だけが届く
      reportHandled(err, { area: 'review', op: 'edit findings' })
      toast({ tone: 'danger', message: t('common.actionFailed'), detail: errorMessage(err) })
    }).finally(() => {
      pending.current--
      if (!pending.current) setBusy(false)
    })
    queue.current = next
    return next
  }
  const edit = (change: ReviewEdit) => action(async () => {
    onUpdate(await window.ade.invoke('review:edit', review.id, change))
  })
  const items = review.document.items
  const sendable = items.filter((it) => it.include).length
  /** Send to Agent で送る件数。未対応の指摘だけ（完了・対応中・確認待ちは送らない） */
  const unstarted = pendingIds(items, review.progress).length
  /*
   * 録画の途中で対象（URL・ファイル）を切り替えたら、指摘を対象ごとにまとめる（見出しで分ける。対象で絞るチップは置かない）。
   * 番号はまとめた順に振る（feedback.md の節分けと同じ並び）。
   */
  const groups = groupByTarget(items, (it) => it.context.url, review.document.meta.urlPresets ?? [])
  const grouped = groups.length > 1
  let counter = 0
  /*
   * 確認モード: Agent が直した指摘（human_review）だけを並べ、BEFORE / AFTER を順に見て OK / NG を付ける。
   * O = OK、N = NG のコメント欄へ、↓ / ↑ = 次 / 前、Esc = 終了。入力欄で打っているときはキーを奪わない
   */
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewIndex, setReviewIndex] = useState(0)
  const reviewing = (it: FeedbackItem) => it.include && progressOf(review.progress, it.id) === 'human_review'
  const progressCount = countProgress(items, review.progress)
  /** 進み具合で隠すもの（確認モードの間は使わない。確認モードは確認待ちだけを並べる） */
  const [hiddenStatuses, setHiddenStatusesState] = useState<FindingProgress[]>(loadHiddenStatuses)
  const setHiddenStatuses = (next: FindingProgress[]) => {
    setHiddenStatusesState(next)
    saveHiddenStatuses(next)
  }
  const statusFiltered = !reviewMode && hiddenStatuses.length > 0
  const [reviewFirstOn, setReviewFirstState] = useState(loadReviewFirst)
  const setReviewFirst = (on: boolean) => {
    setReviewFirstState(on)
    saveReviewFirst(on)
  }
  const numbered = groups.flatMap((g) => g.items.map((item) => ({ item, n: ++counter, owner: g })))
  const rows = (reviewFirstOn ? reviewFirst(numbered, (row) => progressOf(review.progress, row.item.id)) : numbered)
    .filter((row) => !reviewMode || reviewing(row.item))
    .filter((row) => !statusFiltered || isStatusShown(hiddenStatuses, progressOf(review.progress, row.item.id)))
    // 対象の見出しは、絞り込んだあとの各対象の先頭に出す（先頭の指摘が隠れても見出しは残す）
    .map((row, i, all) => ({ ...row, group: i === 0 || all[i - 1]!.owner !== row.owner ? row.owner : null }))
  const currentRow = reviewMode ? rows[Math.min(reviewIndex, rows.length - 1)] : undefined
  /*
   * 並べ替え（つまみのドラッグ＆ドロップ・つまみで ↑ / ↓）。番号・feedback.md・Agent へ送る順はこの順に従う。
   * 全体の並びは画面の並び（対象ごとにまとめた順）。絞り込み中は見えている中での相対位置で決め、見えない指摘の位置は保つ。
   * 対象ごとにまとめているときは、同じ対象の中でだけ動かす（対象は指摘の URL で決まり、動かしても変わらないため）
   */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; position: DropPosition } | null>(null)
  const refocusHandle = useRef<string | null>(null)
  const allIds = groups.flatMap((g) => g.items.map((it) => it.id))
  // 並べ替えは元の並び（番号の順）の中で決める。「確認待ちを上に」は表示だけなので使わない
  const visibleIds = allIds.filter((id) => rows.some((row) => row.item.id === id))
  const ownerOf = (id: string) => rows.find((row) => row.item.id === id)?.owner
  const canReorder = !reviewMode && rows.length > 1
  const reorderTo = (next: string[] | null) => {
    if (next) void edit({ kind: 'order', ids: next })
  }
  const moveFinding = (id: string, delta: -1 | 1) => {
    const owner = ownerOf(id)
    reorderTo(stepAmongVisible(allIds, visibleIds, id, delta, (other) => ownerOf(other) === owner))
  }
  const acceptsDrop = (e: DragEvent<HTMLElement>, id: string) =>
    dragging !== null && Array.from(e.dataTransfer.types).includes(FINDING_DRAG_TYPE) && ownerOf(dragging) === ownerOf(id)
  const endDrag = () => {
    setDragging(null)
    setDropAt(null)
  }
  // キーボードで動かしたあと、並び直したつまみへフォーカスを戻す
  useEffect(() => {
    const id = refocusHandle.current
    if (!id) return
    refocusHandle.current = null
    document.querySelector<HTMLElement>(`[data-reorder-handle="${CSS.escape(id)}"]`)?.focus()
  }, [review])
  /** 本文を差し替えて Agent へ送る（確認への返答・NG の送り直し）。宛先は Send to Agent のボタンと同じ */
  const sendText = async (text: string) => {
    const { agents, running } = await loadSendTargets()
    return sendReviewToAgent({ reviewId: review.id, target: resolveRememberedTarget(rememberedSendTarget(projectKey), agents, running), focusedTerminalId: terminalId, defaultAgent, text,
      onStarting: (agent) => toast({ tone: 'info', message: t('review.startingAgent', { agent: agentLabel(agent) }) }) })
  }
  const verdict = async (itemId: string, kind: ReviewVerdict, body?: string) => {
    let ok = false
    await action(async () => {
      onUpdate({ ...review, progress: await window.ade.invoke('review:verdict', review.id, itemId, kind, body) })
      ok = true
    })
    return ok
  }
  /** NG の指摘をコメントつきで送り直す。itemIds を省くと送り直し待ちすべて（Agent はまた並列で直す） */
  const sendNg = (itemIds?: string[]) => void action(async () => {
    const prompt = await window.ade.invoke('review:ngPrompt', review.id, itemIds)
    const result = await sendText(prompt.text)
    if (result.ok) onUpdate({ ...review, progress: await window.ade.invoke('review:resent', review.id, prompt.ids) })
    toast({ tone: result.ok && result.submitted !== false ? 'success' : 'warning', message: result.ok && result.submitted !== false ? t('review.verdict.sent', { count: prompt.ids.length }) : result.message })
  })
  useEffect(() => {
    if (!reviewMode) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return
      const current = rows[Math.min(reviewIndex, rows.length - 1)]
      if (e.key === 'Escape') { setReviewMode(false); return }
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setReviewIndex((i) => Math.min(i + 1, Math.max(0, rows.length - 1))) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setReviewIndex((i) => Math.max(0, i - 1)) }
      else if (e.key === 'o' && current && !busy) { e.preventDefault(); void verdict(current.item.id, 'ok') }
      else if (e.key === 'n' && current) { e.preventDefault(); document.querySelector<HTMLTextAreaElement>(`[data-testid="review-verdict-input-${current.n}"]`)?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  // 今の指摘を画面に入れる
  useEffect(() => {
    if (currentRow) document.querySelector(`[data-testid="review-item-${currentRow.n}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentRow?.n])
  const draft = !review.document.organizedByLlm && items.length > 0
  // 押すとこのレビューに追記して録る（撮り忘れを同じレビューへ足す）。新しいレビューは ⌘⇧R・上の［録画］
  const recordButton = (className: string) => onRecord && <span className="rv-record-group">
    <Tooltip side="bottom" label={t('review.recordMoreTip')}>
      <Button variant="record" className={className} icon={<Circle size={10} fill="currentColor" strokeWidth={0} />} disabled={recording}
        data-testid={className === 'rv-record' ? 'findings-record' : 'findings-record-empty'} onClick={() => onRecord('append')}>{t('review.recordMore')}</Button>
    </Tooltip>
  </span>
  /** 指摘の時刻から、どの録画のどの時刻を再生するか（追記していなければ最初の動画のその時刻） */
  // 削った版（何もない時間を除いたもの）なら、削った区間ぶん詰めた位置から開く
  const playbackOf = (item: FeedbackItem) => playbackAt(review.takes, review.videoUrl, item.t)

  return <div className="findings rv" data-testid="findings" aria-busy={busy}>
    <header className="rv-head">
      <div className="rv-head__summary">
        <span className="rv-head__count"><strong>{items.length}</strong>{t('review.findingsLabel', { count: items.length })}</span>
        <span className="rv-head__meta">
          <span className={`rv-dot${busy ? ' is-busy' : ''}`} aria-hidden="true" />
          {busy ? t('review.saving') : t('review.saved')} · {t('review.sendCount', { sendable, total: items.length })} · {time(review.document.meta.durationMs)}
          {draft && <span className="rv-head__draft" title={t('review.draftHint')}>{t('review.draft')}</span>}
        </span>
        {/* 指摘の進み具合（progress.json。Agent が作業しながら書く） */}
        <ProgressSummary items={items} progress={review.progress} />
        {/* 確認待ちをまとめて見る・NG をまとめて送り直す（並列で直す → まとめて確認 → NG だけ戻す、を速く回す） */}
        <ReviewActions humanReview={progressCount.humanReview} queued={progressCount.queued} reviewMode={reviewMode} busy={busy}
          onToggleReviewMode={() => { setReviewMode((on) => !on); setReviewIndex(0) }} onSendQueued={() => sendNg()} />
      </div>
      {/* 送る指摘が残っているときだけ案内を出す。どれも着手済みなら何も出さない（送れない理由は送信ボタンの説明に出る） */}
      {!(sendable > 0 && unstarted === 0) && <p className="rv-head__hint" data-testid="findings-head-hint">{t('review.headHint')}</p>}
      <div className="rv-head__actions">
        <div className="rv-head__tools">
          <Tool side="bottom" tip={t('review.undo')} label={t('review.undoLabel')} icon={<Undo2 size={15} />} disabled={busy || !review.canUndo} onClick={() => void edit({ kind: 'undo' })} />
          {/*
            並び順。手動（ドラッグの順）・録画の時刻順・進み具合の順。進み具合の順は、その時点で並べ替えた順を手動の順として保存する
            （番号・feedback.md・Agent へ送る順が並びに従うため、表示だけを並べ替えない）。元に戻す ↶ でも1手ずつ戻せる
          */}
          {items.length > 1 && <Tooltip side="bottom" label={t('review.sort.tip')}><span className="rv-select"><select className="rv-sort" aria-label={t('review.sort.label')} disabled={busy}
            value={reviewFirstOn ? 'review_first' : review.document.customOrder ? 'manual' : 'time'} data-testid="findings-sort"
            onChange={(e) => {
              setReviewFirst(e.target.value === 'review_first')
              if (e.target.value === 'time') void edit({ kind: 'order', ids: null })
              else if (e.target.value === 'status') void edit({ kind: 'order', ids: sortByStatus(allIds, review.progress) })
            }}>
            <option value="review_first">{t('review.sort.reviewFirst')}</option>
            <option value="manual" disabled={!review.document.customOrder}>{t('review.sort.manual')}</option>
            <option value="time">{t('review.sort.time')}</option>
            <option value="status">{t('review.sort.status')}</option>
          </select></span></Tooltip>}
          <Tool side="bottom" tip={t('review.openFolder')} label={t('review.folder')} icon={<FolderOpen size={15} />} disabled={busy} onClick={() => void action(async () => {
            await window.ade.invoke('review:folder', review.id)
          })} />
          <Tool side="bottom" tip={t('review.copyForAgent')} label={t('review.copyForAgent')} icon={<Clipboard size={15} />} disabled={busy || sendable === 0} onClick={() => void action(async () => {
            await window.ade.invoke('review:copy', review.id)
            toast({ tone: 'success', message: t('review.copied'), detail: t('review.copiedDetail') })
          })} />
        </div>
        <div className="rv-organize" data-disabled={busy || !review.canOrganize || undefined}>
          <Tooltip side="bottom" label={t('review.organizeTip')}>
            <button type="button" className="rv-organize__run" aria-label={t('review.organizeLabel')} disabled={busy || !review.canOrganize}
              onClick={() => void action(async () => onUpdate(await window.ade.invoke('review:organize', review.id, runner)))}>
              <Sparkles size={14} /><span>{t('review.organize')}</span>
            </button>
          </Tooltip>
          <Tooltip side="bottom" label={t('review.organizeRunnerTip')}><span className="rv-select"><select className="rv-organize__runner" aria-label={t('review.organizeRunner')} value={runner} disabled={busy} onChange={(e) => {
            const next = e.target.value as OrganizeRunnerId
            setRunner(next)
            void window.ade.invoke('settings:organizer', { runner: next })
          }}>
            {/* 先頭はおすすめの Ollama（設定していなくても出す。動いていなければ押したときに理由を出す） */}
            <option value={`api:${RECOMMENDED_ORGANIZE_PROVIDER}`}>{t('onboarding.decision.recommendedOption', { label: providerLabel(LLM_PROVIDER_PRESETS[RECOMMENDED_ORGANIZE_PROVIDER], t) })}</option>
            <optgroup label={t('review.organizeRunnerCli')}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></optgroup>
            {/* 選んでいる API は、キーを消したあとでも残す（押すと理由を出す） */}
            {LLM_API_PROVIDERS.some((p) => p !== RECOMMENDED_ORGANIZE_PROVIDER && (apiReady.includes(p) || runner === `api:${p}`)) && <optgroup label={t('review.organizeRunnerApi')}>
              {LLM_API_PROVIDERS.filter((p) => p !== RECOMMENDED_ORGANIZE_PROVIDER && (apiReady.includes(p) || runner === `api:${p}`)).map((p) => <option key={p} value={`api:${p}`}>{providerLabel(LLM_PROVIDER_PRESETS[p], t)}</option>)}
            </optgroup>}
          </select></span></Tooltip>
          {organizeModelSelect()}
        </div>
        {/* 録る・送るは1組。幅が足りないときも離さず、まとめて次の行へ回す */}
        <div className="rv-head__primary">
        {recordButton('rv-record')}
        <SendTargetButton projectKey={projectKey} disabled={busy || !unstarted} count={unstarted}
          disabledReason={sendable > 0 && unstarted === 0 ? t('review.nothingPending') : undefined}
          onSend={(target) => {
            // 押し直し・二度押しで同じ送信を重ねない（トーストが2回出ていた）
            if (sending.current) return
            sending.current = true
            void action(async () => {
              // 宛先に Agent が居なければ、その Agent（自動なら既定の Agent）を起動してから送る（lib/sendReview.ts）
              const result = await sendReviewToAgent({ reviewId: review.id, target, focusedTerminalId: terminalId, defaultAgent,
                onStarting: (agent) => toast({ tone: 'info', message: t('review.startingAgent', { agent: agentLabel(agent) }) }) })
              // 送った時刻（sentAt）を読み直す。追記した指摘の「未送信」の印を外すため。
              // 読み直せなくても送信は済んでいるので、結果の知らせはそのまま出す（失敗は main の IPC が送る）
              if (result.ok) await window.ade.invoke('review:load', review.id).then(onUpdate, () => undefined)
              toast({ tone: result.ok ? (result.submitted === false ? 'warning' : 'success') : 'warning', message: result.message })
            }).finally(() => { sending.current = false })
          }} />
        </div>
      </div>
    </header>

    <div className="rv-list">
      {review.warnings.length > 0 && <div className="rv-notice" role="status">
        <AlertTriangle size={14} aria-hidden="true" />
        <div>{review.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>
      </div>}

      {items.length === 0 && <EmptyState art={<FindingsEmptyArt />} title={t('review.emptyTitle')}
        description={t('review.emptyDescription')} actions={recordButton('rv-record rv-record--empty')} />}

      {items.length > 0 && !reviewMode && <StatusFilterBar counts={countByStatus(items, review.progress)} hidden={hiddenStatuses} onChange={setHiddenStatuses} />}


      {rows.map(({ item, n, group }) => {
        const source = sourcesOf(item)
        const checking = item.status === 'needs_check'
        const take = takeAt(review.takes, item.t)
        const unsent = isUnsentTake(take, review.sentAt)
        const playback = playbackOf(item)
        // 要望と同じ原文は引用に出さない（下書きでは要望＝話した全文。原文は保存されている）
        const quotes = same(item.quotes.map((q) => q.text).join(''), item.request) ? [] : item.quotes.filter((q) => !same(q.text, item.request))
        return <Fragment key={item.id}>
          {/* 対象が1つでも、デザイン・設計書・参考（外部サイト）で撮った指摘なら見出しを出す（アプリのコードへの指摘ではないと分かるように） */}
          {(grouped || group?.target.purpose) && group && <h3 className="rv-target" title={group.target.url ?? group.target.name}>
            <TargetName target={group.target} />
            <span className="rv-targets__count">{group.items.length}</span>
          </h3>}
          <article onDragOver={(e) => {
            if (!acceptsDrop(e, item.id)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const box = e.currentTarget.getBoundingClientRect()
            const position = dropPositionAt(e.clientY - box.top, box.height)
            if (dropAt?.id !== item.id || dropAt.position !== position) setDropAt({ id: item.id, position })
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropAt?.id === item.id) setDropAt(null)
          }}
          onDrop={(e) => {
            if (!acceptsDrop(e, item.id) || !dragging) return
            e.preventDefault()
            const box = e.currentTarget.getBoundingClientRect()
            reorderTo(moveAmongVisible(allIds, visibleIds, dragging, item.id, dropPositionAt(e.clientY - box.top, box.height)))
            endDrag()
          }}
          className={`rv-card${dragging === item.id ? ' is-dragging' : ''}${dropAt?.id === item.id ? ` is-drop-${dropAt.position}` : ''}${item.include ? '' : ' is-excluded'}${checking ? ' is-checking' : ''}${progressOf(review.progress, item.id) === 'done' ? ' is-done' : ''}${reviewing(item) ? ' is-reviewing' : ''}${currentRow?.item === item ? ' is-current' : ''}`} data-testid={`review-item-${n}`}>
          {/* BEFORE（録画時の静止画）と、Agent が直したあとに撮った AFTER（progress.json の after）。ReviewShots.tsx */}
          <FindingShots review={review} item={item} n={n} onZoom={(src) => setImage({ src, n })} />

          <div className="rv-card__body">
            <div className="rv-card__top">
              {canReorder && <button type="button" className="rv-card__grip" draggable={!busy} disabled={busy} data-reorder-handle={item.id} data-testid={`review-item-grip-${n}`}
                aria-label={t('review.reorderHandle', { n })} title={t('review.reorderHandle', { n })}
                onDragStart={(e) => {
                  e.dataTransfer.setData(FINDING_DRAG_TYPE, item.id)
                  e.dataTransfer.effectAllowed = 'move'
                  const card = e.currentTarget.closest('.rv-card')
                  if (card) e.dataTransfer.setDragImage(card, 24, 24)
                  setDragging(item.id)
                }}
                onDragEnd={endDrag}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                  e.preventDefault()
                  refocusHandle.current = item.id
                  moveFinding(item.id, e.key === 'ArrowUp' ? -1 : 1)
                }}>
                <GripVertical size={14} aria-hidden="true" />
              </button>}
              <input className="rv-card__title" aria-label={t('review.titleLabel', { n })} key={`${item.id}-title-${item.title}`} defaultValue={item.title} disabled={busy} spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur() }}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== item.title) void edit({ kind: 'text', id: item.id, title: e.target.value.trim() }); else e.target.value = item.title }} />
              {/* 進み具合（未対応 → 対応中 → 完了）。Agent と同じ progress.json に書く */}
              <ProgressToggle n={n} progress={progressOf(review.progress, item.id)} disabled={busy}
                onChange={() => void action(async () => {
                  const progress = await window.ade.invoke('review:progress', review.id, { [item.id]: nextProgress(progressOf(review.progress, item.id)) })
                  onUpdate({ ...review, progress })
                })} />
              {checking &&<span className="rv-flag"><Flag size={11} />{t('review.needsCheck')}</span>}
              {/* 追記した録画の指摘。まだ Agent へ送っていなければ強調する */}
              {take?.addedAt && <span className={`rv-added${unsent ? ' is-unsent' : ''}`} data-testid="review-item-added"
                title={t(unsent ? 'review.addedUnsentTip' : 'review.addedTip', { n: take.n })}>{t('review.addedBadge')}</span>}
            </div>
            {/* Agent が直した指摘（human_review）。人が OK / NG / Comment を付ける。done にできるのは人だけ */}
            {reviewing(item) && <VerdictPanel n={n} entry={review.progress![item.id]!} busy={busy} onVerdict={(kind, body) => verdict(item.id, kind, body)} />}
            {/* NG を付けて、まだ送り直していない。1件だけ送る操作（まとめて送るのはヘッダー） */}
            {item.include && review.progress?.[item.id]?.queued && <QueuedPanel n={n} entry={review.progress[item.id]!} busy={busy} onSendOne={() => sendNg([item.id])} />}
            {/* 要望は Agent に渡す本文。空に見えると何も伝わらないように見えるので、見出しと同じでもそのまま出す */}
            <textarea className="rv-card__request" aria-label={t('review.requestLabel', { n })} key={`${item.id}-request-${item.request}`} defaultValue={item.request}
              placeholder={t('review.requestPlaceholder')} disabled={busy} rows={2}
              onBlur={(e) => {
                if (e.target.value !== item.request) void edit({ kind: 'text', id: item.id, request: e.target.value.trim() })
              }} />
            {/* 話した言葉（文字起こし）。要望と同じなら出さない */}
            {quotes.length > 0 && <p className="rv-card__quote rv-card__transcript"><Mic size={11} aria-hidden="true" /><span className="rv-card__transcript-label">{t('review.transcriptLabel')}</span>{quotes.map((q) => t('review.quote', { text: q.text })).join(' ')}</p>}

            <div className="rv-card__foot">
              <div className="rv-card__chips">
                <SourceChips {...source} />
                {item.context.url && <span className="rv-chip" title={item.context.url}><Globe size={11} /><span>{hostOf(item.context.url)}</span></span>}
                {item.context.element && <span className="rv-chip rv-chip--mono" title={item.context.element.selector}><Code2 size={11} /><span>{item.context.element.selector}</span></span>}
              </div>
              <div className="rv-card__tools">
                <label className={`rv-include${item.include ? ' is-on' : ''}`} title={item.include ? t('review.include') : t('review.exclude')}>
                  <input type="checkbox" checked={item.include} disabled={busy} aria-label={t('review.includeLabel', { n })}
                    onChange={(e) => void edit({ kind: 'include', id: item.id, include: e.target.checked })} />
                  <span className="rv-include__track" aria-hidden="true" />
                  <Send size={12} aria-hidden="true" />
                </label>
                <span className="rv-card__sep" aria-hidden="true" />
                {playback && <Tool tip={t('review.watchRecording')} label={t('review.watchRecordingLabel')} icon={<Play size={14} />} disabled={busy} onClick={() => setPlaying(playback)} />}
                <Tool tip={t('review.replaceImage')} label={t('review.replaceImage')} icon={<Images size={14} />} disabled={busy}
                  onClick={() => void action(async () => setFrames({ itemId: item.id, n, current: item.frameTimes, options: await window.ade.invoke('review:frames', review.id, item.id) }))} />
                {/* 整理が「要確認」にした指摘だけ確定できる（手で要確認にする・次とまとめるボタンは置かない） */}
                {checking && <Tool tip={t('review.confirm')} label={t('review.confirmLabel')} icon={<CheckCircle2 size={14} />} className="rv-tool--confirm" disabled={busy} onClick={() => void edit({ kind: 'status', id: item.id, status: 'decided' })} />}
                <Tool tip={t('review.delete')} label={t('review.deleteLabel', { n })} icon={<Trash2 size={14} />} className="rv-tool--danger" disabled={busy}
                  onClick={() => void edit({ kind: 'delete', id: item.id })} />
              </div>
            </div>
          </div>
        </article>
        </Fragment>
      })}

      {review.document.dropped.length > 0 && <details className="rv-dropped">
        <summary>{t('review.droppedSummary', { count: review.document.dropped.length })}</summary>
        <ul>{review.document.dropped.map((dropped) => <li key={dropped.t}>
          <span className="rv-dropped__time">{time(dropped.t)}</span>
          <span className="rv-dropped__text">{t('review.quote', { text: dropped.text })}<small>{dropped.reason}</small></span>
          <Button variant="ghost" icon={<RotateCcw size={13} />} disabled={busy}
            onClick={() => void action(async () => onUpdate(await window.ade.invoke('review:restore', review.id, dropped.t)))}>{t('review.restoreDropped')}</Button>
        </li>)}</ul>
      </details>}

      {/* 全体への補足（Overall Note）の欄は置かない。古いレビューの note は feedback.md に今までどおり載る */}
      {statusFiltered && rows.length === 0 && <p className="rv-head__hint" role="status" data-testid="findings-status-filter-empty">{t('review.statusFilter.empty')}</p>}
      {reviewMode && rows.length === 0 && <p className="rv-head__hint" role="status" data-testid="review-mode-empty">{t('review.reviewMode.empty')}</p>}
    </div>

    {frames && <Modal className="rv-modal" label={t('review.replaceImageTitle')} onClose={() => setFrames(null)}>
      <div className="rv-modal__panel rv-modal__panel--wide">
        <header className="rv-modal__head">
          <h2><Images size={16} aria-hidden="true" />{t('review.pickImageFor', { n: frames.n })}</h2>
          <ModalClose onClose={() => setFrames(null)} />
        </header>
        {frames.options.length > 0
          ? <div className="rv-frames">{frames.options.map((frame) => {
            const current = frames.current.includes(frame.t)
            return <button type="button" key={frame.t} className={`rv-frame${current ? ' is-current' : ''}`} disabled={busy} aria-label={t('review.pickImageAt', { time: time(frame.t) })}
              onClick={() => void edit({ kind: 'frames', id: frames.itemId, frameTimes: [frame.t] }).then(() => setFrames(null))}>
              <img src={frame.image} alt="" />
              <span className="rv-frame__time">{time(frame.t)}</span>
              {current && <span className="rv-frame__current" title={t('review.currentImage')}><CheckCircle2 size={12} aria-hidden="true" /><span className="rv-sr">{t('review.currentImage')}</span></span>}
            </button>
          })}</div>
          : <p className="rv-modal__empty">{t('review.noFrames')}</p>}
      </div>
    </Modal>}

    {videoTime !== null && playing && <Modal className="rv-modal" label={t('review.recordingPlayback')} onClose={() => setPlaying(null)}>
      <div className="rv-modal__media">
        <ModalClose onClose={() => setPlaying(null)} />
        <video ref={videoRef} src={playing.url} controls
          onLoadedMetadata={() => {
            const video = videoRef.current
            if (!video) return
            // MediaRecorder の WebM は長さが Infinity のまま。末尾へ飛ばすと長さが確定するので、確定後に開始時刻へ戻す
            if (Number.isFinite(video.duration)) video.currentTime = videoTime / 1000
            else { probingDuration.current = true; video.currentTime = Number.MAX_SAFE_INTEGER }
          }}
          onDurationChange={() => {
            const video = videoRef.current
            if (!video || !probingDuration.current || !Number.isFinite(video.duration)) return
            probingDuration.current = false
            video.currentTime = videoTime / 1000
          }}
          onError={() => toast({ tone: 'warning', message: t('review.playbackFailed') })} />
        <span className="rv-modal__caption"><Play size={12} />{playing.take ? t('review.fromTake', { n: playing.take, time: time(playing.label) }) : t('review.fromTime', { time: time(playing.label) })}</span>
      </div>
    </Modal>}


    {image && <Modal className="rv-modal" label={t('review.findingScreen')} onClose={() => setImage(null)}>
      <div className="rv-modal__media">
        <ModalClose onClose={() => setImage(null)} />
        <img src={image.src} alt={t('review.zoomedAlt')} />
        <span className="rv-modal__caption"><span className="rv-card__n rv-card__n--inline">{image.n}</span>{t('review.findingN', { n: image.n })}</span>
      </div>
    </Modal>}
  </div>
}
