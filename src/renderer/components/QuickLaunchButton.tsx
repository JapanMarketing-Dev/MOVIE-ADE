import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppWindow, FileText, Globe, Plus, Search, Settings, SquareTerminal } from 'lucide-react'
import type { TuiAgent } from '@shared/types'
import { SHORTCUTS } from '../lib/shortcut'
import {
  buildQuickLaunchEntries,
  entryId,
  type QuickLaunchEntry
} from '../terminal/quickLaunchSearch'
import { AgentIcon } from './AgentIcon'
import { useT, type TFunction } from '../lib/i18n'

/**
 * タブ列の「＋」。押すと「新しいターミナル / Claude Code / Codex / Agent設定…」を選べる。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/QuickLaunchButton.tsx（MIT, Copyright 2026 Lovecast Inc.）
 * Orca の項目構成・並び・ショートカット表示をそのまま使い、Agent検出・telemetry・store は持ち込んでいない。
 *
 * メニューは popover（最上位レイヤー）に出す。タブ列は横スクロールのため overflow で切れてしまうので、
 * 位置は開く直前にボタンの座標から決める。外側クリックと Esc で閉じるのはブラウザに任せる。
 *
 * ペインの分割（右に分割／下に分割）でも、同じメニューで新しいペインの中身を選ぶ
 * （Orca の TerminalTabSplitMenuSection と同じ並び）。
 *
 * search を渡すと、一番上に Orca と同じ検索欄を出す（TabBarCreateEntry 相当）。入力に応じて
 * メニューの項目・開いているタブ・登録したURL・ファイルを絞り込み、↑↓で選んで Enter で実行する。
 */

/** メニューに出すエージェント1件 */
export interface QuickLaunchAgent {
  id: TuiAgent
  label: string
  /** カスタムのアイコンの文字 */
  icon?: string
}

const MENU_WIDTH = 220
const SEARCH_MENU_WIDTH = 320
/** ファイル検索を打ち始めてから呼ぶまでの間 */
const FILE_SEARCH_DEBOUNCE_MS = 150

/** 検索欄の材料と、選ばれたときの動き */
export interface QuickLaunchSearch {
  tabs: ReadonlyArray<{ key: string; title: string }>
  urls: ReadonlyArray<{ label: string; url: string; project: string }>
  onSelectTab: (key: string) => void
  onOpenUrl: (url: string) => void
  /** ファイル検索（fs:search）。無ければファイルは出さない */
  searchFiles?: (query: string) => Promise<string[]>
  onOpenFile?: (path: string) => void
}

export function QuickLaunchButton({
  agents,
  onNewTerminal,
  onLaunchAgent,
  onOpenAgentSettings,
  icon = <Plus size={14} strokeWidth={2} />,
  label: labelProp,
  newTerminalShortcut = SHORTCUTS.newTerminal(),
  testId = 'terminal-add-tab',
  disabled = false,
  search
}: {
  /** 出すエージェント（Orca と同じく、インストール済みか登録したもので、無効にしていないもの） */
  agents: readonly QuickLaunchAgent[]
  onNewTerminal: () => void
  onLaunchAgent: (agent: TuiAgent) => void
  /** 渡されたときだけ「Agent設定…」を出す */
  onOpenAgentSettings?: () => void
  icon?: ReactNode
  /** ボタンとメニューの名前 */
  label?: string
  /** 「新しいターミナル」の横に出すショートカット */
  newTerminalShortcut?: string
  /** ボタンの data-testid。項目は `<testId>-shell` などになる（既定の「＋」だけ従来の名前） */
  testId?: string
  disabled?: boolean
  /** 渡すと一番上に検索欄を出す */
  search?: QuickLaunchSearch
}) {
  const t = useT()
  const label = labelProp ?? t('terminal.newTab')
  const itemId = (suffix: string) =>
    testId === 'terminal-add-tab' ? `terminal-launch-${suffix}` : `${testId}-${suffix}`
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [files, setFiles] = useState<{ query: string; paths: string[] }>({ query: '', paths: [] })
  const width = search ? SEARCH_MENU_WIDTH : MENU_WIDTH

  const searchFiles = search?.onOpenFile ? search.searchFiles : undefined
  const entries = useMemo(
    () =>
      buildQuickLaunchEntries(search ? query : '', {
        agents,
        settings: Boolean(onOpenAgentSettings),
        tabs: search?.tabs ?? [],
        urls: search?.urls ?? [],
        // 古い入力の結果は出さない
        files: files.query === query.trim() ? files.paths : []
      }),
    [agents, search, query, files, onOpenAgentSettings]
  )

  // ファイルは打ち終わるのを少し待ってから探す
  useEffect(() => {
    const q = query.trim()
    if (!searchFiles || !q) return
    let stale = false
    const timer = setTimeout(() => {
      searchFiles(q)
        .then((paths) => {
          if (!stale) setFiles({ query: q, paths })
        })
        .catch(() => { // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
          if (!stale) setFiles({ query: q, paths: [] })
        })
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, searchFiles])

  useEffect(() => setHighlight(0), [query])

  // 開く直前に位置を決め、開いたら検索欄（無ければ最初の項目）へ焦点を移す
  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const onBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') return
      const button = buttonRef.current
      if (!button) return
      setQuery('')
      setHighlight(0)
      const rect = button.getBoundingClientRect()
      // ペインの右端からはみ出さず、左のブラウザ（ネイティブのビューが上に重なる）へも出ない位置
      const pane = button.closest('.terminal-pane')?.getBoundingClientRect()
      const minLeft = (pane?.left ?? 0) + 4
      const maxLeft = window.innerWidth - width - 8
      menu.style.left = `${Math.max(minLeft, Math.min(rect.left, maxLeft))}px`
      menu.style.top = `${rect.bottom + 4}px`
    }
    const onToggle = (event: Event) => {
      const open = (event as ToggleEvent).newState === 'open'
      buttonRef.current?.setAttribute('aria-expanded', String(open))
      if (!open) return
      if (inputRef.current) inputRef.current.focus()
      else menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    }
    menu.addEventListener('beforetoggle', onBeforeToggle)
    menu.addEventListener('toggle', onToggle)
    return () => {
      menu.removeEventListener('beforetoggle', onBeforeToggle)
      menu.removeEventListener('toggle', onToggle)
    }
  }, [width])

  const runEntry = (entry: QuickLaunchEntry) => {
    menuRef.current?.hidePopover()
    switch (entry.kind) {
      case 'shell':
        return onNewTerminal()
      case 'agent':
        return onLaunchAgent(entry.agent)
      case 'settings':
        return onOpenAgentSettings?.()
      case 'tab':
        return search?.onSelectTab(entry.tabKey)
      case 'url':
      case 'open-url':
        return search?.onOpenUrl(entry.url)
      case 'file':
        return search?.onOpenFile?.(entry.path)
    }
  }

  // 検索欄があるときは焦点を欄に置いたまま、↑↓で選んで Enter で実行する。
  // 無いときは上下キーで項目へ焦点を移す（Tab で抜けられるよう、ほかのキーは触らない）
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (search) {
      if (event.key === 'Enter' && event.target === inputRef.current) {
        event.preventDefault()
        const entry = entries[highlight]
        if (entry) runEntry(entry)
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      if (entries.length === 0) return
      const next = event.key === 'ArrowDown' ? highlight + 1 : highlight - 1
      setHighlight((next + entries.length) % entries.length)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    items[(next + items.length) % items.length]?.focus()
  }

  // 選んでいる項目が見えるようにする
  useEffect(() => {
    if (!search) return
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight, search])

  const renderEntry = (entry: QuickLaunchEntry, index: number) => {
    const view = entryView(entry, newTerminalShortcut, t)
    const active = Boolean(search) && index === highlight
    return (
      <div key={entryId(entry)} className="quick-launch__row">
        {entry.kind === 'settings' && <div className="quick-launch__separator" role="separator" />}
        <button
          type="button"
          role="menuitem"
          id={`${menuId}-${index}`}
          data-index={index}
          className={`quick-launch__item${entry.kind === 'settings' ? ' quick-launch__item--muted' : ''}${active ? ' is-active' : ''}`}
          title={entry.kind === 'agent' ? t('quickLaunch.launchAgent', { agent: entry.label }) : undefined}
          tabIndex={search ? -1 : undefined}
          onMouseMove={() => search && index !== highlight && setHighlight(index)}
          onClick={() => runEntry(entry)}
          data-testid={itemId(view.testSuffix)}
        >
          {view.icon}
          <span className="quick-launch__label">{view.label}</span>
          {view.detail && <span className="quick-launch__detail">{view.detail}</span>}
          {view.shortcut && <kbd className="quick-launch__shortcut">{view.shortcut}</kbd>}
        </button>
      </div>
    )
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="terminal-tabs__add"
        popoverTarget={menuId}
        aria-haspopup="menu"
        aria-expanded="false"
        title={label}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
      >
        {icon}
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={label}
        className="quick-launch"
        style={{ width }}
        onKeyDown={onKeyDown}
        data-testid={itemId('menu')}
      >
        {search && (
          <div className="quick-launch__search">
            <Search size={14} strokeWidth={1.75} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              className="quick-launch__input"
              value={query}
              placeholder={t('quickLaunch.placeholder')}
              aria-label={t('quickLaunch.placeholder')}
              aria-activedescendant={entries.length > 0 ? `${menuId}-${highlight}` : undefined}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              data-testid={itemId('search')}
            />
          </div>
        )}
        <div className="quick-launch__list">
          {entries.map(renderEntry)}
          {entries.length === 0 && <div className="quick-launch__empty">{t('quickLaunch.noMatches')}</div>}
        </div>
      </div>
    </>
  )
}

function entryView(
  entry: QuickLaunchEntry,
  newTerminalShortcut: string,
  t: TFunction
): { icon: ReactNode; label: string; detail?: string; shortcut?: string; testSuffix: string } {
  switch (entry.kind) {
    case 'shell':
      return {
        icon: <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" />,
        label: t('quickLaunch.newTerminal'),
        shortcut: newTerminalShortcut || undefined,
        testSuffix: 'shell'
      }
    case 'agent':
      return {
        icon: <AgentIcon agent={entry.agent} label={entry.icon ?? entry.label} size={14} />,
        label: entry.label,
        testSuffix: entry.agent.replace(':', '-')
      }
    case 'settings':
      return { icon: <Settings size={14} strokeWidth={1.75} aria-hidden="true" />, label: t('quickLaunch.agentSettings'), testSuffix: 'settings' }
    case 'tab':
      return { icon: <AppWindow size={14} strokeWidth={1.75} aria-hidden="true" />, label: entry.title, detail: t('quickLaunch.tab'), testSuffix: `tab-${entry.tabKey}` }
    case 'url':
      return {
        icon: <Globe size={14} strokeWidth={1.75} aria-hidden="true" />,
        label: entry.label,
        detail: entry.project ? `${entry.project} · ${entry.url}` : entry.url,
        testSuffix: 'url'
      }
    case 'open-url':
      return { icon: <Globe size={14} strokeWidth={1.75} aria-hidden="true" />, label: entry.url, detail: t('quickLaunch.openUrl'), testSuffix: 'open-url' }
    case 'file':
      return { icon: <FileText size={14} strokeWidth={1.75} aria-hidden="true" />, label: entry.path.split('/').pop() ?? entry.path, detail: entry.path, testSuffix: 'file' }
  }
}
