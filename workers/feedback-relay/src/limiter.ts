/**
 * 頻度の上限と、同じ内容の連投の検出。Durable Object（1つの鍵に1つ）で数える。
 * KV は書き込みがすぐには全体に届かないので、上限を確実に守るために Durable Object を使う。
 *
 * 鍵は IP・インストール ID・本文をそのまま使わず、秘密の鍵の HMAC にしてから名前にする（limiterKey）。
 * 記録するのは時刻だけで、24時間を過ぎたものは消し、空になったらストレージごと消す（alarm）。
 */
import type { Env, LimiterState } from './env'

export type Window = { windowMs: number; max: number }
export type LimiterOp = 'hit' | 'peek' | 'record' | 'release'
export type LimiterResult = { allowed: boolean; retryAfterSec: number }

/** 記録を残す最長の期間（これより古い時刻は消す） */
export const KEEP_MS = 24 * 60 * 60 * 1000

/**
 * 時刻の並びに対して、上限を超えるかを決める（純粋関数）。
 * hit: 超えなければ数える（確かめると数えるが1回の呼び出しの中で起きるので、同時の要求でも枠を超えない。予約に使う）
 * peek: 数えずに確かめる / record: 確かめずに数える / release: hit で数えた1件（同じ now）を取り消す
 */
export function decide(times: number[], op: LimiterOp, windows: readonly Window[], now: number): { times: number[]; result: LimiterResult } {
  // now より後の時刻も残して数える。Worker の各インスタンスの時計はそろわず、同時の要求は時刻の順に届くとは限らない。
  // 後の時刻を落とすと、遅れて届いた要求に先の記録が見えず、同じ内容や上限を素通りする（security-3 [7]）
  const recent = times.filter((t) => t > now - KEEP_MS)
  if (op === 'release') {
    const at = recent.lastIndexOf(now)
    return { times: at < 0 ? recent : [...recent.slice(0, at), ...recent.slice(at + 1)], result: { allowed: true, retryAfterSec: 0 } }
  }
  let retryAfterMs = 0
  if (op !== 'record') {
    for (const w of windows) {
      const inWindow = recent.filter((t) => t > now - w.windowMs).sort((a, b) => a - b)
      if (inWindow.length >= w.max) {
        // いちばん古いものが窓から出るまで待つ
        retryAfterMs = Math.max(retryAfterMs, inWindow[inWindow.length - w.max] + w.windowMs - now)
      }
    }
  }
  const allowed = retryAfterMs === 0
  const next = (op === 'hit' && allowed) || op === 'record' ? [...recent, now] : recent
  return { times: next, result: { allowed, retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)) } }
}

/** Durable Object の本体。Worker からだけ fetch で呼ばれる */
export class FeedbackLimiter {
  constructor(private readonly state: LimiterState) {}

  async fetch(request: Request): Promise<Response> {
    const input = (await request.json()) as { op: LimiterOp; windows: Window[]; now: number }
    const times = (await this.state.storage.get<number[]>('times')) ?? []
    const { times: next, result } = decide(times, input.op, input.windows, input.now)
    if (next.length > 0) {
      await this.state.storage.put('times', next)
      await this.state.storage.setAlarm(Math.min(...next) + KEEP_MS)
    } else if (times.length > 0) {
      await this.state.storage.deleteAll()
    }
    return Response.json(result)
  }

  /** 24時間たった記録を消す。残りが無ければストレージごと消す */
  async alarm(): Promise<void> {
    const now = Date.now()
    const times = ((await this.state.storage.get<number[]>('times')) ?? []).filter((t) => t > now - KEEP_MS)
    if (times.length === 0) {
      await this.state.storage.deleteAll()
      return
    }
    await this.state.storage.put('times', times)
    await this.state.storage.setAlarm(Math.min(...times) + KEEP_MS)
  }
}

/** IP・インストール ID・内容から、秘密の鍵の HMAC-SHA256 で鍵の名前を作る（元の値は残さない） */
export async function limiterKey(salt: string, kind: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}\u0000${value}`))
  return `${kind}:${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Durable Object に1回問い合わせる */
export async function askLimiter(env: Env, name: string, op: LimiterOp, windows: readonly Window[], now: number): Promise<LimiterResult> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name))
  const res = await stub.fetch(
    new Request('https://limiter.internal/', { method: 'POST', body: JSON.stringify({ op, windows, now }), headers: { 'content-type': 'application/json' } })
  )
  if (!res.ok) throw new Error('limiter failed')
  return (await res.json()) as LimiterResult
}
