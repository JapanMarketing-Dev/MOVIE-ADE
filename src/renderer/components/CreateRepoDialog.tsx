import { useEffect, useState } from 'react'
import { CircleAlert, ExternalLink, FolderGit2, Lock, X } from 'lucide-react'
import { isValidRepoName, type RepoCreateInfo, type RepoCreateResult } from '@shared/repoCreate'
import type { Project } from '@shared/types'
import { Button, IconButton, Modal, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import '../styles/github.css'

/**
 * プロジェクトの右クリックの「GitHub で private リポジトリを作る」（src/main/github/createRepo.ts）。
 *   1. 下調べ（gh のログイン・置き場の候補・git の状態・最初のコミットに入るファイルの数と外す秘密らしいファイル）
 *   2. 置き場・名前・説明を決める。private は固定
 *   3. 確認（外へ出る操作なので、置き場/名前・private・push するかを並べてから「作成」）
 *   4. 作ったら URL を出す。フォルダの origin はそのリポジトリになる
 */
export function CreateRepoDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const [info, setInfo] = useState<RepoCreateInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [initialCommit, setInitialCommit] = useState(true)
  const [step, setStep] = useState<'form' | 'confirm' | 'busy' | 'done'>('form')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RepoCreateResult | null>(null)

  useEffect(() => {
    let alive = true
    void window.ade.invoke('github:repoCreateInfo', project.id).then((next) => {
      if (!alive) return
      setInfo(next)
      setOwner(next.defaultOwner ?? '')
      setName(next.suggestedName)
    }).catch((err) => { if (alive) setLoadError(errorMessage(err)) })
    return () => { alive = false }
  }, [project.id])

  const owners = info?.login ? [info.login, ...info.orgs] : []
  const nameOk = isValidRepoName(name)
  const blocked = !info || !info.ready || info.hasOrigin
  const push = !!info && (info.hasCommits || (initialCommit && info.initialFiles > 0))

  const create = async () => {
    setStep('busy')
    setError(null)
    try {
      const created = await window.ade.invoke('github:createPrivateRepo', project.id, { owner, name, description, initialCommit })
      setResult(created)
      setStep('done')
      toast({ tone: 'success', message: t('repoCreate.done', { repo: `${owner}/${name}` }) })
    } catch (err) {
      setError(errorMessage(err))
      setStep('confirm')
    }
  }

  return <Modal className="rv-modal" label={t('repoCreate.title')} onClose={() => step !== 'busy' && onClose()}>
    <div className="gh-send repo-create" data-testid="repo-create-dialog">
      <header className="gh-send__head">
        <h2><FolderGit2 size={15} aria-hidden="true" />{t('repoCreate.title')}</h2>
        <IconButton label={t('common.close')} icon={<X size={16} />} disabled={step === 'busy'} onClick={onClose} />
      </header>

      {!info && !loadError && <p className="st-note" role="status"><Spinner size={12} /> {t('repoCreate.loading')}</p>}
      {loadError && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{loadError}</p>}
      {info && !info.ready && <p className="st-note st-note--warn" role="alert" data-testid="repo-create-not-ready"><CircleAlert size={12} aria-hidden="true" />{info.reason}</p>}
      {info?.hasOrigin && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{t('repoCreate.errors.hasOrigin')}</p>}

      {info && info.ready && !info.hasOrigin && step === 'form' && <>
        <p className="st-note">{t('repoCreate.intro', { folder: project.name })}</p>
        <label className="gh-send__field">
          <span className="gh-send__label">{t('repoCreate.owner')}</span>
          <select className="st-select" value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="repo-create-owner">
            {owners.map((o) => <option key={o} value={o}>{o === info.login ? `${o} (${t('repoCreate.you')})` : o}</option>)}
          </select>
        </label>
        <label className="gh-send__field">
          <span className="gh-send__label">{t('repoCreate.name')}</span>
          <input className="gh-send__input" value={name} maxLength={100} spellCheck={false} onChange={(e) => setName(e.target.value)} data-testid="repo-create-name" />
          {!nameOk && <span className="st-note st-note--warn">{t('repoCreate.errors.name')}</span>}
        </label>
        <label className="gh-send__field">
          <span className="gh-send__label">{t('repoCreate.description')}</span>
          <input className="gh-send__input" value={description} maxLength={350} onChange={(e) => setDescription(e.target.value)} data-testid="repo-create-description" />
        </label>
        <p className="st-note"><Lock size={12} aria-hidden="true" /> {t('repoCreate.privateOnly')}</p>
        {!info.hasCommits && <label className="st-check">
          <input type="checkbox" checked={initialCommit} onChange={(e) => setInitialCommit(e.target.checked)} data-testid="repo-create-initial-commit" />
          {t('repoCreate.initialCommit', { count: info.initialFiles })}
        </label>}
        {!info.hasCommits && initialCommit && info.excludedSecrets.length > 0 && <div className="repo-create__warn" data-testid="repo-create-secrets">
          <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('repoCreate.secretsExcluded', { count: info.excludedSecrets.length })}</p>
          <ul className="repo-create__secrets">{info.excludedSecrets.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
        </div>}
        <div className="gh-send__foot">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={blocked || !nameOk || !owner} onClick={() => setStep('confirm')} data-testid="repo-create-next">{t('repoCreate.next')}</Button>
        </div>
      </>}

      {(step === 'confirm' || step === 'busy') && info && <>
        <p className="st-note">{t('repoCreate.confirm')}</p>
        <dl className="repo-create__summary" data-testid="repo-create-summary">
          <dt>{t('repoCreate.repository')}</dt><dd><code>{owner}/{name}</code></dd>
          <dt>{t('repoCreate.visibility')}</dt><dd><Lock size={12} aria-hidden="true" /> {t('repoCreate.private')}</dd>
          <dt>{t('repoCreate.folder')}</dt><dd>{project.name}</dd>
          <dt>{t('repoCreate.pushLabel')}</dt><dd>{push ? t('repoCreate.pushYes') : t('repoCreate.pushNo')}</dd>
        </dl>
        {error && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{error}</p>}
        <div className="gh-send__foot">
          <Button variant="ghost" disabled={step === 'busy'} onClick={() => setStep('form')}>{t('repoCreate.back')}</Button>
          <Button variant="primary" disabled={step === 'busy'} onClick={() => void create()} data-testid="repo-create-run">
            {step === 'busy' ? t('repoCreate.creating') : t('repoCreate.create')}
          </Button>
        </div>
      </>}

      {step === 'done' && result && <>
        <p className="st-note" data-testid="repo-create-done">{t(result.pushed ? 'repoCreate.donePushed' : 'repoCreate.doneEmpty', { repo: `${owner}/${name}` })}</p>
        {result.excluded > 0 && <p className="st-note">{t('repoCreate.doneExcluded', { count: result.excluded })}</p>}
        <div className="gh-send__foot">
          <Button variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void window.ade.invoke('github:open', result.url).catch(() => undefined)}>{t('repoCreate.openOnGithub')}</Button>
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </>}
    </div>
  </Modal>
}
