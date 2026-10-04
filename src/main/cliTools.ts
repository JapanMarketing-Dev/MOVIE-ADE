import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  CLI_TOOL_IDS,
  CLI_TOOLS,
  cliDetectCommands,
  cliToolSupported,
  cliVersionArgs,
  parseCliVersion,
  type CliToolId,
  type CliToolStatus
} from '@shared/cliTools'
import { resolveCommandsInDirs, searchDirs } from './agentDetection'
import { resolveTrustedExecutable } from './agentExecutable'

/**
 * 設定の「よく使うサービスの CLI」の一覧に出す CLI の検出（入っているか・版）。
 * 探し方は Agent の検出（agentDetection.ts）と同じ（ログインシェルの PATH ＋ よく使うインストール先）で、
 * 絶対パスのフォルダだけから探し、見つかったものは信頼できる実行ファイルの決まり（agentExecutable.ts）で確かめる。
 * 版は確かめた絶対パスをカタログの固定の引数（versionArg）で1回だけ走らせて読む（シェルを通さない。Windows の .cmd を除く）。
 * 一覧を開いたときだけ呼ばれる（起動時には走らない）。同時に走らせる版の読み取りは VERSION_CONCURRENCY まで。
 */

/** 版を読むのを待つ上限。gcloud・az は起動が遅い */
const VERSION_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 30_000
/** 同時に走らせる版の読み取り（CLI が増えても、プロセスを一度にたくさん起こさない） */
export const VERSION_CONCURRENCY = 4

function toolDirs(id: CliToolId): string[] {
  return (CLI_TOOLS[id].homeBinDirs ?? []).map((dir) => join(homedir(), ...dir.split('/')))
}

function readVersion(path: string, args: readonly string[], dirs: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // Windows の npm の .cmd はシェル経由でないと起動できない。引数はカタログの固定の文字列だけ
    const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)
    execFile(windowsScript ? `"${path}"` : path, [...args], {
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

/** items を最大 limit 個ずつ並べて処理する（順は items のまま） */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

let cache: { at: number; result: CliToolStatus[] } | null = null
let running: Promise<CliToolStatus[]> | null = null

async function detectAll(): Promise<CliToolStatus[]> {
  const home = homedir()
  // `.`・空・相対の PATH の項目は今のフォルダを指すので使わない
  const base = (await searchDirs()).filter((dir) => isAbsolute(dir))
  const supported = CLI_TOOL_IDS.filter((id) => cliToolSupported(id, process.platform))
  // 共通のフォルダは全部の CLI でまとめて1回だけ一覧する
  const inBase = await resolveCommandsInDirs(supported.flatMap(cliDetectCommands), base)
  return mapWithLimit(CLI_TOOL_IDS, VERSION_CONCURRENCY, async (id): Promise<CliToolStatus> => {
    const missing: CliToolStatus = { id, installed: false, version: null }
    if (!supported.includes(id)) return missing
    const commands = cliDetectCommands(id)
    const extra = toolDirs(id)
    const dirs = [...base, ...extra]
    let path = commands.map((command) => inBase.get(command)).find((p): p is string => p !== undefined)
    if (!path && extra.length > 0) {
      const inExtra = await resolveCommandsInDirs(commands, extra)
      path = commands.map((command) => inExtra.get(command)).find((p): p is string => p !== undefined)
    }
    if (!path) return missing
    // 見つけた絶対パスを、Agent の起動と同じ決まりで確かめる（ホームで動かす扱い）
    const trusted = await resolveTrustedExecutable(path, { env: { ...process.env, PATH: dirs.join(delimiter) }, cwd: home, home, dirs })
    if (!trusted.ok) return missing
    const args = cliVersionArgs(id)
    return { id, installed: true, version: args ? await readVersion(trusted.path, args, dirs) : null }
  })
}

export async function listCliTools(refresh = false): Promise<CliToolStatus[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  // 検出中にもう一度呼ばれても（インストール待ちの再検出など）、同じ検出を待つ
  if (!running) {
    running = detectAll().then((result) => {
      cache = { at: Date.now(), result }
      return result
    }).finally(() => { running = null })
  }
  return running
}
