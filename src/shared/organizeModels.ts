/**
 * 指摘の画面の「整理」の横で選ぶモデルの一覧と、選んだモデルを settings.json に書く形。
 * 提供元（runner）の選択の隣にモデルの選択を出し、どの AI の何のモデルで整理するかを見えるようにする（ReviewFindings）。
 *
 * - API（api:<provider>）: 設定の「指摘の整理」と同じプリセットの推奨の一覧（@shared/aiProviders）＋設定したモデル。
 *   Ollama の推奨はこの PC のメモリと GPU から main が選んだもの（@shared/localModels）。書く先は organizer.endpoints.<provider>.model
 * - CLI（codex / claude-code）: organizer.cliModels。Claude Code は --model の別名（haiku・sonnet・opus）、Codex は CLI の既定（-m を渡さない）
 * - 既定のモデルを選び直したら上書きを消す（Ollama は PC に合わせた推奨に戻る。設定の画面の表示と同じ）
 */
import { LLM_PROVIDER_PRESETS, type AiEndpointConfig, type LlmApiProvider, type OrganizeRunnerId } from './aiProviders'
import { withRecommendedModel } from './localModels'

/** Claude Code の runner の既定のモデル（claude --model。main の ClaudeCodeRunner と同じ） */
export const CLAUDE_CODE_ORGANIZE_DEFAULT_MODEL = 'haiku'
/** Claude Code の --model に渡せる別名（CLI が最新の版に解決する） */
const CLAUDE_CODE_MODELS = ['haiku', 'sonnet', 'opus'] as const

type CliRunner = 'codex' | 'claude-code'

/** 整理の設定のうち、モデルを決める部分（settings.json の organizer） */
export interface OrganizerModelPrefs {
  endpoints?: Partial<Record<LlmApiProvider, AiEndpointConfig>>
  cliModels?: Partial<Record<CliRunner, string>>
}

export interface OrganizeModelOption {
  /** 渡すモデル名。'' は CLI の既定（モデルを渡さない） */
  id: string
  /** 既定で使うモデル（画面では「おすすめ」） */
  recommended?: boolean
}

export interface OrganizeModelChoice {
  /** 今使うモデル。'' は CLI の既定・未設定（LM Studio・OpenAI 互換でモデルを入れていない） */
  current: string
  /** 何も選び直していないときに使うモデル */
  defaultModel: string
  options: OrganizeModelOption[]
  /** 一覧に無いモデルを設定の「指摘の整理」で入れられる（API の提供元だけ） */
  otherInSettings: boolean
}

function apiProvider(runner: OrganizeRunnerId): LlmApiProvider | null {
  return runner.startsWith('api:') ? runner.slice(4) as LlmApiProvider : null
}

/** 選べるモデルの一覧。今のモデルが一覧に無ければ（設定で入れた名前）先頭の次に足す */
export function organizeModelChoice(runner: OrganizeRunnerId, prefs: OrganizerModelPrefs | undefined, localOrganizeModel?: string): OrganizeModelChoice {
  const provider = apiProvider(runner)
  let defaultModel: string
  let ids: Array<{ id: string; recommended?: true }>
  let configured: string | undefined
  if (provider) {
    const preset = LLM_PROVIDER_PRESETS[provider]
    const local = provider === 'ollama' ? localOrganizeModel?.trim() || undefined : undefined
    defaultModel = local ?? preset.model
    ids = local ? withRecommendedModel(preset.models, local) : [...preset.models]
    configured = prefs?.endpoints?.[provider]?.model?.trim() || undefined
  } else if (runner === 'claude-code') {
    defaultModel = CLAUDE_CODE_ORGANIZE_DEFAULT_MODEL
    ids = CLAUDE_CODE_MODELS.map((id) => (id === defaultModel ? { id, recommended: true as const } : { id }))
    configured = prefs?.cliModels?.['claude-code']?.trim() || undefined
  } else {
    defaultModel = ''
    ids = [{ id: '', recommended: true }]
    configured = prefs?.cliModels?.codex?.trim() || undefined
  }
  const current = configured ?? defaultModel
  const options: OrganizeModelOption[] = ids.map((m) => (m.recommended ? { id: m.id, recommended: true } : { id: m.id }))
  if (current && !options.some((o) => o.id === current)) options.splice(Math.min(1, options.length), 0, { id: current })
  return { current, defaultModel, options, otherInSettings: provider !== null }
}

/**
 * モデルを選び直したときに 'settings:organizer' へ送る差分。既定のモデルなら上書きを消す。
 * endpoints は提供元ごとの設定をまるごと送る形（main がキーの参照を引き継ぐ）なので、ほかの欄はそのまま残す
 */
export function organizeModelPatch(runner: OrganizeRunnerId, prefs: OrganizerModelPrefs | undefined, model: string, defaultModel: string): OrganizerModelPrefs {
  const next = model.trim()
  const provider = apiProvider(runner)
  if (provider) {
    const endpoints = { ...prefs?.endpoints }
    const { model: _old, ...rest } = endpoints[provider] ?? {}
    const ep: AiEndpointConfig = next && next !== defaultModel ? { ...rest, model: next } : rest
    if (Object.keys(ep).length) endpoints[provider] = ep
    else delete endpoints[provider]
    return { endpoints }
  }
  const id = runner as CliRunner
  const cliModels = { ...prefs?.cliModels }
  if (next && next !== defaultModel) cliModels[id] = next
  else delete cliModels[id]
  return { cliModels: Object.keys(cliModels).length ? cliModels : undefined }
}

/** 提供元とモデルを1行にした名前（例: 「Ollama · gpt-oss:20b」）。モデルが無ければ提供元だけ */
export function organizeRunnerSummary(providerName: string, model: string): string {
  return model ? `${providerName} · ${model}` : providerName
}
