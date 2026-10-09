/**
 * 共有の Worker の相手向けの API（同じオリジン）。パスワードのある共有のセッションは HttpOnly の cookie で、ここでは触れない。
 */
import type { ShareErrorCode, ShareEventsFile, ShareNote, SharePublicView, ShareRecordingStart } from '../../../src/shared/feedbackShare'

export class ApiError extends Error {
  constructor(readonly code: ShareErrorCode | 'network') {
    super(code)
  }
}

export const shareId: string = (location.pathname.match(/^\/s\/([0-9a-f]{32})\/?$/) ?? [])[1] ?? ''

const base = () => `/v1/public/${shareId}`

async function call<T extends Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base()}${path}`, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError('network')
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || body.ok !== true) throw new ApiError(typeof body.code === 'string' ? (body.code as ShareErrorCode) : 'internal')
  return body as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export async function loadShare(): Promise<SharePublicView> {
  return (await call<{ share: SharePublicView }>('')).share
}

export async function unlockShare(proof: string): Promise<void> {
  await call('/unlock', jsonInit('POST', { proof }))
}

export const mediaUrl = (recId: string) => `${base()}/recordings/${recId}/media`
export const thumbUrl = (recId: string) => `${base()}/recordings/${recId}/thumb.jpg`

/**
 * 録画を送る。始める → 分けて送る（順に、失敗したら2回まで送り直す）→ 送り終える。
 * honeypot（website）に何か入っていれば Worker は受けたふりをするだけ（decoy）
 */
export async function sendRecording(input: {
  start: ShareRecordingStart & { website?: string }
  blob: Blob | null
  notes: ShareNote[]
  events?: ShareEventsFile
  thumbnail?: string
  onProgress: (fraction: number) => void
}): Promise<void> {
  const started = await call<{ id: string; parts: number; partBytes: number; decoy?: boolean }>('/recordings', jsonInit('POST', input.start))
  if (started.decoy) return
  const id = started.id
  try {
    for (let n = 1; n <= started.parts; n++) {
      const chunk = input.blob!.slice((n - 1) * started.partBytes, n * started.partBytes)
      for (let attempt = 0; ; attempt++) {
        try {
          await call(`/recordings/${id}/parts/${n}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: chunk })
          break
        } catch (err) {
          if (attempt >= 2 || (err instanceof ApiError && err.code !== 'network' && err.code !== 'internal')) throw err
          await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)))
        }
      }
      input.onProgress(n / Math.max(1, started.parts))
    }
    await call(`/recordings/${id}/complete`, jsonInit('POST', { notes: input.notes, ...(input.events ? { events: input.events } : {}), ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}) }))
    input.onProgress(1)
  } catch (err) {
    await call(`/recordings/${id}/abort`, { method: 'POST' }).catch(() => undefined)
    throw err
  }
}
