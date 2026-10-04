import { PRODUCT_NAME, t } from '@shared/i18n'
import type { AgentNotifyOpen, AgentNotifyRequest } from '@shared/agentNotify'
import type { Project } from '@shared/types'

/**
 * Agent の作業が終わった・確認を待っているときの OS 通知（設定の agents.notify が入のときだけ）。
 *
 * 出すかどうか（見ているタブか・重複か）は renderer の terminal/agentAttention.ts が決める。
 * ここは設定を確かめ、文言を作って出し、押されたらウィンドウを前に出してそのタブへ移るよう renderer に伝える。
 * Electron に依存しないよう、通知とウィンドウは引数で受ける（単体テストで差し替える）。
 */

/** Electron の Notification のうち使う分 */
export interface NotificationLike {
  on(event: 'click', listener: () => void): unknown
  show(): void
}

export interface AgentNotifyDeps {
  enabled: () => boolean
  projects: () => readonly Pick<Project, 'id' | 'name'>[]
  supported: () => boolean
  create: (options: { title: string; body: string; silent: boolean }) => NotificationLike
  /** 押されたとき: ウィンドウを前に出し、renderer にタブを開かせる */
  open: (target: AgentNotifyOpen) => void
}

/** 外から来るタブ名は短く切り、制御文字を落とす */
const MAX_LABEL = 80
function cleanLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
  return [...text].slice(0, MAX_LABEL).join('')
}

/** 通知の文言。プロジェクトが分からなければアプリ名 */
export function agentNotifyText(request: Pick<AgentNotifyRequest, 'kind' | 'tab'>, projectName: string | null): { title: string; body: string } {
  const name = projectName ?? PRODUCT_NAME
  const tab = cleanLabel(request.tab)
  if (request.kind === 'blocked') {
    return { title: t('notify.agentBlocked.title', { name }), body: tab ? t('notify.agentBlocked.body', { tab }) : t('notify.agentBlocked.bodyNoTab') }
  }
  return { title: t('notify.agentDone.title', { name }), body: tab ? t('notify.agentDone.body', { tab }) : t('notify.agentDone.bodyNoTab') }
}

/** 出した通知（押されるまで持つ） */
const live = new Set<NotificationLike>()
const MAX_LIVE = 20

/** 通知を出す。出したら true */
export function showAgentNotification(request: unknown, deps: AgentNotifyDeps): boolean {
  if (!deps.enabled() || !deps.supported() || !request || typeof request !== 'object') return false
  const r = request as Partial<AgentNotifyRequest>
  if (r.kind !== 'done' && r.kind !== 'blocked') return false
  const terminalId = typeof r.terminalId === 'string' && r.terminalId.length <= 200 ? r.terminalId : null
  // 知らないプロジェクトの id は使わない（名前も出さない）
  const project = typeof r.projectId === 'string' ? deps.projects().find((p) => p.id === r.projectId) ?? null : null
  const { title, body } = agentNotifyText({ kind: r.kind, tab: r.tab ?? '' }, project?.name ?? null)
  const notification = deps.create({ title, body, silent: false })
  // 参照を持たないと、押される前に回収されて click が届かないことがある（Electron の Notification）。
  // 通知センターに残ったものも押せるよう、閉じても新しい順に MAX_LIVE 件までは持っておく
  live.add(notification)
  for (const old of live) if (live.size > MAX_LIVE) live.delete(old)
  notification.on('click', () => {
    live.delete(notification)
    deps.open({ projectId: project?.id ?? null, terminalId })
  })
  notification.show()
  return true
}
