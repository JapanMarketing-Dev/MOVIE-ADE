import { spawn } from 'node:child_process'
import { parseGitStatusZ, type FsGitStatus } from '@shared/gitDecorations'
import { AUTOMATIC_GIT_CONFIG, gitSyncEnv, trustedGit } from './github/gitSync'

/**
 * ファイルツリーの git の色分け（fs:gitStatus）。変更・追跡外・削除・.gitignore の対象を、プロジェクトからの相対パスで返す。
 *
 * - git はフッターと同じく信頼できる絶対パスで起動する（trustedGit。プロジェクトの中・相対の PATH の項目は使わない）
 * - 引数は決まった配列だけ（renderer からは何も受け取らない）。`-C 根` と `-- .` でプロジェクトの中だけを見る
 * - fsmonitor を切る（リポジトリの設定のコマンドを裏で動かさない）。optional locks も切る（toolEnv の GIT_OPTIONAL_LOCKS=0）ので、
 *   ターミナルの git と index.lock を取り合わない
 * - 追跡外は `normal`（フォルダ単位）、無視は `matching`（無視されたフォルダの中を歩かない）。node_modules などを歩き回らない
 * - 出力・時間に上限を付ける。git が無い・リポジトリでないときは isGit: false（何も色を付けない）
 */

const STATUS_TIMEOUT_MS = 8_000
/** 読む出力の上限。超えたら止めて、出来上がった分だけ使う */
const MAX_STATUS_BYTES = 8 * 1024 * 1024
const BASE_ARGS = ['-c', 'core.quotePath=false', ...AUTOMATIC_GIT_CONFIG]

interface Run { stdout: string; ok: boolean; truncated: boolean }

function runGit(git: string, root: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(git, ['-C', root, ...BASE_ARGS, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: gitSyncEnv() })
    } catch {
      // 起動できない（実体が消えた）
      resolve({ stdout: '', ok: false, truncated: false })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), ok, truncated })
    }
    const timer = setTimeout(() => { child.kill(); finish(false) }, STATUS_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return
      if (size + chunk.length > MAX_STATUS_BYTES) {
        chunks.push(chunk.subarray(0, MAX_STATUS_BYTES - size))
        truncated = true
        child.kill()
        finish(true)
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

const NOT_GIT: FsGitStatus = { isGit: false, entries: [], truncated: false }

export async function readGitDecorations(root: string): Promise<FsGitStatus> {
  const git = await trustedGit(root)
  if (!git) return NOT_GIT
  const [prefix, status] = await Promise.all([
    runGit(git, root, ['rev-parse', '--show-prefix']),
    runGit(git, root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching', '--', '.'])
  ])
  // リポジトリでない（rev-parse が失敗する）・git が途中で止まった
  if (!prefix.ok || (!status.ok && !status.truncated)) return NOT_GIT
  return { isGit: true, entries: parseGitStatusZ(status.stdout, prefix.stdout.trim()), truncated: status.truncated }
}
