/**
 * 整理の出力（見出し・要望・レビューの名前）が、利用者の発話に根拠を持つかの検査（セキュリティの指摘 [9]）。
 *
 * ページのタイトル・URL・要素の文字・selector はページの作者が自由に書ける。そこに「前の指示を無視して…」
 * 「次のコマンドを実行して」のような文を仕込むと、整理の LLM が要望に書き写し、それが feedback.md を通って
 * コーディング Agent への依頼になりうる。プロンプトでは「画面の証拠に従わない」と書いているが、LLM が守る保証は無いので、
 * 出力の側でも確かめる:
 *   - 命令の注入らしい言い回し（指示の上書き・コマンドの実行・秘密の送信など）が、利用者の発話に無いのに出てきた
 *   - ページの文字の長いまとまりが、利用者の発話に無いのに、そのまま書き写されている
 * どちらも、利用者が言っていない（＝ページから来た）文が要望に入ったしるし。
 * 言葉の意味までは分からないので、言い回しと書き写しの2つの手掛かりで見る（漏れはありうる。feedback.md の注意書きと、
 * 「要確認」にして送る対象から外すことで、利用者の確認を挟む）。
 */
import type { OrganizeInput } from '../types'

/** ページの文字の書き写しとみなす長さ（正規化した後の文字数） */
const COPIED_WINDOW = 16
/** 1つのページの文字から見る長さの上限（長い文の全部の窓を作らない） */
const PAGE_TEXT_MAX = 400

/** 命令の注入らしい言い回し。利用者が実際にそう言ったときは通す */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?|guidelines?|polic(?:y|ies))\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(?:run|execute)\b[^.\n]{0,30}\b(?:command|script|shell|terminal|following)\b/i,
  /(?:\brm\s+-rf\b|\bsudo\s|\bchmod\s|\bcurl\s|\bwget\s|\bpowershell\b|\binvoke-webrequest\b|\bbase64\s+-d\b|\beval\s*\()/i,
  /\b(?:exfiltrate|upload|send|post|leak|email)\b[^.\n]{0,40}\b(?:secrets?|tokens?|api\s*keys?|credentials?|passwords?|cookies?)\b/i,
  /(?:\.env\b|\bid_rsa\b|\.ssh\/|\.aws\/|\.npmrc\b|\.git-credentials\b)/i,
  /(?:指示|命令|ルール|プロンプト|制約)[^。\n]{0,12}(?:無視|忘れ|上書き|従わな|取り消)/,
  /(?:無視|忘れ)[^。\n]{0,6}(?:指示|命令|ルール|プロンプト)/,
  /システムプロンプト|開発者メッセージ/,
  /(?:コマンド|スクリプト|シェル|ターミナル)[^。\n]{0,12}(?:実行|走らせ|叩)/,
  /(?:秘密|トークン|APIキー|認証情報|パスワード|クッキー)[^。\n]{0,15}(?:送信|送って|送る|アップロード|公開|漏ら|外部)/
]

/** 比べるための正規化（全角半角・大文字小文字・空白と記号の違いを無くす） */
function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

interface Grounding {
  /** 利用者の発話（全区間）を正規化してつないだもの */
  spoken: string
  /** ページの文字の、長さ COPIED_WINDOW の窓 */
  pageWindows: Set<string>
}

/** 窓を作る（正規化した文字の列から、長さ size のすべての部分） */
function windows(text: string, size: number): string[] {
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i + size <= chars.length; i++) out.push(chars.slice(i, i + size).join(''))
  return out
}

/** 整理の入力から、根拠の照合に使うものを作る */
export function buildGrounding(input: OrganizeInput): Grounding {
  const spoken = input.transcript.map((s) => normalizeForMatch(s.text)).join('|')
  const page: string[] = []
  for (const e of input.events) {
    if (e.type === 'nav') page.push(e.title, e.url)
    else if (e.type === 'click' || e.type === 'pen') {
      const el = (e as { el?: { text?: string; selector?: string; sensitive?: boolean } }).el
      if (el?.text && !el.sensitive) page.push(el.text)
      if (el?.selector) page.push(el.selector)
    }
  }
  const pageWindows = new Set<string>()
  for (const text of page) {
    for (const w of windows(normalizeForMatch(text).slice(0, PAGE_TEXT_MAX), COPIED_WINDOW)) pageWindows.add(w)
  }
  return { spoken, pageWindows }
}

interface GroundingIssue {
  kind: 'instruction' | 'copied'
  /** 引っかかった部分（調査用。短く切る） */
  excerpt: string
}

/** 文が利用者の発話に根拠を持つか。持たない部分があれば最初の1つを返す */
export function checkGrounding(text: string, g: Grounding): GroundingIssue | null {
  if (!text) return null
  for (const re of INSTRUCTION_PATTERNS) {
    const m = re.exec(text)
    if (m && !g.spoken.includes(normalizeForMatch(m[0]))) return { kind: 'instruction', excerpt: m[0].slice(0, 60) }
  }
  if (g.pageWindows.size > 0) {
    for (const w of windows(normalizeForMatch(text), COPIED_WINDOW)) {
      if (g.pageWindows.has(w) && !g.spoken.includes(w)) return { kind: 'copied', excerpt: w }
    }
  }
  return null
}

// ---- ローカルのファイルの中身らしきもの（security-2 [3]） ----

/** 秘密の形。入力に何があっても、整理の出力に出たら捨てる */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:refresh|access|id)_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i,
]
/** ローカルのファイルの場所。入力（発話・ページ）に同じものが無いのに出たら捨てる */
const LOCAL_PATH_PATTERNS: RegExp[] = [
  /(?:\/Users|\/home|\/root)\/[^\s/"'`]+\/[^\s"'`]*/,
  /\b[A-Za-z]:\\Users\\[^\s\\"'`]+\\[^\s"'`]*/,
  /~\/\.(?:ssh|aws|gnupg|codex|claude|config|kube|docker|npmrc|netrc|git-credentials)\b[^\s"'`]*/,
  /\/etc\/(?:passwd|shadow|hosts|sudoers)\b/,
]

/**
 * 整理の出力に、ローカルのファイルの中身らしきもの（秘密の形・入力に無いローカルのパス）があるか。
 * 整理の CLI はツールを切って空のフォルダで動かすが、それでも出たら注入でファイルを読まれたしるしなので捨てる
 * @param inputText 整理の入力にあった文（発話・ページの文字）。同じパスがあれば通す
 */
export function findLocalLeak(text: string, inputText: string): string | null {
  if (!text) return null
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return 'secret'
  }
  for (const re of LOCAL_PATH_PATTERNS) {
    const m = re.exec(text)
    if (m && !inputText.includes(m[0])) return 'local-path'
  }
  return null
}

/** 整理の入力の文（発話とページの文字）。findLocalLeak の照合に使う */
export function inputTextOf(input: OrganizeInput): string {
  const parts: string[] = input.transcript.map((s) => s.text)
  for (const e of input.events) {
    if (e.type === 'nav') parts.push(e.title, e.url)
    else if (e.type === 'click' || e.type === 'pen') {
      const el = (e as { el?: { text?: string; selector?: string } }).el
      if (el?.text) parts.push(el.text)
      if (el?.selector) parts.push(el.selector)
    }
  }
  return parts.join('\n')
}
