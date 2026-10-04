/** Agent の通知（renderer → main の agentNotify:show、押されたら main → renderer の agentNotify:open） */

export interface AgentNotifyRequest {
  /** done: そのプロジェクトの Agent がすべて終わった / blocked: 確認（許可・質問）を待っている */
  kind: 'done' | 'blocked'
  /** 登録したプロジェクトの id。未登録のフォルダなら null */
  projectId: string | null
  /** 開くターミナル（main の id） */
  terminalId: string | null
  /** タブ名（通知の本文に出す） */
  tab: string
}

export interface AgentNotifyOpen {
  projectId: string | null
  terminalId: string | null
}
