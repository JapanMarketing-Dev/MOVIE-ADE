import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_AGENT_PREFERENCES,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_URL,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type AgentPreferences,
  type Project,
  type Settings
} from '@shared/types'
import { sanitizeAgentPreferences } from '@shared/agentCatalog'
import { sanitizeCaptureTarget } from '@shared/captureTarget'
import { normalizeThemePreference } from '@shared/theme'
import { DEFAULT_LAYOUT, sanitizeLayout } from '@shared/layout'
import { normalizeLocalePreference } from '@shared/i18n'
import { migrateLegacySettings } from './projects'
import { sanitizeAgentAccounts } from './accounts/sanitize'
import { normalizeBaseUrl, sanitizeCostLimit, sanitizeEndpointMap } from './pipeline/stt/endpoint'
import { isLlmApiProvider, isOrganizeRunnerId, isSttRemoteProvider } from '@shared/aiProviders'

/**
 * WS-1 前回のフォルダ・URL・分割幅を復元する。
 * 設計 8章のとおり、OSのユーザー設定フォルダ（app.getPath('userData')）へ保存する。
 * 依存を増やさないため electron-store は使わず、小さなJSONを自前で読み書きする。
 */

/**
 * E2E（ADE_E2E=1）ではAgentタブを自動で開かない。CLI の有無に左右されず、
 * 最初のタブがいつも素のシェルになるようにする（ターミナルのE2Eはプロンプトを待つ）
 */
const SKIP_STARTUP_AGENTS = process.env.ADE_E2E === '1'

const DEFAULTS: Settings = {
  folderPath: null,
  url: DEFAULT_URL,
  splitRatio: DEFAULT_SPLIT_RATIO,
  layout: DEFAULT_LAYOUT,
  theme: 'system',
  locale: 'system',
  viewport: 'desktop',
  projects: [],
  activeProjectId: null,
  agents: SKIP_STARTUP_AGENTS ? { ...DEFAULT_AGENT_PREFERENCES, startupAgents: [] } : DEFAULT_AGENT_PREFERENCES
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function sanitizeProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((p): Project[] => {
    if (!p || typeof p !== 'object') return []
    const r = p as Partial<Project>
    if (!str(r.id) || !str(r.folderPath) || seen.has(r.id)) return []
    seen.add(r.id)
    const urls = Array.isArray(r.urls) ? r.urls.flatMap((u) =>
      u && str(u.id) && str(u.url) ? [{ id: u.id, label: str(u.label) ? u.label : u.url, url: u.url }] : []) : []
    return [{ id: r.id, name: str(r.name) ? r.name : r.folderPath.split(/[\\/]/).pop() ?? r.folderPath, folderPath: r.folderPath, urls }]
  })
}

function sanitizeAgents(raw: unknown): AgentPreferences {
  const agents = sanitizeAgentPreferences(raw)
  return SKIP_STARTUP_AGENTS ? { ...agents, startupAgents: [] } : agents
}

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

function clampRatio(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, n))
}

/** 読み込んだJSONを型どおりに直す。壊れた値は既定値へ戻す（単体テストから使うため export） */
export function sanitize(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const r = raw as Partial<Settings>
  return {
    ...(typeof r.whisperModel === 'string' ? { whisperModel: r.whisperModel } : {}),
    ...(r.capture ? { capture: {
      captureMic: r.capture.captureMic !== false, captureSystemAudio: r.capture.captureSystemAudio === true,
      transcription: isSttRemoteProvider(r.capture.transcription) ? r.capture.transcription : 'local' as const,
      language: r.capture.language === 'ja' || r.capture.language === 'en' ? r.capture.language : 'auto' as const,
      micDeviceId: typeof r.capture.micDeviceId === 'string' ? r.capture.micDeviceId : undefined,
      keepDays: Number.isFinite(r.capture.keepDays) ? Math.min(3650, Math.max(0, Math.round(r.capture.keepDays))) : 7,
      stayFeedbackOnStop: r.capture.stayFeedbackOnStop === true,
      captureTarget: sanitizeCaptureTarget(r.capture.captureTarget),
      // 文字起こしの接続先。キー本体は settings.json に入れない（pipeline/stt/keys.ts）
      ...(() => {
        // 以前の baseUrl / model（OpenAI 互換だけ）は sttEndpoints.compatible へ移す
        const raw = r.capture.sttEndpoints && typeof r.capture.sttEndpoints === 'object' ? { ...r.capture.sttEndpoints } : {}
        if (!raw.compatible && (typeof r.capture.baseUrl === 'string' || typeof r.capture.model === 'string')) {
          raw.compatible = { baseUrl: normalizeBaseUrl(r.capture.baseUrl) ?? undefined, model: r.capture.model }
        }
        const sttEndpoints = sanitizeEndpointMap(raw, isSttRemoteProvider)
        const costLimitUsd = sanitizeCostLimit(r.capture.costLimitUsd)
        return { ...(sttEndpoints ? { sttEndpoints } : {}), ...(costLimitUsd !== undefined ? { costLimitUsd } : {}) }
      })()
    } } : {}),
    folderPath: typeof r.folderPath === 'string' && r.folderPath.length > 0 ? r.folderPath : null,
    url: typeof r.url === 'string' && r.url.length > 0 ? r.url : DEFAULTS.url,
    splitRatio: clampRatio(r.splitRatio),
    layout: sanitizeLayout(r.layout, r.terminalDock),
    theme: normalizeThemePreference(r.theme),
    locale: normalizeLocalePreference(r.locale),
    viewport: r.viewport === 'mobile' ? 'mobile' : 'desktop',
    ...(() => {
      const projects = sanitizeProjects(r.projects)
      const activeProjectId = projects.some((p) => p.id === r.activeProjectId) ? r.activeProjectId! : null
      return { projects, activeProjectId }
    })(),
    agents: sanitizeAgents(r.agents),
    // 未設定は ON のまま書かない。明示の OFF だけを残す
    ...(r.crashReports === false ? { crashReports: false } : {}),
    ...(r.crashReportsNoticeShown === true ? { crashReportsNoticeShown: true } : {}),
    ...(r.agentAccounts ? { agentAccounts: sanitizeAgentAccounts(r.agentAccounts) } : {}),
    // 空・空白だけは「未設定」（既定文を使う）。長すぎる値は切り詰める
    ...(typeof r.agentPrompt === 'string' && r.agentPrompt.trim() ? { agentPrompt: r.agentPrompt.trim().slice(0, 2000) } : {}),
    // 「指摘を整理」の実行方法と API の接続先。キー本体は入れない（pipeline/stt/keys.ts）
    ...(r.organizer && typeof r.organizer === 'object' ? (() => {
      const endpoints = sanitizeEndpointMap(r.organizer.endpoints, isLlmApiProvider)
      const runner = isOrganizeRunnerId(r.organizer.runner) ? r.organizer.runner : undefined
      return runner || endpoints ? { organizer: { ...(runner ? { runner } : {}), ...(endpoints ? { endpoints } : {}) } } : {}
    })() : {})
  }
}

/** 起動経路で1度だけ読む。失敗（初回起動・破損）は既定値で続行する */
export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    // 旧設定（folderPath だけ）はここで1度だけプロジェクトへ移す
    cache = migrateLegacySettings(sanitize(JSON.parse(await readFile(filePath(), 'utf8'))))
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function currentSettings(): Settings {
  return cache ?? { ...DEFAULTS }
}

/** 書き込みは起動後の操作でしか起きないため、まとめて遅延保存する */
export function updateSettings(patch: Partial<Settings>): void {
  cache = sanitize({ ...currentSettings(), ...patch })
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void persist()
  }, 300)
  writeTimer.unref?.()
}

export async function persist(): Promise<void> {
  const target = filePath()
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(currentSettings(), null, 2)}\n`, 'utf8')
  } catch (err) {
    console.warn('[settings] 保存に失敗しました', err)
  }
}

/**
 * 終了時に未書き込みの変更を取りこぼさない。
 * `before-quit` は非同期の完了を待たないので、ここだけは同期で書く。
 */
export function flushSettingsSync(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  const target = filePath()
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(currentSettings(), null, 2)}\n`, 'utf8')
  } catch (err) {
    console.warn('[settings] 保存に失敗しました', err)
  }
}
