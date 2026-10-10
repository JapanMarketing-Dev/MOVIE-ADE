// site/js/config.js の SITE_URL から、各ページの og:image・og:url・canonical の絶対 URL を書き直す。
// サイトはビルドしないので、SITE_URL を変えたらこれを1回走らせる（pnpm site:meta）。
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assetVersion } from '../docs/asset-version.mjs'

const root = 'site'
// config.js は package.json に "type": "module" が無いので import すると警告が出る。定数だけを文字として読む
const SITE_URL = /export const SITE_URL = '([^']+)'/.exec(await readFile(join(root, 'js', 'config.js'), 'utf8'))?.[1]
if (!SITE_URL) throw new Error('site/js/config.js に SITE_URL が見つかりません')
// OGP / X のカード画像。X や Slack は画像を URL ごとに長くキャッシュする（改名前の MOVIE-ADE の画像が出続けた）ので、
// 中身の版（sha256 の先頭8文字）を付けて、絵が変わったら別の URL として取り直させる
export const OG_IMAGE_URL = `${SITE_URL}/assets/ferret-og.png?v=${assetVersion('assets/ferret-og.png')}`

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
    image: OG_IMAGE_URL,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Windows, Linux',
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'Japan Marketing LLC', url: 'https://www.japan-marketing.co.jp/' }
  }
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`
}

// SNS で共有したときのカード（OGP / X）。代替テキストは属性にそのまま入れるので " と & を含めない。og.png の寸法と代替テキスト、X 向けの title・description・image を足す。
// og:title・og:description はページごとに書いたものを正本にし、twitter:* はそれを写す。何度走らせても同じになる
const OG_IMAGE_ALT = 'Ferret: the ADE for feedback by voice and screen. A pen circles Sign up on a pricing page, two findings appear, and a terminal running claude reports Done 2/2.'
// og:locale は <html lang> から（docs は言語ごとのページがある。tools/docs/build-docs.mjs の OG_LOCALES と同じ）
const OG_LOCALES = { en: 'en_US', ja: 'ja_JP' }
function socialMeta(html) {
  const locale = OG_LOCALES[/<html lang="([^"]+)"/.exec(html)?.[1] ?? 'en'] ?? 'en_US'
  const title = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1]
  const description = /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1]
  const card = /^([ \t]*)<meta name="twitter:card" content="[^"]*">\n/m.exec(html)
  if (title === undefined || description === undefined || !card) return html
  const indent = card[1]
  const lines = [
    `<meta property="og:locale" content="${locale}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${OG_IMAGE_ALT}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${OG_IMAGE_URL}">`,
    `<meta name="twitter:image:alt" content="${OG_IMAGE_ALT}">`
  ]
  const stripped = html.replace(
    /^[ \t]*<meta (?:property="og:(?:locale|image:(?:type|width|height|alt))"|name="twitter:(?:title|description|image|image:alt)") content="[^"]*">\n/gm,
    ''
  )
  return stripped.replace(/^[ \t]*<meta name="twitter:card" content="[^"]*">\n/m, lines.map((l) => `${indent}${l}\n`).join(''))
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
  // meta refresh で別のページへ移るだけのページ（docs/index.html）と、noindex のページ（まだ訳の無い docs/<lang>/ のページ。
  // canonical は英語のページを指す。build-docs.mjs が書く）は、サイトマップに載せず canonical もそのままにする
  const noindex = /<meta name="robots" content="noindex/.test(before)
  if (!/http-equiv="refresh"/.test(before) && !noindex) urls.push({ url, lastmod: lastmod(file) })
  let after = socialMeta(before)
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${OG_IMAGE_URL}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
  if (!noindex) after = after.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
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
