/**
 * 実行環境の解決。
 * whisper の実行ファイル・モデル、GPUの有無、使えるLLM CLIを決める。
 *
 * **Electron の API には依存しない。** パス（`app.getPath('userData')` や
 * `process.resourcesPath`）は引数で受け取るので、単体テストできる。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { PlatformName } from '@shared/types'
import type { WhisperModelId } from './stt/models'
import { whisperModels } from './stt/models'
import { commonBinaryDirs } from '../platform/binaryDirs'
import { pickWindowsWhereResult } from '../platform/windowsSpawn'
import { timedSync } from '@shared/report'

/** 呼び出し側（main）が渡すパス */
export interface EnvironmentPaths {
  /** 配布時のリソースフォルダ（`process.resourcesPath`）。開発時は省略 */
  resourcesDir?: string
  /** モデルの置き場所（`join(app.getPath('userData'), 'models')`） */
  modelDir: string
}

/** テストで差し替える外部依存 */
export interface EnvironmentProbes {
  platform: PlatformName
  arch: string
  /** ホームフォルダ。~/.local/bin などを探すのに使う。省略時は探さない */
  home?: string
  /** ファイルが存在するか */
  exists: (path: string) => boolean
  /** PATH 上のコマンドの絶対パス。無ければ null */
  which: (command: string) => string | null
  /**
   * コマンドを実行して stdout+stderr を返す。失敗したら null。
   * GPUバックエンドの検出と CLI の有無の確認に使う。
   */
  run?: (command: string, args: string[]) => Promise<string | null>
}

const WHISPER_EXECUTABLE = 'whisper-cli'

/**
 * whisper の実行ファイルを探す。
 * 1. 配布時: `<resources>/whisper/<platform>-<arch>/whisper-cli`（同梱したもの）
 * 2. PATH 上
 * 3. Homebrew などの既定の場所（OSごと。platform/binaryDirs.ts）
 */
export function resolveWhisperBinary(
  paths: EnvironmentPaths,
  probes: EnvironmentProbes
): string | null {
  const name = probes.platform === 'win32' ? `${WHISPER_EXECUTABLE}.exe` : WHISPER_EXECUTABLE

  if (paths.resourcesDir) {
    const bundled = joinPath([paths.resourcesDir, 'whisper', `${probes.platform}-${probes.arch}`, name])
    if (probes.exists(bundled)) return bundled
  }

  const onPath = probes.which(WHISPER_EXECUTABLE)
  if (onPath) return onPath

  for (const dir of commonBinaryDirs(probes.platform as NodeJS.Platform, probes.home ?? '')) {
    const candidate = joinPath([dir, name])
    if (probes.exists(candidate)) return candidate
  }
  return null
}

/** モデルファイルの置き場所。ユーザー設定フォルダの下に置く（プロジェクトを汚さない。NF-9） */
export function whisperModelPath(paths: EnvironmentPaths, id: WhisperModelId): string {
  return joinPath([paths.modelDir, whisperModels[id].file])
}

export function isWhisperModelReady(
  paths: EnvironmentPaths,
  id: WhisperModelId,
  probes: EnvironmentProbes
): boolean {
  return probes.exists(whisperModelPath(paths, id))
}

/**
 * GPU（Metal / CUDA / Vulkan）が使えるか。
 *
 * whisper-cli は起動時に読み込んだバックエンドを stderr へ出すので、それを見て判定する。
 * 実行できない場合は、macOS は Metal あり、それ以外は無しとみなす（控えめな既定）。
 */
export async function detectGpu(binary: string | null, probes: EnvironmentProbes): Promise<boolean> {
  if (binary && probes.run) {
    const out = await probes.run(binary, ['--help'])
    if (out !== null) {
      return /loaded (MTL|CUDA|Vulkan|HIP|SYCL) backend/i.test(out)
    }
  }
  return probes.platform === 'darwin'
}

/**
 * 使うモデルを決める。
 * CPUのみでは `large-v3-turbo` が実時間の0.84倍かかり逐次処理が追いつかないため、
 * `small`（0.32倍）へ落とす（設計 5章①、05_pipeline_findings.md）。
 */
export function chooseWhisperModel(gpuAvailable: boolean): WhisperModelId {
  return gpuAvailable ? 'large-v3-turbo' : 'small'
}

export interface WhisperRuntime {
  binary: string
  modelId: WhisperModelId
  modelPath: string
  gpuAvailable: boolean
  /** モデルが未ダウンロードなら true。呼び出し側は downloadWhisperModel() を走らせる */
  needsDownload: boolean
}

/** whisper を動かすのに必要なものを一度に解決する */
export async function resolveWhisperRuntime(
  paths: EnvironmentPaths,
  probes: EnvironmentProbes,
  override?: { modelId?: WhisperModelId }
): Promise<WhisperRuntime | { error: 'binary-not-found' }> {
  const binary = resolveWhisperBinary(paths, probes)
  if (!binary) return { error: 'binary-not-found' }

  const gpuAvailable = await detectGpu(binary, probes)
  const modelId = override?.modelId ?? chooseWhisperModel(gpuAvailable)
  const modelPath = whisperModelPath(paths, modelId)
  return {
    binary,
    modelId,
    modelPath,
    gpuAvailable,
    needsDownload: !probes.exists(modelPath)
  }
}

// ───────────────────────── LLM CLI の検出 ─────────────────────────

export type LlmRunnerKind = 'codex' | 'claude-code'

export interface LlmRuntime {
  kind: LlmRunnerKind
  binary: string
  /** Claude Code のときだけ使う。Codex は config を無効化して既定モデルに任せる */
  model?: string
}

/**
 * 使えるCLIを検出する。
 * 既定は Codex（所要時間が安定）。無ければ Claude Code の sonnet（設計 6章）。
 */
export async function detectLlmRuntime(
  probes: EnvironmentProbes,
  preferred?: LlmRunnerKind
): Promise<LlmRuntime | null> {
  const codex = probes.which('codex')
  const claude = probes.which('claude')

  const candidates: LlmRuntime[] = []
  if (codex) candidates.push({ kind: 'codex', binary: codex })
  if (claude) candidates.push({ kind: 'claude-code', binary: claude, model: 'sonnet' })

  if (candidates.length === 0) return null
  if (preferred) {
    const hit = candidates.find((c) => c.kind === preferred)
    if (hit) return hit
  }
  // 既定の優先順は Codex → Claude Code
  return candidates[0]!
}

/** 一覧で「使える／使えない」を出すための検出結果 */
export interface LlmAvailability {
  codex: boolean
  claudeCode: boolean
}

export async function detectLlmAvailability(probes: EnvironmentProbes): Promise<LlmAvailability> {
  return {
    codex: probes.which('codex') !== null,
    claudeCode: probes.which('claude') !== null
  }
}

/** `node:path` を動的 import せずに済ませる（この関数はテストで多用するため） */
function joinPath(parts: string[]): string {
  const sep = parts.some((p) => p.includes('\\')) && !parts[0]!.startsWith('/') ? '\\' : '/'
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[/\\]+$/, '') : p.replace(/^[/\\]+|[/\\]+$/g, '')))
    .filter((p) => p.length > 0)
    .join(sep)
}

/** which の結果を覚える時間（PATH の変化は30秒で拾い直す） */
const WHICH_CACHE_MS = 30_000
const whichCache = new Map<string, { value: string | null; at: number }>()

/** 既定の probes（main から使う）。Electron には依存しない */
export function nodeProbes(): EnvironmentProbes {
  return {
    platform: process.platform as PlatformName,
    arch: process.arch,
    home: homedir(),
    exists: (p) => existsSync(p),
    which: (command) => {
      /*
       * which / where を同期で起動するので main が止まる（重い Mac では数百 ms〜秒）。capture:availability などで
       * 何度も呼ばれるので、結果を30秒覚える（見つからないことも覚える）。時間は重い処理として控える
       */
      const hit = whichCache.get(command)
      if (hit && Date.now() - hit.at < WHICH_CACHE_MS) return hit.value
      const finder = process.platform === 'win32' ? 'where' : 'which'
      const value = timedSync(`which:${command}`.slice(0, 40), () => {
        try {
          const out = execFileSync(finder, [command], {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
          })
          // Windows の where は npm の拡張子なしのスクリプトを先に出すことがある。起動できるものを選ぶ
          if (process.platform === 'win32') return pickWindowsWhereResult(out, process.env)
          const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
          return first ? first.trim() : null
        } catch {
          // コマンドが見つからない（想定内）
          return null
        }
      })
      whichCache.set(command, { value, at: Date.now() })
      return value
    },
    run: async (command, args) =>
      new Promise((resolve) => {
        execFile(command, args, { timeout: 20_000, encoding: 'utf8', windowsHide: true }, (_err, stdout, stderr) => {
          const text = `${stdout ?? ''}${stderr ?? ''}`
          resolve(text.length > 0 ? text : null)
        })
      })
  }
}
