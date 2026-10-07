import { deflateRawSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { parseClock, parseMeetingTranscript } from '@shared/meetingTranscript'
import { applyMeetingScores, meetingDecisionBody, meetingFrameTimes, meetingMediaExtension, meetingScoreFromAnswer, MEETING_SCORE_THRESHOLD } from '@shared/meetingImport'
import { checkDecisionRequest } from '../../src/main/decision/requestBound'
import { fromOpenAiDecisions, toOpenAiDecisions } from '../../src/main/decision/openaiDecisions'

// 取り込みの main の処理は Electron の非表示ウィンドウを使う（media.ts）。ここでは判定と .docx だけを確かめるので、作らない
vi.mock('electron', () => ({ BrowserWindow: class {}, nativeImage: {} }))
const record = { current: null as unknown }
vi.mock('../../src/main/sessions', () => ({
  loadSession: async () => record.current,
  createSession: async () => { throw new Error('not used') },
  ensureGitExclude: async () => undefined,
  frameFilePath: (_paths: unknown, path: string) => `/frames/${path}`
}))
const { docxPlainText, scoreMeetingReview } = await import('../../src/main/meeting/import')

describe('mtg の文字起こしを読む', () => {
  it('時刻の書き方を ms にする', () => {
    expect(parseClock('0:05')).toBe(5000)
    expect(parseClock('12:34')).toBe(754_000)
    expect(parseClock('1:02:03')).toBe(3_723_000)
    expect(parseClock('00:00:01.5')).toBe(1500)
    expect(parseClock('00:00:01,250')).toBe(1250)
    expect(parseClock('12:61')).toBeNull()
    expect(parseClock('abc')).toBeNull()
  })

  it('WebVTT（<v 名前> と Zoom の「名前: 本文」）', () => {
    const vtt = [
      'WEBVTT', '',
      '1', '00:00:01.000 --> 00:00:04.000', '<v Alice>The signup button is hard to see.</v>', '',
      '2', '00:00:05.000 --> 00:00:08.500', 'Bob: Let us make it blue.', ''
    ].join('\n')
    const parsed = parseMeetingTranscript(vtt, 'meeting.vtt')
    expect(parsed.format).toBe('vtt')
    expect(parsed.timed).toBe(true)
    expect(parsed.speakers).toEqual(['Alice', 'Bob'])
    expect(parsed.utterances).toEqual([
      { t: 1000, t1: 4000, speaker: 'Alice', text: 'The signup button is hard to see.' },
      { t: 5000, t1: 8500, speaker: 'Bob', text: 'Let us make it blue.' }
    ])
  })

  it('SRT（番号の行は本文にしない）', () => {
    const srt = '1\n00:00:02,000 --> 00:00:03,000\n料金ページの文字が小さい\n\n2\n00:00:04,000 --> 00:00:06,000\n見出しを大きくしてほしい\n'
    const parsed = parseMeetingTranscript(srt, 'a.srt')
    expect(parsed.format).toBe('srt')
    expect(parsed.utterances.map((u) => [u.t, u.text])).toEqual([[2000, '料金ページの文字が小さい'], [4000, '見出しを大きくしてほしい']])
  })

  it('Google Meet・Gemini の形（時刻の行のあとに「名前: 本文」が続く）', () => {
    const meet = 'Transcript\n00:00:00\n\n佐藤: ヘッダーのロゴが小さいです\n田中: 了解です\n00:05:00\n佐藤: フッターのリンクが切れています\n田中: 直します\n'
    const parsed = parseMeetingTranscript(meet)
    expect(parsed.timed).toBe(true)
    expect(parsed.speakers).toEqual(['佐藤', '田中'])
    const footer = parsed.utterances.find((u) => u.text.includes('フッター'))!
    expect(footer.t).toBe(300_000)
    // 時刻の無い行は前後から割り振り、順番どおりに増える
    const times = parsed.utterances.map((u) => u.t)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(parsed.utterances.find((u) => u.text === 'ヘッダーのロゴが小さいです')!.t).toBe(0)
  })

  it('「[時刻] 名前: 本文」「名前 (時刻): 本文」', () => {
    const lines = '[00:00:12] Alice: The modal closes too early\n[00:01:02] Bob: Agreed\nCarol (00:02:00): Also the toast overlaps\n'
    const parsed = parseMeetingTranscript(lines)
    expect(parsed.utterances.map((u) => [u.t, u.speaker, u.text])).toEqual([
      [12_000, 'Alice', 'The modal closes too early'], [62_000, 'Bob', 'Agreed'], [120_000, 'Carol', 'Also the toast overlaps']
    ])
  })

  it('Circleback・Otter の形（「名前  0:05」の行のあとに本文）', () => {
    const text = 'Alice  0:05\nThe chart colors are confusing.\nCan we use the brand palette?\n\nBob  0:20\nSure.\n'
    const parsed = parseMeetingTranscript(text)
    expect(parsed.format).toBe('speaker-time')
    expect(parsed.utterances[0]).toMatchObject({ t: 5000, speaker: 'Alice', text: 'The chart colors are confusing.' })
    expect(parsed.utterances[1]).toMatchObject({ speaker: 'Alice', text: 'Can we use the brand palette?' })
    expect(parsed.utterances[2]).toMatchObject({ t: 20_000, speaker: 'Bob', text: 'Sure.' })
  })

  it('時刻の無い「名前: 本文」は、文の長さから時刻を見積もる', () => {
    const parsed = parseMeetingTranscript('Alice: one\nBob: two\nAlice: three\n')
    expect(parsed.format).toBe('speaker')
    expect(parsed.timed).toBe(false)
    expect(parsed.utterances.map((u) => u.speaker)).toEqual(['Alice', 'Bob', 'Alice'])
    expect(parsed.utterances[1]!.t).toBeGreaterThan(parsed.utterances[0]!.t)
  })

  it('1回だけの「注意: 」は話者にしない。名前も時刻も無い文は段落ごと', () => {
    const notes = '注意: この画面は社内向けです。\n\nボタンの色を変えたい。\n\n次回までに文言を決める。'
    const parsed = parseMeetingTranscript(notes)
    expect(parsed.speakers).toEqual([])
    expect(parsed.utterances.map((u) => u.text)).toEqual(['注意: この画面は社内向けです。', 'ボタンの色を変えたい。', '次回までに文言を決める。'])
  })

  it('URL や文は話者の名前にしない', () => {
    const parsed = parseMeetingTranscript('https: //example.com を開く\nhttps: //example.com を閉じる\n')
    expect(parsed.speakers).toEqual([])
  })
})

describe('判定の依頼と答え', () => {
  const subject = { title: 'Make the signup button blue', request: 'Change the signup button color to blue.', quotes: [{ name: 'Alice', text: 'The signup button is hard to see.' }] }

  it('中継が受け付ける System One の形（画像なし・あり）', () => {
    for (const image of [undefined, 'aGVsbG8=']) {
      const body = meetingDecisionBody('clef-flash', subject, image)
      const check = checkDecisionRequest(Buffer.from(JSON.stringify(body)), 'clef-flash')
      expect(check.ok, JSON.stringify(check)).toBe(true)
      expect(Object.keys(body.questions as object)).toEqual(image ? ['request', 'screen'] : ['request'])
    }
    expect(String(meetingDecisionBody('m', subject).state)).toContain('Alice: The signup button is hard to see.')
  })

  it('OpenAI の Decisions API へも写せる（中継が写す）', () => {
    const converted = toOpenAiDecisions(meetingDecisionBody('gpt-6-luna', subject, 'iVBORw0KGgo='), 'gpt-6-luna')
    expect(converted.ok).toBe(true)
    if (!converted.ok) return
    const back = fromOpenAiDecisions({ answers: [{ type: 'predicate', name: 'request', probability: 0.83 }, { type: 'predicate', name: 'screen', probability: 0.4 }] }, converted.names)
    expect(meetingScoreFromAnswer(back)).toEqual({ request: 0.83, screen: 0.4 })
  })

  it('答えを読む（Cloudflare の { result } の包みも）。読めなければ null', () => {
    expect(meetingScoreFromAnswer({ answers: { request: { noul: 0.9 } } })).toEqual({ request: 0.9 })
    expect(meetingScoreFromAnswer({ result: { answers: { request: { noul: 0.2 }, screen: { noul: 0.7 } } }, success: true })).toEqual({ request: 0.2, screen: 0.7 })
    expect(meetingScoreFromAnswer({ answers: { request: { noul: 2 } } })).toBeNull()
    expect(meetingScoreFromAnswer(null)).toBeNull()
  })

  it('点を付け、編集前ならしきい値で送る対象を決める', () => {
    const items = [{ id: 'a', include: false }, { id: 'b', include: true }, { id: 'c', include: true }]
    const scores = new Map([['a', { request: 0.912 }], ['b', { request: 0.1 }]])
    const fresh = applyMeetingScores(items, scores, MEETING_SCORE_THRESHOLD, true)
    expect(fresh.items).toEqual([{ id: 'a', include: true, meetingScore: { request: 0.91 } }, { id: 'b', include: false, meetingScore: { request: 0.1 } }, { id: 'c', include: true }])
    expect(fresh.excluded).toBe(1)
    // 人が編集したあとは送る対象を変えない
    const edited = applyMeetingScores(items, scores, MEETING_SCORE_THRESHOLD, false)
    expect(edited.items.map((i) => i.include)).toEqual([false, true, true])
    expect(edited.excluded).toBe(0)
  })
})

describe('コマを撮る時刻', () => {
  it('近い発言はまとめ、動画の終わりを越えない', () => {
    expect(meetingFrameTimes([0, 2000, 20_000, 21_000, 90_000], 60_000)).toEqual([1000, 21_000, 59_800])
  })
  it('多すぎれば均等に間引く', () => {
    const times = meetingFrameTimes(Array.from({ length: 1000 }, (_, i) => i * 20_000), 30_000_000, 100)
    expect(times).toHaveLength(100)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
  it('拡張子', () => {
    expect(meetingMediaExtension('Meet.MP4')).toBe('mp4')
    expect(meetingMediaExtension('notes.txt')).toBeNull()
  })
})

/** テスト用の ZIP（無圧縮と deflate を交互に） */
function makeZip(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  Object.entries(files).forEach(([name, content], index) => {
    const data = Buffer.from(content)
    const method = index % 2 === 1 ? 8 : 0
    const stored = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    chunks.push(local, nameBytes, stored)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(stored.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + stored.length
  })
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cd, end]))
}

describe('.docx の文字起こし', () => {
  it('段落ごとの文にする（書き出した Meet の文字起こしがそのまま読める）', async () => {
    const xml = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>'
      + '<w:p><w:r><w:t>00:00:03</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Alice: </w:t></w:r><w:r><w:t>Fix the header</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Bob: OK</w:t></w:r></w:p></w:body></w:document>'
    const text = await docxPlainText(makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }))
    expect(text).toBe('00:00:03\nAlice: Fix the header\nBob: OK')
    expect(parseMeetingTranscript(text).utterances[0]).toMatchObject({ t: 3000, speaker: 'Alice', text: 'Fix the header' })
  })
})

describe('候補の判定（scoreMeetingReview）', () => {
  const paths = { id: '20261007-120000', dir: '/r' } as never
  const item = (id: string, title: string) => ({ id, title, request: title, quotes: [{ speaker: 'other', t: 0, text: title, name: 'Alice' }], frameTimes: [1000], include: false })

  it('判定を有効にしていなければ送らずに理由を返す', async () => {
    const save = vi.fn()
    const result = await scoreMeetingReview({ paths, session: null, encodeFrame: async () => null, save, onProgress: () => {} })
    expect(result.scored).toBe(0)
    expect(result.skipped).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it('1件ずつ問い、画像は設定の渡し方で付け、429 は待ってやり直す', async () => {
    record.current = { document: { items: [item('a', 'Make the button blue'), item('b', 'See you next week')] }, frames: [{ t: 1000, path: 'f.jpg' }] }
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    const session = {
      model: 'clef-flash', images: true, imageFormat: 'data-uri' as const, close: () => {},
      ask: async (body: Record<string, unknown>) => {
        bodies.push(body)
        calls++
        if (calls === 1) return { status: 429, json: null }
        return { status: 200, json: { answers: { request: { noul: String(body.state).includes('blue') ? 0.95 : 0.05 } } } }
      }
    }
    const saved: Array<[string, number]> = []
    const sleep = vi.fn(async () => {})
    const result = await scoreMeetingReview({ paths, session, encodeFrame: async () => 'QUJD', sleep, onProgress: () => {},
      save: async (scores) => { for (const [id, s] of scores) saved.push([id, s.request]); return { excluded: 1 } } })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ scored: 2, excluded: 1 })
    expect(saved).toEqual([['a', 0.95], ['b', 0.05]])
    expect(bodies[0]!.images).toEqual(['data:image/jpeg;base64,QUJD'])
  })

  it('続けて失敗したら（接続先・キーの誤り）残りを送らずに理由を返す', async () => {
    record.current = { document: { items: Array.from({ length: 10 }, (_, i) => item(`i${i}`, `t${i}`)) }, frames: [] }
    let calls = 0
    const session = { model: 'm', images: false, imageFormat: 'base64' as const, close: () => {}, ask: async () => { calls++; return { status: 401, json: {} } } }
    const result = await scoreMeetingReview({ paths, session, encodeFrame: async () => null, save: async () => ({ excluded: 0 }), onProgress: () => {} })
    expect(calls).toBe(3)
    expect(result.scored).toBe(0)
    expect(result.skipped).toContain('401')
  })
})
