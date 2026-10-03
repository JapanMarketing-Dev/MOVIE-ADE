/** テスト用の固定入力。whisper と LLM を呼ばずにパイプラインを通せる最小の素材。 */
import type { Event, FrameRef, Material, SessionMeta, TranscriptSegment } from '../../src/main/pipeline/types'

export const meta: SessionMeta = {
  id: '20261002-104012',
  startedAt: '2026-10-02T10:40:12+09:00',
  durationMs: 60_000,
  targetUrl: 'http://localhost:3000/',
  twoSpeakers: false,
}

export const events: Event[] = [
  { t: 0, type: 'nav', url: 'http://localhost:3000/', title: 'トップ', viewport: 1280 },
  { t: 0, type: 'viewport', width: 1280 },
  { t: 12_400, type: 'click', x: 980, y: 28, el: { selector: 'a.nav-pricing', text: '料金' } },
  { t: 13_000, type: 'nav', url: 'http://localhost:3000/pricing', title: '料金', viewport: 1280 },
  {
    t: 18_200,
    type: 'pen',
    id: 'p3',
    t_end: 19_650,
    bbox: [590, 380, 180, 64],
    el: { selector: 'button.plan-cta', text: '申し込む' },
  },
  { t: 40_000, type: 'pen', id: 'p9', t_end: 41_000, bbox: [10, 10, 20, 20], el: { selector: 'div.footer' } },
]

export const frames: FrameRef[] = [
  { t: 0, path: 'work/0.png', cursor: { x: 640, y: 360 } },
  { t: 3_000, path: 'work/1.png', cursor: { x: 640, y: 360 } },
  { t: 13_200, path: 'work/2.png', cursor: { x: 980, y: 28 } },
  { t: 19_750, path: 'work/3.png', cursor: { x: 980, y: 28 } },
  { t: 25_400, path: 'work/4.png', cursor: { x: 980, y: 28 } },
  { t: 41_100, path: 'work/5.png', cursor: { x: 980, y: 28 } },
]

export const transcript: TranscriptSegment[] = [
  // 1件目: 2秒未満の間隔で続く2区間（1つのまとまりになる）
  { t0: 2_000, t1: 4_000, speaker: 'self', text: 'この見出しが小さいですね', source: 'mic' },
  { t0: 5_500, t1: 7_000, speaker: 'self', text: 'もう少し大きくしてください', source: 'mic' },
  // 2件目: 間隔が2秒以上あるので別のまとまり
  { t0: 18_000, t1: 21_000, speaker: 'self', text: 'このボタンの色が薄いです', source: 'mic' },
  // 3件目: 書き込みの無い発話
  { t0: 24_800, t1: 26_500, speaker: 'self', text: '表記がばらばらです', source: 'mic' },
]

export const material: Material = { meta, transcript, events, frames }
