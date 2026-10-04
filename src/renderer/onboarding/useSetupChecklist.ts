import { useCallback, useEffect, useState } from 'react'
import { DECISION_PRESETS } from '@shared/decision'
import { decisionReady } from './onboardingFlowState'
import { setupChecklist, setupProgress, type SetupItem } from './setupChecklistState'

/**
 * チェックリストの元になる状態を main から集める（設定・Agent の検出・文字起こし・権限・全プロジェクトのレビュー）。
 * 権限は読むだけで、確認のダイアログは出さない。プロジェクト・Agent・録画が変わったときと、ウインドウに戻ったときに読み直す。
 */
export function useSetupChecklist(): { items: SetupItem[] | null; progress: ReturnType<typeof setupProgress> | null; refresh: () => void } {
  const [items, setItems] = useState<SetupItem[] | null>(null)

  const refresh = useCallback(() => {
    void (async () => {
      const [settings, agents, available, permissions, skill] = await Promise.all([
        window.ade.invoke('app:settings'),
        window.ade.invoke('agents:list').catch(() => null),
        window.ade.invoke('capture:availability').catch(() => null),
        window.ade.invoke('permissions:status').catch(() => null),
        window.ade.invoke('agentSkill:status').catch(() => null)
      ])
      // 録画した・送ったことがあるかだけを、登録済みのプロジェクトごとに聞く（全部の履歴は読まない。security-4 [10]）
      const activity = await Promise.all(settings.projects.map((p) => window.ade.invoke('review:activity', p.folderPath).catch(() => ({ recorded: false, sent: false }))))
      const decision = settings.decision
      const vendor = decision ? DECISION_PRESETS[decision.preset].vendor : null
      const keyPresent = !!(vendor && available?.keys[vendor]) || !!decision?.apiKey
      setItems(setupChecklist({
        platform: window.ade.platform,
        startupAgents: settings.agents.startupAgents,
        installedAgents: agents ? agents.filter((o) => o.installed).map((o) => o.id) : null,
        agentSkillInstalled: skill ? skill.some((s) => s.installed) : null,
        projectCount: settings.projects.length,
        transcriptionReady: !!available && (available.localReady || Object.values(available.stt).some(Boolean)),
        decisionReady: !!decision?.enabled && decisionReady(decision, keyPresent),
        permissions,
        reviewCount: activity.filter((a) => a.recorded).length,
        sentCount: activity.filter((a) => a.sent).length
      }))
    })().catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（前の表示のまま）
  }, [])

  useEffect(() => {
    refresh()
    const offs = [
      window.ade.on('projects:changed', refresh),
      window.ade.on('agents:changed', refresh),
      window.ade.on('review:ready', refresh)
    ]
    window.addEventListener('focus', refresh)
    window.addEventListener(SETUP_CHANGED_EVENT, refresh)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('focus', refresh)
      window.removeEventListener(SETUP_CHANGED_EVENT, refresh)
    }
  }, [refresh])

  return { items, progress: items ? setupProgress(items) : null, refresh }
}

/** 設定を変えた画面（セットアップを閉じた・Agent へ送ったなど）から、チェックリストに読み直してもらう */
const SETUP_CHANGED_EVENT = 'ade:setup-changed'

export function notifySetupChanged(): void {
  window.dispatchEvent(new CustomEvent(SETUP_CHANGED_EVENT))
}
