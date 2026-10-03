import { Fragment, useEffect, useState, useRef } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clipboard,
  Code2,
  FileText,
  Flag,
  GitPullRequest,
  FolderOpen,
  Globe,
  Images,
  Merge,
  Mic,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  X
} from 'lucide-react'
import { isUnsentTake, playbackAt, takeAt, type ReviewData, type ReviewEdit, type ReviewFrame } from '@shared/review'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, isOrganizeRunnerId, providerLabel, type LlmApiProvider, type OrganizeRunnerId } from '@shared/aiProviders'
import { Button, EmptyState, IconButton, Modal, Tooltip, useToast } from '../ui'
import { FindingsEmptyArt } from './reviewArt'
import { FindingShots } from './ReviewShots'
import { errorMessage } from '../lib/errors'
import { GitHubSendDialog } from './GitHubSendDialog'
import { useT } from '../lib/i18n'
import { groupByTarget, targetHeading, type ReviewTarget } from '@shared/reviewTarget'
import { reportHandled } from '@shared/report'
import { agentLabel } from '@shared/agentCatalog'
import type { TuiAgent } from '@shared/types'
import { formatShortcut } from '../lib/shortcut'
import { loadSendTargets, rememberedSendTarget, resolveRememberedTarget, sendReviewToAgent } from '../lib/sendReview'
import { SendTargetButton } from './SendTargetButton'
import { NeedsHumanPanel, ProgressSummary, ProgressToggle, QueuedPanel, ReviewActions, VerdictPanel } from './FindingProgress'
import { countProgress, nextProgress, pendingIds, progressOf, type ReviewVerdict } from '@shared/findingProgress'

type FeedbackItem = ReviewData['document']['items'][number]

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
  return <>
    <Icon size={12} aria-hidden="true" />
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
  const [runner, setRunner] = useState<OrganizeRunnerId>('codex')
  /** Agent がどこにも居ないときに起動するもの（設定の startupAgents の先頭） */
  const [defaultAgent, setDefaultAgent] = useState<TuiAgent>('claude')
  /** 送り先を覚える単位（開いているプロジェクト） */
  const [projectKey, setProjectKey] = useState('default')
  /** API キーで直接呼べる提供元（設定の「指摘の整理」でキーと接続先が揃ったもの） */
  const [apiReady, setApiReady] = useState<LlmApiProvider[]>([])
  useEffect(() => {
    void Promise.all([window.ade.invoke('app:settings'), window.ade.invoke('capture:availability')]).then(([s, a]) => {
      if (isOrganizeRunnerId(s.organizer?.runner)) setRunner(s.organizer.runner)
      const first = s.agents?.startupAgents?.find((a) => !s.agents.disabledAgents?.includes(a))
      if (first) setDefaultAgent(first)
      if (s.activeProjectId) setProjectKey(s.activeProjectId)
      setApiReady(LLM_API_PROVIDERS.filter((p) => a.llm[p]))
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }, [])
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<{ src: string; n: number } | null>(null)
  const [frames, setFrames] = useState<{ itemId: string; n: number; current: number[]; options: ReviewFrame[] } | null>(null)
  /** 再生する動画と、その動画の中の開始時刻（追記した録画は takes ごとに別の動画） */
  const [playing, setPlaying] = useState<{ url: string; t: number; label: number; take: number | null } | null>(null)
  const videoTime = playing?.t ?? null
  const [githubOpen, setGithubOpen] = useState(false)
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
   * 録画の途中で対象（URL・ファイル）を切り替えたら、指摘を対象ごとにまとめ、対象で絞れるようにする。
   * 番号はまとめた順に振る（feedback.md の節分けと同じ並び）。
   */
  const [targetFilter, setTargetFilter] = useState<string | null>(null)
  const groups = groupByTarget(items, (it) => it.context.url, review.document.meta.urlPresets ?? [])
  const grouped = groups.length > 1
  const activeFilter = grouped && groups.some((g) => g.target.key === targetFilter) ? targetFilter : null
  let counter = 0
  /*
   * 確認モード: Agent が直した指摘（human_review）だけを並べ、BEFORE / AFTER を順に見て OK / NG を付ける。
   * O = OK、N = NG のコメント欄へ、↓ / ↑ = 次 / 前、Esc = 終了。入力欄で打っているときはキーを奪わない
   */
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewIndex, setReviewIndex] = useState(0)
  const reviewing = (it: FeedbackItem) => it.include && progressOf(review.progress, it.id) === 'human_review'
  const progressCount = countProgress(items, review.progress)
  const rows = groups.flatMap((g) => g.items.map((item, i) => ({ item, n: ++counter, group: i === 0 ? g : null })))
    .filter((row) => !activeFilter || groups.find((g) => g.items.includes(row.item))?.target.key === activeFilter)
    .filter((row) => !reviewMode || reviewing(row.item))
  const currentRow = reviewMode ? rows[Math.min(reviewIndex, rows.length - 1)] : undefined
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
  // 押すとこのレビューに追記して録る（撮り忘れを同じレビューへ足す）。新しいレビューは隣の ＋（⌘⇧R と同じ）
  const recordButton = (className: string) => onRecord && <span className="rv-record-group">
    <Tooltip side="bottom" label={t('review.recordMoreTip')}>
      <Button variant="record" className={className} icon={<Circle size={10} fill="currentColor" strokeWidth={0} />} disabled={recording}
        data-testid={className === 'rv-record' ? 'findings-record' : 'findings-record-empty'} onClick={() => onRecord('append')}>{t('review.recordMore')}</Button>
    </Tooltip>
    <Tool side="bottom" tip={t('review.recordNewReviewTip', { shortcut: formatShortcut('Mod', 'Shift', 'R') })} label={t('review.recordNewReview')} icon={<Plus size={14} />}
      disabled={recording} data-testid="findings-record-new" onClick={() => onRecord('new')} />
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
      {/* 送る指摘はあるが、どれも着手済み（完了・対応中・確認待ち）なら、送れない理由を出す */}
      <p className="rv-head__hint" role={sendable > 0 && unstarted === 0 ? 'status' : undefined} data-testid="findings-head-hint">
        {sendable > 0 && unstarted === 0 ? t('review.nothingPending') : t('review.headHint')}
      </p>
      <div className="rv-head__actions">
        <div className="rv-head__tools">
          <Tool side="bottom" tip={t('review.undo')} label={t('review.undoLabel')} icon={<Undo2 size={15} />} disabled={busy || !review.canUndo} onClick={() => void edit({ kind: 'undo' })} />
          <Tool side="bottom" tip={t('review.openFolder')} label={t('review.folder')} icon={<FolderOpen size={15} />} disabled={busy} onClick={() => void action(async () => {
            await window.ade.invoke('review:folder', review.id)
          })} />
          <Tool side="bottom" tip={t('review.copyForAgent')} label={t('review.copyForAgent')} icon={<Clipboard size={15} />} disabled={busy || sendable === 0} onClick={() => void action(async () => {
            await window.ade.invoke('review:copy', review.id)
            toast({ tone: 'success', message: t('review.copied'), detail: t('review.copiedDetail') })
          })} />
          {/* 送る前に送り先と本文の確認ダイアログを出す。押しただけでは GitHub に書き込まない */}
          <Tool side="bottom" tip={t('review.sendToGitHubTip')} label={t('review.sendToGitHub')} icon={<GitPullRequest size={15} />} disabled={busy || sendable === 0}
            onClick={() => setGithubOpen(true)} />
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
            <optgroup label={t('review.organizeRunnerCli')}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></optgroup>
            {/* 選んでいる API は、キーを消したあとでも残す（押すと理由を出す） */}
            {(apiReady.length > 0 || runner.startsWith('api:')) && <optgroup label={t('review.organizeRunnerApi')}>
              {LLM_API_PROVIDERS.filter((p) => apiReady.includes(p) || runner === `api:${p}`).map((p) => <option key={p} value={`api:${p}`}>{providerLabel(LLM_PROVIDER_PRESETS[p], t)}</option>)}
            </optgroup>}
          </select></span></Tooltip>
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

      {grouped && <div className="rv-targets" role="group" aria-label={t('review.targets.filter')}>
        <button type="button" className="rv-targets__chip" aria-pressed={activeFilter === null} onClick={() => setTargetFilter(null)}>
          {t('review.targets.all')}<span className="rv-targets__count">{items.length}</span>
        </button>
        {groups.map((g) => <button key={g.target.key} type="button" className="rv-targets__chip" aria-pressed={activeFilter === g.target.key}
          title={g.target.url ?? g.target.name} onClick={() => setTargetFilter(g.target.key)}>
          <TargetName target={g.target} /><span className="rv-targets__count">{g.items.length}</span>
        </button>)}
      </div>}

      {rows.map(({ item, n, group }) => {
        // 隣との結合は時刻の並び（items）で判定する
        const index = items.indexOf(item)
        const source = sourcesOf(item)
        const checking = item.status === 'needs_check'
        const take = takeAt(review.takes, item.t)
        const unsent = isUnsentTake(take, review.sentAt)
        const playback = playbackOf(item)
        // 要望と同じ原文は引用に出さない（下書きでは要望＝話した全文。原文は保存されている）
        const quotes = same(item.quotes.map((q) => q.text).join(''), item.request) ? [] : item.quotes.filter((q) => !same(q.text, item.request))
        return <Fragment key={item.id}>
          {grouped && group && <h3 className="rv-target" title={group.target.url ?? group.target.name}>
            <TargetName target={group.target} />
            <span className="rv-targets__count">{group.items.length}</span>
          </h3>}
          <article className={`rv-card${item.include ? '' : ' is-excluded'}${checking ? ' is-checking' : ''}${progressOf(review.progress, item.id) === 'done' ? ' is-done' : ''}${item.include && progressOf(review.progress, item.id) === 'needs_human' ? ' is-asking' : ''}${reviewing(item) ? ' is-reviewing' : ''}${currentRow?.item === item ? ' is-current' : ''}`} data-testid={`review-item-${n}`}>
          {/* BEFORE（録画時の静止画）と、Agent が直したあとに撮った AFTER（progress.json の after）。ReviewShots.tsx */}
          <FindingShots review={review} item={item} n={n} onZoom={(src) => setImage({ src, n })} />

          <div className="rv-card__body">
            <div className="rv-card__top">
              <input className="rv-card__title" aria-label={t('review.titleLabel', { n })} key={`${item.id}-title-${item.title}`} defaultValue={item.title} disabled={busy} spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
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
            {/* Agent が前提違いで人間へ戻した指摘（needs_human）。返答して送り直す／取り下げる／撮り直す */}
            {item.include && review.progress?.[item.id]?.status === 'needs_human' && <NeedsHumanPanel n={n} entry={review.progress[item.id]!} busy={busy}
              onReply={async (reply) => {
                let ok = false
                await action(async () => {
                  // 宛先は Send to Agent のボタンと同じ（最後に選んだ宛先を今の Agent・タブに合わせる。居なければ起動してから送る）
                  const text = await window.ade.invoke('review:replyPrompt', review.id, item.id, reply)
                  const { agents, running } = await loadSendTargets()
                  const target = resolveRememberedTarget(rememberedSendTarget(projectKey), agents, running)
                  const result = await sendReviewToAgent({ reviewId: review.id, target, focusedTerminalId: terminalId, defaultAgent, text,
                    onStarting: (agent) => toast({ tone: 'info', message: t('review.startingAgent', { agent: agentLabel(agent) }) }) })
                  if (result.ok) {
                    ok = true
                    onUpdate({ ...review, progress: await window.ade.invoke('review:progress', review.id, { [item.id]: { status: 'in_progress', reply } }) })
                  }
                  // submitted === false は貼り付けただけ（利用者が Enter を押す）。その案内は result.message に入っている
                  toast({ tone: result.ok && result.submitted !== false ? 'success' : 'warning', message: result.ok && result.submitted !== false ? t('review.needsHuman.sent') : result.message })
                })
                return ok
              }}
              onWithdraw={() => void action(async () => {
                // Send to Agent から外し、進み具合も未対応へ戻す（完了扱いにしない）
                const next = await window.ade.invoke('review:edit', review.id, { kind: 'include', id: item.id, include: false })
                onUpdate({ ...next, progress: await window.ade.invoke('review:progress', review.id, { [item.id]: 'todo' }) })
              })}
              {...(onRecord ? { onRerecord: () => onRecord('append') } : {})} />}
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
                {checking
                  ? <Tool tip={t('review.confirm')} label={t('review.confirmLabel')} icon={<CheckCircle2 size={14} />} className="rv-tool--confirm" disabled={busy} onClick={() => void edit({ kind: 'status', id: item.id, status: 'decided' })} />
                  : <Tool tip={t('review.markNeedsCheck')} label={t('review.markNeedsCheck')} icon={<Flag size={14} />} disabled={busy} onClick={() => void edit({ kind: 'status', id: item.id, status: 'needs_check' })} />}
                {index < items.length - 1 && <Tool tip={t('review.mergeNext')} label={t('review.mergeNextLabel')} icon={<Merge size={14} />} disabled={busy}
                  onClick={() => void edit({ kind: 'merge', ids: [item.id, items[index + 1]!.id] })} />}
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

    {githubOpen && <GitHubSendDialog reviewId={review.id} onClose={() => setGithubOpen(false)} />}

    {image && <Modal className="rv-modal" label={t('review.findingScreen')} onClose={() => setImage(null)}>
      <div className="rv-modal__media">
        <ModalClose onClose={() => setImage(null)} />
        <img src={image.src} alt={t('review.zoomedAlt')} />
        <span className="rv-modal__caption"><span className="rv-card__n rv-card__n--inline">{image.n}</span>{t('review.findingN', { n: image.n })}</span>
      </div>
    </Modal>}
  </div>
}
