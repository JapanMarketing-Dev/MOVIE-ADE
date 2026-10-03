import { useEffect, useState } from 'react'
import { CircleAlert, CircleDot, GitPullRequest, Send, X } from 'lucide-react'
import type { GitHubReviewDraft, GitHubReviewTarget } from '@shared/github'
import { Button, IconButton, Modal, Spinner, useToast } from '../ui'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import '../styles/github.css'

/**
 * レビュー結果（feedback.md）を GitHub へ送る確認ダイアログ。
 *
 * 送り先（新しい Issue か、自分の開いている PR へのコメントか）と本文を先に見せ、
 * 利用者が確かめて押したときだけ書き込む。本文はここで直せる。画像は送らない（本文に断り書きが入る）。
 */
export function GitHubSendDialog({ reviewId, onClose }: { reviewId: string; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const [draft, setDraft] = useState<GitHubReviewDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<'issue' | number>('issue')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [checked, setChecked] = useState(false)
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    let alive = true
    window.ade.invoke('github:reviewDraft', reviewId).then((next) => {
      if (!alive) return
      setDraft(next)
      setTitle(next.title)
      setBody(next.body)
    }, (err: unknown) => alive && setError(errorMessage(err)))
    return () => { alive = false }
  }, [reviewId])

  // 送り先や本文を変えたら、確認をやり直してもらう
  useEffect(() => setChecked(false), [target, title, body])

  const repoName = draft ? `${draft.repo.owner}/${draft.repo.repo}` : ''
  const pr = typeof target === 'number' ? draft?.pullRequests.find((p) => p.number === target) : undefined
  const ready = Boolean(draft) && body.trim() !== '' && (target !== 'issue' || title.trim() !== '')

  const post = async () => {
    if (!draft || !ready || !checked) return
    const spec: GitHubReviewTarget = target === 'issue' ? { kind: 'issue', title: title.trim() } : { kind: 'pr-comment', number: target }
    setPosting(true)
    try {
      const result = await window.ade.invoke('github:postReview', reviewId, spec, body)
      toast({ tone: 'success', message: target === 'issue' ? t('github.send.issueCreated') : t('github.send.commented'), detail: result.url })
      void window.ade.invoke('github:open', result.url).catch(() => {})
      onClose()
    } catch (err) {
      toast({ tone: 'danger', message: t('github.send.failed'), detail: errorMessage(err) })
    } finally {
      setPosting(false)
    }
  }

  return <Modal className="rv-modal" label={t('github.send.title')} onClose={() => !posting && onClose()}>
    <div className="gh-send" data-testid="github-send">
      <header className="gh-send__head">
        <h2><Send size={15} aria-hidden="true" />{t('github.send.title')}</h2>
        <IconButton label={t('common.close')} icon={<X size={16} />} autoFocus disabled={posting} onClick={onClose} />
      </header>

      {!draft && !error && <p className="st-note"><Spinner size={12} />{t('github.send.drafting')}</p>}
      {error && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{error}</p>}

      {draft && <>
        <div className="gh-send__field" role="radiogroup" aria-label={t('github.send.destination')}>
          <span className="gh-send__label">{t('github.send.destinationRepo', { repo: repoName })}</span>
          <div className="gh-send__targets">
            <label className="gh-send__target">
              <input type="radio" name="gh-target" checked={target === 'issue'} disabled={posting} onChange={() => setTarget('issue')} />
              <CircleDot size={13} aria-hidden="true" />{t('github.send.newIssue')}
            </label>
            {draft.pullRequests.map((p) => <label key={p.number} className="gh-send__target">
              <input type="radio" name="gh-target" checked={target === p.number} disabled={posting} onChange={() => setTarget(p.number)} />
              <GitPullRequest size={13} aria-hidden="true" />{t('github.send.prComment', { number: p.number, title: p.title })}
            </label>)}
            {draft.pullRequests.length === 0 && <p className="st-note">{t('github.send.noPrs')}</p>}
          </div>
        </div>

        {target === 'issue' && <label className="gh-send__field">
          <span className="gh-send__label">{t('github.send.issueTitle')}</span>
          <input className="gh-send__input" value={title} maxLength={256} disabled={posting} onChange={(e) => setTitle(e.target.value)} spellCheck={false} />
        </label>}

        <label className="gh-send__field">
          <span className="gh-send__label">{t('github.send.body')}</span>
          <textarea className="gh-send__body" value={body} disabled={posting} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
        </label>

        <label className="gh-send__confirm">
          <input type="checkbox" checked={checked} disabled={posting || !ready} onChange={(e) => setChecked(e.target.checked)} />
          <span>{target === 'issue'
            ? t('github.send.confirmIssue', { repo: repoName })
            : t('github.send.confirmPr', { repo: repoName, number: target, title: pr?.title ?? '' })}</span>
        </label>

        <footer className="gh-send__foot">
          <Button variant="ghost" disabled={posting} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<Send size={13} />} busy={posting} disabled={!ready || !checked}
            onClick={() => void post()}>{target === 'issue' ? t('github.send.createIssue') : t('github.send.postComment')}</Button>
        </footer>
      </>}
    </div>
  </Modal>
}
