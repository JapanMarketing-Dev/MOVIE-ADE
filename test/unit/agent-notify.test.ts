import { describe, expect, it, vi } from 'vitest'
import { agentNotifyText, showAgentNotification, type AgentNotifyDeps, type NotificationLike } from '../../src/main/agentNotify'
import { setLocale } from '@shared/i18n'

function fakeDeps(overrides: Partial<AgentNotifyDeps> = {}) {
  const shown: Array<{ title: string; body: string; click: () => void }> = []
  const open = vi.fn()
  const deps: AgentNotifyDeps = {
    enabled: () => true,
    supported: () => true,
    projects: () => [{ id: 'p1', name: 'acme-shop' }],
    create: (options) => {
      const entry: { title: string; body: string; click: () => void } = { ...options, click: () => undefined }
      const notification: NotificationLike = {
        on: (_event, listener) => { entry.click = listener },
        show: () => { shown.push(entry) }
      }
      return notification
    },
    open,
    ...overrides
  }
  return { deps, shown, open }
}

describe('Agent の OS 通知（main）', () => {
  it('設定が切・通知が使えない・形が違う依頼なら出さない', () => {
    const off = fakeDeps({ enabled: () => false })
    expect(showAgentNotification({ kind: 'done', projectId: 'p1', terminalId: 't1', tab: '1: claude' }, off.deps)).toBe(false)
    const unsupported = fakeDeps({ supported: () => false })
    expect(showAgentNotification({ kind: 'done', projectId: 'p1', terminalId: 't1', tab: 'x' }, unsupported.deps)).toBe(false)
    const bad = fakeDeps()
    expect(showAgentNotification({ kind: 'other', projectId: 'p1' }, bad.deps)).toBe(false)
    expect(showAgentNotification(null, bad.deps)).toBe(false)
    expect(bad.shown).toHaveLength(0)
  })

  it('プロジェクト名とタブ名で出し、押されたらそのプロジェクトとターミナルを開く', () => {
    setLocale('en')
    const { deps, shown, open } = fakeDeps()
    expect(showAgentNotification({ kind: 'blocked', projectId: 'p1', terminalId: 't1', tab: '1: claude' }, deps)).toBe(true)
    expect(shown[0]?.title).toBe('acme-shop: waiting for you')
    expect(shown[0]?.body).toContain('1: claude')
    shown[0]?.click()
    expect(open).toHaveBeenCalledWith({ projectId: 'p1', terminalId: 't1' })
  })

  it('知らないプロジェクトの id は使わず、アプリ名で出す。タブ名の制御文字は落として短く切る', () => {
    setLocale('en')
    const { deps, shown, open } = fakeDeps()
    showAgentNotification({ kind: 'done', projectId: 'nope', terminalId: 't9', tab: `a\u0007b${'x'.repeat(200)}` }, deps)
    expect(shown[0]?.title).toBe('Ferret: agents finished')
    expect(shown[0]?.body).not.toContain('\u0007')
    expect(shown[0]!.body.length).toBeLessThan(140)
    shown[0]?.click()
    expect(open).toHaveBeenCalledWith({ projectId: null, terminalId: 't9' })
  })

  it('タブ名が無ければタブ名なしの文言', () => {
    setLocale('ja')
    expect(agentNotifyText({ kind: 'done', tab: '' }, 'acme-shop')).toEqual({
      title: 'acme-shop：Agent の作業が完了',
      body: 'このプロジェクトの Agent がすべて終わりました。押すと開きます。'
    })
    setLocale('en')
  })
})
