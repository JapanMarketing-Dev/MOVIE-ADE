/**
 * mtg の文字起こし（Gemini・Google Meet・Circleback・Zoom などが書き出したもの、または貼り付けた文）を読む。
 *
 * ツールとは連携しない。書き出したファイルの文字か、貼り付けた文だけを受け取り、話者と時刻を拾えるだけ拾う。
 *   - WebVTT（Zoom・Meet の字幕。`<v 名前>` と「名前: 本文」の両方）・SRT
 *   - 時刻の行のあとに「名前: 本文」が続く形（Google Meet・Gemini の文字起こし。時刻の行は5分ごとなどまばら）
 *   - 「[00:12:34] 名前: 本文」「00:12:34 名前: 本文」「名前 (00:12:34): 本文」
 *   - 「名前  0:05」の行のあとに本文の行が続く形（Circleback・Otter など）
 *   - 「名前: 本文」だけ（時刻なし）
 *   - どれでもなければ段落ごと
 * 時刻の無い行は、前後の時刻から割り振る（全く無ければ文の長さから見積もる。timed: false）。
 *
 * main と renderer の両方が読む（画面は取り込む前に「何件・何人」を出す）。純粋な関数だけを置く。
 */

/** 読み取った発話1件。t・t1 は mtg の始まりからのミリ秒 */
export interface MeetingUtterance {
  t: number
  t1: number
  /** 話者の名前（分からなければ無し） */
  speaker?: string
  text: string
}

export type MeetingTranscriptFormat = 'vtt' | 'srt' | 'timestamped' | 'speaker-time' | 'speaker' | 'paragraphs'

export interface ParsedMeetingTranscript {
  format: MeetingTranscriptFormat
  utterances: MeetingUtterance[]
  /** 元の文に時刻があったか（無ければ時刻は見積もり。動画のコマは撮れない） */
  timed: boolean
  /** 話者の名前（出てきた順） */
  speakers: string[]
}

/** 読む文の上限（文字数）。1日分の mtg でも収まる */
export const MAX_TRANSCRIPT_CHARS = 2_000_000
/** 発話の数の上限 */
export const MAX_UTTERANCES = 20_000
/** 1件の本文の上限（文字数） */
const MAX_UTTERANCE_CHARS = 4000
/** 話者の名前の上限（文字数） */
const MAX_SPEAKER_CHARS = 40

/** 0:05・12:34・1:02:03・00:00:01.500・00:00:01,500 を ms に。読めなければ null */
export function parseClock(text: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(text.trim())
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const s = Number(m[3])
  if (min >= 60 && m[1] !== undefined) return null
  if (s >= 60) return null
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0
  return ((h * 60 + min) * 60 + s) * 1000 + ms
}

const CLOCK = String.raw`\d{1,3}:\d{1,2}(?::\d{2})?(?:[.,]\d{1,3})?`
const CUE = new RegExp(String.raw`^(${CLOCK})\s*-->\s*(${CLOCK})`)
/** [00:12:34] 本文 ・ (00:12:34) 本文 ・ 00:12:34 本文 */
const LEADING_TIME = new RegExp(String.raw`^[\[(]?(${CLOCK})[\])]?\s*[-–—|]?\s+(.+)$`)
/** 名前 (00:12:34): 本文 ・ 名前 [00:12:34] 本文 ・ 名前 00:12:34 - 本文 */
const NAME_TIME_TEXT = new RegExp(String.raw`^(.{1,${MAX_SPEAKER_CHARS}}?)\s*[\[(](${CLOCK})[\])]\s*[:：]?\s*(.+)$`)
/** 名前  0:05（行の終わりが時刻。本文は次の行から） */
const NAME_TIME_LINE = new RegExp(String.raw`^(.{1,${MAX_SPEAKER_CHARS}}?)\s+[\[(]?(${CLOCK})[\])]?$`)
const TIME_ONLY = new RegExp(String.raw`^[\[(]?(${CLOCK})[\])]?$`)
/** 名前: 本文（全角のコロンも） */
const NAME_TEXT = new RegExp(String.raw`^([^:：\n]{1,${MAX_SPEAKER_CHARS}})[:：]\s*(.+)$`)

/** 話者の名前として使えるか（URL・文の一部・数字だけは名前にしない） */
function plausibleName(name: string): boolean {
  const n = name.trim()
  if (!n || n.length > MAX_SPEAKER_CHARS) return false
  if (/https?|www\.|[<>{}=]|\/\//i.test(n)) return false
  if (/^[\d\s:.,-]+$/.test(n)) return false
  // 文（句点・疑問符を含む・語が多すぎる）は名前ではない
  if (/[。．!?！？]/.test(n)) return false
  if (n.split(/\s+/).length > 5) return false
  return true
}

/** 字幕のタグ（<c>・<i>・<00:00:01.000> など）を外す。外したあとにまたタグの形が残ることがあるので、変わらなくなるまで繰り返す */
function stripCueTags(text: string): string {
  let out = text
  let before: string
  do {
    before = out
    out = out.replace(/<[^<>]{1,80}>/g, '')
  } while (out !== before)
  return out
}

const cleanText = (text: string): string => stripCueTags(text).replace(/\s+/g, ' ').trim().slice(0, MAX_UTTERANCE_CHARS)
const cleanName = (name: string): string => name.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEAKER_CHARS)

interface RawLine { t: number | null; t1?: number; speaker?: string; text: string }

/** 字幕（VTT・SRT）の本文から話者を取る。`<v 名前>本文` か「名前: 本文」 */
function cueSpeaker(text: string): { speaker?: string; text: string } {
  const voice = /^<v(?:\.[^\s>]*)?\s+([^>]{1,80})>(.*)$/s.exec(text)
  if (voice && plausibleName(voice[1]!)) return { speaker: cleanName(voice[1]!), text: voice[2]! }
  const named = NAME_TEXT.exec(text)
  if (named && plausibleName(named[1]!)) return { speaker: cleanName(named[1]!), text: named[2]! }
  return { text }
}

function parseCues(lines: string[]): RawLine[] {
  const out: RawLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const cue = CUE.exec(lines[i]!.trim())
    if (!cue) continue
    const t = parseClock(cue[1]!)
    const t1 = parseClock(cue[2]!)
    const body: string[] = []
    for (i++; i < lines.length && lines[i]!.trim() !== ''; i++) body.push(lines[i]!.trim())
    const joined = body.join(' ')
    if (!joined) continue
    const { speaker, text } = cueSpeaker(joined)
    const cleaned = cleanText(text)
    if (cleaned) out.push({ t, ...(t1 !== null ? { t1 } : {}), ...(speaker ? { speaker } : {}), text: cleaned })
  }
  return out
}

/** 時刻の行・名前の行を前から順に読む（Meet・Gemini・Circleback・「[時刻] 名前: 本文」） */
function parseLines(lines: string[]): { lines: RawLine[]; kind: 'timestamped' | 'speaker-time' | 'speaker' } {
  const out: RawLine[] = []
  let clock: number | null = null
  let pendingSpeaker: { name: string; t: number | null } | null = null
  let kind: 'timestamped' | 'speaker-time' | 'speaker' = 'speaker'
  const push = (line: RawLine) => {
    const text = cleanText(line.text)
    if (text) out.push({ ...line, text, ...(line.speaker ? { speaker: cleanName(line.speaker) } : {}) })
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { pendingSpeaker = null; continue }
    const only = TIME_ONLY.exec(line)
    if (only) { clock = parseClock(only[1]!); kind = 'timestamped'; continue }
    const nameTime = NAME_TIME_TEXT.exec(line)
    if (nameTime && plausibleName(nameTime[1]!)) {
      clock = parseClock(nameTime[2]!)
      push({ t: clock, speaker: nameTime[1]!, text: nameTime[3]! })
      kind = 'timestamped'
      pendingSpeaker = null
      continue
    }
    const header = NAME_TIME_LINE.exec(line)
    if (header && plausibleName(header[1]!)) {
      clock = parseClock(header[2]!)
      pendingSpeaker = { name: header[1]!, t: clock }
      kind = 'speaker-time'
      continue
    }
    const lead = LEADING_TIME.exec(line)
    if (lead) {
      clock = parseClock(lead[1]!)
      const named = NAME_TEXT.exec(lead[2]!)
      if (named && plausibleName(named[1]!)) push({ t: clock, speaker: named[1]!, text: named[2]! })
      else push({ t: clock, text: lead[2]! })
      kind = 'timestamped'
      pendingSpeaker = null
      continue
    }
    if (pendingSpeaker) {
      push({ t: pendingSpeaker.t, speaker: pendingSpeaker.name, text: line })
      // 同じ話者の続きの行は時刻を持たない（前後から割り振る）
      pendingSpeaker = { name: pendingSpeaker.name, t: null }
      continue
    }
    const named = NAME_TEXT.exec(line)
    if (named && plausibleName(named[1]!)) {
      // 時刻の行の直後の1件だけに時刻を付ける（Meet の時刻の行は、その後の数件をまとめた目安）
      push({ t: clock, speaker: named[1]!, text: named[2]! })
      clock = null
      continue
    }
    push({ t: clock, text: line })
    clock = null
  }
  return { lines: out, kind }
}

/** 話者らしい名前が、本当に話者か（2回以上出てくる・全体の行の多くが「名前: 本文」） */
function confirmSpeakers(lines: RawLine[]): RawLine[] {
  const counts = new Map<string, number>()
  for (const line of lines) if (line.speaker) counts.set(line.speaker, (counts.get(line.speaker) ?? 0) + 1)
  const named = lines.filter((l) => l.speaker).length
  const mostlyNamed = named >= Math.max(2, lines.length * 0.5)
  return lines.map((line) => {
    if (!line.speaker || mostlyNamed || (counts.get(line.speaker) ?? 0) >= 2) return line
    // 1回だけ出てきた「名前: 」は、文の一部（「注意: …」など）として本文に戻す
    const { speaker, ...rest } = line
    return { ...rest, text: `${speaker}: ${line.text}` }
  })
}

/** 時刻の無い行に時刻を割り振る。前後の時刻の間を文の長さで分け、無ければ長さから見積もる */
function fillTimes(lines: RawLine[]): { utterances: MeetingUtterance[]; timed: boolean } {
  const timed = lines.some((l) => l.t !== null)
  // 1文字あたりの目安（話す速さ。日本語で1秒に約7文字）
  const estimate = (text: string) => Math.max(1500, Math.min(60_000, text.length * 140))
  const times: number[] = new Array<number>(lines.length)
  let i = 0
  let last = 0
  while (i < lines.length) {
    const known = lines[i]!.t
    if (known !== null) {
      times[i] = Math.max(last, known)
      last = times[i]!
      i++
      continue
    }
    // 次に時刻のある行までの区間を、文の長さの比で割り振る
    let j = i
    while (j < lines.length && lines[j]!.t === null) j++
    const start = i === 0 ? 0 : times[i - 1]! + estimate(lines[i - 1]!.text)
    const lengths = lines.slice(i, j).map((l) => estimate(l.text))
    const nextKnown = j < lines.length ? Math.max(start, lines[j]!.t!) : null
    const span = nextKnown !== null ? nextKnown - start : lengths.reduce((a, b) => a + b, 0)
    const total = lengths.reduce((a, b) => a + b, 0) || 1
    let at = Math.max(start, last)
    for (let k = i; k < j; k++) {
      times[k] = Math.round(at)
      at += (lengths[k - i]! / total) * span
    }
    last = times[j - 1]!
    i = j
  }
  const utterances = lines.map((line, k) => {
    const t = times[k]!
    const next = k + 1 < lines.length ? times[k + 1]! : t + estimate(line.text)
    const t1 = line.t1 !== undefined && line.t1 >= t ? line.t1 : Math.max(t + 500, Math.min(next, t + estimate(line.text)))
    return { t, t1, ...(line.speaker ? { speaker: line.speaker } : {}), text: line.text }
  })
  return { utterances, timed }
}

/** 段落（空行区切り）ごとに1件 */
function paragraphs(text: string): RawLine[] {
  return text.split(/\n\s*\n/).map((p) => ({ t: null, text: cleanText(p) })).filter((p) => p.text)
}

/**
 * 文字起こしを読む。fileName は形の手がかり（.vtt・.srt）。読めた発話が無ければ utterances は空
 */
export function parseMeetingTranscript(input: string, fileName = ''): ParsedMeetingTranscript {
  const text = input.slice(0, MAX_TRANSCRIPT_CHARS).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  let format: MeetingTranscriptFormat
  let raw: RawLine[]
  const cueCount = lines.reduce((n, line) => n + (CUE.test(line.trim()) ? 1 : 0), 0)
  if (cueCount > 0) {
    // 字幕。VTT と SRT は時刻の行の形が同じなので同じ読み方（番号の行は本文の前の空行で区切られて無視される）
    format = ext === 'vtt' || /^WEBVTT/.test(text.trimStart()) ? 'vtt' : 'srt'
    raw = parseCues(lines)
  } else {
    const parsed = parseLines(lines)
    raw = confirmSpeakers(parsed.lines)
    const named = raw.filter((l) => l.speaker).length
    const anyTime = raw.some((l) => l.t !== null)
    format = parsed.kind === 'speaker-time' ? 'speaker-time' : anyTime ? 'timestamped' : named > 0 ? 'speaker' : 'paragraphs'
    // 名前も時刻も無い文は、行ごとではなく段落ごとにする（貼り付けた議事メモ）
    if (format === 'paragraphs') raw = paragraphs(text)
  }
  raw = raw.slice(0, MAX_UTTERANCES)
  const { utterances, timed } = fillTimes(raw)
  const speakers: string[] = []
  for (const u of utterances) if (u.speaker && !speakers.includes(u.speaker)) speakers.push(u.speaker)
  return { format, utterances, timed, speakers }
}
