import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, Link2, Plus, RefreshCw, Share2, Trash2, Undo2, X } from 'lucide-react'
import type { BrowserState } from '@shared/types'
import type { ShareComment, ShareShape, ShareSnapshot, ShareSummaryInfo } from '@shared/feedbackShare'
import { isPresetableUrl } from '@shared/projectUrl'
import { Badge, Button, IconButton, Modal, Spinner, Tooltip, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import '../styles/github.css'
import '../styles/share.css'

/**
 * 内蔵ブラウザのツールバーの「共有」。ログイン無しで誰でも指摘を送れるリンク（share.ferretade.dev）を作り、届いた指摘を取り込む。
 *
 * - 作る・ページを足すときは、ダイアログを閉じて内蔵ブラウザのビューを見せてから、main が表示中のタブを1枚撮って上げる
 *   （ダイアログを開いている間はビューが隠れるため。押した直後の1回だけ撮れる。src/main/feedbackShare/ipc.ts）
 * - 届いた指摘は、静止画に注釈を重ねて見せ、選んで取り込む・断る。取り込んだものは「文字で指摘」と同じ指摘になり、
 *   App の note:added で開く（以後は Agent へ渡し、BEFORE/AFTER を人が確かめる）
 * - 持ち主のトークンは main だけが持つ。ここに来るのは題名・URL・期限・指摘・静止画（data URL）だけ
 */

/** ダイアログを閉じてから、内蔵ブラウザのビューが元の場所に戻るまで待つ時間 */
const VIEW_SETTLE_MS = 400

export function ShareButton({ state }: { state: BrowserState }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  /** ビューを見せて撮る。撮ったあと、ダイアログを開き直す */
  const withView = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setOpen(false)
    await new Promise((done) => setTimeout(done, VIEW_SETTLE_MS))
    try {
      return await work()
    } finally {
      setOpen(true)
    }
  }, [])
  return <>
    <Tooltip label={t('share.button.title')} side="top">
      <Button variant="ghost" className="browser-toolbar__share" icon={<Share2 size={14} strokeWidth={1.75} aria-hidden="true" />} data-testid="browser-share" onClick={() => setOpen(true)}>
        {t('share.button.label')}
      </Button>
    </Tooltip>
    {open && <SharePanel pageUrl={state.url} focus={focus} onFocus={setFocus} withView={withView} onClose={() => setOpen(false)} />}
  </>
}

function SharePanel({ pageUrl, focus, onFocus, withView, onClose }: {
  pageUrl: string
  focus: string | null
  onFocus: (id: string | null) => void
  withView: <T>(work: () => Promise<T>) => Promise<T>
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [shares, setShares] = useState<ShareSummaryInfo[] | null>(null)
  const [persisted, setPersisted] = useState(true)
  const [title, setTitle] = useState('')
  const [showOthers, setShowOthers] = useState(false)
  const [busy, setBusy] = useState(false)
  const canCapture = isPresetableUrl(pageUrl)

  const warn = useCallback((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }), [toast])
  const reload = useCallback(async () => {
    const result = await window.ade.invoke('share:list')
    setShares(result.shares)
    setPersisted(result.persisted)
  }, [])
  useEffect(() => { void reload().catch(warn) }, [reload, warn])

  const copy = (url: string, message = t('share.copied')) =>
    void navigator.clipboard.writeText(url).then(() => toast({ tone: 'success', message }), () => toast({ tone: 'warning', message: url }))

  const create = () => {
    if (busy) return
    setBusy(true)
    void withView(() => window.ade.invoke('share:create', { title: title.trim(), showOthers }))
      .then((created) => { setTitle(''); onFocus(created.id); copy(created.url, t('share.created')) })
      .catch(warn)
      .finally(() => setBusy(false))
  }
  const addPage = (id: string) => {
    if (busy) return
    setBusy(true)
    void withView(() => window.ade.invoke('share:addPage', id))
      .then(() => { onFocus(id); toast({ tone: 'success', message: t('share.pageAdded') }) })
      .catch(warn)
      .finally(() => setBusy(false))
  }

  return <Modal className="rv-modal" label={t('share.title')} onClose={() => !busy && onClose()}>
    <div className="gh-send share" data-testid="share-dialog">
      <header className="gh-send__head">
        <h2><Share2 size={15} aria-hidden="true" />{t('share.title')}</h2>
        <IconButton label={t('share.close')} icon={<X size={16} />} disabled={busy} onClick={onClose} />
      </header>
      <p className="st-note">{t('share.intro')}</p>

      <section className="share__new">
        <label className="gh-send__field">
          <span className="gh-send__label">{t('share.newTitle')}</span>
          <input className="gh-send__input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} data-testid="share-title" />
        </label>
        <label className="share__check">
          <input type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} data-testid="share-show-others" />
          {t('share.showOthers')}
        </label>
        <p className="st-note">{t('share.uploadNote')}</p>
        <div className="gh-send__foot">
          {!canCapture && <span className="st-note">{t('share.noHttpPage')}</span>}
          <Button variant="primary" icon={<Link2 size={13} />} busy={busy} disabled={!canCapture} onClick={create} data-testid="share-create">{t('share.create')}</Button>
        </div>
      </section>

      {!persisted && <p className="st-note st-note--warn">{t('share.notPersisted')}</p>}
      {shares === null ? <p className="st-note">{t('share.loading')}</p> : shares.length === 0 ? <p className="st-note">{t('share.noShares')}</p> : <section className="share__list" aria-label={t('share.list')}>
        <h3 className="gh-send__label">{t('share.list')}</h3>
        {shares.map((share) => <ShareRow key={share.id} share={share} open={focus === share.id} busy={busy} canCapture={canCapture}
          onToggle={() => onFocus(focus === share.id ? null : share.id)} onCopy={() => copy(share.url)} onAddPage={() => addPage(share.id)}
          onDeleted={() => { onFocus(null); void reload().catch(warn) }} onImported={onClose} onError={warn} />)}
      </section>}
    </div>
  </Modal>
}

function ShareRow({ share, open, busy, canCapture, onToggle, onCopy, onAddPage, onDeleted, onImported, onError }: {
  share: ShareSummaryInfo
  open: boolean
  busy: boolean
  canCapture: boolean
  onToggle: () => void
  onCopy: () => void
  onAddPage: () => void
  onDeleted: () => void
  onImported: () => void
  onError: (err: unknown) => void
}) {
  const t = useT()
  const toast = useToast()
  const [armed, setArmed] = useState(false)
  const expires = new Date(share.expiresAt).toLocaleDateString()
  const remove = () => {
    if (!armed) { setArmed(true); return }
    void window.ade.invoke('share:delete', share.id).then(() => { toast({ tone: 'success', message: t('share.deleted') }); onDeleted() }, onError)
  }
  return <div className={`share__row${open ? ' share__row--open' : ''}`} data-testid="share-row">
    <div className="share__row-head">
      <button type="button" className="share__row-title" aria-expanded={open} onClick={onToggle}>
        <span className="share__name">{share.title || share.url}</span>
        <span className="share__meta">{t('share.expires', { date: expires })}</span>
      </button>
      <Tooltip label={t('share.copy')}><IconButton label={t('share.copy')} icon={<Copy size={14} />} onClick={onCopy} data-testid="share-copy" /></Tooltip>
      <Tooltip label={t('share.addPage')}><IconButton label={t('share.addPage')} icon={<Plus size={14} />} disabled={!canCapture || busy} onClick={onAddPage} data-testid="share-add-page" /></Tooltip>
      <Button variant={armed ? 'danger' : 'ghost'} icon={<Trash2 size={13} />} onClick={remove} onBlur={() => setArmed(false)} data-testid="share-delete">{armed ? t('share.deleteConfirm') : t('share.delete')}</Button>
    </div>
    {open && <ShareDetail shareId={share.id} onImported={onImported} onError={onError} />}
  </div>
}

function ShareDetail({ shareId, onImported, onError }: { shareId: string; onImported: () => void; onError: (err: unknown) => void }) {
  const t = useT()
  const toast = useToast()
  const [data, setData] = useState<{ snapshot: ShareSnapshot; images: Record<string, string> } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)
  const load = useCallback(() => {
    setData(null)
    void window.ade.invoke('share:open', shareId).then(setData, onError)
  }, [shareId, onError])
  useEffect(load, [load])

  const comments = useMemo(() => {
    const order = { new: 0, imported: 1, rejected: 2 } as const
    return [...(data?.snapshot.comments ?? [])].sort((a, b) => order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt))
  }, [data])
  const pending = comments.filter((c) => c.status === 'new')
  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const setStatus = (comment: ShareComment, status: 'new' | 'rejected') => {
    void window.ade.invoke('share:setStatus', shareId, comment.id, status).then(() => {
      setSelected((prev) => { const next = new Set(prev); next.delete(comment.id); return next })
      load()
    }, onError)
  }
  const importSelected = () => {
    if (working || selected.size === 0) return
    setWorking(true)
    void window.ade.invoke('share:import', shareId, [...selected])
      .then((result) => { if (result) { toast({ tone: 'success', message: t('share.imported', { count: selected.size }) }); onImported() } else load() })
      .catch(onError)
      .finally(() => setWorking(false))
  }

  if (!data) return <p className="st-note share__loading"><Spinner /> {t('share.loading')}</p>
  const pages = new Map(data.snapshot.pages.map((p) => [p.id, p]))
  return <div className="share__detail" data-testid="share-detail">
    <div className="share__toolbar">
      <span className="st-note">{t('share.pages', { count: data.snapshot.pages.length })}</span>
      <Button variant="ghost" icon={<RefreshCw size={13} />} onClick={load}>{t('share.refresh')}</Button>
      {pending.length > 0 && <Button variant="ghost" icon={<Check size={13} />} onClick={() => setSelected(new Set(pending.map((c) => c.id)))}>{t('share.selectAll')}</Button>}
    </div>
    {comments.length === 0 ? <p className="st-note">{t('share.empty')}</p> : <ul className="share__comments">
      {comments.map((comment) => {
        const page = pages.get(comment.pageId)
        const image = page ? data.images[page.id] : undefined
        return <li key={comment.id} className={`share__comment share__comment--${comment.status}`} data-testid="share-comment">
          {comment.status === 'new' && <input type="checkbox" className="share__pick" aria-label={t('share.pick')} checked={selected.has(comment.id)} onChange={() => toggle(comment.id)} />}
          <div className="share__shot">
            {image && <img src={image} alt="" />}
            {image && comment.shape && !comment.live && <ShapeOverlay shape={comment.shape} />}
          </div>
          <div className="share__body">
            <div className="share__who">
              <span>{comment.name || t('share.anonymous')}</span>
              <span className="share__meta">{new Date(comment.createdAt).toLocaleString()}</span>
              <Badge tone={comment.status === 'new' ? 'brand' : comment.status === 'imported' ? 'success' : 'neutral'}>{t(`share.status.${comment.status}`)}</Badge>
            </div>
            <p className="share__text">{comment.text}</p>
            {comment.live && <p className="share__meta">{t('share.liveNote')} · {comment.live.url}</p>}
            {page && <p className="share__meta">{page.title || page.url}</p>}
            <div className="share__actions">
              {comment.status === 'new' && <Button variant="ghost" icon={<X size={13} />} onClick={() => setStatus(comment, 'rejected')} data-testid="share-reject">{t('share.reject')}</Button>}
              {comment.status === 'rejected' && <Button variant="ghost" icon={<Undo2 size={13} />} onClick={() => setStatus(comment, 'new')}>{t('share.restore')}</Button>}
            </div>
          </div>
        </li>
      })}
    </ul>}
    <div className="gh-send__foot">
      <Button variant="primary" icon={<Check size={13} />} busy={working} disabled={selected.size === 0} onClick={importSelected} data-testid="share-import">
        {t('share.import', { count: selected.size })}
      </Button>
    </div>
  </div>
}

/** 送られた注釈を静止画の上に重ねる（座標は 0..1） */
function ShapeOverlay({ shape }: { shape: ShareShape }) {
  return <svg className="share__overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
    {shape.kind === 'pin' && <circle cx={shape.x} cy={shape.y} r={0.02} className="share__mark" />}
    {shape.kind === 'rect' && <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} className="share__mark" />}
    {shape.kind === 'pen' && <polyline points={shape.points.map((p) => p.join(',')).join(' ')} className="share__mark share__mark--pen" />}
  </svg>
}
