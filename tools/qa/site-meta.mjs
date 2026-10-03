// site/js/config.js の SITE_URL から、各ページの og:image・og:url・canonical の絶対 URL を書き直す。
// サイトはビルドしないので、SITE_URL を変えたらこれを1回走らせる（pnpm site:meta）。
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const root = 'site'
// config.js は package.json に "type": "module" が無いので import すると警告が出る。定数だけを文字として読む
const SITE_URL = /export const SITE_URL = '([^']+)'/.exec(await readFile(join(root, 'js', 'config.js'), 'utf8'))?.[1]
if (!SITE_URL) throw new Error('site/js/config.js に SITE_URL が見つかりません')

async function htmlFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)))
    else if (entry.name.endsWith('.html') && entry.name !== '404.html') out.push(full)
  }
  return out
}

/** site/ からの相対パス → 公開 URL のパス（Cloudflare Pages の既定どおり .html を外し、index.html はディレクトリ） */
function pagePath(rel) {
  const p = rel.split(sep).join('/')
  if (p === 'index.html') return '/'
  if (p.endsWith('/index.html')) return `/${p.slice(0, -'index.html'.length)}`
  return `/${p.replace(/\.html$/, '')}`
}

let changed = 0
for (const file of await htmlFiles(root)) {
  const before = await readFile(file, 'utf8')
  const url = SITE_URL + pagePath(relative(root, file))
  const after = before
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${SITE_URL}/assets/og.png$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
  if (after !== before) {
    await writeFile(file, after)
    changed++
    console.log(`updated ${file}`)
  }
}
console.log(`${changed} file(s) updated for ${SITE_URL}`)
