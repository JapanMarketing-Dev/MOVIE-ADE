import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, ListChecks, Play, RefreshCw, Repeat } from 'lucide-react'
import type { Project } from '@shared/types'
import { formatUsd, type OrchestraOverview } from '@shared/agentCost'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useProjectActivity } from '../terminal/agentActivity'
import { Button, useToast } from '../ui'
import { OrchestraComposer } from './OrchestraComposer'
import { OrchestraRequestPicker } from './OrchestraRequestPicker'

/**
 * 全体（すべてのプロダクト）のダッシュボード。オーケストラ全体を見て、まとめて指示する。
 * - 上：全体の数字（対象のプロダクト・未対応・確認待ち・概算のコスト）と、全体への指示の欄・用意した依頼（人から学ぶ・dream・定期実行など）を選んで送る欄
 * - 人の確認リスト（全体の Agent が human.md に書いたもの）。開くとフィードバックの画面でそのページを開く。
 *   録画を止めずに次のページへ移れるので、1回のフィードバックで全部のプロダクトを確かめられる
 * - プロジェクトの表：オーケストラの対象・対象外、Agent の動き、未対応・確認待ち、コスト
 */
export function OrchestraDashboard({ projects, onOpenProject, onOpenUrl, onReviewChecklist, onStartRound }: {
  projects: readonly Project[]
  onOpenProject: (projectId: string) => void
  /** フィードバックの画面でそのページを開く（録画中なら録画を止めずに移る） */
  onOpenUrl: (url: string) => void
  /** 確認リストを上から順に開きながら、1回の録画でフィードバックする */
  onReviewChecklist: (urls: string[]) => void
  onStartRound: (kind: 'record' | 'confirm') => void
}) {
  const t = useT()
  const toast = useToast()
  const activity = useProjectActivity()
  const [overview, setOverview] = useState<OrchestraOverview | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    void window.ade.invoke('orchestra:overview')
      .then(setOverview)
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setLoading(false))
  }, [toast])
  useEffect(() => { load() }, [load, projects])
  useEffect(() => {
    const timer = setInterval(load, 60_000)
    return () => clearInterval(timer)
  }, [load])

  const toggleIncluded = (id: string, included: boolean) => {
    // 押したらすぐ表示を変える（保存に失敗したら読み直して戻す）
    setOverview((prev) => prev && { ...prev, projects: prev.projects.map((r) => (r.id === id ? { ...r, included } : r)) })
    void window.ade.invoke('project:update', { id, orchestraExcluded: !included }).then(load)
      .catch((err) => { toast({ tone: 'warning', message: errorMessage(err) }); load() })
  }

  const rows = overview?.projects ?? []
  const included = rows.filter((r) => r.included)
  const totalCost = (overview?.orchestraCost.usd ?? 0) + rows.reduce((n, r) => n + r.cost.usd, 0)
  const checklist = overview?.checklist ?? []

  return <div className="orchestra" data-testid="orchestra-dashboard">
    <header className="orchestra__head">
      <h2 className="orchestra__title">{t('orchestra.dashboardTitle')}</h2>
      <Button variant="ghost" icon={<RefreshCw size={13} />} disabled={loading} onClick={load} data-testid="orchestra-reload">{t('common.reload')}</Button>
    </header>

    <div className="orchestra__stats">
      <Stat label={t('orchestra.statProducts')} value={`${included.length}/${rows.length}`} testId="orchestra-stat-products" />
      <Stat label={t('orchestra.statOpen')} value={String(included.reduce((n, r) => n + r.open, 0))} testId="orchestra-stat-open" />
      <Stat label={t('orchestra.statPending')} value={String(included.reduce((n, r) => n + r.pending, 0))} testId="orchestra-stat-pending" />
      <Stat label={t('orchestra.statCost', { days: overview?.costDays ?? 30 })} value={formatUsd(totalCost)} testId="orchestra-stat-cost" />
    </div>

    <OrchestraComposer />
    <div className="orchestra__actions">
      <Button icon={<Repeat size={13} />} onClick={() => onStartRound('record')} data-testid="orchestra-round-record">{t('round.startRecord')}</Button>
      <Button icon={<ListChecks size={13} />} onClick={() => onStartRound('confirm')} data-testid="orchestra-round-confirm">{t('round.startConfirm')}</Button>
      <OrchestraRequestPicker />
    </div>

    <section className="orchestra__section" data-testid="orchestra-checklist">
      <div className="orchestra__section-head">
        <h3>{t('orchestra.checklistTitle')}</h3>
        {checklist.length > 0 && <Button variant="primary" icon={<Play size={13} />} onClick={() => onReviewChecklist(checklist.map((c) => c.url))} data-testid="orchestra-checklist-review">{t('orchestra.checklistReview', { count: checklist.length })}</Button>}
      </div>
      {checklist.length === 0
        ? <p className="st-note">{t('orchestra.checklistEmpty')}</p>
        : <table className="orchestra__table">
          <tbody>
            {checklist.map((item) => <tr key={item.url} data-testid={`orchestra-check-${item.key}`}>
              <td className="orchestra__key">{item.key}</td>
              <td>{item.label}</td>
              <td className="orchestra__note">{item.note}</td>
              <td className="orchestra__cell-actions">
                <button type="button" className="st-link" title={item.url} onClick={() => onOpenUrl(item.url)} data-testid={`orchestra-check-open-${item.key}`}>
                  {t('orchestra.open')}<ExternalLink size={11} aria-hidden="true" />
                </button>
              </td>
            </tr>)}
          </tbody>
        </table>}
    </section>

    <section className="orchestra__section" data-testid="orchestra-projects">
      <h3>{t('orchestra.projectsTitle')}</h3>
      {rows.length === 0 ? <p className="st-note">{t('orchestra.noProducts')}</p> : <table className="orchestra__table">
        <thead>
          <tr>
            <th>{t('orchestra.colIncluded')}</th>
            <th>{t('orchestra.colProject')}</th>
            <th>{t('orchestra.colAgent')}</th>
            <th>{t('orchestra.colOpen')}</th>
            <th>{t('orchestra.colPending')}</th>
            <th>{t('orchestra.colCost')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const state = activity[r.id]
            return <tr key={r.id} className={r.included ? '' : 'is-excluded'} data-testid={`orchestra-row-${r.id}`}>
              <td><input type="checkbox" checked={r.included} aria-label={t('orchestra.colIncluded')} onChange={(e) => toggleIncluded(r.id, e.target.checked)} data-testid={`orchestra-include-${r.id}`} /></td>
              <td className="orchestra__name">{r.name}</td>
              <td><span className={`orchestra__state orchestra__state--${state ?? 'idle'}`}>{t(state === 'working' ? 'orchestra.stateWorking' : state === 'blocked' ? 'orchestra.stateBlocked' : 'orchestra.stateIdle')}</span></td>
              <td>{r.open}</td>
              <td>{r.pending}</td>
              <td title={`${r.cost.input + r.cost.cacheRead + r.cost.cacheWrite} in / ${r.cost.output} out`}>{formatUsd(r.cost.usd)}</td>
              <td className="orchestra__cell-actions"><button type="button" className="st-link" onClick={() => onOpenProject(r.id)} data-testid={`orchestra-open-${r.id}`}>{t('orchestra.openProject')}</button></td>
            </tr>
          })}
        </tbody>
      </table>}
      <p className="st-note">{t('orchestra.costNote')}</p>
    </section>
  </div>
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return <div className="orchestra__stat" data-testid={testId}>
    <span className="orchestra__stat-value">{value}</span>
    <span className="orchestra__stat-label">{label}</span>
  </div>
}
