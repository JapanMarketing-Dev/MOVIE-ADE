// LP のヒーローアニメーション（site/js/hero.js、Claude Opus 5.5 で作成）から、静止画と README 用の動く画像を書き出す。
//   node tools/docs/render-hero.mjs            … site/assets/hero-poster.webp（動きを減らす設定・JS なし用）
//   node tools/docs/render-hero.mjs --readme   … 上に加えて docs/images/hero.gif（GitHub の README 用。JS も canvas も動かないので GIF にする）
// hero.js をそのまま Chromium（devDependencies の Playwright）で描くので、絵はサイトと必ず一致する。
// 圧縮には cwebp と ffmpeg を使う。
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SITE = join(ROOT, 'site')
const README = process.argv.includes('--readme')

// 背景つきの描画台。README では透明にできないので、サイトの舞台に近い暗い面と光を敷く
const STAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
#s{position:relative;width:1000px;height:640px;overflow:hidden}
#s.bg{background:#050508}
#s.bg::before{content:'';position:absolute;inset:0;background:radial-gradient(70% 70% at 70% 0%,rgba(255,255,255,.05),transparent 70%)}
canvas{position:absolute;inset:0;width:1000px;height:640px}
</style><div id="s"><canvas id="c"></canvas></div>
<script type="module">
import { drawHero, heroState, posterState, HERO_W, HERO_H } from '/js/hero.js'
const c = document.getElementById('c')
window.setup = (scale, bg) => {
  c.width = HERO_W * scale; c.height = HERO_H * scale
  document.getElementById('s').classList.toggle('bg', bg)
  window.ctx = c.getContext('2d'); window.ctx.setTransform(scale, 0, 0, scale, 0, 0)
}
window.frame = (t, loop) => drawHero(window.ctx, heroState(t, loop))
window.poster = () => drawHero(window.ctx, posterState())
window.ready = true
</script>`

const TYPES = { '.js': 'text/javascript', '.html': 'text/html' }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/__stage.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(STAGE)
  try {
    const body = readFileSync(join(SITE, path))
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
}).listen(0)
const base = `http://127.0.0.1:${server.address().port}`
const tmp = mkdtempSync(join(tmpdir(), 'ferret-hero-'))
const browser = await chromium.launch()

async function stage(scale) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: scale })
  await page.goto(`${base}/__stage.html`)
  await page.waitForFunction(() => window.ready)
  return page
}
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`

try {
  // 静止画: 透明背景（サイトの舞台の上に重ねる）
  let page = await stage(1.6)
  await page.evaluate(() => {
    window.setup(1.6, false)
    window.poster()
  })
  await page.locator('#s').screenshot({ path: join(tmp, 'poster.png'), omitBackground: true })
  const poster = join(SITE, 'assets/hero-poster.webp')
  execFileSync('cwebp', ['-quiet', '-q', '82', '-alpha_q', '90', join(tmp, 'poster.png'), '-o', poster])
  console.log(`site/assets/hero-poster.webp ${kb(poster)}`)
  await page.close()

  if (README) {
    // 2周目以降の状態（ブラウザの枠が出たまま）を1周ぶん描くので、GIF の継ぎ目が見えない
    const fps = 20
    const loop = 8.8
    const n = Math.round(loop * fps)
    page = await stage(1.28)
    await page.evaluate(() => window.setup(1.28, true))
    for (let i = 0; i < n; i++) {
      await page.evaluate((t) => window.frame(t, 2), i / fps)
      await page.locator('#s').screenshot({ path: join(tmp, `f${String(i).padStart(4, '0')}.png`) })
    }
    const gif = join(ROOT, 'docs/images/hero.gif')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(tmp, 'f%04d.png'), '-vf',
      'split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop', '0', gif])
    console.log(`docs/images/hero.gif ${kb(gif)}`)
  }
} finally {
  await browser.close()
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
