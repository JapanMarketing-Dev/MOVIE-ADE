import { STAR_REPO } from '@shared/starPrompt'
import { gh, type ExecResult } from './gh'

/**
 * gh で「star 済みか」を調べ、star する。
 *
 * Orca由来: ~/bench/orca/src/main/github/client/fetch/orca-star.ts の checkOrcaStarred / starOrca（MIT, Copyright 2026 Lovecast Inc.）
 * 認証は利用者の gh に任せる（トークンは読まない）。star するのは利用者が押したときだけ。
 */

type GhRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>

const STAR_PATH = `user/starred/${STAR_REPO.owner}/${STAR_REPO.repo}`
/** 画面に見える処理ではないので、遅い答えは待たずにブラウザの案内へ回す */
const STAR_GH_TIMEOUT_MS = 15_000

let inFlight: Promise<boolean | null> | null = null

/**
 * star 済みなら true、まだなら false、分からない（gh が無い・未ログイン・通信できない）なら null。
 * 同時に何か所から聞かれても gh は1つだけ走らせる。
 */
export function checkStarred(run: GhRunner = gh): Promise<boolean | null> {
  inFlight ??= runCheck(run).finally(() => { inFlight = null })
  return inFlight
}

async function runCheck(run: GhRunner): Promise<boolean | null> {
  const result = await run(['api', '--include', STAR_PATH], { timeoutMs: STAR_GH_TIMEOUT_MS })
  const text = `${result.stdout}\n${result.stderr}`
  if (!result.failed && /HTTP\/\S+\s+(?:200|204)\b/.test(text)) return true
  // 404 だけが「まだ star していない」の答え
  if (result.failed && /HTTP 404|HTTP\/\S+\s+404\b/.test(text)) return false
  return null
}

/** star する。できたら true */
export async function starRepo(run: GhRunner = gh): Promise<boolean> {
  const result = await run(['api', '-X', 'PUT', STAR_PATH], { timeoutMs: STAR_GH_TIMEOUT_MS })
  return !result.failed
}
