/**
 * Agent の PTY へプロンプトを送る（要件 OUT-2 / 設計7章 / 04_benchmark.md 3.3）。
 *
 * 送信の手順（先行例の実測に合わせる。順番を変えないこと）:
 *   ① 送れる状態かを確かめる。`blocked`（権限の確認待ち）なら送らず理由を返す
 *   ② 開始マーカー ＋ 整えた本文 ＋ 終了マーカー を**1回の write で**送る（Enter は付けない）
 *   ③ 50ms 待つ
 *   ④ 状態を**もう一度**確かめる（ここで失うと本文だけ残る）
 *   ⑤ Enter を**別の write で**送る
 *
 * `working`（処理中）は通す。Agent 側で順番待ちになるため。
 */
import { delay as wait } from '@shared/delay'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  PTY_WRITE_CHUNK_BYTES,
  SUBMIT
} from './protocol'
import type { AgentTerminal, AgentState } from './protocol'
import { fitsSingleWrite, sanitizePastePayload, splitForWrite } from './sanitize'
import { t, type MessageKey } from '@shared/i18n'

/** 送信をやめた理由 */
type SendFailure =
  /** 権限の確認待ち。答えてもらう必要がある */
  | 'permission'
  /** 入力欄の準備ができない（起動直後のまま） */
  | 'not-ready'
  /** 本文が空 */
  | 'empty'
  /** 本文は入れたが Enter の前に状態を失った。利用者が Enter を押せば送れる */
  | 'partial'
  /** PTY への書き込みが失敗した */
  | 'write-failed'

type SendResult =
  /** submitted: Enter まで送った。false なら貼り付けただけ（利用者が Enter を押す） */
  | { ok: true; bytes: number; writes: number; submitted: boolean }
  | { ok: false; failure: SendFailure; message: string; bodyWritten: boolean }

interface SendOptions {
  terminal: AgentTerminal
  /** 送る本文（1行の指示） */
  text: string
  /** いまの状態を返す。②の前と④で呼ばれる */
  getState: () => AgentState | Promise<AgentState>
  /** 本文のあと Enter までの待ち時間(ms) */
  submitDelayMs?: number
  /** テストで差し替える */
  sleep?: (ms: number) => Promise<void>
  /**
   * 貼り付けのあと Enter を送るか（既定は送る）。Enter で送信されると確かめていない Agent では false にし、
   * 貼り付けるだけにする（@shared/sendTarget の agentSubmitsPaste）
   */
  submit?: boolean
}

const DEFAULT_SUBMIT_DELAY_MS = 50

/**
 * 貼り付けから Enter までの待ち。長い本文ほど Agent が読み込むのに時間がかかり、早すぎる Enter は貼り付けの途中に
 * 届いて改行として入るか、途中までで送信される。Windows の ConPTY は特に遅い（Orca #16680。Orca の
 * getTerminalPasteIngestMs と同じ考え方: 1ms あたり macOS / Linux は 4KB、Windows は 64B）。上限は 3 秒
 */
export function submitDelayFor(bytes: number, platform: NodeJS.Platform = process.platform): number {
  const perMs = platform === 'win32' ? 64 : 4096
  return Math.min(3000, DEFAULT_SUBMIT_DELAY_MS + Math.floor(Math.max(0, bytes) / perMs))
}

const MESSAGE_KEYS = {
  permission: 'agent.send.permission',
  'not-ready': 'agent.send.notReady',
  empty: 'agent.send.empty',
  partial: 'agent.send.partial',
  'write-failed': 'agent.send.writeFailed'
} as const satisfies Record<SendFailure, MessageKey>

export async function sendToAgent(options: SendOptions): Promise<SendResult> {
  const { terminal, getState } = options
  const sleep = options.sleep ?? wait
  const payload = sanitizePastePayload(options.text).trim()
  if (payload.length === 0) return fail('empty', false)
  const delay = options.submitDelayMs ?? submitDelayFor(Buffer.byteLength(payload, 'utf8'))

  // ① 送れる状態か
  const before = await getState()
  if (before === 'blocked') return fail('permission', false)
  if (before === 'unknown') return fail('not-ready', false)

  // ② 本文を入れる（Enter は付けない）
  let writes = 0
  try {
    if (fitsSingleWrite(payload)) {
      await terminal.write(`${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`)
      writes += 1
    } else {
      writes += await writeLargePayload(terminal, payload)
    }
  } catch (e) {
    return fail('write-failed', false, e)
  }

  // Enter を送らない Agent は、貼り付けたところで終える（利用者が中身を見て Enter を押す）
  if (options.submit === false) return { ok: true, bytes: Buffer.byteLength(payload, 'utf8'), writes, submitted: false }

  // ③ 待つ
  await sleep(delay)

  // ④ もう一度確かめる
  const after = await getState()
  if (after === 'blocked') return fail('permission', true)
  if (after === 'unknown') return fail('partial', true)

  // ⑤ Enter は別の write で
  try {
    await terminal.write(SUBMIT)
    writes += 1
  } catch (e) {
    return fail('partial', true, e)
  }

  return { ok: true, bytes: Buffer.byteLength(payload, 'utf8'), writes, submitted: true }
}

/**
 * 64KiB を超える本文。開始マーカー → 本文のチャンク → 終了マーカー を個別に送る。
 * **途中で失敗しても終了マーカーは必ず流す**（枠を開いたままにしない）。
 */
async function writeLargePayload(terminal: AgentTerminal, payload: string): Promise<number> {
  let writes = 0
  await terminal.write(BRACKETED_PASTE_START)
  writes += 1
  try {
    for (const chunk of splitForWrite(payload, PTY_WRITE_CHUNK_BYTES)) {
      await terminal.write(chunk)
      writes += 1
      // abort / data のコールバックを間に走らせる。setTimeout(0) は 4ms にクランプされる
      await new Promise<void>((r) => setImmediate(r))
    }
  } finally {
    await terminal.write(BRACKETED_PASTE_END)
    writes += 1
  }
  return writes
}

function fail(failure: SendFailure, bodyWritten: boolean, cause?: unknown): SendResult {
  const detail = cause instanceof Error ? ` (${cause.message})` : ''
  return { ok: false, failure, message: `${t(MESSAGE_KEYS[failure])}${detail}`, bodyWritten }
}

/**
 * 「コピー」用の文（外部で動かしている Agent 向け。要件 OUT-3）。
 * 送信と同じ文面を返す。整形はしない（人が貼る先が分からないため）。
 */
export function copyText(prompt: string): string {
  return prompt
}
