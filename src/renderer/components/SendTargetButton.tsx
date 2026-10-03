import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Send, Sparkles } from 'lucide-react'
import { AUTO_TARGET, sendTargetKey, type SendTarget, type SendTargetOption } from '@shared/sendTarget'
import { Button, Tooltip } from '../ui'
import { AgentIcon } from './AgentIcon'
import { useT } from '../lib/i18n'
import { loadSendTargets, rememberSendTarget, rememberedSendTarget, resolveRememberedTarget, sendTargetLabel } from '../lib/sendReview'

/**
 * 「Agentへ送信」の分割ボタン。左が送信、右の ▾ で宛先を選ぶ。
 * 宛先は 自動 / 動いている Agent のタブ / 有効でインストール済みの Agent（動いていなければ送るときに起動）。
 * 最後に選んだ宛先はプロジェクトごとに覚え、次はボタン1つで同じ宛先へ送る。
 */
export function SendTargetButton({ projectKey, disabled, onSend }: {
  /** 宛先を覚える単位（プロジェクトの id。無ければ共通） */
  projectKey: string
  disabled: boolean
  onSend: (target: SendTarget) => void
}) {
  const t = useT()
  const menuId = useId()
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [target, setTarget] = useState<SendTarget>(() => rememberedSendTarget(projectKey))
  const [options, setOptions] = useState<SendTargetOption[]>([])

  // 覚えていた宛先を、いま選べるものに直す（タブが閉じていればその Agent、無効にした Agent なら自動）
  const refresh = () => loadSendTargets().then(({ options: next, agents, running }) => {
    setOptions(next)
    setTarget((current) => resolveRememberedTarget(current, agents, running))
  }).catch(() => undefined) // 一覧が取れなくても自動で送れる（失敗は main の IPC が送る）
  useEffect(() => {
    setTarget(rememberedSendTarget(projectKey))
    void refresh()
  }, [projectKey])

  // ▾ を開く直前に一覧を取り直し、ボタンの下に出す
  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const onBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') return
      void refresh()
      const rect = toggleRef.current?.getBoundingClientRect()
      if (!rect) return
      menu.style.left = `${Math.max(8, Math.min(rect.right - 280, window.innerWidth - 288))}px`
      menu.style.top = `${rect.bottom + 4}px`
    }
    const onToggle = (event: Event) => {
      const open = (event as ToggleEvent).newState === 'open'
      toggleRef.current?.setAttribute('aria-expanded', String(open))
      if (open) menu.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus()
    }
    menu.addEventListener('beforetoggle', onBeforeToggle)
    menu.addEventListener('toggle', onToggle)
    return () => {
      menu.removeEventListener('beforetoggle', onBeforeToggle)
      menu.removeEventListener('toggle', onToggle)
    }
  }, [])

  const choose = (next: SendTarget) => {
    menuRef.current?.hidePopover()
    setTarget(next)
    rememberSendTarget(projectKey, next)
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  const selectedKey = sendTargetKey(target)
  const selected = options.find((o) => o.key === selectedKey) ?? (target.kind === 'auto' ? null : { agent: target.agent, tab: undefined })
  const label = target.kind === 'auto' ? t('review.sendToAgent') : t('review.sendTo', { agent: sendTargetLabel(selected) })
  const item = (key: string, next: SendTarget, icon: React.ReactNode, text: string, detail: string | null, testId: string) =>
    <button key={key} type="button" role="menuitemradio" aria-checked={key === selectedKey} className="quick-launch__item"
      onClick={() => choose(next)} data-testid={testId}>
      {icon}
      <span className="quick-launch__label">{text}</span>
      {detail && <span className="quick-launch__detail">{detail}</span>}
      {key === selectedKey && <Check size={13} aria-hidden="true" />}
    </button>

  return <span className="rv-send-split">
    <Tooltip side="bottom" label={t('review.sendToAgentTip')}>
      <Button variant="primary" className="rv-send" icon={<Send size={14} />} disabled={disabled} onClick={() => onSend(target)} data-testid="send-to-agent">{label}</Button>
    </Tooltip>
    <button ref={toggleRef} type="button" className="btn btn--primary rv-send-split__toggle" popoverTarget={menuId} aria-haspopup="menu" aria-expanded="false"
      aria-label={t('review.sendTargetMenu')} title={t('review.sendTargetMenu')} disabled={disabled} data-testid="send-target-toggle">
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    <div ref={menuRef} id={menuId} popover="auto" role="menu" aria-label={t('review.sendTargetMenu')} className="quick-launch rv-send-menu" style={{ width: 280 }}
      onKeyDown={onKeyDown} data-testid="send-target-menu">
      <div className="quick-launch__list">
        {item('auto', AUTO_TARGET, <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />, t('review.sendTargetAuto'), null, 'send-target-auto')}
        {options.map((o) => item(o.key, o.target, o.agent ? <AgentIcon agent={o.agent} label={sendTargetLabel(o)} size={14} /> : null, sendTargetLabel(o),
          o.running ? t('review.sendTargetRunning') : t('review.sendTargetLaunch'), `send-target-${o.key.replace(/[:]/g, '-')}`))}
      </div>
    </div>
  </span>
}
