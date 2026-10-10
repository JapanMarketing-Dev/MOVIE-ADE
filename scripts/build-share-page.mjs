#!/usr/bin/env node
/**
 * 共有リンクの相手の画面（workers/feedback-share/client）を1本の JS と CSS にまとめ、
 * workers/feedback-share/src/generated.ts に書く（Worker が /assets/share.js・/assets/share.css として配る）。
 *
 *   node scripts/build-share-page.mjs
 *
 * 外へは何も送らない（手元でまとめるだけ）。アプリの部品（FeedbackToolbar・書き込みの部品・tokens.css など）をそのまま使うので、
 * それらを変えたら作り直す。まとめた元のファイルの sha256 を generated.ts に残し、test/unit/share-page-build.test.ts が
 * 作り直し忘れを止める。
 * 画面は日本語と英語だけなので、アプリの i18n のほかの言語は空にする（英語へ落ちる）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENTRY = resolve(ROOT, 'workers/feedback-share/client/main.tsx')
const OUT = resolve(ROOT, 'workers/feedback-share/src/generated.ts')
const OTHER_LOCALES = /^\.\/(zh-CN|zh-TW|ko|es|fr|de|it|pt-BR|ru|hi|id|vi)$/

const result = await build({
  configFile: false,
  logLevel: 'error',
  root: ROOT,
  plugins: [{
    name: 'share-only-en-ja',
    enforce: 'pre',
    resolveId(id, importer) {
      if (importer && /src[\\/]shared[\\/]i18n[\\/]index\.ts$/.test(importer) && OTHER_LOCALES.test(id)) return '\0share-empty-locale'
      return null
    },
    load(id) {
      return id === '\0share-empty-locale' ? 'export const zhCN = {}, zhTW = {}, ko = {}, es = {}, fr = {}, de = {}, it = {}, ptBR = {}, ru = {}, hi = {}, id = {}, vi = {}' : null
    }
  }],
  resolve: { alias: { '@shared': resolve(ROOT, 'src/shared') } },
  define: { 'process.env.NODE_ENV': '"production"' },
  esbuild: { jsx: 'automatic', legalComments: 'none' },
  build: {
    write: false,
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000,
    lib: { entry: ENTRY, formats: ['iife'], name: 'FerretShare', fileName: () => 'share.js' },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
})

const output = (Array.isArray(result) ? result[0] : result).output
const js = output.find((o) => o.type === 'chunk')
const css = output.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
if (!js || !css) throw new Error('share page: missing js or css output')

// まとめた元のファイル（node_modules を除く）と、その sha256
const inputs = Object.keys(js.modules)
  .filter((id) => !id.startsWith('\0') && !id.includes('node_modules') && id.startsWith(ROOT))
  .map((id) => id.replace(/\?.*$/, ''))
const cssInputs = ['src/renderer/styles/tokens.css', 'src/renderer/styles/ui.css', 'src/renderer/styles/feedback.css', 'workers/feedback-share/client/share.css'].map((p) => resolve(ROOT, p))
const files = [...new Set([...inputs, ...cssInputs])].map((file) => relative(ROOT, file).split('\\').join('/')).sort()
const hashes = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(resolve(ROOT, file))).digest('hex').slice(0, 16)]))

const text = `/**
 * 生成したファイル（手で直さない）。node scripts/build-share-page.mjs が workers/feedback-share/client からまとめる。
 * SHARE_INPUTS は、まとめた元のファイルの sha256 の先頭（test/unit/share-page-build.test.ts が作り直し忘れを止める）。
 */
/* eslint-disable */
export const SHARE_INPUTS: Record<string, string> = ${JSON.stringify(hashes, null, 2)}

export const SHARE_JS: string = ${JSON.stringify(js.code)}

export const SHARE_CSS: string = ${JSON.stringify(css.source)}
`
writeFileSync(OUT, text)
console.log(`share page: js ${Math.round(js.code.length / 1024)} KiB, css ${Math.round(String(css.source).length / 1024)} KiB, ${files.length} inputs -> ${relative(ROOT, OUT)}`)
