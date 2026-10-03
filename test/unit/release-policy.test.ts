import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * リリースの供給網のポリシー（セキュリティ報告 [1] [5]）。ファイルを読むだけで、何も動かさない。
 *   - GitHub Actions はコミットの SHA に固定する（タグは付け替えられる）。コメントに版を書く
 *   - @latest・版を固定しない npx を使わない
 *   - 外から来た値を扱うスクリプトで shell を使わない
 *   - secrets はジョブ全体ではなく、使うステップにだけ渡す。R2 のトークンを持つジョブはリポジトリへ書けない
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const workflowDir = '.github/workflows'
const workflows = readdirSync(join(root, workflowDir)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${workflowDir}/${f}`)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules') continue
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, out)
    else if (/\.(mjs|cjs|js|ts|sh)$/.test(name)) out.push(p)
  }
  return out
}
const scriptFiles = [...walk('scripts'), ...walk('tools')]

/** トップレベルの jobs: の下を、ジョブごとの行に分ける（インデント 2 のキーがジョブ名） */
function jobsOf(text: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>()
  let inJobs = false
  let current: string[] | null = null
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:')
      current = null
      continue
    }
    if (!inJobs) continue
    const m = /^ {2}([\w-]+):\s*$/.exec(line)
    if (m) {
      current = []
      jobs.set(m[1], current)
    } else if (current) current.push(line)
  }
  return jobs
}

/** ジョブの直下（インデント 4）のキーの中身の行 */
function block(lines: string[], key: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^ {4}${key}:`).test(l))
  if (start < 0) return []
  const out = [lines[start]]
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(l)) break
    out.push(l)
  }
  return out
}

describe('GitHub Actions の固定', () => {
  it.each(workflows)('%s の uses は 40 桁のコミット SHA と版のコメントで固定している', (file) => {
    const uses = read(file)
      .split('\n')
      .filter((l) => /^\s*(-\s+)?uses:/.test(l))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) {
      expect(line, line).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/)
    }
  })

  it.each(workflows)('%s に @latest・版の範囲の道具を使う箇所が無い', (file) => {
    const text = read(file)
    expect(text).not.toMatch(/@latest\b/)
    expect(text).not.toMatch(/\bnpx\b(?![^\n]*@\d+\.\d+\.\d+)/)
    // pnpm の版も固定する
    for (const m of text.matchAll(/^\s+version:\s*(\S+)\s*$/gm)) expect(m[1]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each(workflows)('%s は secrets をジョブ全体の env に置かない（使うステップにだけ渡す）', (file) => {
    const text = read(file)
    // トップレベルの env
    expect(text).not.toMatch(/^env:[\s\S]*?secrets\./m)
    for (const [name, lines] of jobsOf(text)) {
      expect(block(lines, 'env').join('\n'), `${file} の ${name}`).not.toMatch(/secrets\./)
    }
  })

  it('R2 のトークンを持つジョブはリポジトリへ書けず、OIDC も持たない。リポジトリへ書けるジョブは R2 のトークンを持たない', () => {
    const text = read(`${workflowDir}/release.yml`)
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m)
    const jobs = jobsOf(text)
    const withR2 = [...jobs].filter(([, lines]) => lines.some((l) => /secrets\.CLOUDFLARE_/.test(l)))
    expect(withR2.map(([n]) => n).sort()).toEqual(['promote', 'stage'])
    for (const [name, lines] of jobs) {
      const perms = block(lines, 'permissions').join('\n')
      const hasR2 = lines.some((l) => /secrets\.CLOUDFLARE_/.test(l))
      if (hasR2) {
        expect(perms, name).toMatch(/contents: read/)
        expect(perms, name).not.toMatch(/write/)
      }
      if (/write/.test(perms)) expect(hasR2, name).toBe(false)
    }
  })

  it('release は SHA256SUMS だけを R2 の外（GitHub Release）に出し、stage / promote はそれと突き合わせる', () => {
    const text = read(`${workflowDir}/release.yml`)
    expect(text).toMatch(/sha256sum Ferret-\* > \.\.\/SHA256SUMS/)
    // GitHub Release に付けるのは SHA256SUMS だけ（インストーラーは R2 だけ。attestation は入れない決定）
    expect(text).toMatch(/gh release create "\$\{GITHUB_REF_NAME\}" SHA256SUMS --repo/)
    expect(text).not.toMatch(/gh release (create|upload)[^\n]*\.(dmg|exe|AppImage|deb)/)
    expect(text).not.toMatch(/attest-build-provenance|id-token:/)
    const jobs = jobsOf(text)
    expect(jobs.get('stage')!.join('\n')).toMatch(/--expect-sums release-meta\/SHA256SUMS/)
    expect(jobs.get('promote')!.join('\n')).toMatch(/--expect-sums release-meta\/SHA256SUMS/)
    // workflow の入力や vars を run の中へ式で直接埋め込まない（env を通す）
    for (const [name, lines] of jobs) {
      const runs = lines.join('\n').split(/\n\s+(?=- |[\w-]+:)/).filter((b) => /^\s*run:/.test(b))
      for (const r of runs) expect(r, name).not.toMatch(/\$\{\{\s*(inputs|vars|github\.event)\./)
    }
  })
})

describe('スクリプトの外の道具の起動', () => {
  it.each(scriptFiles)('%s で shell を使って起動しない', (file) => {
    expect(read(file)).not.toMatch(/shell:\s*(true|process\.platform)/)
  })

  it.each(scriptFiles)('%s に @latest や版を固定しない npx の指定が無い', (file) => {
    const text = read(file)
    expect(text).not.toMatch(/['"`][\w@/.-]+@latest['"`]/)
    expect(text).not.toMatch(/spawnSync\(\s*['"]npx['"]/)
  })

  it('package.json のスクリプトは npx で版を固定しない道具を取らない', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).not.toMatch(/@latest\b/)
      expect(cmd, name).not.toMatch(/npx\s+(--yes\s+)?[\w@/.-]+@\d+(\.\d+)?(\s|$)/)
    }
  })

  it('wrangler は devDependencies で版を固定し、pnpm-lock.yaml に integrity がある', () => {
    const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }
    const version = pkg.devDependencies.wrangler
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    const lock = read('pnpm-lock.yaml')
    expect(lock).toMatch(new RegExp(`\\n {2}wrangler@${version.replace(/\./g, '\\.')}:\\n {4}resolution: \\{integrity: sha512-`))
  })

  it('release-r2.mjs は manifest の値をローカルのパスに使わず、R2 から読んだ JSON を確かめてから使う', () => {
    const text = read('scripts/release-r2.mjs')
    expect(text).not.toMatch(/join\(work,\s*f\.name\)/)
    expect(text).not.toMatch(/WRANGLER\s*=\s*process\.env/)
    expect(text).toMatch(/validateManifest\(/)
    expect(text).toMatch(/validateIndex\(/)
    // R2 の manifest・索引は getManifest / getIndex を通して読む（getJson を直接使うのは、その2つと「あるかどうか」だけ）
    const direct = [...text.matchAll(/getJson\(([^)]*)\)/g)].map((m) => m[1])
    expect(direct.sort()).toEqual(['`releases/${version}/manifest.json`', "'versions.json'", 'key', 'key'].sort())
  })

  it('検査の対象のファイルが実際にある（パスの書き間違いで素通りしない）', () => {
    expect(scriptFiles.map((f) => relative(root, join(root, f)))).toEqual(expect.arrayContaining(['scripts/release-r2.mjs', 'scripts/release-github.mjs', 'scripts/release-tools.mjs', 'scripts/sentry-sourcemaps.mjs', 'scripts/sentry-release.mjs', 'scripts/dev.mjs', 'scripts/install-app-deps.mjs']))
    expect(workflows).toEqual(expect.arrayContaining([`${workflowDir}/release.yml`, `${workflowDir}/cross-platform.yml`]))
  })
})
