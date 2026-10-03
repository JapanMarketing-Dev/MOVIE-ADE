/**
 * Mac で Windows のインストーラ（NSIS）を作る前に、パスの長さを確かめる。
 *
 *   node scripts/check-nsis-paths.mjs <electron-builder を動かすフォルダ>
 *
 * Mac の makensis は、読み込む electron-builder のテンプレート（node_modules/.pnpm/app-builder-lib@…/templates/nsis/…）
 * のパスが長いと、アンインストーラを作るところで何も出さずに落ちる（終了コード -1）。
 * 0.3.0 で、深い worktree（scratchpad の下）から流して起きた。この Mac で、テンプレートの一番長いパスが
 * 228 文字なら通り、344 文字では落ちることを確かめた。Windows の MAX_PATH（260）を上限にして、超えたら作る前に止める。
 * scripts/build-release.sh は、NSIS を /tmp の下の短いフォルダの複製から作るので、普段はこの上限に当たらない。
 */
import { readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export const NSIS_PATH_LIMIT = 260

/** 一番長いパスが上限を超えていれば、理由の文を返す（純粋関数。test/unit で確かめる） */
export function nsisPathProblem(longestPath, limit = NSIS_PATH_LIMIT) {
  if (longestPath.length <= limit) return null
  return `NSIS のテンプレートのパスが ${longestPath.length} 文字で、上限 ${limit} 文字を超えています（${longestPath}）。` +
    'Mac の makensis はアンインストーラを作るところで落ちます。短いパスのフォルダ（/tmp の下など）から作ってください'
}

/** フォルダの下の一番長いファイルのパス */
export function longestFilePath(dir) {
  let longest = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const candidate = entry.isDirectory() ? longestFilePath(path) : path
    if (candidate.length > longest.length) longest = candidate
  }
  return longest
}

/** projectDir の electron-builder が使う NSIS のテンプレートのフォルダ（実際のパス） */
export function nsisTemplatesDir(projectDir) {
  const require = createRequire(join(resolve(projectDir), 'package.json'))
  const builder = require.resolve('electron-builder')
  const lib = require.resolve('app-builder-lib/package.json', { paths: [builder] })
  return join(realpathSync(dirname(lib)), 'templates', 'nsis')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const projectDir = process.argv[2] ?? process.cwd()
  const problem = nsisPathProblem(longestFilePath(nsisTemplatesDir(projectDir)))
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
}
