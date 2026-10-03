// サイトマップの全 URL を IndexNow（Bing・Yandex・Seznam・Naver など）に知らせる。site:deploy のあとに1回走らせる（pnpm site:indexnow）。
// 鍵は公開の値で、site/<鍵>.txt を配信して持ち主であることを示す（秘密ではない）。
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = 'site'
const SITE_URL = /export const SITE_URL = '([^']+)'/.exec(await readFile(join(root, 'js', 'config.js'), 'utf8'))?.[1]
if (!SITE_URL) throw new Error('site/js/config.js に SITE_URL が見つかりません')
const keyFile = (await readdir(root)).find((f) => /^[0-9a-f]{32}\.txt$/.test(f))
if (!keyFile) throw new Error('site/ に IndexNow の鍵のファイル（32桁の16進.txt）がありません')
const key = keyFile.slice(0, -4)
const urlList = [...(await readFile(join(root, 'sitemap.xml'), 'utf8')).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: new URL(SITE_URL).host, key, keyLocation: `${SITE_URL}/${keyFile}`, urlList })
})
console.log(`IndexNow: ${res.status} ${res.statusText} (${urlList.length} URLs)`)
if (!res.ok && res.status !== 202) process.exit(1)
