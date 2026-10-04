import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { CLI_TOOL_IDS, CLI_TOOLS, cliDetectCommands, parseCliVersion, type CliToolId, type CliToolStatus } from '@shared/cliTools'
import { resolveCommandsInDirs, searchDirs } from './agentDetection'

/**
 * 設定の「CLI」の一覧に出す、よく使うサービスの CLI の検出（入っているか・版）。
 * 探し方は Agent の検出（agentDetection.ts）と同じ（ログインシェルの PATH ＋ よく使うインストール先）。
 * 版は見つかった実行ファイルを固定の引数（カタログの versionArg）で1回だけ走らせて読む。
 */

/** 版を読むのを待つ上限。gcloud・az は起動が遅い */
const VERSION_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 30_000

function toolDirs(id: CliToolId): string[] {
  return (CLI_TOOLS[id].homeBinDirs ?? []).map((dir) => join(homedir(), ...dir.split('/')))
}

function readVersion(path: string, arg: string, dirs: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // Windows の npm の .cmd はシェル経由でないと起動できない。引数はカタログの固定の文字列だけ
    const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)
    execFile(windowsScript ? `"${path}"` : path, [arg], {
      timeout: VERSION_TIMEOUT_MS,
      encoding: 'utf8',
      shell: windowsScript,
      windowsHide: true,
      // npm の CLI は node を PATH から探す（Finder から起動したときの短い PATH では見つからない）
      env: { ...process.env, PATH: dirs.join(delimiter) }
    }, (_error, stdout, stderr) => {
      // 終了コードが 0 でなくても版を出すものがある（読めなければ null）
      resolve(parseCliVersion(`${stdout ?? ''}\n${stderr ?? ''}`))
    })
  })
}

let cache: { at: number; result: CliToolStatus[] } | null = null

export async function listCliTools(refresh = false): Promise<CliToolStatus[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  const base = await searchDirs()
  const result = await Promise.all(CLI_TOOL_IDS.map(async (id): Promise<CliToolStatus> => {
    const dirs = [...base, ...toolDirs(id)]
    const commands = cliDetectCommands(id)
    const resolved = await resolveCommandsInDirs(commands, dirs)
    const path = commands.map((command) => resolved.get(command)).find((p): p is string => p !== undefined) ?? null
    if (!path) return { id, installed: false, version: null }
    return { id, installed: true, version: await readVersion(path, CLI_TOOLS[id].versionArg, dirs) }
  }))
  cache = { at: Date.now(), result }
  return result
}
