// site/js/config.js の SITE_URL から、各ページの og:image・og:url・canonical の絶対 URL を書き直す。
// サイトはビルドしないので、SITE_URL を変えたらこれを1回走らせる（pnpm site:meta）。
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

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

/** トップページの構造化データ（schema.org の SoftwareApplication）。検索結果にアプリとして出すため */
function jsonLd() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Ferret',
    alternateName: 'Ferret ADE',
    description:
      'An Agentic Development Environment (ADE) for feedback by voice and screen. Point at the real screen, say what’s wrong, and hand your coding agent dozens of precise findings at once.',
    url: `${SITE_URL}/`,
    downloadUrl: `${SITE_URL}/download`,
    image: `${SITE_URL}/assets/og.png`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Windows, Linux',
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'Japan Marketing LLC', url: 'https://www.japan-marketing.co.jp/' }
  }
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`
}

/** 最後に commit された日（YYYY-MM-DD）。git が無いときは付けない */
function lastmod(file) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

let changed = 0
const urls = []
for (const file of (await htmlFiles(root)).sort()) {
  const before = await readFile(file, 'utf8')
  const url = SITE_URL + pagePath(relative(root, file))
  // meta refresh で別のページへ移るだけのページ（docs/index.html）は、サイトマップに載せない
  if (!/http-equiv="refresh"/.test(before)) urls.push({ url, lastmod: lastmod(file) })
  let after = before
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${SITE_URL}/assets/og.png$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
  if (pagePath(relative(root, file)) === '/') {
    const ld = jsonLd()
    after = /<script type="application\/ld\+json">[\s\S]*?<\/script>/.test(after)
      ? after.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ld)
      : after.replace('</head>', `  ${ld}\n</head>`)
  }
  if (after !== before) {
    await writeFile(file, after)
    changed++
    console.log(`updated ${file}`)
  }
}

// サイトマップと robots.txt も SITE_URL から作る（検索エンジンに全ページを知らせる）
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((u) => `  <url><loc>${u.url}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`),
  '</urlset>',
  ''
].join('\n')
const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
for (const [name, body] of [['sitemap.xml', sitemap], ['robots.txt', robots]]) {
  const path = join(root, name)
  const prev = await readFile(path, 'utf8').catch(() => '')
  if (prev !== body) {
    await writeFile(path, body)
    changed++
    console.log(`updated ${path}`)
  }
}
console.log(`${changed} file(s) updated for ${SITE_URL}`)
