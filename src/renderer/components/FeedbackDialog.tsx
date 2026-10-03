import { useEffect, useMemo, useState } from 'react'
import { Bug, Camera, CircleAlert, ExternalLink, Lightbulb, MessageSquarePlus, Send, X } from 'lucide-react'
import { PRODUCT_NAME } from '@shared/i18n'
import {
  FEEDBACK_REPO_SLUG,
  buildIssueBody,
  buildIssueTitle,
  deriveTitle,
  issueFormFields,
  type FeedbackEnvironment,
  type FeedbackKind,
  type FeedbackSubmitInput,
  type FeedbackSubmitResult
} from '@shared/feedback'
import { MAX_IMAGES } from '@shared/feedbackRelay'
import { Button, IconButton, Modal, Segmented, useToast } from '../ui'
import { useT, type TFunction } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { subscribeIpc } from '../lib/ipcEvents'
import { onFeedbackRequest, requestFeedback, type FeedbackPrefill } from '../lib/feedbackEvents'
import { DEFAULT_MASK_SELECTORS, scaleRects } from '@shared/screenshotMask'
import { ScreenshotEditor, renderMasked, type MaskedImage } from './ScreenshotEditor'
import '../styles/github.css'

/**
 * フィードバック（バグ・改善の提案）を GitHub の Issue として送るダイアログ。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/sidebar/SidebarFeedbackDialog.tsx と
 *           use-sidebar-feedback-environment-prefill.ts（環境情報を既定で添える）（MIT, Copyright 2026 Lovecast Inc.）
 * 利用者の声をなるべく多く集めるため、既定は GitHub のアカウント無しで送れる匿名の中継。
 * gh でログイン済みなら「自分の GitHub アカウントで送る」も選べる。中継が落ちていればブラウザの「新しい Issue」へ切り替わる。
 * 一行だけでも送れる（題名か、どれか1つの欄があればよい）。送る前に題名と本文の全体と「公開の Issue になる」ことを見せる。
 *
 * 開く場所: サイドバーの下（FeedbackLink）・ヘルプのメニュー・エラーのトーストの「報告する」・送信 3 回後の声かけ。
 */

export { requestFeedback }

/** サイドバーの下に置く小さな入口 */
export function FeedbackLink() {
  const t = useT()
  return <button type="button" className="feedback-link" onClick={() => requestFeedback()} data-testid="feedback-link">
    <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden="true" />
    <span>{t('feedback.sidebar')}</span>
  </button>
}

/** App に1つ置く。ダイアログと、送信 3 回後の声かけのトースト */
export function FeedbackDialogHost() {
  const [prefill, setPrefill] = useState<FeedbackPrefill | null>(null)
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    const offRequest = onFeedbackRequest((next) => { setAsking(false); setPrefill(next) })
    const offMenu = subscribeIpc('menu:command', (command) => { if (command === 'sendFeedback') setPrefill({}) }, 'github')
    const offAsk = subscribeIpc('feedback:ask', () => setAsking(true), 'github')
    return () => { offRequest(); offMenu(); offAsk() }
  }, [])
  return <>
    {asking && !prefill && <FeedbackAskToast onClose={() => setAsking(false)} />}
    {prefill && <FeedbackDialog prefill={prefill} onClose={() => setPrefill(null)} />}
  </>
}

/** 「使いづらいところはありましたか？」。main が一度だけ送る（出した時点で記録済み。断っても二度と出ない） */
function FeedbackAskToast({ onClose }: { onClose: () => void }) {
  const t = useT()
  return <div className="toast-host star-host" data-testid="feedback-ask">
    <div className="toast star-prompt" role="dialog" aria-label={t('feedback.ask.title')}>
      <span className="star-prompt__icon" aria-hidden="true"><MessageSquarePlus size={14} strokeWidth={1.75} /></span>
      <div className="star-prompt__body">
        <span className="toast__message">{t('feedback.ask.title')}</span>
        <span className="toast__detail">{t('feedback.ask.body')}</span>
        <div className="star-prompt__actions">
          <Button variant="default" icon={<MessageSquarePlus size={13} />} onClick={() => { onClose(); requestFeedback() }}>{t('feedback.ask.send')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('feedback.ask.dismiss')}</Button>
        </div>
      </div>
      <IconButton label={t('feedback.close')} size="sm" icon={<X size={14} strokeWidth={1.75} />} onClick={onClose} />
    </div>
  </div>
}


function rejectedMessage(t: TFunction, result: Extract<FeedbackSubmitResult, { kind: 'rejected' }>): string {
  if (result.code === 'rate_limited') return t('feedback.rejected.rate_limited', { minutes: Math.max(1, Math.ceil((result.retryAfterSec ?? 3600) / 60)) })
  if (result.code === 'duplicate') return t('feedback.rejected.duplicate')
  if (result.code === 'too_large' || result.code === 'image_too_large' || result.code === 'too_many_images' || result.code === 'bad_image') return t('feedback.rejected.too_large')
  return t('feedback.rejected.other', { code: result.code })
}

function FeedbackDialog({ prefill, onClose }: { prefill: FeedbackPrefill; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const [kind, setKind] = useState<FeedbackKind>(prefill.kind ?? 'bug')
  const [title, setTitle] = useState(prefill.title ?? '')
  const [fields, setFields] = useState({ summary: '', what: '', expected: '', actual: '' })
  const [showDetails, setShowDetails] = useState(false)
  const [includeEnv, setIncludeEnv] = useState(true)
  const [includeInstallId, setIncludeInstallId] = useState(true)
  const [env, setEnv] = useState<FeedbackEnvironment | null>(null)
  const [account, setAccount] = useState<string | null | undefined>(undefined)
  const [sendingVia, setSendingVia] = useState<FeedbackSubmitInput['via'] | null>(null)
  const [images, setImages] = useState<MaskedImage[]>([])
  /** 大きく見せて塗りつぶしている画像の番号 */
  const [editing, setEditing] = useState<number | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState<FeedbackSubmitResult | null>(null)

  useEffect(() => {
    let alive = true
    window.ade.invoke('feedback:environment').then((next) => alive && setEnv(next), () => alive && setEnv(null))
    window.ade.invoke('feedback:account').then((next) => alive && setAccount(next), () => alive && setAccount(null))
    return () => { alive = false }
  }, [])

  const draft = { kind, title: deriveTitle({ title, ...fields }), ...fields }
  const issueTitle = buildIssueTitle(draft)
  const body = useMemo(() => buildIssueBody(draft, includeEnv ? env : null, PRODUCT_NAME), [kind, title, fields, includeEnv, env]) // eslint-disable-line react-hooks/exhaustive-deps
  const ready = draft.title !== '' && !sending && !capturing && account !== undefined
  const busy = sending || capturing

  /** ダイアログを一度隠してから、今の Ferret の画面を撮る（ダイアログが写り込まないように） */
  const capture = async () => {
    if (images.length >= MAX_IMAGES || busy) return
    setCapturing(true)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    try {
      // 名前・パス・URL が写りうる領域（ダイアログを隠したあとの画面の位置）を、撮る前に控える
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const areas = DEFAULT_MASK_SELECTORS.flatMap((selector) => [...document.querySelectorAll(selector)].map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }))
      const shot = await window.ade.invoke('feedback:captureWindow')
      const raw = { type: shot.type, base64: shot.base64, width: shot.width, height: shot.height }
      const masks = scaleRects(areas, viewport, raw)
      const next: MaskedImage = { raw, masks, output: await renderMasked(raw, masks) }
      setImages((prev) => [...prev, next].slice(0, MAX_IMAGES))
      // 送る前に必ず大きく見せる
      setEditing(images.length)
    } catch (err) {
      toast({ tone: 'warning', message: t('feedback.errors.captureFailed'), detail: errorMessage(err) })
    } finally {
      setCapturing(false)
    }
  }

  /** 既定は「送る」（匿名の中継）。補助の選択肢は gh（自分の GitHub アカウント）とブラウザ */
  const submit = async (via: FeedbackSubmitInput['via']) => {
    if (!ready) return
    setSending(true)
    setSendingVia(via)
    try {
      const result = await window.ade.invoke('feedback:submit', {
        kind,
        title: issueTitle,
        body,
        fields: issueFormFields(draft, includeEnv ? env : null, PRODUCT_NAME),
        via,
        includeEnvironment: includeEnv,
        includeInstallId,
        images: via === 'relay' ? images.map(({ output }) => output) : []
      })
      if (result.kind === 'rejected') toast({ tone: 'warning', message: rejectedMessage(t, result) })
      else setDone(result)
    } catch (err) {
      toast({ tone: 'danger', message: t('feedback.failed'), detail: errorMessage(err) })
    } finally {
      setSending(false)
      setSendingVia(null)
    }
  }

  const label = (key: 'what' | 'expected' | 'actual') => t(kind === 'bug' ? `feedback.bug.${key}` : `feedback.idea.${key}`)

  // 撮っている間はダイアログを描かない（showModal の層ごと外す）
  if (capturing) return null

  return <><Modal className="rv-modal" label={t('feedback.title')} onClose={() => !busy && onClose()}>
    <div className="gh-send feedback" data-testid="feedback-dialog">
      <header className="gh-send__head">
        <h2><MessageSquarePlus size={15} aria-hidden="true" />{t('feedback.title')}</h2>
        <IconButton label={t('feedback.close')} icon={<X size={16} />} disabled={busy} onClick={onClose} />
      </header>

      {done ? <div className="feedback__done" role="status" data-testid="feedback-done">
        {done.kind === 'created'
          ? <>
            <p className="gh-callout__title">{t('feedback.created')}</p>
            <code className="feedback__url">{done.url}</code>
            <div className="gh-send__foot">
              <Button variant="ghost" onClick={onClose}>{t('feedback.close')}</Button>
              <Button variant="primary" icon={<ExternalLink size={13} />} onClick={() => void window.ade.invoke('github:open', done.url).catch(() => undefined)}>{t('feedback.openIssue')}</Button>
            </div>
          </>
          : done.kind === 'opened' && <>
            <p className="gh-callout__title">{t('feedback.opened')}</p>
            <p className="st-note">{t('feedback.openedDetail')}</p>
            {done.reason === 'relay-down' && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('feedback.relayDown')}</p>}
            {done.reason === 'gh-failed' && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('feedback.ghFailed')}{done.detail ? ` ${done.detail}` : ''}</p>}
            {done.truncated && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('feedback.truncated')}</p>}
            {images.length > 0 && <p className="st-note">{t('feedback.imagesHint')}</p>}
            <div className="gh-send__foot"><Button variant="primary" onClick={onClose}>{t('feedback.close')}</Button></div>
          </>}
      </div> : <>
        <p className="st-note">{t('feedback.intro', { repo: FEEDBACK_REPO_SLUG })}</p>

        <div className="gh-send__field">
          <span className="gh-send__label">{t('feedback.kind.label')}</span>
          <Segmented<FeedbackKind> ariaLabel={t('feedback.kind.label')} value={kind} onChange={setKind} options={[
            { value: 'bug', label: t('feedback.kind.bug'), icon: <Bug size={13} /> },
            { value: 'idea', label: t('feedback.kind.idea'), icon: <Lightbulb size={13} /> }
          ]} />
        </div>

        {/* 既定は大きな欄を1つだけ。題名は任意（空なら本文の先頭から作る） */}
        <label className="gh-send__field">
          <span className="gh-send__label">{t(kind === 'bug' ? 'feedback.bug.summary' : 'feedback.idea.summary')}</span>
          <textarea className="gh-send__input feedback__summary" rows={4} value={fields.summary} disabled={busy} placeholder={t('feedback.summaryPlaceholder')}
            onChange={(e) => setFields((prev) => ({ ...prev, summary: e.target.value }))} data-testid="feedback-summary" autoFocus />
        </label>

        {/* 既定で見せるのは大きな欄1つだけ。題名・詳しい欄・画面の添付・送る情報の選択は「詳しく書く」の中 */}
        <details className="feedback__more" open={showDetails} onToggle={(e) => setShowDetails(e.currentTarget.open)}>
          <summary data-testid="feedback-more">{t('feedback.moreDetails')}</summary>
          <label className="gh-send__field">
            <span className="gh-send__label">{t('feedback.titleOptional')}</span>
            <input className="gh-send__input" value={title} maxLength={200} disabled={busy} placeholder={t('feedback.field.titlePlaceholder')}
              onChange={(e) => setTitle(e.target.value)} data-testid="feedback-title" />
          </label>
          {(['what', 'expected', 'actual'] as const).map((key) => <label key={key} className="gh-send__field">
            <span className="gh-send__label">{label(key)}</span>
            <textarea className="gh-send__input feedback__text" rows={2} value={fields[key]} disabled={busy}
              onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))} />
          </label>)}

          <div className="gh-send__field">
            <div className="feedback__images">
              <Button variant="default" icon={<Camera size={13} />} disabled={busy || images.length >= MAX_IMAGES}
                onClick={() => void capture()} data-testid="feedback-attach-window">{t('feedback.attachWindow')}</Button>
              <span className="st-note">{t('feedback.imagesLimit', { max: MAX_IMAGES })}</span>
            </div>
            {images.length > 0 && <>
              <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('feedback.screenshot.warning')}</p>
              <div className="feedback__thumbs">{images.map((image, i) => <div key={i} className="feedback__thumb">
                <button type="button" className="feedback__thumb-open" onClick={() => setEditing(i)} aria-label={t('feedback.screenshot.edit', { n: i + 1 })} data-testid="feedback-thumb">
                  <img src={`data:${image.output.type};base64,${image.output.base64}`} alt="" />
                </button>
                <IconButton size="sm" className="feedback__thumb-remove" label={t('feedback.removeImage', { n: i + 1 })} icon={<X size={12} />} disabled={busy}
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} />
              </div>)}</div>
            </>}
          </div>

          <div className="feedback__checks">
            <label className="feedback__env">
              <input type="checkbox" checked={includeEnv} disabled={busy} onChange={(e) => setIncludeEnv(e.target.checked)} data-testid="feedback-include-env" />
              <span>{t('feedback.includeEnvironment')}<small>{t('feedback.environmentNote')}</small></span>
            </label>
            <label className="feedback__env">
              <input type="checkbox" checked={includeInstallId} disabled={busy} onChange={(e) => setIncludeInstallId(e.target.checked)} data-testid="feedback-include-install-id" />
              <span>{t('feedback.includeInstallId')}</span>
            </label>
          </div>
        </details>

        {/* 送る内容は既定で畳む。「公開の Issue になる」の一行は常に見せる */}
        <details className="feedback__more">
          <summary data-testid="feedback-show-preview">{t('feedback.showPreview')}</summary>
          <pre className="feedback__preview" data-testid="feedback-preview">{`${issueTitle}\n\n${body}`}</pre>
        </details>

        <p className="gh-send__confirm feedback__public"><CircleAlert size={13} aria-hidden="true" />{t('feedback.publicNotice')}</p>

        <footer className="gh-send__foot feedback__foot">
          <div className="feedback__other" aria-label={t('feedback.otherWays')}>
            {typeof account === 'string' && <Button variant="ghost" disabled={!ready} busy={sendingVia === 'gh'} onClick={() => void submit('gh')}
              icon={<Send size={13} />} data-testid="feedback-submit-gh">{t('feedback.via.gh', { user: account })}</Button>}
            <Button variant="ghost" disabled={!ready} busy={sendingVia === 'browser'} onClick={() => void submit('browser')}
              icon={<ExternalLink size={13} />} data-testid="feedback-submit-browser">{t('feedback.openBrowser')}</Button>
          </div>
          <Button variant="primary" busy={sendingVia === 'relay'} disabled={!ready} onClick={() => void submit('relay')} data-testid="feedback-submit"
            icon={<Send size={13} />}>
            {sendingVia === 'relay' ? t('feedback.sending') : t('feedback.send')}
          </Button>
        </footer>
      </>}
    </div>
  </Modal>
    {/* フィードバックのダイアログより後に開く（showModal の層で上に重ねる）ため、兄弟として後ろに置く */}
    {editing !== null && images[editing] && <ScreenshotEditor image={images[editing]!} index={editing}
      onDone={(next) => { setImages((prev) => prev.map((img, i) => (i === editing ? next : img))); setEditing(null) }}
      onDiscard={() => { setImages((prev) => prev.filter((_, i) => i !== editing)); setEditing(null) }} />}
  </>
}
