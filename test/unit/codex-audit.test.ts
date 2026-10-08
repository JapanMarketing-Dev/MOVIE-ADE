import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CODEX_AUDIT_FILE, CODEX_AUDIT_PRESET, codexAuditArgs, isTerminalPreset } from '../../src/shared/codexAudit'
import { BUILTIN_REQUESTS } from '../../src/shared/agentRequests'

describe('Codex のセキュリティ監査（全体のダッシュボードのボタン）', () => {
  it('Daybreak Blue・Extra high で開き、依頼文のファイルを読むよう短く頼む', () => {
    for (const lang of ['ja', 'en'] as const) {
      const args = codexAuditArgs(lang)
      expect(args.slice(0, 4)).toEqual(['-m', 'gpt-daybreak-blue-latest', '-c', 'model_reasoning_effort="xhigh"'])
      expect(args[4]).toContain(CODEX_AUDIT_FILE)
      expect(args).toHaveLength(5)
      // 権限・サンドボックスの引数は足さない（それは設定の skipPermissions と決まりだけが決める。security-5 [2]）
      for (const a of args.slice(0, 4)) expect(a).not.toMatch(/sandbox|yolo|bypass|approval|^-s$|^-a$|full-auto/)
    }
  })

  it('決まった名前だけを preset として受け取る', () => {
    expect(isTerminalPreset(CODEX_AUDIT_PRESET)).toBe(true)
    for (const v of ['codex', '', null, undefined, '-m evil', { preset: CODEX_AUDIT_PRESET }]) expect(isTerminalPreset(v)).toBe(false)
  })

  it('依頼文はアプリ・DB・インフラ・CI・秘密・依存を見て、直さず指摘だけ、クラウドと DB は読み取りだけ', () => {
    const text = BUILTIN_REQUESTS.find((b) => b.id === 'security-codex')!.text.en
    for (const word of ['every product', 'application', 'database', 'infrastructure', 'CI/CD', 'secrets', 'supply chain', 'findings only', 'read-only', 'attack path', '.ferret/security/', 'human.md']) expect(text).toContain(word)
  })

  it('起動の引数は main だけが作る（renderer の preset は名前だけ、登録したフォルダで Codex のときだけ）', () => {
    const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('const extraArgs = await terminalPresetArgs(options)')
    expect(main).toContain("if (!isTerminalPreset(options.preset)) return []")
    expect(main).toContain("if (options.agent !== 'codex') return []")
    expect(main).toContain('currentSettings().projects.some((p) => p.folderPath === folder)')
    const terminal = readFileSync(new URL('../../src/main/terminal.ts', import.meta.url), 'utf8')
    expect(terminal).toContain('launchLine = await trusted([...policy.argv, ...(internal.extraArgs ?? [])], label)')
  })
})

describe('Codex の監査はあらゆる基準と道具で調べる', () => {
  it('CIS Benchmarks・CIS Controls・OWASP・CWE・NIST・SLSA などの基準ごとに判定し、道具で検査し、報告に基準の番号を付ける', () => {
    for (const lang of ['en', 'ja'] as const) {
      const text = BUILTIN_REQUESTS.find((b) => b.id === 'security-codex')!.text[lang]
      for (const word of ['CIS Benchmarks', 'CIS Controls v8', 'OWASP Top 10', 'OWASP API Security Top 10', 'OWASP ASVS', 'OWASP MASVS', 'CWE Top 25', 'NIST CSF 2.0', 'SLSA', 'OpenSSF Scorecard', 'Prowler', 'kube-bench', 'Docker Bench', 'Trivy', 'Checkov', 'Semgrep', 'gitleaks', 'osv-scanner', 'testssl.sh', 'OWASP ZAP']) expect(text).toContain(word)
      expect(text.length).toBeLessThan(5500)
    }
    const en = BUILTIN_REQUESTS.find((b) => b.id === 'security-codex')!.text.en
    expect(en).toContain('localhost and development only')
    expect(en).toContain('pass and fail counts by CIS Benchmark item')
  })
})
