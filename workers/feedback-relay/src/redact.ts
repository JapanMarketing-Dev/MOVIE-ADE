/**
 * 公開の Issue になる前に、本文と題名から秘密や個人を特定しうるものを伏せ字にする。
 * 送る人が気づかずに貼った鍵・トークン・メール・ホームのパス（ユーザー名を含む）を対象にする。
 * 完全ではないので、アプリの側でも送る前に本文を見せて確かめてもらう。
 */

type Rule = { name: string; pattern: RegExp; replace: string | ((match: string, ...groups: string[]) => string) }

const RULES: Rule[] = [
  // 秘密鍵のブロック（PEM）
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, replace: '[REDACTED private key]' },
  // 各サービスのトークンの形
  { name: 'github', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: '[REDACTED token]' },
  { name: 'anthropic-openai', pattern: /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, replace: '[REDACTED token]' },
  { name: 'stripe', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: '[REDACTED token]' },
  { name: 'aws-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: '[REDACTED token]' },
  { name: 'google', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replace: '[REDACTED token]' },
  { name: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED token]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '[REDACTED token]' },
  { name: 'bearer', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: (_m, kind) => `${kind} [REDACTED]` },
  // URL に入った資格情報（https://user:pass@host、Sentry の DSN など）
  { name: 'url-credentials', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, replace: (_m, scheme) => `${scheme}[REDACTED]@` },
  // key=value の形（api_key=..., "token": "...", password: ...）
  {
    name: 'assignment',
    pattern: /\b((?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|pwd)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`
  },
  // メール
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, replace: '[REDACTED email]' },
  // ホームのパスのユーザー名（/Users/name、/home/name、C:\Users\name、~name は残さない）
  { name: 'home-mac', pattern: /\/Users\/(?!Shared\b)[^/\s"'`]+/g, replace: '/Users/<user>' },
  { name: 'home-linux', pattern: /\/home\/[^/\s"'`]+/g, replace: '/home/<user>' },
  { name: 'home-windows', pattern: /\b([A-Za-z]:[\\/]+Users[\\/]+)(?!Public\b)[^\\/\s"'`]+/gi, replace: (_m, prefix) => `${prefix}<user>` }
]

/** 伏せ字にした文字列と、当たった規則の名前（ログには名前の数だけを出す。中身は出さない） */
export function redact(text: string): { text: string; hits: string[] } {
  let out = text
  const hits: string[] = []
  for (const rule of RULES) {
    const next = out.replace(rule.pattern, rule.replace as never)
    if (next !== out) hits.push(rule.name)
    out = next
  }
  return { text: out, hits }
}

/**
 * GitHub で通知や参照を起こさないようにする（題名と、本文の保険）。見た目はほぼ同じで、間に幅の無い空白を入れる。
 * 公開の Issue に、匿名の送り主が人を呼び出したり、ほかの Issue に印を付けたりできないようにするため。
 * GitHub の参照の書き方は多い（@name、#123、owner/repo#123、GH-123、owner/repo@sha、github.com の URL、&#46; などの文字参照）ので、
 * 前後の文字を問わず、印になる記号のすぐあとで崩す（security-4 [11]）。本文はさらに literalBlock でコードブロックに入れる
 */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/@(?=[A-Za-z0-9])/g, '@\u200b')
    .replace(/#(?=[0-9xX])/g, '#\u200b')
    .replace(/\b(GH)-(?=\d)/gi, '$1-\u200b')
    .replace(/github\.com/gi, (m) => `${m.slice(0, 6)}\u200b${m.slice(6)}`)
}

/**
 * 送られた本文を、そのままの文字として表示させる（security-4 [11]）。
 * GitHub は コードブロックの中では、メンション・Issue の参照・リンク・HTML・文字参照を読まない。
 * フェンスは本文の中のいちばん長いバッククォートの並びより長くするので、本文の中の ``` や ~~~ では閉じない
 */
export function literalBlock(text: string): string {
  return literalFenced(text)
}

/**
 * 1行の短い値（版・OS など）を、そのままの文字として表示させる（security-6 [5]）。
 * メンション・参照を崩してから、インラインのコード（`…`）に入れる。GitHub はコードの中では参照・リンクを作らない。
 * 改行は空白にし、区切りは値の中のいちばん長いバッククォートの並びより長くする（値の中の ` で閉じない）
 */
export function literalInline(value: string): string {
  const text = neutralizeMentions(value.replace(/[\r\n]+/g, ' '))
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const tick = '`'.repeat(longest + 1)
  // 先頭・末尾がバッククォートなら空白をはさむ（GitHub の書き方）
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${tick}${pad}${text}${pad}${tick}`
}

function literalFenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text.replace(/\n+$/, '')}\n${fence}`
}
