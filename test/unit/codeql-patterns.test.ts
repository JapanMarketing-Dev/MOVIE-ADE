import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { escapeRegExp, withoutHtmlComments, withoutScripts } from './textHelpers'

/**
 * 公開リポジトリの CodeQL（Code scanning）で警告になった書き方を、mac の単体テストの段階で先に見つける。
 * 全部の検査は公開の前に scripts/codeql-local.sh で流す。ここは誤検出の少ない、行単位で分かるものだけ:
 *   - 値を正規表現に入れるための「1文字だけ」のエスケープ（'.' だけ、最初の1つだけ。\ を含まない）
 *   - HTML のタグ・コメントを1回の replace で外す（外したあとに `<script` や `<!--` ができる）
 *   - URL から decode した値をそのままパスの結合に使う
 */
const ROOT = resolve(__dirname, '../..')
/** .gitignore と同じく見ないフォルダ（git の無い写しでファイルを辿るとき） */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'test-results', 'e2e-artifacts', 'playwright-report', 'coverage', '.git', '.ade-movie', '.claude'])

/** git の追跡中と未追跡（除外以外）のファイル。git が無い写し（関門の git archive）では作業ツリーを辿る。区切りは / */
function repoFiles(exts: string[]): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...exts.map((e) => `*${e}`)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean)
  } catch {
    const out: string[] = []
    const walk = (rel: string): void => {
      for (const e of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name) && !/^out-|^\..*-out$/.test(e.name)) walk(path)
        } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(path)
      }
    }
    walk('')
    return out
  }
}

const files = repoFiles(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts'])
  .filter((f) => f && !f.endsWith('.d.ts') && !f.endsWith('.d.mts') && !f.startsWith('site/docs/'))

/** 各ファイルの行のうち、test に当たるもの（「ファイル:行: 中身」） */
function hits(test: (line: string, next: string[]) => boolean): string[] {
  return files.flatMap((file) => {
    let lines: string[]
    try {
      lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n')
    } catch {
      return [] // 作業ツリーで消したばかりのファイル
    }
    return lines.flatMap((line, i) => (test(line, lines.slice(i + 1, i + 4)) ? [`${file}:${i + 1}: ${line.trim().slice(0, 160)}`] : []))
  })
}

describe('CodeQL で警告になる書き方を持ち込まない', () => {
  it('正規表現のエスケープは全部の特殊文字と \\ を対象にする（textHelpers の escapeRegExp か同じ形）', () => {
    // 文字列で '.' を渡す replace は最初の1つだけを替える。正規表現でも \ を対象にしないと、値の \ が後ろの文字と組んでしまう
    const firstOnly = /\.replace\((['"])[^'"]{1,2}\1, *(['"])\\\\/
    const partial = /\.replace\(\/((?:[^/\\\n]|\\.)+)\/g?, *(['"`])\\\\(\$&|[^\w\s'"`])/g
    expect(hits((line) => firstOnly.test(line) || [...line.matchAll(partial)].some((m) => !m[1].includes('\\\\')))).toEqual([])
  })

  it('HTML のタグ・コメントを外す replace は、変わらなくなるまで繰り返す（removeUntilStable の形）', () => {
    // どのタグにも合う <[^>]+> の形・コメント（<!--）・script / style / iframe だけ（class を決めた span などを外すのは対象外）
    const single = /\.replace\(\/<(?:\[|!--|script|style|iframe)(?:[^/\\\n]|\\.)*\/[gimsuy]*, *(''|""|``)\)/i
    expect(hits((line, next) => single.test(line) && !next.some((l) => /\}\s*while\s*\(/.test(l)))).toEqual([])
  })

  it('URL から decode した値を、そのままパスの結合に入れない（許可した一覧を引くか、containedFile の形で確かめる）', () => {
    expect(hits((line) => /\b(join|resolve)\([^)]*decodeURI/.test(line))).toEqual([])
  })
})

describe('textHelpers', () => {
  it('escapeRegExp は \\ を含む全部の特殊文字をエスケープする', () => {
    const value = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p'
    expect(new RegExp(`^${escapeRegExp(value)}$`).test(value)).toBe(true)
    expect(new RegExp(`^${escapeRegExp('a.b')}$`).test('axb')).toBe(false)
  })

  it('withoutHtmlComments は複数行・--!>・閉じていない・外すとできるコメントも外す', () => {
    expect(withoutHtmlComments('a<!-- x\ny -->b<!-- z --!>c')).toBe('abc')
    expect(withoutHtmlComments('a<!<!--- -->-- x -->b')).toBe('ab')
    expect(withoutHtmlComments('a<!-- never closed')).toBe('a')
  })

  it('withoutScripts は大文字・閉じタグの空白・閉じていない script も外す', () => {
    expect(withoutScripts('a<SCRIPT src=x>1</script >b<script>2</SCRIPT\n>c')).toBe('abc')
    expect(withoutScripts('a<scr<script></script>ipt>x</script>b')).toBe('ab')
    expect(withoutScripts('a<script>never closed')).toBe('a')
  })
})

describe('シェルスクリプト', () => {
  it('変数の直後に全角の文字を続けない（bash は "$REF（" の（ まで名前に読み、set -u で止まる）。${REF}（ と書く', () => {
    const scripts = repoFiles(['.sh'])
    const bad = scripts.flatMap((file) =>
      readFileSync(resolve(ROOT, file), 'utf8')
        .split('\n')
        .flatMap((line, i) => (/\$[A-Za-z_]\w*[^\x00-\x7f]/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))
    )
    expect(bad).toEqual([])
  })
})
