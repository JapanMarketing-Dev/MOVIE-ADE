#!/usr/bin/env node
/**
 * 配布物の app.asar に、入れてよいものだけが入っているかを確かめる（scripts/build-release.sh が OS ごとに呼ぶ）。
 *
 *   node scripts/check-app-asar.mjs <app.asar> [<app.asar> ...]
 *
 * - 一番上にあってよいのは out/・package.json・node_modules/ だけ（electron-builder.config.cjs の APP_FILES）
 * - ソースマップ（.map）・.env・Agent の作業ツリー（.claude/）・レビューの記録（.ade-movie/ .ferret/）が無い
 * - 大きさが上限（MAX_BYTES）以下
 *
 * 0.4.6 の公開前に、Windows 版の files に除外だけを書いていたため APP_FILES が効かず、作業フォルダが丸ごと入った
 * （Agent の作業ツリー・手元のレビューの記録を含む 475 MB）。公開する前に、ここで必ず止める。
 */
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'

// @electron/asar は直接の依存ではない（electron-builder → app-builder-lib が持つ）。同じものをたどって読む
const fromBuilder = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json'))
const fromLib = createRequire(fromBuilder.resolve('app-builder-lib/package.json'))
const asar = fromLib('@electron/asar')

export const ALLOWED_TOP = new Set(['out', 'package.json', 'node_modules'])
/** いまの app.asar は 64 MB ほど。倍を超えたら何かが入り込んでいる */
export const MAX_BYTES = 160 * 1024 * 1024
const FORBIDDEN = [/\.map$/, /(^|\/)\.env(\.|$)/, /^\.claude\//, /^\.ade-movie\//, /^\.ferret\//, /(^|\/)e2e-artifacts\//]

/** asar の目録（header）から、ファイルの相対パスを全部取り出す */
export function listFiles(header, prefix = '') {
  const out = []
  for (const [name, node] of Object.entries(header.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (node.files) out.push(...listFiles(node, path))
    else out.push(path)
  }
  return out
}

/** 問題の一覧（空なら通る） */
export function asarProblems(header, size) {
  const problems = []
  for (const top of Object.keys(header.files ?? {})) {
    if (!ALLOWED_TOP.has(top)) problems.push(`入れてはいけないものが一番上にあります: ${top}`)
  }
  const files = listFiles(header)
  for (const pattern of FORBIDDEN) {
    const hits = files.filter((f) => pattern.test(f))
    if (hits.length) problems.push(`${pattern} に当たるものが ${hits.length} 件あります（例: ${hits.slice(0, 3).join(', ')}）`)
  }
  if (size > MAX_BYTES) problems.push(`大きすぎます: ${(size / 1048576).toFixed(1)} MiB（上限 ${MAX_BYTES / 1048576} MiB）`)
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    console.error('使い方: node scripts/check-app-asar.mjs <app.asar> [...]')
    process.exit(2)
  }
  let failed = false
  for (const path of paths) {
    const problems = asarProblems(asar.getRawHeader(path).header, statSync(path).size)
    if (problems.length) {
      failed = true
      console.error(`NG ${path}`)
      for (const p of problems) console.error(`  - ${p}`)
    } else {
      console.log(`OK ${path}`)
    }
  }
  process.exit(failed ? 1 : 0)
}
