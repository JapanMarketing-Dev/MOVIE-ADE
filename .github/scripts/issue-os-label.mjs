// Orca由来: .github/workflows/issue-os-labeler.yaml（MIT, Copyright 2026 Lovecast Inc.）
// Issue の本文の「### Environment」の「- OS: macOS 26.0 (arm64)」から OS のラベルを付ける。
// 本文の形は .github/ISSUE_TEMPLATE/bug_report.yml の placeholder と、アプリ内の「フィードバックを送る」が作る本文
// （src/shared/feedback.ts の formatEnvironment）で同じ。本文は読むだけで、実行も式への埋め込みもしない。

export const OS_LABELS = Object.freeze({ macos: 'os:macos', windows: 'os:windows', linux: 'os:linux' })

const ALIASES = [
  [/^(macos|mac|osx|darwin)$/, 'macos'],
  [/^(windows|win|win32|win10|win11)$/, 'windows'],
  [/^(linux|ubuntu|debian|fedora|arch|manjaro|mint|pop|opensuse|nixos|kali)$/, 'linux']
]

/** 本文から付けるラベル。読み取れなければ null（推測では付けない） */
export function osLabelFor(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^###\s+Environment\s*$/i.test(l))
  if (start < 0) return null
  const section = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break
    section.push(line)
  }
  for (const line of section) {
    const m = /^\s*(?:[-*]\s*)?OS\s*:\s*([A-Za-z][A-Za-z0-9]*)/i.exec(line)
    if (!m) continue
    const name = m[1].toLowerCase()
    for (const [re, key] of ALIASES) if (re.test(name)) return OS_LABELS[key]
    return null
  }
  return null
}

/** actions/github-script から呼ぶ。読み取れたときだけ、ほかの OS のラベルを外して1つにする */
export async function applyOsLabel({ github, context, core }) {
  const issue = context.payload.issue
  const desired = osLabelFor(issue?.body)
  if (!desired) {
    core.info('No operating system found in the Environment section. Skipping.')
    return
  }
  const managed = Object.values(OS_LABELS)
  const current = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
  for (const label of current.filter((l) => managed.includes(l) && l !== desired)) {
    try {
      await github.rest.issues.removeLabel({ ...context.repo, issue_number: issue.number, name: label })
    } catch (error) {
      // 同時に誰かが外した
      if (error?.status !== 404) throw error
    }
  }
  if (!current.includes(desired)) {
    await github.rest.issues.addLabels({ ...context.repo, issue_number: issue.number, labels: [desired] })
  }
  core.info(`Labeled #${issue.number} with ${desired}.`)
}
