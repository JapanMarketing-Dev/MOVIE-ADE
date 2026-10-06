import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge } from 'lucide-react'
import { formatCost, formatTokens, projectLabel, type ApiCallKind, type ApiUsageSummary, type ApiUsageTotals } from '@shared/apiUsage'
import { useT } from '../lib/i18n'
import { StatusPopover } from './StatusPopover'
import '../styles/decision.css'

const KINDS: readonly ApiCallKind[] = ['decision', 'transcription', 'organize']

/** 「42 回 · 18.3k tok · $0.01」の短い形。費用は分かったときだけ */
function shortTotals(t: ApiUsageTotals, tr: ReturnType<typeof useT>, model: string): string {
  const base = tr('apiUsage.label', { model, calls: t.calls, tokens: formatTokens(t.inputTokens + t.outputTokens) })
  return t.costKnown > 0 ? `${base} · ${formatCost(t)}` : base
}

const time = (iso: string) => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * フッター左下の「API の使用量」（従量課金の判定モデル・文字起こし・整理の呼び出し）。
 * 判定モデルの呼び出しは Agent がローカル中継を通して行うので、Ferret が数えられる（src/main/decision/）。
 * 判定モデルが無効で、今月の記録も無ければ出さない（幅 0 になり、フッターの並びから外れる）。
 */
export function ApiUsageMeter({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const t = useT()
  const [summary, setSummary] = useState<ApiUsageSummary | null>(null)
  const [open, setOpen] = useState(false)
  /** プロジェクト ID → 名前（プロジェクトごとの合計の見出し）。開いたときに読む */
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    void window.ade.invoke('app:settings').then((s) => setProjectNames(Object.fromEntries(s.projects.map((p) => [p.id, p.name])))).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ID のまま出す）
  }, [open])
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const load = useCallback(() => window.ade.invoke('usage:apiCalls').then(setSummary).catch(() => undefined), []) // 失敗は main の IPC が Sentry へ送る（ここは表示しないだけ）
  useEffect(() => {
    void load()
    const off = window.ade.on('usage:apiCallsChanged', setSummary)
    // 判定モデルの有効・無効を切り替えたら出し直す
    const offSettings = window.ade.on('settings:changed', () => void load())
    return () => { off(); offSettings() }
  }, [load])
  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])
  useEffect(() => () => onOpenChangeRef.current?.(false), [])
  const close = useCallback(() => setOpen(false), [])

  if (!summary || (!summary.enabled && summary.month.calls === 0)) return null
  const model = summary.model ?? t('apiUsage.title')

  return <>
    <button ref={triggerRef} type="button" className="statusbar__btn sb-api" aria-haspopup="dialog" aria-expanded={open}
      title={`${shortTotals(summary.today, t, model)}\n${t('apiUsage.tooltip')}`} onClick={() => setOpen((v) => !v)} data-testid="statusbar-api-usage">
      <Gauge size={12} strokeWidth={2} aria-hidden="true" />
      <span className="sb-api__text">{shortTotals(summary.today, t, model)}</span>
    </button>
    {open && <StatusPopover anchor={triggerRef.current} label={t('apiUsage.title')} onClose={close} className="sb-pop--api">
      <div className="sb-api-pop" data-testid="api-usage-popover">
        <div className="sb-api-pop__head">
          <h2 className="sb-api-pop__title">{t('apiUsage.title')}</h2>
          <span className="sb-api-pop__model">{summary.enabled ? t('apiUsage.decisionModel', { model: summary.model ?? '' }) : t('apiUsage.decisionOff')}</span>
        </div>
        <div className="sb-api-pop__totals">
          {([['apiUsage.today', summary.today], ['apiUsage.month', summary.month]] as const).map(([label, totals]) => <div key={label} className="sb-api-pop__total">
            <span className="sb-api-pop__label">{t(label)}</span>
            <span className="sb-api-pop__big">{t('apiUsage.calls', { count: totals.calls })} · {formatCost(totals)}</span>
            <span className="sb-api-pop__sub">{t('apiUsage.tokens', { input: formatTokens(totals.inputTokens), output: formatTokens(totals.outputTokens) })}</span>
          </div>)}
        </div>
        {summary.month.calls === 0 ? <p className="sb-api-pop__note">{t('apiUsage.empty')}</p> : <>
          <Breakdown title={t('apiUsage.byModel')} rows={Object.entries(summary.byModel)} />
          <Breakdown title={t('apiUsage.byKind')} rows={KINDS.flatMap((k) => (summary.byKind[k] ? [[t(`apiUsage.kind.${k}`), summary.byKind[k]!] as [string, ApiUsageTotals]] : []))} />
          <Breakdown title={t('apiUsage.byProject')} rows={Object.entries(summary.byProject).map(([id, totals]) => [projectLabel(id, projectNames, t('apiUsage.noProject')), totals])} />
          <table className="sb-api-pop__table">
            <caption className="sb-api-pop__label sb-api-pop__caption">{t('apiUsage.recent')}</caption>
            {/* 時刻とモデル名の列を広く取り、数の列は詰める（切れた名前はツールチップで全文） */}
            <colgroup><col className="sb-api-pop__col-name" /><col /><col /><col /><col /></colgroup>
            <tbody>{summary.recent.map((r, i) => <tr key={`${r.ts}-${i}`}>
              <td title={r.model}>{time(r.ts)} {r.model}</td>
              <td className={r.status >= 200 && r.status < 300 ? undefined : 'is-error'}>{r.status || '—'}</td>
              <td>{r.latencyMs >= 1000 ? `${(r.latencyMs / 1000).toFixed(1)}s` : `${r.latencyMs}ms`}</td>
              <td>{r.inputTokens !== undefined || r.outputTokens !== undefined ? formatTokens((r.inputTokens ?? 0) + (r.outputTokens ?? 0)) : '—'}</td>
              <td>{formatCost(r)}</td>
            </tr>)}</tbody>
          </table>
        </>}
        <p className="sb-api-pop__note">{t('apiUsage.costNote')}</p>
        <button type="button" className="sb-api-pop__link" onClick={() => void window.ade.invoke('usage:openApiLog')}>{t('apiUsage.openLog')}</button>
      </div>
    </StatusPopover>}
  </>
}

function Breakdown({ title, rows }: { title: string; rows: Array<[string, ApiUsageTotals]> }) {
  const t = useT()
  if (rows.length === 0) return null
  return <table className="sb-api-pop__table">
    <caption className="sb-api-pop__label sb-api-pop__caption">{title}</caption>
    <colgroup><col className="sb-api-pop__col-name" /><col /><col /><col /></colgroup>
    <tbody>{rows.map(([name, totals]) => <tr key={name}>
      <td title={name}>{name}</td>
      <td>{t('apiUsage.calls', { count: totals.calls })}</td>
      <td>{formatTokens(totals.inputTokens + totals.outputTokens)} tok</td>
      <td>{formatCost(totals)}</td>
    </tr>)}</tbody>
  </table>
}
