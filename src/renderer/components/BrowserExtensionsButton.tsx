import { useEffect, useState, type MouseEvent } from 'react'
import { Puzzle } from 'lucide-react'
import type { BrowserExtensionInfo } from '@shared/browserExtensions'
import { IconButton } from '../ui'
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
 * 拡張を選び、そのポップアップを内蔵ブラウザの右上に開く。拡張が1つも無ければ出さない
 */
export function BrowserExtensionsButton({ className, size = 'sm', testId = 'browser-extensions' }: { className?: string; size?: 'sm' | 'md'; testId?: string }) {
  const t = useT()
  const list = useBrowserExtensions()
  if (!list.some((ext) => ext.enabled)) return null
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    void window.ade.invoke('browserExtensions:menu', { x: rect.left, y: rect.bottom })
      .then((choice) => {
        // 「拡張機能を管理」は設定のページの拡張機能の節へ
        if (choice === 'manage') window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'extensions' } }))
      })
      .catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }
  return <IconButton label={t('browserExtensions.button')} title={t('browserExtensions.buttonTitle')} size={size} className={className}
    icon={<Puzzle size={size === 'sm' ? 16 : 14} strokeWidth={1.75} />} onClick={open} data-testid={testId} />
}
