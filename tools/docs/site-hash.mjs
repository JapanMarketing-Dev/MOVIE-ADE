// site/ の HTML と JS モジュールの、CSS / JS・画像への参照に ?v=<中身の版> を付け直す（pnpm site:hash。pnpm site:meta も最後に走らせる）。
// docs/ の HTML は tools/docs/build-docs.mjs が同じ版を付けて書き出すので、ここでは触らない。
// CSS・JS を変えたら、これと pnpm docs:build を走らせる（単体テスト site-assets がずれを検出する）。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SITE_DIR, MODULE_IMPORTS, assetVersion } from './asset-version.mjs'

let changed = 0
const write = (path, before, after) => {
  if (after === before) return
  writeFileSync(path, after)
  changed++
  console.log(`updated ${path.slice(SITE_DIR.length + 1)}`)
}

// 1. モジュールの import（葉から順に）
for (const [file, deps] of MODULE_IMPORTS) {
  const path = join(SITE_DIR, file)
  const before = readFileSync(path, 'utf8')
  let after = before
  for (const dep of deps) {
    const v = assetVersion(`js/${dep}`)
    after = after.replace(new RegExp(`(from '\\./${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(\\?v=[0-9a-f]+)?'`, 'g'), `$1?v=${v}'`)
  }
  write(path, before, after)
}

// 2. site/ 直下の HTML（docs/ は build-docs.mjs が書く）
for (const name of readdirSync(SITE_DIR).filter((f) => f.endsWith('.html'))) {
  const path = join(SITE_DIR, name)
  const before = readFileSync(path, 'utf8')
  // ファビコンにも版を付ける。版が無いと、ブラウザが古いファビコン（改名前の絵）を1日覚えたままになる
  const after = before.replace(/((?:src|href)=")(\/?)((?:js\/)?[\w-]+\.(?:css|js)|favicon\.svg|favicon-32\.png|apple-touch-icon\.png)(\?v=[0-9a-f]+)?"/g, (whole, attr, slash, rel) =>
    `${attr}${slash}${rel}?v=${assetVersion(rel)}"`)
    // 画像にも版を付ける。静止画を描き直しても、Cloudflare が古い絵を1日返し続けるのを防ぐ（src・srcset・data-poster。og:image の絶対 URL は対象外）
    .replace(/(?<=["\s,])(\/?assets\/[\w/.-]+\.(?:webp|png|jpg|svg|gif))(\?v=[0-9a-f]+)?(?=[\s",])/g, (whole, rel) => `${rel}?v=${assetVersion(rel.replace(/^\//, ''))}`)
  write(path, before, after)
}
console.log(`${changed} file(s) updated`)
