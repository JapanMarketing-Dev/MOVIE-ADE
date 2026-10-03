import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Star, X } from 'lucide-react'
import type { StarPromptMode } from '@shared/starPrompt'
import { Button, IconButton, Spinner, useToast } from '../ui'
import { useT, type TFunction } from '../lib/i18n'
import { subscribeIpc } from '../lib/ipcEvents'
import '../styles/github.css'

/**
 * 「GitHub で Ferret に star を」のトースト。main が良い場面で 'star:show' を送ったときだけ出る。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/star-nag/StarNagToastHost.tsx の StarNagToast（MIT, Copyright 2026 Lovecast Inc.）
 *   - gh が使えるときは「Star」の1回の押下で star。失敗したら「GitHub を開く」に切り替える
 *   - gh が使えないときは最初から「GitHub を開く」
 * Orca の「あとで」に、Ferret では「今後表示しない」を足した。押されない限り star しない。
 * 置き場所は通常のトーストと同じ右上（内蔵ブラウザのビューの上に出すと隠れるため）。
 */

type Status = 'idle' | 'busy' | 'starred' | 'opened'

/** 設定の「この Ferret について」とヘルプのメニューの入口。gh で star、できなければブラウザで開く */
export async function starFromMenu(t: TFunction, toast: ReturnType<typeof useToast>): Promise<void> {
  try {
    const result = await window.ade.invoke('star:fromMenu')
    if (result === 'starred') toast({ tone: 'success', message: t('star.thanks') })
    else if (result === 'opened') toast({ tone: 'info', message: t('star.opened') })
    else toast({ tone: 'warning', message: t('star.failed') })
  } catch {
    toast({ tone: 'warning', message: t('star.failed') })
  }
}

export function StarPromptHost() {
  const t = useT()
  const toast = useToast()
  const [mode, setMode] = useState<StarPromptMode | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offShow = subscribeIpc('star:show', (next) => {
      setStatus('idle')
      setMode(next === 'gh' ? 'gh' : 'web')
    }, 'github')
    const offMenu = subscribeIpc('menu:command', (command) => {
      if (command === 'starOnGitHub') void starFromMenu(t, toast)
    }, 'github')
    return () => { offShow(); offMenu() }
  }, [t, toast])

  // 設定などのダイアログ（showModal）より上に出すため、通常のトーストと同じく popover の層に置く
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof host.showPopover !== 'function') return
    if (mode && !host.matches(':popover-open')) host.showPopover()
    if (!mode && host.matches(':popover-open')) host.hidePopover()
  }, [mode])

  // 押したあとの「ありがとう」「開きました」は少し見せてから閉じる
  useEffect(() => {
    if (status !== 'starred' && status !== 'opened') return
    const timer = window.setTimeout(() => setMode(null), 2400)
    return () => window.clearTimeout(timer)
  }, [status])

  const busy = status === 'busy'
  const finished = status === 'starred' || status === 'opened'

  const act = async () => {
    if (busy || finished) return
    setStatus('busy')
    if (mode === 'web') {
      try {
        await window.ade.invoke('star:openWeb')
        setStatus('opened')
      } catch {
        setStatus('idle')
        toast({ tone: 'warning', message: t('star.failed') })
      }
      return
    }
    const ok = await window.ade.invoke('star:star').catch(() => false)
    if (ok) {
      setStatus('starred')
      return
    }
    // gh で star できなかった。ブラウザで開く案内に切り替える
    setMode('web')
    setStatus('idle')
  }

  const close = (channel: 'star:later' | 'star:never') => {
    if (busy) return
    setMode(null)
    if (!finished) void window.ade.invoke(channel).catch(() => undefined)
  }

  const label = status === 'starred' ? t('star.thanks')
    : status === 'opened' ? t('star.opened')
      : busy ? (mode === 'web' ? t('star.opening') : t('star.starring'))
        : mode === 'web' ? t('star.openGitHub') : t('star.star')

  return <div ref={hostRef} popover="manual" className="toast-host star-host" data-testid="star-prompt-host">
    {mode && <div className="toast star-prompt" role="dialog" aria-label={t('star.title')} data-testid="star-prompt">
      <span className="star-prompt__icon" aria-hidden="true"><Star size={14} strokeWidth={1.75} className={status === 'starred' ? 'is-filled' : undefined} /></span>
      <div className="star-prompt__body">
        <span className="toast__message">{t('star.title')}</span>
        <span className="toast__detail">{t('star.body')}</span>
        <div className="star-prompt__actions">
          <Button variant="default" className="star-prompt__primary" disabled={busy || finished} onClick={() => void act()}
            icon={busy ? <Spinner size={13} /> : mode === 'web' ? <ExternalLink size={13} /> : <Star size={13} />} data-testid="star-prompt-star">
            {label}
          </Button>
          {!finished && <>
            <Button variant="ghost" disabled={busy} onClick={() => close('star:later')} data-testid="star-prompt-later">{t('star.later')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => close('star:never')} data-testid="star-prompt-never">{t('star.never')}</Button>
          </>}
        </div>
      </div>
      <IconButton label={t('star.close')} size="sm" icon={<X size={14} strokeWidth={1.75} />} disabled={busy} onClick={() => close('star:later')} />
    </div>}
  </div>
}
