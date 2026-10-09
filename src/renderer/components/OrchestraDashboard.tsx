import { Fragment, useCallback, useEffect, useState } from 'react'
import { ExternalLink, FileText, ListChecks, Play, RefreshCw, Send, ShieldCheck, Sparkles, Video } from 'lucide-react'
import type { Project } from '@shared/types'
import { formatUsd, type CostPeriod, type OrchestraOverview } from '@shared/agentCost'
import { optionAnswer, pageItems } from '@shared/humanChecklist'
import { CODEX_AUDIT_PRESET } from '@shared/codexAudit'
import { requestAgentLaunch } from '../lib/agentLaunchRequest'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useProjectActivity } from '../terminal/agentActivity'
import { Button, useToast } from '../ui'
import { AgentRequestsSection } from './AgentRequestsSection'
import { AllowedOperations, ChecklistAnswer, useOrchestraRules } from './ChecklistAnswer'
import { OrchestraComposer } from './OrchestraComposer'
import { OrchestraCost, periodUsd } from './OrchestraCost'

/**
 * 全体（すべてのプロダクト）のダッシュボード。オーケストラ全体を見て、まとめて指示する。
 * - 一番上：人が確認すべきこと（全体の Agent が human.md に書いたもの。URL の無い承認・用意・決めることも）。
 *   「Agent に書き出してもらう」で全プロダクトから集めて human.md に書く依頼を送る。開くとフィードバックの画面でそのページを開く。
 *   各項目に番号の選択肢（おすすめ付き）か自由な文で答え（human.md の「## 回答」に書く）、「回答をまとめて Agent に送る」で全部を1回で渡す。
 *   その下に、全体として人の確認なしで進めてよい操作（orchestra.allowed）
 * - 全体の数字（対象のプロダクト・未対応・確認待ち・今月のコスト）と、全体への指示の欄
 * - 全プロダクトを1回の録画でフィードバック（帯のタブでプロダクトを切り替えると、指摘の宛先も切り替わる）・確認の巡回・Codex の監査
 * - Agent への依頼（雛形を選んで送る・まとめて送る・1回きりのものは隠す）
 * - プロジェクトの表：オーケストラの対象・対象外、Agent の動き、未対応・確認待ち、コスト（インフラなどを含む）
 */
export function OrchestraDashboard({ projects, onOpenProject, onOpenUrl, onReviewChecklist, onRecordAll, onStartRound }: {
  projects: readonly Project[]
  onOpenProject: (projectId: string) => void
  /** フィードバックの画面でそのページを開く（録画中なら録画を止めずに移る） */
  onOpenUrl: (url: string) => void
  /** 確認リストを上から順に開きながら、1回の録画でフィードバックする */
  onReviewChecklist: (urls: string[]) => void
  /** 全体のフィードバックの画面で録画を始める（1回の録画で全プロダクト） */
  onRecordAll: () => void
  onStartRound: (kind: 'confirm') => void
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
    const timer = setInterval(load, 30_000)
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
  const monthCost = periodUsd(overview, 'month')
  const checklist = overview?.checklist ?? []
  const pages = pageItems(checklist)
  const rowUsd = (r: (typeof rows)[number], p: CostPeriod) => r.cost[p].usd + r.extra[p].usd
  const [rules, updateRules] = useOrchestraRules()
  const answered = checklist.filter((c) => c.answer).length
  const recommendable = checklist.filter((c) => !c.answer && c.options?.some((o) => o.recommended))
  /** 答えを human.md に書き、書いたあとの確認リストに入れ替える */
  const saveAnswers = useCallback(async (entries: Array<{ key: string; answer: string }>) => {
    try {
      const items = await window.ade.invoke('orchestra:answer', entries)
      setOverview((prev) => prev && { ...prev, checklist: items })
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    }
  }, [toast])
  const fillRecommended = () => void saveAnswers(recommendable.map((c) => ({ key: c.key, answer: optionAnswer(c.options!.find((o) => o.recommended)!) })))
  const [sending, setSending] = useState(false)
  const sendAnswers = () => {
    if (sending) return
    setSending(true)
    void window.ade.invoke('orchestra:sendAnswers')
      .then((result) => toast({ tone: result.ok ? 'success' : 'warning', message: result.message }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setSending(false))
  }
  const allowFromItem = (text: string) => {
    if (!rules || !text.trim()) return
    const lines = (rules.allowed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.includes(text.trim())) updateRules({ ...rules, allowed: [...lines, text.trim()].join('\n') })
  }
  const [asking, setAsking] = useState(false)
  /** 人が確認すべきことを全プロダクトから集めて human.md に書く依頼（@shared/agentRequests の human-checklist）を送る */
  const askChecklist = () => {
    if (asking) return
    setAsking(true)
    void window.ade.invoke('agentRequests:send', ['human-checklist'])
      .then((result) => toast({ tone: result.ok ? 'success' : 'warning', message: result.ok ? t('orchestra.checklistAsked') : result.message }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setAsking(false))
  }

  return <div className="orchestra" data-testid="orchestra-dashboard">
    <header className="orchestra__head">
      <h2 className="orchestra__title">{t('orchestra.dashboardTitle')}</h2>
      <Button variant="ghost" icon={<RefreshCw size={13} />} disabled={loading} onClick={load} data-testid="orchestra-reload">{t('common.reload')}</Button>
    </header>

    <section className="orchestra__section" data-testid="orchestra-checklist">
      <div className="orchestra__section-head">
        <h3>{t('orchestra.checklistTitle')}</h3>
        <div className="orchestra__section-actions">
          <Button icon={<FileText size={13} />} disabled={asking} title={t('orchestra.checklistAskHint')} onClick={askChecklist} data-testid="orchestra-checklist-ask">{t('orchestra.checklistAsk')}</Button>
          {recommendable.length > 0 && <Button icon={<Sparkles size={13} />} title={t('orchestra.answerFillHint')} onClick={fillRecommended} data-testid="orchestra-answer-fill">{t('orchestra.answerFill', { count: recommendable.length })}</Button>}
          {answered > 0 && <Button variant="primary" icon={<Send size={13} />} disabled={sending} title={t('orchestra.answersSendHint')} onClick={sendAnswers} data-testid="orchestra-answers-send">{t('orchestra.answersSend', { count: answered })}</Button>}
          {pages.length > 0 && <Button variant="primary" icon={<Play size={13} />} onClick={() => onReviewChecklist(pages.map((c) => c.url))} data-testid="orchestra-checklist-review">{t('orchestra.checklistReview', { count: pages.length })}</Button>}
        </div>
      </div>
      {checklist.length === 0
        ? <p className="st-note">{t('orchestra.checklistEmpty')}</p>
        : <table className="orchestra__table">
          <tbody>
            {checklist.map((item, i) => <Fragment key={`${item.key}-${i}`}>
              <tr className="orchestra__check-row" data-testid={`orchestra-check-${item.key}`}>
                <td className="orchestra__key">{item.key}</td>
                <td>{item.label}</td>
                <td className="orchestra__note">{item.note}</td>
                <td className="orchestra__cell-actions">
                  {item.url && <button type="button" className="st-link" title={item.url} onClick={() => onOpenUrl(item.url)} data-testid={`orchestra-check-open-${item.key}`}>
                    {t('orchestra.open')}<ExternalLink size={11} aria-hidden="true" />
                  </button>}
                </td>
              </tr>
              {/^[A-Z]{1,2}\d/.test(item.key) && <tr className={`orchestra__answer-row${item.answer ? ' is-answered' : ''}`}>
                <td />
                <td colSpan={3}><ChecklistAnswer item={item} onSave={(key, answer) => saveAnswers([{ key, answer }])} onAllow={rules ? allowFromItem : undefined} /></td>
              </tr>}
            </Fragment>)}
          </tbody>
        </table>}
      {rules && <AllowedOperations rules={rules} onChange={updateRules} />}
    </section>


    <div className="orchestra__stats">
      <Stat label={t('orchestra.statProducts')} value={`${included.length}/${rows.length}`} testId="orchestra-stat-products" />
      <Stat label={t('orchestra.statOpen')} value={String(included.reduce((n, r) => n + r.open, 0))} testId="orchestra-stat-open" />
      <Stat label={t('orchestra.statPending')} value={String(included.reduce((n, r) => n + r.pending, 0))} testId="orchestra-stat-pending" />
      <Stat label={t('orchestra.statCostMonth')} value={formatUsd(monthCost)} testId="orchestra-stat-cost" />
    </div>

    <OrchestraComposer />
    <div className="orchestra__actions">
      <Button icon={<Video size={13} />} title={t('orchestra.recordAllHint')} onClick={onRecordAll} data-testid="orchestra-record-all">{t('orchestra.recordAll')}</Button>
      <Button icon={<ListChecks size={13} />} onClick={() => onStartRound('confirm')} data-testid="orchestra-round-confirm">{t('round.startConfirm')}</Button>
      <Button icon={<ShieldCheck size={13} />} title={t('orchestra.codexAuditHint')} onClick={() => requestAgentLaunch('codex', CODEX_AUDIT_PRESET)} data-testid="orchestra-codex-audit">{t('orchestra.codexAudit')}</Button>
    </div>

    <section className="orchestra__section" data-testid="orchestra-requests">
      <h3>{t('orchestra.requestsTitle')}</h3>
      <AgentRequestsSection />
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
            <th>{t('orchestra.costMonth')}</th>
            <th>{t('orchestra.costYear')}</th>
            <th>{t('orchestra.costTotal')}</th>
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
              <td>{formatUsd(rowUsd(r, 'month'))}</td>
              <td>{formatUsd(rowUsd(r, 'year'))}</td>
              <td>{formatUsd(rowUsd(r, 'total'))}</td>
              <td className="orchestra__cell-actions"><button type="button" className="st-link" onClick={() => onOpenProject(r.id)} data-testid={`orchestra-open-${r.id}`}>{t('orchestra.openProject')}</button></td>
            </tr>
          })}
        </tbody>
      </table>}
    </section>

    <OrchestraCost overview={overview} />
  </div>
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return <div className="orchestra__stat" data-testid={testId}>
    <span className="orchestra__stat-value">{value}</span>
    <span className="orchestra__stat-label">{label}</span>
  </div>
}
