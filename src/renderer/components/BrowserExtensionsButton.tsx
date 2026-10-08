import { useEffect, useState, type MouseEvent } from 'react'
import { Puzzle } from 'lucide-react'
import type { BrowserExtensionInfo } from '@shared/browserExtensions'
import { IconButton, useToast } from '../ui'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'

/** 内蔵ブラウザの拡張機能の一覧（main の読み込みの結果）。変わるたびに届く */
export function useBrowserExtensions(): BrowserExtensionInfo[] {
  const [list, setList] = useState<BrowserExtensionInfo[]>([])
  useEffect(() => {
    void window.ade.invoke('browserExtensions:list').then(setList).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（空のまま続ける）
    return window.ade.on('browserExtensions:changed', setList)
  }, [])
  return list
}

/**
 * ツールバーの拡張機能のボタン（Chrome のパズルのボタン）。押すとネイティブのメニュー（内蔵ブラウザのビューの上にも出る）で
 * 拡張を選び、そのポップアップを内蔵ブラウザの右上に開く。内蔵ブラウザで Chrome ウェブストアの拡張のページを開いているときは、
 * メニューの「このページの拡張を入れる」で入れられる（拡張がまだ1つも無いときも出す）
 */
export function BrowserExtensionsButton({ className, size = 'sm', testId = 'browser-extensions' }: { className?: string; size?: 'sm' | 'md'; testId?: string }) {
  const t = useT()
  const toast = useToast()
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    void window.ade.invoke('browserExtensions:menu', { x: rect.left, y: rect.bottom })
      .then(async (choice) => {
        // 「拡張機能を管理」は設定のページの拡張機能の節へ
        if (choice === 'manage') window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'extensions' } }))
        // 「このページの拡張を入れる」。どの拡張かは main がいま開いているストアのページから決める
        if (choice === 'install') {
          try {
            const next = await window.ade.invoke('browserExtensions:installFromStore')
            const added = next.at(-1)
            if (added) toast({ tone: 'success', message: t('browserExtensions.installed', { name: added.name }) })
          } catch (err) {
            toast({ tone: 'warning', message: errorMessage(err) })
          }
        }
      })
      .catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }
  return <IconButton label={t('browserExtensions.button')} title={t('browserExtensions.buttonTitle')} size={size} className={className}
    icon={<Puzzle size={size === 'sm' ? 16 : 14} strokeWidth={1.75} />} onClick={open} data-testid={testId} />
}

/** ツールバーに並べる拡張のボタンの数の上限（ほかはパズルのボタンのメニューから） */
export const MAX_EXTENSION_ACTIONS = 6

/**
 * 拡張機能のボタン（Chrome の URL 欄の右のアイコン）。読み込めた拡張を並べ、押すとそのポップアップ（無ければ設定のページ）を
 * 内蔵ブラウザの右上に開く。Google 翻訳のように、ページの外のボタンから使う拡張のため
 */
export function BrowserExtensionActions({ className }: { className?: string }) {
  const t = useT()
  const toast = useToast()
  const list = useBrowserExtensions().filter((e) => e.enabled && e.id && !e.error).slice(0, MAX_EXTENSION_ACTIONS)
  if (list.length === 0) return null
  const open = (path: string, name: string) => {
    void window.ade.invoke('browserExtensions:open', path)
      .then((result) => { if (result === 'none') toast({ tone: 'info', message: t('browserExtensions.noAction', { name }) }) })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }
  return <div className={`browser-ext-actions${className ? ` ${className}` : ''}`} data-testid="browser-extension-actions">
    {list.map((ext) => <button key={ext.path} type="button" className="browser-ext-actions__btn" title={ext.name} aria-label={ext.name}
      onClick={() => open(ext.path, ext.name)} data-testid="browser-extension-action">
      {ext.icon ? <img src={ext.icon} alt="" width={16} height={16} draggable={false} /> : <span className="browser-ext-actions__letter" aria-hidden="true">{ext.name.slice(0, 1).toUpperCase()}</span>}
    </button>)}
  </div>
}
