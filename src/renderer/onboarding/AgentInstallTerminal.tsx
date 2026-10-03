import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Copy, Download, ExternalLink, RotateCw, Square } from 'lucide-react'
import { requiredInstallTool } from '@shared/agentInstall'
import { Button, IconButton, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { acquireTerminal, releaseTerminal } from '../terminal/terminalClient'
import { AgentInstallController, isInstallBusy, type InstallState } from './agentInstallController'
import '../styles/onboarding.css'

/**
 * 見つからなかった Agent の CLI を、カードの中の小さなターミナルでインストールする。
 * セットアップの Agent の手順と、設定 → Agent の「見つかりません」の行で使う。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/OnboardingInlineCommandTerminal.tsx（MIT）。
 *   1回きりのシェルを作ってコマンドを流す・出力をその場で見せて入力も受ける（sudo のパスワードなど）・
 *   外したらシェルを閉じる、を移植した。シェルは内蔵ターミナルと同じ TerminalManager（ログインシェル・同じ PATH）で、
 *   xterm の扱いも内蔵ターミナルと同じ terminalClient を使う。
 *
 * 押すまで何も実行しない。動いている間は「中止」で PTY を閉じる。成功したら onRefresh で検出し直す。
 * 画面を読み込み直したときに残ったシェルは、内蔵ターミナルのつなぎ直し（restorePlan）がどのタブにも無いものとして閉じる。
 */
export function AgentInstallTerminal({ agentId, label, command, guideUrl, onRefresh }: {
  agentId: string
  label: string
  /** 1行のインストールコマンド。無ければインストール方法のリンクだけを出す */
  command?: string
  guideUrl: string
  /** 検出し直す。その Agent が見つかったら true */
  onRefresh: () => Promise<boolean>
}) {
  const t = useT()
  const toast = useToast()
  const [state, setState] = useState<InstallState>({ phase: 'idle', run: 0 })
  const [outputHidden, setOutputHidden] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh
  const controllerRef = useRef<AgentInstallController | null>(null)
  const keyOf = (run: number) => `agent-install:${agentId}:${run}`

  useEffect(() => {
    if (!command) return
    const controller = new AgentInstallController(command, {
      create: async (line, run) => {
        const handle = acquireTerminal(keyOf(run))
        const info = await window.ade.invoke('terminal:create', {
          size: handle.size(), command: line, exitWhenDone: true, title: t('agentInstall.terminalTitle', { agent: label })
        })
        handle.bindPty(info.id)
        return info.id
      },
      close: (ptyId) => void window.ade.invoke('terminal:close', ptyId).catch(() => undefined),
      onExit: (listener) => window.ade.on('terminal:exit', listener),
      refresh: () => refreshRef.current()
    }, setState)
    controllerRef.current = controller
    return () => {
      // 手順を移った・セットアップや設定を閉じた・カードが消えた（インストール済みになった）
      controller.dispose()
      controllerRef.current = null
    }
  }, [agentId, command])

  // 実行ごとの xterm をカードの中に開く。次の実行・外すときに前のものを捨てる（PTY が残っていれば閉じる）
  useLayoutEffect(() => {
    if (state.run === 0) return
    const key = keyOf(state.run)
    const handle = acquireTerminal(key)
    if (hostRef.current) handle.open(hostRef.current)
    handle.focus()
    return () => releaseTerminal(key)
  }, [state.run, agentId])

  if (!command) {
    return <a className="ob-link" href={guideUrl} target="_blank" rel="noreferrer">
      {t('onboarding.agents.installGuide')}<ExternalLink size={11} aria-hidden="true" /></a>
  }

  const busy = isInstallBusy(state)
  const start = () => { setOutputHidden(false); controllerRef.current?.start() }
  const copy = () => void navigator.clipboard.writeText(command).then(() => toast({ tone: 'success', message: t('common.copied') }), () => {})
  const guide = <a className="ob-link" href={guideUrl} target="_blank" rel="noreferrer">
    {t('onboarding.agents.installGuide')}<ExternalLink size={11} aria-hidden="true" /></a>

  return <div className="agent-install" data-testid={`agent-install-${agentId}`} data-phase={state.phase}>
    <div className="agent-install__command">
      <code title={command}>{command}</code>
      <IconButton size="sm" label={t('common.copyCommand')} icon={<Copy size={12} />} onClick={copy} />
    </div>

    {state.run > 0 && <div className="agent-install__term" hidden={outputHidden && !busy} ref={hostRef}
      // Esc はインストーラ（npm の確認など）へ渡す。セットアップの「閉じますか？」を出さない
      onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault() }}
      aria-label={t('agentInstall.terminalTitle', { agent: label })} />}

    <div className="agent-install__actions">
      {state.phase === 'idle' && <>
        <Button variant="primary" icon={<Download size={13} />} onClick={start} data-testid={`agent-install-${agentId}-run`}>{t('agentInstall.install')}</Button>
      </>}
      {busy && <>
        <span className="agent-install__status" role="status"><Spinner size={12} />{t(state.phase === 'starting' ? 'agentInstall.starting' : 'agentInstall.running')}</span>
        <Button icon={<Square size={11} />} onClick={() => controllerRef.current?.cancel()} data-testid={`agent-install-${agentId}-cancel`}>{t('agentInstall.cancel')}</Button>
      </>}
      {state.phase === 'done' && state.outcome === 'success' && <>
        <span className="agent-install__status is-ok" role="status"><CircleCheck size={12} aria-hidden="true" />
          {t(state.detected === null ? 'agentInstall.checking' : state.detected ? 'agentInstall.installed' : 'agentInstall.installedNotFound', { agent: label })}</span>
        {state.detected === false && <Button icon={<RotateCw size={12} />} onClick={() => void onRefresh()}>{t('onboarding.agents.recheck')}</Button>}
      </>}
      {state.phase === 'done' && state.outcome !== 'success' && <>
        <span className="agent-install__status is-error" role="status"><CircleAlert size={12} aria-hidden="true" />
          {state.outcome === 'missingTool'
            ? t('agentInstall.missingTool', { tool: requiredInstallTool(command) })
            : t('agentInstall.failed', { code: String(state.exitCode ?? '?') })}</span>
        <Button icon={<RotateCw size={12} />} onClick={start} data-testid={`agent-install-${agentId}-retry`}>{t('agentInstall.retry')}</Button>
        {guide}
      </>}
      {(state.phase === 'cancelled' || state.phase === 'error') && <>
        <span className={`agent-install__status${state.phase === 'error' ? ' is-error' : ''}`} role="status">
          {state.phase === 'error' ? state.message : t('agentInstall.cancelled')}</span>
        <Button icon={<RotateCw size={12} />} onClick={start} data-testid={`agent-install-${agentId}-retry`}>{t('agentInstall.retry')}</Button>
        {guide}
      </>}
      {!busy && state.run > 0 && <Button variant="ghost" onClick={() => setOutputHidden((v) => !v)}>
        {t(outputHidden ? 'agentInstall.showOutput' : 'agentInstall.hideOutput')}</Button>}
    </div>
  </div>
}

/**
 * 設定 → Agent の「見つかりません」の行に置く、たためるインストール欄。
 * 開いている間だけ中身（とシェル）を持ち、たたんだらシェルを閉じる（Orca の「パネルが消えたらシェルを閉じる」と同じ）。
 */
export function AgentInstallDisclosure(props: Parameters<typeof AgentInstallTerminal>[0]) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return <details className="st-agent-row__details agent-install-disclosure" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary data-testid={`agent-install-${props.agentId}-open`}>{t('agentInstall.disclosure', { agent: props.label })}</summary>
    {open && <AgentInstallTerminal {...props} />}
  </details>
}
