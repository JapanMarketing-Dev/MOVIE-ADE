import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * リポジトリの直下に置いてよいファイル。試しに作った画像や要求の JSON（a.png・b.png・req.json）が
 * 公開リポジトリに残ったことがあるので、直下のファイルは決めたものだけにする。足すときはここにも足す。
 */
const ROOT_FILES = new Set([
  '.gitattributes', '.gitignore', '.gitleaks.toml', 'CONTRIBUTING.md', 'LICENSE', 'README.ja.md', 'README.md', 'SECURITY.md',
  'THIRD_PARTY_NOTICES.md', 'electron-builder.config.cjs', 'electron-builder.dev.cjs', 'electron.vite.config.ts', 'package.json',
  'playwright.config.ts', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.preload.json', 'tsconfig.test.json',
  'tsconfig.web.json', 'vitest.config.ts', 'wrangler.jsonc'
])

const root = resolve(__dirname, '../..')

/** 追跡中のファイル。git が無い複製（リリースの build）では、直下のファイルをそのまま見る */
function rootFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter((f) => f && !f.includes('/'))
  } catch {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.env') && e.name !== '.DS_Store').map((e) => e.name)
  }
}

describe('リポジトリの直下', () => {
  it('決めたファイルしか置かない（試しに作ったファイルを commit しない）', () => {
    expect(rootFiles().filter((f) => !ROOT_FILES.has(f) && !f.startsWith('.'))).toEqual([])
  })
})
