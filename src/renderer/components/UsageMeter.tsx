import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Info, Plus, RefreshCw } from 'lucide-react'
import {
  clampUsedPercent,
  formatPlanLabel,
  formatWindowChipLabel,
  soonestResetLabel,
  tightestUsageSection,
  usageSections,
  usageStatusLabel,
  usageTone,
  type AccountUsage,
  type ProviderRateLimits,
  type UsageSection,
  type UsageState
} from '@shared/usage'
import { TUI_AGENT_LABEL, type AccountAgent } from '@shared/types'
import { Segmented } from '../ui'
import { useAgentAccounts } from '../hooks/useAgentAccounts'
import { onAccountsStateChanged } from '../lib/accountLogin'
import { errorMessage } from '../lib/errors'
import { AgentIcon } from './AgentIcon'
import { pickUsageDensityLevel, segmentDetail, type UsageMode } from '../lib/usageDensity'
import { useT, type TFunction } from '../lib/i18n'
import '../styles/accounts.css'

/**
 * フッター左下の使用量表示と、押すと開く「Usage」ポップオーバー。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/status-bar/StatusBar.tsx（使用量の部分）,
 *           ~/bench/orca/src/renderer/src/components/status-bar/StatusBarProviderSegment.tsx（ProviderSegment / MiniBar）,
 *           ~/bench/orca/src/renderer/src/components/status-bar/UsageRosterPanel.tsx,
 *           ~/bench/orca/src/renderer/src/components/status-bar/ClaudeSwitcherMenu.tsx（アカウント別の内訳と切り替え）,
 *           ~/bench/orca/src/renderer/src/components/status-bar/status-bar-claude-accounts.ts,
 *           ~/bench/orca/src/renderer/src/components/status-bar/status-bar-codex-accounts.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく、アカウントの切り替えは各行の「>」から入る内訳の中で行う。
 * 「Usage details & history」の画面・表示する Agent の選択・「% left」表示は持ち込んでいない。
 * メニューは popover（最上位レイヤー）に出し、フッターの上へ開く。
 */

const AGENTS: readonly AccountAgent[] = ['claude', 'codex']
const PANEL_WIDTH = 360
const MODE_STORAGE_KEY = 'ade.usageFooterMode'

function readMode(): UsageMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'compact' ? 'compact' : 'verbose'
  } catch {
    return 'verbose'
  }
}

function saveMode(mode: UsageMode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // 保存できなくても表示は切り替わる
  }
}

/** 残り時間の表示を1分ごとに進める */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function MiniBar({ usedPercent, wide = false }: { usedPercent: number; wide?: boolean }) {
  const used = clampUsedPercent(usedPercent)
  return (
    <span className={`usage-bar${wide ? ' usage-bar--wide' : ''}`} data-tone={usageTone(used)} aria-hidden="true">
      <span className="usage-bar__fill" style={{ width: `${used}%` }} />
    </span>
  )
}

const usedLabel = (t: TFunction, window: { usedPercent: number }) => t('usage.used', { percent: clampUsedPercent(window.usedPercent) })

/** フッターに出す1枠分の名前（5時間・週は残り時間、Fable はそのまま） */
function chipLabel(section: UsageSection, now: number): string {
  return section.key === 'fableWeekly' ? 'Fable' : formatWindowChipLabel(section.window, now)
}

/** フッターの1プロバイダ分（Orca の ProviderSegment） */
function ProviderSegment({ p, agent, mode, level, now }: { p: ProviderRateLimits | null; agent: AccountAgent; mode: UsageMode; level: number; now: number }) {
  const t = useT()
  if (!p || p.status === 'idle') {
    return (
      <span className="usage-seg usage-seg--muted">
        <AgentIcon agent={agent} size={12} />
        <span className="usage-seg__pulse">···</span>
      </span>
    )
  }
  const tightest = tightestUsageSection(p)
  if (p.status === 'fetching' && !tightest) {
    return (
      <span className="usage-seg usage-seg--muted">
        <AgentIcon agent={agent} size={12} />
        <span className="usage-seg__pulse">···</span>
      </span>
    )
  }
  if (p.status === 'unavailable') {
    return (
      <span className="usage-seg usage-seg--muted">
        <AgentIcon agent={agent} size={12} /> --
      </span>
    )
  }
  if (!tightest) {
    return (
      <span className="usage-seg usage-seg--muted">
        <AgentIcon agent={agent} size={12} />
        <AlertTriangle size={11} aria-hidden="true" />
        {level < 4 && <span>{usageStatusLabel(p)}</span>}
      </span>
    )
  }
  const detail = segmentDetail(mode, level)
  const sections = detail.allSections
    ? usageSections(p).filter((section) => detail.secondary || section.key !== 'fableWeekly')
    : [tightest]
  const value = (section: UsageSection) =>
    `${detail.used ? usedLabel(t, section.window) : `${clampUsedPercent(section.window.usedPercent)}%`}${detail.labels ? ` ${chipLabel(section, now)}` : ''}`
  return (
    <span className="usage-seg">
      <AgentIcon agent={agent} size={12} />
      {detail.bar && <MiniBar usedPercent={tightest.window.usedPercent} />}
      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {index > 0 && <span className="usage-seg__dot">·</span>}
          <span className="usage-seg__value" data-tone={usageTone(section.window.usedPercent)}>{value(section)}</span>
        </Fragment>
      ))}
      {/* 失敗したが直前の値を出しているとき（Orca と同じく小さな注意だけ出す） */}
      {p.status === 'error' && <AlertTriangle size={11} className="usage-seg__stale" aria-label={p.error ?? t('usage.updateFailed')} />}
    </span>
  )
}

/**
 * フッターの空きに合わせて段階を選ぶ（Orca の useStatusBarDensity を、使用量の欄だけに絞ったもの）。
 * 段階ごとに「全部出したときの幅」を覚え、空き（自分の幅＋フッターの余白）に収まるいちばん広い段階を選ぶ。
 * まだ測っていない段階はいったん出して測る（描画前の layout effect なので、ちらつかない）。
 */
function useUsageDensity(contentKey: string): {
  level: number
  meterRef: React.RefObject<HTMLSpanElement | null>
  contentRef: React.RefObject<HTMLSpanElement | null>
} {
  const [level, setLevel] = useState(0)
  const levelRef = useRef(0)
  levelRef.current = level
  const widthsRef = useRef<Array<number | undefined>>([])
  const meterRef = useRef<HTMLSpanElement | null>(null)
  const contentRef = useRef<HTMLSpanElement | null>(null)

  const evaluate = useCallback(() => {
    const meter = meterRef.current
    const content = contentRef.current
    if (!meter || !content) return
    // 空き＝自分がいま使っている幅＋フッターの伸びる余白（最小幅を除く）
    const spacer = meter.closest('.statusbar')?.querySelector<HTMLElement>(':scope > .statusbar__spacer')
    const spare = spacer ? Math.max(0, spacer.getBoundingClientRect().width - (Number.parseFloat(getComputedStyle(spacer).minWidth) || 0)) : 0
    const meterWidth = meter.getBoundingClientRect().width
    const available = meterWidth + spare
    // 全部出したときの幅＝中身の幅＋（再読み込みボタンなど、中身以外の幅）
    const trigger = content.parentElement
    const triggerWidth = trigger?.getBoundingClientRect().width ?? 0
    const style = trigger ? getComputedStyle(trigger) : null
    const padding = style ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0) : 0
    const natural = content.scrollWidth + padding + (meterWidth - triggerWidth)
    widthsRef.current[levelRef.current] = natural
    const next = pickUsageDensityLevel(widthsRef.current, available)
    if (next !== levelRef.current) setLevel(next)
  }, [])

  // 中身（％・残り時間・表示の種類）が変わったら、覚えた幅は使えない
  useLayoutEffect(() => {
    widthsRef.current = []
    if (levelRef.current !== 0) setLevel(0)
    else evaluate()
  }, [contentKey, evaluate])

  useLayoutEffect(() => {
    evaluate()
  })

  useEffect(() => {
    const footer = meterRef.current?.closest('.statusbar')
    if (!footer) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(evaluate)
    })
    observer.observe(footer)
    // ほかの項目の出し入れ（フッターの表示設定）で余白が変わったときにも測り直す
    const spacer = footer.querySelector(':scope > .statusbar__spacer')
    if (spacer) observer.observe(spacer)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [evaluate])

  return { level, meterRef, contentRef }
}

/** ポップオーバーの1枠分（ラベル・ミニバー・％） */
function UsageMetric({ section }: { section: UsageSection }) {
  return (
    <span className="usage-metric">
      <span className="usage-metric__label">{section.label}</span>
      <MiniBar usedPercent={section.window.usedPercent} />
      <span className="usage-metric__value" data-tone={usageTone(section.window.usedPercent)}>{clampUsedPercent(section.window.usedPercent)}%</span>
    </span>
  )
}

/** ポップオーバーの1プロバイダ分（Orca の UsageRow） */
function UsageRow({ p, agent, mode, now }: { p: ProviderRateLimits | null; agent: AccountAgent; mode: UsageMode; now: number }) {
  const t = useT()
  const sections = p ? usageSections(p) : []
  const plan = formatPlanLabel(p?.planType)
  const tightest = p && mode === 'compact' ? tightestUsageSection(p) : null
  const reset = p && sections.length > 0 ? soonestResetLabel(p, now) : null
  return (
    <span className="usage-row__body">
      <span className="usage-row__head">
        <span className="usage-row__icon"><AgentIcon agent={agent} size={13} /></span>
        <span className="usage-row__name">
          {TUI_AGENT_LABEL[agent]}
          {plan && <span className="usage-row__plan"> · {plan}</span>}
        </span>
        {sections.length === 0 ? (
          <span className="usage-row__status">{p ? usageStatusLabel(p) : t('usage.loading')}</span>
        ) : tightest ? (
          <span className="usage-row__right"><UsageMetric section={tightest} /></span>
        ) : reset ? (
          <span className="usage-row__reset">{reset}</span>
        ) : null}
      </span>
      {sections.length > 0 && mode === 'verbose' && (
        <span className="usage-row__metrics">
          {sections.map((section) => <UsageMetric key={section.key} section={section} />)}
        </span>
      )}
      {p?.status === 'error' && sections.length > 0 && p.error && <span className="usage-row__error">{p.error}</span>}
    </span>
  )
}

/** 「>」の先：アカウント別の内訳と切り替え（Orca の ClaudeSwitcherMenu 相当） */
function AccountBreakdown({ agent, onBack, onManage, onSwitched }: { agent: AccountAgent; onBack: () => void; onManage?: () => void; onSwitched: () => void }) {
  const t = useT()
  const { state, action, error, select, add } = useAgentAccounts()
  const [rows, setRows] = useState<AccountUsage[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [switched, setSwitched] = useState(false)

  const load = useCallback(
    async (force: boolean) => {
      try {
        setRows(await window.ade.invoke('usage:accounts', agent, force))
        setLoadError(null)
      } catch (err) {
        setLoadError(errorMessage(err))
      }
    },
    [agent]
  )

  useEffect(() => {
    void load(false)
  }, [load, state])

  const busy = action !== 'idle'
  const pending = state?.[agent].accounts.filter((a) => a.lastAuthenticatedAt === null) ?? []

  return (
    <div className="usage-panel__drill">
      <div className="usage-panel__head">
        <button type="button" className="usage-panel__back" onClick={onBack} aria-label={t('usage.back')}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <AgentIcon agent={agent} size={13} />
        <span className="usage-panel__title">{t('usage.accountsOf', { agent: TUI_AGENT_LABEL[agent] })}</span>
        <button type="button" className="usage-panel__icon" onClick={() => void load(true)} aria-label={t('common.reload')} title={t('common.reload')}>
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="usage-panel__rule" />
      {rows === null && !loadError && <p className="usage-panel__empty">{t('usage.loading')}</p>}
      {rows?.map((row) => {
        const sections = row.rateLimits ? usageSections(row.rateLimits) : []
        return (
          <button
            key={row.accountId ?? 'system'}
            type="button"
            role="menuitemradio"
            aria-checked={row.active}
            className="usage-row usage-account"
            disabled={busy || row.active}
            onClick={() =>
              void select(agent, row.accountId).then(() => {
                setSwitched(true)
                onSwitched()
              })
            }
          >
            <span className="usage-account__check">{row.active && <Check size={12} strokeWidth={2.5} />}</span>
            <span className="usage-row__body">
              <span className="usage-row__head">
                <span className="usage-row__name">{row.label}</span>
                {row.active && <span className="usage-account__active">{t('accounts.selected')}</span>}
              </span>
              {sections.length > 0 ? (
                <span className="usage-row__metrics usage-row__metrics--flush">
                  {sections.map((section) => <UsageMetric key={section.key} section={section} />)}
                </span>
              ) : (
                <span className="usage-row__status">{row.rateLimits ? usageStatusLabel(row.rateLimits) : t('usage.loading')}</span>
              )}
            </span>
          </button>
        )
      })}
      {pending.length > 0 && <p className="usage-panel__empty">{t('usage.pending', { count: pending.length })}</p>}
      {(error || loadError) && <p className="account-switcher__error" role="alert">{error ?? loadError}</p>}
      <p className={`account-switcher__note${switched ? ' is-emphasis' : ''}`} role={switched ? 'status' : undefined}>
        <Info size={12} strokeWidth={2} aria-hidden="true" />
        <span>{switched ? t('usage.switchedPrefix') : ''}{t('usage.switchNote', { agent: TUI_AGENT_LABEL[agent] })}</span>
      </p>
      <div className="usage-panel__rule" />
      <button type="button" className="usage-panel__link" disabled={busy} onClick={() => void add(agent)}>
        <Plus size={13} aria-hidden="true" />
        <span>{t('usage.addAccount')}</span>
      </button>
      {onManage && (
        <button type="button" className="usage-panel__link" onClick={onManage}>
          <span>{t('usage.manageAccounts')}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export function UsageMeter({
  onManageAccounts,
  onOpenChange
}: {
  onManageAccounts?: () => void
  /** ポップオーバーの開閉。開いている間は内蔵ブラウザ（ネイティブのビュー）を隠してもらう（App.tsx の viewVisible） */
  onOpenChange?: (open: boolean) => void
}) {
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const t = useT()
  const [usage, setUsage] = useState<UsageState>({ claude: null, codex: null })
  const [refreshing, setRefreshing] = useState(false)
  const [mode, setMode] = useState<UsageMode>(readMode)
  const [view, setView] = useState<'roster' | AccountAgent>('roster')
  const now = useMinuteClock()
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.ade.invoke('usage:get').then(setUsage).catch(() => undefined)
    return window.ade.on('usage:changed', setUsage)
  }, [])

  // アカウントを切り替えたら、その場で新しいアカウントの使用量を取りに行く
  useEffect(() => onAccountsStateChanged(() => void window.ade.invoke('usage:refresh', false).catch(() => undefined)), [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      setUsage(await window.ade.invoke('usage:refresh', true))
    } catch {
      // 失敗は各プロバイダの状態として届く
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') return
      setView('roster')
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const maxLeft = window.innerWidth - PANEL_WIDTH - 8
      panel.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`
      panel.style.bottom = `${window.innerHeight - rect.top + 4}px`
    }
    const onToggle = (event: Event) => {
      const open = (event as ToggleEvent).newState === 'open'
      triggerRef.current?.setAttribute('aria-expanded', String(open))
      onOpenChangeRef.current?.(open)
      // 開いたら古いものだけ取り直す（Orca の「開いたときの更新」）
      if (open) void window.ade.invoke('usage:refresh', false).catch(() => undefined)
    }
    panel.addEventListener('beforetoggle', onBeforeToggle)
    panel.addEventListener('toggle', onToggle)
    return () => {
      panel.removeEventListener('beforetoggle', onBeforeToggle)
      panel.removeEventListener('toggle', onToggle)
      // 開いたまま外れたら、隠したビューを戻してもらう
      onOpenChangeRef.current?.(false)
    }
  }, [])

  const changeMode = (next: UsageMode) => {
    setMode(next)
    saveMode(next)
  }
  const manage = onManageAccounts
    ? () => {
        panelRef.current?.hidePopover()
        onManageAccounts()
      }
    : undefined
  const anyFetching = refreshing || AGENTS.some((agent) => usage[agent]?.status === 'fetching')
  // 表示の中身が変わったときだけ幅を測り直す（1分ごとの残り時間の更新も含む）
  const contentKey = JSON.stringify([mode, now, AGENTS.map((agent) => {
    const p = usage[agent]
    return p && [p.status, p.session?.usedPercent, p.weekly?.usedPercent, p.fableWeekly?.usedPercent, p.session?.resetsAt, p.weekly?.resetsAt]
  })])
  const { level, meterRef, contentRef } = useUsageDensity(contentKey)

  return (
    <span ref={meterRef} className="usage-meter" data-density={level} data-testid="usage-meter">
      <button
        ref={triggerRef}
        type="button"
        className="usage-meter__trigger"
        popoverTarget={panelId}
        aria-haspopup="dialog"
        aria-expanded="false"
        title={t('usage.triggerTitle')}
        data-testid="usage-meter-trigger"
      >
        <span ref={contentRef} className="usage-meter__content">
          {AGENTS.map((agent, index) => (
            <Fragment key={agent}>
              {index > 0 && <span className="usage-meter__sep" aria-hidden="true" />}
              <ProviderSegment p={usage[agent]} agent={agent} mode={mode} level={level} now={now} />
            </Fragment>
          ))}
        </span>
      </button>
      <button type="button" className="usage-meter__refresh" onClick={() => void refresh()} aria-label={t('usage.refresh')} title={t('usage.refresh')}>
        <RefreshCw size={11} className={anyFetching ? 'is-spinning' : ''} aria-hidden="true" />
      </button>
      <div ref={panelRef} id={panelId} popover="auto" role="dialog" aria-label={t('usage.title')} className="quick-launch usage-panel" style={{ width: PANEL_WIDTH }} data-testid="usage-panel">
        {view === 'roster' ? (
          <>
            <div className="usage-panel__head">
              <span className="usage-panel__title">{t('usage.title')}</span>
              <span className="usage-panel__sub">{t('usage.allAgents')}</span>
              <button type="button" className="usage-panel__icon" onClick={() => void refresh()} aria-label={t('common.reload')} title={t('common.reload')}>
                <RefreshCw size={12} className={anyFetching ? 'is-spinning' : ''} aria-hidden="true" />
              </button>
            </div>
            <div className="usage-panel__mode">
              <Segmented<UsageMode>
                ariaLabel={t('usage.modeLabel')}
                value={mode}
                onChange={changeMode}
                options={[
                  { value: 'verbose', label: t('usage.mode.detailed'), title: t('usage.mode.detailedHint') },
                  { value: 'compact', label: t('usage.mode.compact'), title: t('usage.mode.compactHint') }
                ]}
              />
            </div>
            <div className="usage-panel__rule" />
            {AGENTS.map((agent) => (
              <button key={agent} type="button" className="usage-row" onClick={() => setView(agent)} data-testid={`usage-row-${agent}`}>
                <UsageRow p={usage[agent]} agent={agent} mode={mode} now={now} />
                <ChevronRight size={14} className="usage-row__chevron" aria-hidden="true" />
              </button>
            ))}
            {manage && (
              <>
                <div className="usage-panel__rule" />
                <button type="button" className="usage-panel__link" onClick={manage}>
                  <span>{t('usage.manageAccounts')}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </>
            )}
          </>
        ) : (
          <AccountBreakdown agent={view} onBack={() => setView('roster')} onManage={manage} onSwitched={() => void window.ade.invoke('usage:refresh', false)} />
        )}
      </div>
    </span>
  )
}
