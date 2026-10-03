/**
 * GitHub の Issue の本文を組み立てて、REST API で作る。
 * トークンは Authorization ヘッダーにだけ入れ、ログ・応答・例外の文には出さない。
 */
import { FROM_APP_LABEL } from './limits'
import { neutralizeMentions, redact } from './redact'

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

/** 題名・本文を伏せ字にし、メンションを崩して、Issue の題名・本文・ラベルにする */
export function buildIssue(input: IssueInput): { title: string; body: string; labels: string[] } {
  const title = neutralizeMentions(redact(input.title).text)
  const text = neutralizeMentions(redact(input.body).text)
  // 環境情報は送られたものだけを書く（利用者が外したら OS は not shared）
  const os = [input.platform, input.osRelease, input.arch ? `(${input.arch})` : ''].filter(Boolean).join(' ') || 'not shared'
  const lines = [
    ISSUE_HEADING,
    '',
    '> This issue was sent anonymously from the in-app feedback form, through a relay that does not keep the sender\'s IP address.',
    '> Keys, tokens, email addresses and home-folder paths were masked automatically. Reply here; the sender may not see it.',
    '',
    `**Kind:** ${input.kind} · **App:** ${input.appVersion} · **OS:** ${os}`,
    '',
    '---',
    '',
    text
  ]
  if (input.imageUrls.length > 0) {
    lines.push('', '### Screenshots', '', ...input.imageUrls.map((url, i) => `![screenshot ${i + 1}](${url})`))
  }
  return { title, body: `${lines.join('\n')}\n`, labels: [input.kind, FROM_APP_LABEL] }
}

/** Issue を作る。成功なら番号と URL、失敗なら null（理由は呼ぶ側で upstream_failed にする） */
export async function createIssue(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  issue: { title: string; body: string; labels: string[] }
): Promise<{ number: number; url: string } | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
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
  if (res.status !== 201) return null
  const text = await res.text()
  if (text.length > 1024 * 1024) return null
  const data = JSON.parse(text) as { number?: unknown; html_url?: unknown }
  if (typeof data.number !== 'number' || typeof data.html_url !== 'string' || !data.html_url.startsWith(`https://github.com/${repo}/issues/`)) return null
  return { number: data.number, url: data.html_url }
}
