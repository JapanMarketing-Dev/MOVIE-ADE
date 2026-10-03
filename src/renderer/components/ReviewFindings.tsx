import { useEffect, useState, useRef } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Code2,
  Flag,
  GitPullRequest,
  FolderOpen,
  Globe,
  Images,
  Maximize2,
  Merge,
  Mic,
  PenLine,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  X
} from 'lucide-react'
import type { ReviewData, ReviewEdit, ReviewFrame } from '@shared/review'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, isOrganizeRunnerId, providerLabel, type LlmApiProvider, type OrganizeRunnerId } from '@shared/aiProviders'
import { Button, EmptyState, IconButton, Modal, Tooltip, useToast } from '../ui'
import { FindingsEmptyArt, NoImageArt } from './reviewArt'
import { errorMessage } from '../lib/errors'
import { GitHubSendDialog } from './GitHubSendDialog'
import { useT } from '../lib/i18n'

type FeedbackItem = ReviewData['document']['items'][number]

const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`

export function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
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

export function ReviewFindings({ review, onUpdate, terminalId }: { terminalId: string | null; review: ReviewData; onUpdate: (data: ReviewData) => void }) {
  const [runner, setRunner] = useState<OrganizeRunnerId>('codex')
  /** API キーで直接呼べる提供元（設定の「指摘の整理」でキーと接続先が揃ったもの） */
  const [apiReady, setApiReady] = useState<LlmApiProvider[]>([])
  useEffect(() => {
    void Promise.all([window.ade.invoke('app:settings'), window.ade.invoke('capture:availability')]).then(([s, a]) => {
      if (isOrganizeRunnerId(s.organizer?.runner)) setRunner(s.organizer.runner)
      setApiReady(LLM_API_PROVIDERS.filter((p) => a.llm[p]))
    }).catch(() => undefined)
  }, [])
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<{ src: string; n: number } | null>(null)
  const [frames, setFrames] = useState<{ itemId: string; n: number; current: number[]; options: ReviewFrame[] } | null>(null)
  const [videoTime, setVideoTime] = useState<number | null>(null)
  const [githubOpen, setGithubOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const probingDuration = useRef(false)
  const queue = useRef(Promise.resolve())
  const pending = useRef(0)
  const toast = useToast()
  const t = useT()
  const action = (fn: () => Promise<void>) => {
    pending.current++
    setBusy(true)
    const next = queue.current.then(fn).catch((err) => toast({ tone: 'danger', message: t('common.actionFailed'), detail: errorMessage(err) })).finally(() => {
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
  const draft = !review.document.organizedByLlm && items.length > 0

  return <div className="findings rv" data-testid="findings" aria-busy={busy}>
    <header className="rv-head">
      <div className="rv-head__summary">
        <span className="rv-head__count"><strong>{items.length}</strong>{t('review.findingsLabel', { count: items.length })}</span>
        <span className="rv-head__meta">
          <span className={`rv-dot${busy ? ' is-busy' : ''}`} aria-hidden="true" />
          {busy ? t('review.saving') : t('review.saved')} · {t('review.sendCount', { sendable, total: items.length })} · {time(review.document.meta.durationMs)}
          {draft && <span className="rv-head__draft" title={t('review.draftHint')}>{t('review.draft')}</span>}
        </span>
      </div>
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
          <span className="rv-select"><select className="rv-organize__runner" aria-label={t('review.organizeRunner')} value={runner} disabled={busy} onChange={(e) => {
            const next = e.target.value as OrganizeRunnerId
            setRunner(next)
            void window.ade.invoke('settings:organizer', { runner: next })
          }}>
            <optgroup label={t('review.organizeRunnerCli')}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></optgroup>
            {/* 選んでいる API は、キーを消したあとでも残す（押すと理由を出す） */}
            {(apiReady.length > 0 || runner.startsWith('api:')) && <optgroup label={t('review.organizeRunnerApi')}>
              {LLM_API_PROVIDERS.filter((p) => apiReady.includes(p) || runner === `api:${p}`).map((p) => <option key={p} value={`api:${p}`}>{providerLabel(LLM_PROVIDER_PRESETS[p], t)}</option>)}
            </optgroup>}
          </select></span>
        </div>
        <Button variant="primary" className="rv-send" icon={<Send size={14} />} disabled={busy || !terminalId || !sendable}
          title={!terminalId ? t('review.openTerminalFirst') : undefined}
          onClick={() => void action(async () => {
            const result = await window.ade.invoke('review:send', review.id, terminalId!)
            toast({ tone: result.ok ? 'success' : 'warning', message: result.message })
          })}>{t('review.sendToAgent')}</Button>
      </div>
    </header>

    <div className="rv-list">
      {review.warnings.length > 0 && <div className="rv-notice" role="status">
        <AlertTriangle size={14} aria-hidden="true" />
        <div>{review.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>
      </div>}

      {items.length === 0 && <EmptyState art={<FindingsEmptyArt />} title={t('review.emptyTitle')}
        description={t('review.emptyDescription')} />}

      {items.map((item, index) => {
        const n = index + 1
        const shown = item.images.find((name) => review.images[name])
        const src = shown ? review.images[shown] : undefined
        const source = sourcesOf(item)
        const checking = item.status === 'needs_check'
        const requestRepeats = same(item.request, item.title)
        // 見出し・要望と同じ原文は引用に出さない（原文は保存されている）
        const quotes = item.quotes.filter((q) => !same(q.text, item.title) && !same(q.text, item.request))
        return <article key={item.id} className={`rv-card${item.include ? '' : ' is-excluded'}${checking ? ' is-checking' : ''}`} data-testid={`review-item-${n}`}>
          <button type="button" className="rv-card__shot" aria-label={t('review.zoomImage', { n })} disabled={!src}
            onClick={() => src && setImage({ src, n })}>
            {src ? <img src={src} alt={t('review.imageAlt', { n })} /> : <NoImageArt />}
            <span className="rv-card__n" aria-hidden="true">{n}</span>
            <span className="rv-card__time" aria-hidden="true">{time(item.t)}</span>
            {src && <span className="rv-card__zoom" aria-hidden="true"><Maximize2 size={13} /></span>}
          </button>

          <div className="rv-card__body">
            <div className="rv-card__top">
              <input className="rv-card__title" aria-label={t('review.titleLabel', { n })} key={`${item.id}-title-${item.title}`} defaultValue={item.title} disabled={busy} spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== item.title) void edit({ kind: 'text', id: item.id, title: e.target.value.trim() }); else e.target.value = item.title }} />
              {checking && <span className="rv-flag"><Flag size={11} />{t('review.needsCheck')}</span>}
            </div>
            {/* 見出しと同じ要望は空欄に見せる（同じ文を2度出さない）。空のまま離れても要望は変えない */}
            <textarea className="rv-card__request" aria-label={t('review.requestLabel', { n })} key={`${item.id}-request-${item.request}-${requestRepeats}`} defaultValue={requestRepeats ? '' : item.request}
              placeholder={requestRepeats ? t('review.requestPlaceholderExtra') : t('review.requestPlaceholder')} disabled={busy} rows={2}
              onBlur={(e) => {
                const next = e.target.value.trim()
                if (requestRepeats && next === '') return
                if (e.target.value !== item.request) void edit({ kind: 'text', id: item.id, request: next })
              }} />
            {quotes.length > 0 && <p className="rv-card__quote">{quotes.map((q) => t('review.quote', { text: q.text })).join(' ')}</p>}

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
                {review.videoUrl && <Tool tip={t('review.watchRecording')} label={t('review.watchRecordingLabel')} icon={<Play size={14} />} disabled={busy} onClick={() => setVideoTime(item.t)} />}
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

      <label className="rv-note">
        <span className="rv-note__label"><StickyNote size={13} aria-hidden="true" />{t('review.note')}</span>
        <textarea aria-label={t('review.noteLabel')} key={`note-${review.document.note}`} defaultValue={review.document.note ?? ''} disabled={busy}
          placeholder={t('review.notePlaceholder')} rows={2}
          onBlur={(e) => { if (e.target.value !== (review.document.note ?? '')) void edit({ kind: 'note', note: e.target.value }) }} />
      </label>
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

    {videoTime !== null && review.videoUrl && <Modal className="rv-modal" label={t('review.recordingPlayback')} onClose={() => setVideoTime(null)}>
      <div className="rv-modal__media">
        <ModalClose onClose={() => setVideoTime(null)} />
        <video ref={videoRef} src={review.videoUrl} controls
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
        <span className="rv-modal__caption"><Play size={12} />{t('review.fromTime', { time: time(videoTime) })}</span>
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
