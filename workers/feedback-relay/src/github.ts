/**
 * GitHub の Issue の本文を組み立てて、REST API で作る。
 * トークンは Authorization ヘッダーにだけ入れ、ログ・応答・例外の文には出さない。
 */
import { FROM_APP_LABEL } from './limits'
import { literalBlock, literalInline, neutralizeMentions, redact } from './redact'

export type IssueInput = {
  kind: 'bug' | 'enhancement'
  title: string
  body: string
  appVersion: string
  platform?: string
  arch?: string
  osRelease?: string
  imageUrls: string[]
}

export const ISSUE_HEADING = '## Anonymous feedback from the Ferret app'

/**
 * 題名・本文を伏せ字にし、メンションを崩して、Issue の題名・本文・ラベルにする。
 * 本文は送り主が決める文字なので、コードブロックに入れて、そのままの文字として表示させる（参照・リンク・HTML にならない。security-4 [11]）。
 * 送り主が決める値（kind・appVersion・platform・osRelease・arch）は、本文の外の行にも生のまま埋め込まない。
 * すべて literalInline（メンションを崩してからコードの中へ）を通す（GH-123 のような版の値で参照を作らせない。security-6 [5]）
 */
export function buildIssue(input: IssueInput): { title: string; body: string; labels: string[] } {
  const title = neutralizeMentions(redact(input.title).text)
  const text = neutralizeMentions(redact(input.body).text)
  // 環境情報は送られたものだけを書く（利用者が外したら OS は not shared）
  const osParts = [input.platform, input.osRelease, input.arch ? `(${input.arch})` : ''].filter(Boolean).join(' ')
  const os = osParts ? literalInline(osParts) : 'not shared'
  const lines = [
    ISSUE_HEADING,
    '',
    '> This issue was sent anonymously from the in-app feedback form, through a relay that does not keep the sender\'s IP address.',
    '> Keys, tokens, email addresses and home-folder paths were masked automatically. Reply here; the sender may not see it.',
    '',
    `**Kind:** ${literalInline(input.kind)} · **App:** ${literalInline(input.appVersion)} · **OS:** ${os}`,
    '',
    '---',
    '',
    literalBlock(text)
  ]
  if (input.imageUrls.length > 0) {
    lines.push('', '### Screenshots', '', ...input.imageUrls.map((url, i) => `![screenshot ${i + 1}](${url})`))
  }
  return { title, body: `${lines.join('\n')}\n`, labels: [input.kind, FROM_APP_LABEL] }
}

/**
 * Issue を作った結果（security-4 [12]）。
 * created: 作った / not_created: GitHub が断った（4xx。作られていない）/ unknown: 送ったが作られたかが分からない
 * （通信が切れた・5xx・201 の応答が読めない）。GitHub の Issue の作成は冪等でないので、unknown を「作られていない」と扱わない
 */
export type CreateIssueResult = { status: 'created'; number: number; url: string } | { status: 'not_created' } | { status: 'unknown' }

/** Issue を作る。トークンは Authorization にだけ入れる */
export async function createIssue(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  issue: { title: string; body: string; labels: string[] }
): Promise<CreateIssueResult> {
  let res: Response
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'ferret-feedback-relay',
        'x-github-api-version': '2022-11-28'
      },
      body: JSON.stringify(issue)
    })
  } catch {
    // 要求が GitHub に届いたかどうかは分からない
    return { status: 'unknown' }
  }
  // 4xx は GitHub が受け付けなかった（検証・権限・頻度の上限）。作られていない
  if (res.status >= 400 && res.status < 500) return { status: 'not_created' }
  if (res.status !== 201) return { status: 'unknown' }
  try {
    const text = await res.text()
    if (text.length > 1024 * 1024) return { status: 'unknown' }
    const data = JSON.parse(text) as { number?: unknown; html_url?: unknown }
    if (typeof data.number !== 'number' || typeof data.html_url !== 'string' || !data.html_url.startsWith(`https://github.com/${repo}/issues/`)) return { status: 'unknown' }
    return { status: 'created', number: data.number, url: data.html_url }
  } catch {
    // 201（作った）のあとで応答が読めない
    return { status: 'unknown' }
  }
}
