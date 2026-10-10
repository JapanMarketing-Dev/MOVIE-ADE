import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Download, KeyRound, Lock, Plus, RefreshCw, Settings2, Share2, Trash2, Undo2, Wand2, X } from 'lucide-react'
import type { BrowserState } from '@shared/types'
import type { MeetingImportProgress } from '@shared/meetingImport'
import { SHARE_LIMITS, cleanUrl, sharePasswordAdvice, sharePasswordProblem, type ShareRecording, type ShareSettingsInput, type ShareSnapshot, type ShareSummaryInfo, type ShareUrl } from '@shared/feedbackShare'
import { generateSharePassword } from '@shared/shareCrypto'
import { Badge, Button, IconButton, Modal, Spinner, Tooltip, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { finishImportedReview, openImportedReview, organizeRunner } from '../lib/importedReview'
import '../styles/github.css'
import '../styles/share.css'

/**
 * 内蔵ブラウザのツールバーの「共有」。ログイン無しで誰でも指摘を送れるリンク（share.ferretade.dev）。
 *
 * - 押すと、開いているページの共有リンク（同じページの期限内のものがあればそれ、無ければ作る）をクリップボードにコピーし、パネルを開く
 * - リンクを開いた人は、元のページをライブで開いて触りながら、アプリのフィードバックと同じ道具（ペン・枠・文字で指摘・声）で録画して送る。
 *   画面共有・端末の画面収録の動画も送れる。同じリンクを開いた人は誰でも届いた指摘を見られる。7日で消える
 * - 設定：題名・開くページ（複数）・メモ・パスワード（メモにログイン情報などを書くとき。メモはパスワードで暗号化される）
 * - 届いた録画は1件ずつ取り込む・断る。取り込みは mtg と同じ流れ（文字起こし・コマ・書き込み → 整理 → 判定）で、送った人の名前付きの指摘の候補になる
 * - 持ち主のトークンとパスワードは main だけが持つ（パスワードのコピーは main がクリップボードへ写す）
 */
export function ShareButton({ state }: { state: BrowserState }) {
  const t = useT()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const page = useMemo(() => {
    const url = cleanUrl(state.url)
    return url ? { url, title: (state.title || '').slice(0, SHARE_LIMITS.pageTitleChars) } : null
  }, [state.url, state.title])

  const press = () => {
    if (!page) { setOpen(true); return }
    if (busy) return
    setBusy(true)
    void window.ade.invoke('share:forPage', page)
      .then(({ share, created }) => copyText(share.url).then(
        () => toast({ tone: 'success', message: t(created ? 'share.createdCopied' : 'share.copied') }),
        () => toast({ tone: 'warning', message: share.url })
      ).then(() => { setFocus(share.id); setOpen(true) }))
      .catch((err) => { toast({ tone: 'warning', message: errorMessage(err) }); setOpen(true) })
      .finally(() => setBusy(false))
  }

  return <>
    <Tooltip label={t('share.button.title')} side="top">
      <Button variant="ghost" className="browser-toolbar__share" busy={busy} icon={<Share2 size={14} strokeWidth={1.75} aria-hidden="true" />} data-testid="browser-share" onClick={press}>
        {t('share.button.label')}
      </Button>
    </Tooltip>
    {open && <SharePanel page={page} focus={focus} onFocus={setFocus} onClose={() => setOpen(false)} />}
  </>
}

const copyText = (text: string) => navigator.clipboard.writeText(text)

function SharePanel({ page, focus, onFocus, onClose }: {
  page: ShareUrl | null
  focus: string | null
  onFocus: (id: string | null) => void
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [shares, setShares] = useState<ShareSummaryInfo[] | null>(null)
  const [persisted, setPersisted] = useState(true)
  const [creating, setCreating] = useState(false)

  const warn = useCallback((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }), [toast])
  const reload = useCallback(async () => {
    const result = await window.ade.invoke('share:list')
    setShares(result.shares)
    setPersisted(result.persisted)
  }, [])
  useEffect(() => { void reload().catch(warn) }, [reload, warn])

  const copy = (url: string) => void copyText(url).then(() => toast({ tone: 'success', message: t('share.copied') }), () => toast({ tone: 'warning', message: url }))

  return <Modal className="rv-modal" label={t('share.title')} onClose={onClose}>
    <div className="gh-send share" data-testid="share-dialog">
      <header className="gh-send__head">
        <h2><Share2 size={15} aria-hidden="true" />{t('share.title')}</h2>
        <IconButton label={t('share.close')} icon={<X size={16} />} onClick={onClose} />
      </header>
      <p className="st-note">{t('share.intro', { days: SHARE_LIMITS.days })}</p>

      {creating
        ? <ShareSettingsForm initial={{ title: '', urls: page ? [page] : [], memo: '', protected: false, hasPassword: false }} submitLabel={t('share.createSubmit')}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            const created = await window.ade.invoke('share:create', input)
            setCreating(false)
            onFocus(created.id)
            await reload()
            await copyText(created.url).then(() => toast({ tone: 'success', message: t('share.createdCopied') }), () => toast({ tone: 'warning', message: created.url }))
          }} />
        : <div className="share__new-row">
          <Button icon={<Plus size={13} />} onClick={() => setCreating(true)} data-testid="share-new">{t('share.new')}</Button>
        </div>}

      {!persisted && <p className="st-note st-note--warn">{t('share.notPersisted')}</p>}
      {shares === null ? <p className="st-note">{t('share.loading')}</p> : shares.length === 0 ? <p className="st-note">{t('share.noShares')}</p> : <section className="share__list" aria-label={t('share.list')}>
        <h3 className="gh-send__label">{t('share.list')}</h3>
        {shares.map((share) => <ShareRow key={share.id} share={share} open={focus === share.id}
          onToggle={() => onFocus(focus === share.id ? null : share.id)} onCopy={() => copy(share.url)}
          onChanged={() => void reload().catch(warn)} onDeleted={() => { onFocus(null); void reload().catch(warn) }} onImported={onClose} onError={warn} />)}
      </section>}
    </div>
  </Modal>
}

type SettingsInitial = { title: string; urls: ShareUrl[]; memo: string; protected: boolean; hasPassword: boolean }

/** 共有の設定（題名・開くページ・メモ・パスワード）。作るときと変えるときに使う */
function ShareSettingsForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: SettingsInitial
  submitLabel: string
  onSubmit: (input: ShareSettingsInput) => Promise<void>
  onCancel: () => void
}) {
  const t = useT()
  const [title, setTitle] = useState(initial.title)
  const [urlsText, setUrlsText] = useState(initial.urls.map((u) => u.url).join('\n'))
  const [memo, setMemo] = useState(initial.memo)
  /** keep … 今のパスワードのまま、set … 新しいパスワードにする、none … パスワードなし */
  const [passwordMode, setPasswordMode] = useState<'keep' | 'set' | 'none'>(initial.protected ? 'keep' : 'none')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const lines = urlsText.split('\n').map((l) => l.trim()).filter(Boolean)
  const urls = lines.map((url) => ({ url, title: initial.urls.find((u) => u.url === url)?.title ?? '' }))
  const badUrl = lines.find((l) => !cleanUrl(l))
  const withPassword = passwordMode !== 'none'
  const advice = sharePasswordAdvice(memo, withPassword)
  const passwordProblem = passwordMode === 'set' ? sharePasswordProblem(password) : null

  const submit = () => {
    if (saving) return
    if (lines.length === 0 || badUrl) { setError(t('share.errors.urls')); return }
    if (lines.length > SHARE_LIMITS.urls) { setError(t('share.urlsTooMany', { max: SHARE_LIMITS.urls })); return }
    if (passwordProblem) { setError(t(passwordProblem === 'short' ? 'share.errors.passwordShort' : 'share.errors.passwordLong', { min: SHARE_LIMITS.passwordMinChars, max: SHARE_LIMITS.passwordMaxChars })); return }
    setSaving(true)
    setError(null)
    const input: ShareSettingsInput = {
      title: title.trim(), urls, memo,
      ...(passwordMode === 'set' ? { password } : passwordMode === 'none' && initial.protected ? { password: null } : {})
    }
    void onSubmit(input).catch((err) => setError(errorMessage(err))).finally(() => setSaving(false))
  }

  return <section className="share__settings" data-testid="share-settings">
    <label className="gh-send__field">
      <span className="gh-send__label">{t('share.fieldTitle')}</span>
      <input className="gh-send__input" value={title} maxLength={SHARE_LIMITS.titleChars} placeholder={t('share.fieldTitlePlaceholder')} onChange={(e) => setTitle(e.target.value)} data-testid="share-title" />
    </label>
    <label className="gh-send__field">
      <span className="gh-send__label">{t('share.fieldUrls')}</span>
      <textarea className="gh-send__input share__urls" rows={Math.min(5, Math.max(2, lines.length + 1))} value={urlsText} spellCheck={false} placeholder="https://" onChange={(e) => setUrlsText(e.target.value)} data-testid="share-urls" />
      <span className="st-note">{t('share.fieldUrlsHint', { max: SHARE_LIMITS.urls })}</span>
    </label>
    <label className="gh-send__field">
      <span className="gh-send__label">{t('share.fieldMemo')}</span>
      <textarea className="gh-send__input" rows={3} value={memo} maxLength={SHARE_LIMITS.memoChars} placeholder={t('share.fieldMemoPlaceholder')} onChange={(e) => setMemo(e.target.value)} data-testid="share-memo" />
    </label>
    <fieldset className="share__password">
      <legend className="gh-send__label">{t('share.fieldPassword')}</legend>
      <label className="share__check">
        <input type="checkbox" checked={withPassword} onChange={(e) => setPasswordMode(e.target.checked ? (initial.protected ? 'keep' : 'set') : 'none')} data-testid="share-password-on" />
        {t('share.passwordOn')}
      </label>
      {passwordMode === 'keep' && <div className="share__password-row">
        <span className="st-note">{t('share.passwordKept')}</span>
        <Button variant="ghost" onClick={() => setPasswordMode('set')} data-testid="share-password-change">{t('share.passwordChange')}</Button>
      </div>}
      {passwordMode === 'set' && <div className="share__password-row">
        <input className="gh-send__input" type="text" autoComplete="off" spellCheck={false} value={password} maxLength={SHARE_LIMITS.passwordMaxChars} placeholder={t('share.passwordPlaceholder', { min: SHARE_LIMITS.passwordMinChars })}
          onChange={(e) => setPassword(e.target.value)} data-testid="share-password" />
        <Button variant="ghost" icon={<Wand2 size={13} />} onClick={() => setPassword(generateSharePassword())} data-testid="share-password-generate">{t('share.passwordGenerate')}</Button>
      </div>}
      <p className={`st-note${advice === 'memo' ? ' st-note--warn' : ''}`} data-testid="share-password-advice">
        {t(advice === 'none' ? 'share.adviceProtected' : advice === 'memo' ? 'share.adviceMemo' : 'share.adviceOpen')}
      </p>
    </fieldset>
    {error && <p className="st-note st-note--warn" role="alert">{error}</p>}
    <div className="gh-send__foot">
      <Button variant="ghost" onClick={onCancel} disabled={saving}>{t('share.cancel')}</Button>
      <Button variant="primary" busy={saving} onClick={submit} data-testid="share-save">{submitLabel}</Button>
    </div>
  </section>
}

function ShareRow({ share, open, onToggle, onCopy, onChanged, onDeleted, onImported, onError }: {
  share: ShareSummaryInfo
  open: boolean
  onToggle: () => void
  onCopy: () => void
  onChanged: () => void
  onDeleted: () => void
  onImported: () => void
  onError: (err: unknown) => void
}) {
  const t = useT()
  const toast = useToast()
  const [armed, setArmed] = useState(false)
  const [editing, setEditing] = useState<SettingsInitial | null>(null)
  const expires = new Date(share.expiresAt).toLocaleDateString()
  const remove = () => {
    if (!armed) { setArmed(true); return }
    void window.ade.invoke('share:delete', share.id).then(() => { toast({ tone: 'success', message: t('share.deleted') }); onDeleted() }, onError)
  }
  const edit = () => {
    if (editing) { setEditing(null); return }
    void window.ade.invoke('share:settings', share.id).then(setEditing, onError)
  }
  const copyPassword = () => void window.ade.invoke('share:copyPassword', share.id).then(() => toast({ tone: 'success', message: t('share.passwordCopied') }), onError)
  return <div className={`share__row${open ? ' share__row--open' : ''}`} data-testid="share-row">
    <div className="share__row-head">
      <button type="button" className="share__row-title" aria-expanded={open} onClick={onToggle}>
        <span className="share__name">{share.protected && <Lock size={12} aria-label={t('share.protected')} />}{share.title || share.url}</span>
        <span className="share__meta">{t('share.expires', { date: expires })} · {share.urls.map((u) => u.url).join(', ')}</span>
      </button>
      <Tooltip label={t('share.copy')}><IconButton label={t('share.copy')} icon={<Copy size={14} />} onClick={onCopy} data-testid="share-copy" /></Tooltip>
      {share.hasPassword && <Tooltip label={t('share.copyPassword')}><IconButton label={t('share.copyPassword')} icon={<KeyRound size={14} />} onClick={copyPassword} data-testid="share-copy-password" /></Tooltip>}
      <Tooltip label={t('share.settings')}><IconButton label={t('share.settings')} icon={<Settings2 size={14} />} onClick={edit} data-testid="share-edit" /></Tooltip>
      <Button variant={armed ? 'danger' : 'ghost'} icon={<Trash2 size={13} />} onClick={remove} onBlur={() => setArmed(false)} data-testid="share-delete">{armed ? t('share.deleteConfirm') : t('share.delete')}</Button>
    </div>
    {editing && <ShareSettingsForm initial={editing} submitLabel={t('share.save')} onCancel={() => setEditing(null)}
      onSubmit={async (input) => {
        await window.ade.invoke('share:update', share.id, input)
        setEditing(null)
        toast({ tone: 'success', message: t('share.saved') })
        onChanged()
      }} />}
    {open && <ShareDetail shareId={share.id} onImported={onImported} onError={onError} />}
  </div>
}

function ShareDetail({ shareId, onImported, onError }: { shareId: string; onImported: () => void; onError: (err: unknown) => void }) {
  const t = useT()
  const toast = useToast()
  const [data, setData] = useState<{ snapshot: ShareSnapshot; thumbnails: Record<string, string> } | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [progress, setProgress] = useState<MeetingImportProgress | null>(null)
  const load = useCallback(() => {
    setData(null)
    void window.ade.invoke('share:open', shareId).then(setData, onError)
  }, [shareId, onError])
  useEffect(load, [load])
  useEffect(() => (importing ? window.ade.on('meeting:progress', setProgress) : undefined), [importing])

  const recordings = useMemo(() => {
    const order = { new: 0, imported: 1, rejected: 2 } as const
    return [...(data?.snapshot.recordings ?? [])].sort((a, b) => order[a.status] - order[b.status] || b.createdAt.localeCompare(a.createdAt))
  }, [data])
  const setStatus = (rec: ShareRecording, status: 'new' | 'rejected') => {
    void window.ade.invoke('share:setStatus', shareId, rec.id, status).then(load, onError)
  }
  const importOne = (rec: ShareRecording) => {
    if (importing) return
    setImporting(rec.id)
    void (async () => {
      const runner = await organizeRunner()
      const imported = await window.ade.invoke('share:import', shareId, rec.id)
      setProgress({ stage: 'draft' })
      const { review, notes } = await finishImportedReview(imported, runner, t)
      toast({ tone: 'success', message: t('share.imported', { name: rec.name || t('share.anonymous'), count: review.document.items.length }), detail: notes.join(' ') })
      openImportedReview(review)
      onImported()
    })().catch(onError).finally(() => { setImporting(null); setProgress(null) })
  }

  if (!data) return <p className="st-note share__loading"><Spinner /> {t('share.loading')}</p>
  return <div className="share__detail" data-testid="share-detail">
    <div className="share__toolbar">
      <span className="st-note">{t('share.received', { count: recordings.filter((r) => r.status === 'new').length })}</span>
      <Button variant="ghost" icon={<RefreshCw size={13} />} onClick={load}>{t('share.refresh')}</Button>
    </div>
    {recordings.length === 0 ? <p className="st-note">{t('share.empty')}</p> : <ul className="share__comments">
      {recordings.map((rec) => {
        const thumb = data.thumbnails[rec.id]
        return <li key={rec.id} className={`share__comment share__comment--${rec.status}`} data-testid="share-recording">
          <div className="share__shot">{thumb ? <img src={thumb} alt="" /> : <span className="share__shot-empty">{t(`share.mode.${rec.mode}`)}</span>}</div>
          <div className="share__body">
            <div className="share__who">
              <span>{rec.name || t('share.anonymous')}</span>
              <span className="share__meta">{new Date(rec.createdAt).toLocaleString()} · {t(`share.mode.${rec.mode}`)}{rec.durationMs > 0 ? ` · ${formatDuration(rec.durationMs)}` : ''}</span>
              <Badge tone={rec.status === 'new' ? 'brand' : rec.status === 'imported' ? 'success' : 'neutral'}>{t(`share.status.${rec.status}`)}</Badge>
            </div>
            {rec.notes.length > 0 && <ul className="share__notes">
              {rec.notes.slice(0, 5).map((n, i) => <li key={i} className="share__text">{n.text}</li>)}
              {rec.notes.length > 5 && <li className="share__meta">{t('share.moreNotes', { count: rec.notes.length - 5 })}</li>}
            </ul>}
            {rec.startUrl && <p className="share__meta">{rec.startUrl}</p>}
            {importing === rec.id && <p className="st-note"><Spinner /> {progress ? t(`meeting.stage.${progress.stage}`) : t('share.importing')}</p>}
            <div className="share__actions">
              {rec.status !== 'rejected' && <Button variant={rec.status === 'new' ? 'primary' : 'ghost'} icon={<Download size={13} />} busy={importing === rec.id} disabled={!!importing} onClick={() => importOne(rec)} data-testid="share-import">
                {t(rec.status === 'imported' ? 'share.importAgain' : 'share.import')}
              </Button>}
              {rec.status === 'new' && <Button variant="ghost" icon={<X size={13} />} disabled={!!importing} onClick={() => setStatus(rec, 'rejected')} data-testid="share-reject">{t('share.reject')}</Button>}
              {rec.status === 'rejected' && <Button variant="ghost" icon={<Undo2 size={13} />} onClick={() => setStatus(rec, 'new')}>{t('share.restore')}</Button>}
            </div>
          </div>
        </li>
      })}
    </ul>}
  </div>
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
