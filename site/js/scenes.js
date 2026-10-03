/*
 * Ferret — landing page scene animations (below the hero)
 *
 * Created with Claude Opus 5.5 (Anthropic) for Ferret. Original artwork drawn in code: no stock imagery, no
 * external assets, no dependencies. Released under the MIT License with the rest of Ferret.
 *
 * Two short section loops, each telling its point without words:
 *   text     … a long typed prompt is replaced by a pen circle, a box and your voice on the real screen
 *   many     … one recording keeps producing finding cards, and the count goes up
 * and the tabbed product demo under the hero: an animated model of the app (record, findings, meeting, send,
 * verify) whose content follows the selected tab.
 *
 * Same rules as js/hero.js: a fixed 1000×560 scene scaled to the canvas, drawing only while on screen and the tab is
 * visible, the static poster kept until the first frame is drawn, and the poster only (no canvas) with
 * prefers-reduced-motion or at phone widths. drawScene() is exported for the poster renderer
 * (tools/docs/render-hero.mjs).
 */

export const SCENE_W = 1000
export const SCENE_H = 560

const C = {
  panel: '#101017',
  chrome: '#15151f',
  line: 'rgba(255,255,255,0.10)',
  text: '#ecebf5',
  muted: '#8d8ca3',
  faint: 'rgba(255,255,255,0.35)',
  page: '#f6f6f9',
  pageLine: '#e6e6ee',
  bar: '#d9d9e3',
  ink: '#14141c',
  pen: '#ff3d8b',
  green: '#3ee08f',
}
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const seg = (t, a, b) => clamp((t - a) / (b - a))
const outCubic = (p) => 1 - (1 - p) ** 3
const inOutSine = (p) => -(Math.cos(Math.PI * p) - 1) / 2
const lerp = (a, b, p) => a + (b - a) * p

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}
function fillRR(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color
  rr(ctx, x, y, w, h, r)
  ctx.fill()
}
function strokeRR(ctx, x, y, w, h, r, color, lw = 1) {
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r)
  ctx.stroke()
}
function text(ctx, str, x, y, { size = 14, weight = 500, color = C.text, font = SANS, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${font}`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(str, x, y)
}
function bar(ctx, x, y, w, h, color) {
  fillRR(ctx, x, y, w, h, h / 2, color)
}
function windowFrame(ctx, x, y, w, h, title) {
  fillRR(ctx, x, y, w, h, 12, C.chrome)
  strokeRR(ctx, x, y, w, h, 12, C.line)
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.arc(x + 16 + i * 14, y + 16, 4, 0, Math.PI * 2)
    ctx.fill()
  })
  if (title) text(ctx, title, x + 66, y + 16.5, { size: 12, color: C.muted, font: MONO })
}
/* A small pricing page, the same demo as the hero. */
function miniPage(ctx, x, y, w, h, { fixed = false } = {}) {
  ctx.save()
  rr(ctx, x, y, w, h, [0, 0, 10, 10])
  ctx.clip()
  ctx.fillStyle = C.page
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, w, 46)
  ctx.fillStyle = C.pageLine
  ctx.fillRect(x, y + 46, w, 1)
  text(ctx, 'acme.', x + 18, y + 23, { size: 15, weight: 800, color: C.ink })
  ;[0, 1, 2].forEach((i) => bar(ctx, x + w * 0.36 + i * 50, y + 20, 34, 7, C.bar))
  fillRR(ctx, x + w - 96, y + 11, 74, 24, 6, fixed ? C.ink : '#ecebff')
  text(ctx, 'Sign up', x + w - 59, y + 23.5, { size: 11.5, weight: 650, color: fixed ? '#fff' : '#7a72d9', align: 'center' })
  text(ctx, 'Pricing that grows with you', x + w / 2, y + 86, { size: 20, weight: 800, color: C.ink, align: 'center' })
  bar(ctx, x + w / 2 - 100, y + 108, 200, 7, C.bar)
  const cw = Math.min(140, (w - 80) / 3)
  const x0 = x + (w - (cw * 3 + 24)) / 2
  ;['$0', '$19', '$49'].forEach((p, i) => {
    const cx = x0 + i * (cw + 12)
    const cy = y + 136
    fillRR(ctx, cx, cy, cw, 140, 9, '#fff')
    strokeRR(ctx, cx, cy, cw, 140, 9, i === 1 ? C.ink : C.pageLine, i === 1 ? 1.6 : 1)
    bar(ctx, cx + 14, cy + 16, 40, 6, C.bar)
    text(ctx, p, cx + 14, cy + 44, { size: 20, weight: 800, color: C.ink })
    ;[0, 1].forEach((j) => bar(ctx, cx + 14, cy + 70 + j * 13, 80 - j * 16, 5, '#e4e4ec'))
    fillRR(ctx, cx + 14, cy + 106, cw - 28, 22, 5, i === 1 ? C.ink : '#fff')
    if (i !== 1) strokeRR(ctx, cx + 14, cy + 106, cw - 28, 22, 5, '#d6d6e0')
  })
  ctx.restore()
}
function ellipse(ctx, cx, cy, rx, ry, p, start = -2.5) {
  const n = 64
  ctx.beginPath()
  for (let i = 0; i <= n * p; i++) {
    const a = start + (i / n) * Math.PI * 2 * 1.1
    const wob = 1 + 0.05 * Math.sin(i * 0.4) + (i / n) * 0.05
    const px = cx + Math.cos(a) * rx * wob
    const py = cy + Math.sin(a) * ry * wob
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
  }
  ctx.stroke()
}
function boxStroke(ctx, x, y, w, h, p) {
  // a box drawn corner to corner, clockwise
  const per = 2 * (w + h)
  let d = per * p
  ctx.beginPath()
  ctx.moveTo(x, y)
  const legs = [[w, 0], [0, h], [-w, 0], [0, -h]]
  let cx = x
  let cy = y
  for (const [dx, dy] of legs) {
    const len = Math.abs(dx || dy)
    const k = clamp(d / len)
    cx += dx * k
    cy += dy * k
    ctx.lineTo(cx, cy)
    d -= len
    if (d <= 0) break
  }
  ctx.stroke()
}
function waveform(ctx, x, y, level, t, n = 5) {
  for (let i = 0; i < n; i++) {
    const lv = level * (0.3 + 0.7 * Math.abs(Math.sin(t * 9 + i * 1.7)))
    const h = 4 + lv * 16
    bar(ctx, x + i * 6, y - h / 2, 3.5, h, C.pen)
  }
}
function bubble(ctx, x, y, str, { level = 0, t = 0, alpha = 1 } = {}) {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.font = `500 15px ${SANS}`
  const w = ctx.measureText(str).width + 62
  fillRR(ctx, x, y, w, 36, 12, '#fff')
  ctx.beginPath()
  ctx.moveTo(x + 18, y + 36)
  ctx.lineTo(x + 30, y + 36)
  ctx.lineTo(x + 16, y + 46)
  ctx.closePath()
  ctx.fill()
  waveform(ctx, x + 14, y + 18, level, t, 4)
  text(ctx, str, x + 44, y + 19, { size: 15, color: C.ink })
  ctx.restore()
  return w
}
function card(ctx, x, y, w, h, i, { mark = 0, done = null } = {}) {
  fillRR(ctx, x, y, w, h, 8, C.panel)
  strokeRR(ctx, x, y, w, h, 8, C.line)
  const tw = Math.round(h * 1.3) - 16
  fillRR(ctx, x + 8, y + 8, tw, h - 16, 5, '#e9e9ef')
  bar(ctx, x + 14, y + 14, tw * 0.5, 4, '#d4d4dc')
  ctx.strokeStyle = C.pen
  ctx.lineWidth = 1.5
  const mx = x + 8 + tw * (0.3 + ((i * 37) % 50) / 100)
  const my = y + 8 + (h - 16) * (0.35 + ((i * 23) % 40) / 100)
  if (mark % 2 === 0) {
    ctx.beginPath()
    ctx.ellipse(mx, my, tw * 0.18, (h - 16) * 0.14, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else ctx.strokeRect(mx - tw * 0.16, my - (h - 16) * 0.12, tw * 0.32, (h - 16) * 0.24)
  fillRR(ctx, x + 8, y + 8, 14, 14, 3, '#34343f')
  text(ctx, String(i + 1), x + 15, y + 15.5, { size: 9, weight: 700, color: '#fff', align: 'center' })
  const lx = x + tw + 18
  bar(ctx, lx, y + h * 0.3, (w - tw - 30) * 0.85, 6, 'rgba(255,255,255,0.55)')
  bar(ctx, lx, y + h * 0.52, (w - tw - 30) * 0.65, 5, 'rgba(255,255,255,0.18)')
  if (done != null) bar(ctx, lx, y + h * 0.72, 30, 5, done ? C.green : 'rgba(255,255,255,0.18)')
}

/* ── scenes ──────────────────────────────────────────── */

const PROMPT =
  'On the pricing page, the Sign up button in the top-right corner of the header is too pale and does not look clickable. Make it a solid fill like the Start trial button in the middle plan card. Also add a Monthly / Yearly toggle centered just under the subtitle, above the three plan cards, with the yearly option…'

function wrapLines(ctx, str, width) {
  const words = str.split(' ')
  const lines = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (ctx.measureText(next).width > width && line) {
      lines.push(line)
      line = w
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

const SCENES = {
  /* 1. a typed prompt vs. pointing at the screen (8 s) */
  text: {
    loop: 8,
    draw(ctx, t, poster) {
      const typeP = poster ? 1 : seg(t, 0.2, 2.6)
      const textA = poster ? 0.9 : 1 - seg(t, 2.9, 3.4)
      const pageA = poster ? 1 : seg(t, 3.0, 3.5) * (1 - seg(t, 7.5, 7.95))
      // left: the prompt being typed (it shrinks to the side once the screen appears)
      const sx = poster ? 0 : outCubic(seg(t, 2.9, 3.6))
      ctx.save()
      ctx.globalAlpha *= poster ? 1 : Math.max(textA, 0.35)
      const px = lerp(150, 40, poster ? 1 : sx)
      const pw = lerp(700, 330, poster ? 1 : sx)
      fillRR(ctx, px, 70, pw, 420, 12, '#0b0b11')
      strokeRR(ctx, px, 70, pw, 420, 12, C.line)
      text(ctx, 'Typing it', px + 22, 98, { size: 13, weight: 600, color: C.muted })
      ctx.font = `500 ${lerp(17, 13, poster ? 1 : sx)}px ${MONO}`
      const shown = PROMPT.slice(0, Math.round(PROMPT.length * typeP))
      const lines = wrapLines(ctx, shown, pw - 44)
      lines.slice(0, 14).forEach((l, i) => text(ctx, l, px + 22, 132 + i * lerp(26, 22, poster ? 1 : sx), { size: lerp(17, 13, poster ? 1 : sx), color: '#b4b3c6', font: MONO }))
      if (!poster && typeP < 1 && Math.floor(t * 3) % 2 === 0) {
        const last = lines[lines.length - 1] ?? ''
        ctx.font = `500 17px ${MONO}`
        ctx.fillStyle = '#b4b3c6'
        ctx.fillRect(px + 24 + ctx.measureText(last).width, 132 + (lines.length - 1) * 26 - 9, 9, 18)
      }
      // a quiet strike once the screen takes over
      const strike = poster ? 1 : seg(t, 3.0, 3.5)
      if (strike > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(px + 20, 470)
        ctx.lineTo(px + 20 + (pw - 40) * strike, 470)
        ctx.stroke()
      }
      ctx.restore()
      if (pageA <= 0) return
      // right: the real screen with a pen circle, a box and your voice
      ctx.save()
      ctx.globalAlpha *= pageA
      const wx = 400
      const wy = 60
      const ww = 560
      const wh = 400
      windowFrame(ctx, wx, wy, ww, wh, 'localhost:3000/pricing')
      miniPage(ctx, wx + 1, wy + 32, ww - 2, wh - 33)
      text(ctx, 'Showing it', wx, wy + wh + 30, { size: 13, weight: 600, color: C.muted })
      ctx.strokeStyle = C.pen
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      const pen = poster ? 1 : inOutSine(seg(t, 3.6, 4.4))
      if (pen > 0) ellipse(ctx, wx + ww - 60, wy + 32 + 23, 56, 22, pen)
      const box = poster ? 1 : inOutSine(seg(t, 5.0, 5.6))
      const cw = Math.min(140, (ww - 82) / 3)
      const bx = wx + 1 + (ww - 2 - (cw * 3 + 24)) / 2 + cw + 12 + 8
      if (box > 0) boxStroke(ctx, bx, wy + 32 + 136 + 100, cw - 16, 34, box)
      const speak = poster ? 0.6 : seg(t, 3.6, 3.8) * (1 - seg(t, 6.6, 6.9))
      if (speak > 0) {
        const second = !poster && t > 4.9
        bubble(ctx, wx + 20, wy + wh - 70, second ? '“Like this one.”' : '“Make this solid.”', { level: speak, t })
      }
      ctx.restore()
    },
  },

  /* 2. one take, dozens of findings (7 s) */
  many: {
    loop: 7,
    draw(ctx, t, poster) {
      const total = 12
      const n = poster ? total : Math.min(total, Math.floor(seg(t, 0.6, 4.8) * total + 0.0001))
      const fade = poster ? 1 : 1 - seg(t, 6.4, 6.9)
      ctx.save()
      ctx.globalAlpha *= fade
      // the recording
      fillRR(ctx, 40, 60, 250, 46, 23, 'rgba(255,61,139,0.12)')
      ctx.fillStyle = C.pen
      ctx.beginPath()
      ctx.arc(64, 83, 6, 0, Math.PI * 2)
      ctx.fill()
      const secs = poster ? 128 : Math.floor(t * 18)
      text(ctx, `REC ${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`, 80, 84, { size: 16, weight: 600, color: '#ffc2da', font: MONO })
      waveform(ctx, 200, 83, poster ? 0.7 : 0.8, t, 7)
      // the count
      text(ctx, String(n), 40, 210, { size: 96, weight: 700, color: C.text })
      text(ctx, n === 1 ? 'finding' : 'findings', 44, 278, { size: 20, color: C.muted })
      text(ctx, 'from one recording', 44, 306, { size: 15, color: C.faint })
      // the cards
      const cols = 3
      const cw = 200
      const ch = 82
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols)
        const c = i % cols
        const x = 340 + c * (cw + 14)
        const y = 60 + r * (ch + 14)
        const born = poster ? 1 : outCubic(clamp((seg(t, 0.6, 4.8) * total - i) * 1.5))
        ctx.save()
        ctx.globalAlpha *= born
        ctx.translate(0, (1 - born) * 10)
        card(ctx, x, y, cw, ch, i, { mark: i })
        ctx.restore()
      }
      ctx.restore()
    },
  },

}

/* ── the product demo under the hero: an app model whose content follows the selected tab ── */

export const APP_W = 1200
export const APP_H = 700
export const APP_TABS = ['record', 'findings', 'meeting', 'send', 'verify']
export const APP_LOOP = 7

const FIND = ['Sign up is easy to miss', 'Add a yearly toggle', 'Button cut off on mobile', 'Pricing cards misaligned']

function appChrome(ctx, s) {
  fillRR(ctx, 0, 0, APP_W, APP_H, 14, '#0c0c12')
  strokeRR(ctx, 0, 0, APP_W, APP_H, 14, C.line)
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.arc(20 + i * 16, 19, 5, 0, Math.PI * 2)
    ctx.fill()
  })
  text(ctx, 'acme-shop', 90, 19.5, { size: 12.5, color: C.muted })
  fillRR(ctx, APP_W / 2 - 80, 8, 160, 23, 7, 'rgba(255,255,255,0.05)')
  fillRR(ctx, APP_W / 2 - 78, 10, 76, 19, 6, s.feedbackMode ? 'transparent' : 'rgba(255,255,255,0.10)')
  fillRR(ctx, APP_W / 2 + 2, 10, 76, 19, 6, s.feedbackMode ? 'rgba(255,255,255,0.10)' : 'transparent')
  text(ctx, 'Editor', APP_W / 2 - 40, 19.5, { size: 11.5, color: s.feedbackMode ? C.muted : C.text, align: 'center' })
  text(ctx, 'Feedback', APP_W / 2 + 40, 19.5, { size: 11.5, color: s.feedbackMode ? C.text : C.muted, align: 'center' })
  fillRR(ctx, APP_W - 104, 8, 88, 23, 7, s.recording ? '#b4233c' : '#e5484d')
  text(ctx, s.recording ? '■ Stop' : '● Record', APP_W - 60, 19.5, { size: 11.5, weight: 600, color: '#fff', align: 'center' })
  ctx.fillStyle = C.line
  ctx.fillRect(0, 38, APP_W, 1)
  // sidebar
  ctx.fillRect(200, 39, 1, APP_H - 39)
  text(ctx, 'Projects', 16, 60, { size: 11, color: C.muted })
  fillRR(ctx, 10, 72, 180, 26, 6, 'rgba(255,255,255,0.06)')
  text(ctx, 'acme-shop', 22, 85.5, { size: 12.5, weight: 600 })
  text(ctx, 'Today', 16, 116, { size: 10.5, color: C.faint })
  fillRR(ctx, 10, 126, 180, 40, 7, 'rgba(255,255,255,0.03)')
  strokeRR(ctx, 10, 126, 180, 40, 7, C.line)
  text(ctx, s.reviewName, 22, 141, { size: 12, color: C.text })
  text(ctx, '03:37 PM · 0:19', 22, 156, { size: 10, color: C.faint, font: MONO })
  if (s.count != null) text(ctx, `${s.doneCount != null ? '✓ ' : ''}${s.doneCount ?? s.count}/${s.total}`, 178, 141, { size: 11, color: s.doneCount === s.total ? C.green : C.muted, font: MONO, align: 'right' })
  // right panel split
  ctx.fillStyle = C.line
  ctx.fillRect(780, 39, 1, APP_H - 39)
}

function centerTabs(ctx, active) {
  ctx.fillStyle = C.line
  ctx.fillRect(201, 72, 579, 1)
  const tabs = [['Acme — Simple pricing', 'page'], ['Findings', 'findings']]
  let x = 212
  for (const [label, id] of tabs) {
    ctx.font = `500 12px ${SANS}`
    const w = ctx.measureText(label).width + 28
    if (id === active) {
      ctx.fillStyle = C.text
      ctx.fillRect(x, 70, w, 2)
    }
    text(ctx, label, x + 14, 56, { size: 12, color: id === active ? C.text : C.muted })
    x += w + 6
  }
}

function terminal(ctx, tabs, lines, { cursor = true, t = 0 } = {}) {
  let x = 792
  tabs.forEach(([label, on]) => {
    ctx.font = `500 12px ${SANS}`
    const w = ctx.measureText(label).width + 26
    if (on) {
      ctx.fillStyle = C.text
      ctx.fillRect(x, 70, w, 2)
    }
    text(ctx, label, x + 13, 56, { size: 12, color: on ? C.text : C.muted })
    x += w + 4
  })
  ctx.fillStyle = C.line
  ctx.fillRect(781, 72, APP_W - 781, 1)
  let y = 96
  for (const [str, color = '#c9c8d8', weight = 500] of lines) {
    text(ctx, str, 796, y, { size: 12, color, font: MONO, weight })
    y += 21
  }
  if (cursor && Math.floor(t * 2.5) % 2 === 0) {
    ctx.fillStyle = 'rgba(236,235,245,0.7)'
    ctx.fillRect(796, y - 8, 7, 15)
  }
}

function findingRows(ctx, n, { status = [], highlightSend = 0, title = true } = {}) {
  text(ctx, String(n), 216, 98, { size: 22, weight: 700 })
  text(ctx, n === 1 ? 'finding' : 'findings', 236, 100, { size: 12, color: C.muted })
  fillRR(ctx, 216, 116, 104, 26, 7, 'rgba(229,72,77,0.12)')
  strokeRR(ctx, 216, 116, 104, 26, 7, 'rgba(229,72,77,0.5)')
  text(ctx, '● Record more', 268, 129.5, { size: 11.5, color: '#ff8c8f', align: 'center' })
  fillRR(ctx, 330, 116, 116, 26, 7, highlightSend > 0 ? `rgba(255,255,255,${0.75 + 0.25 * highlightSend})` : 'rgba(255,255,255,0.85)')
  text(ctx, '➤ Send to Agent', 388, 129.5, { size: 11.5, weight: 600, color: C.ink, align: 'center' })
  for (let i = 0; i < n; i++) {
    const y = 158 + i * 128
    if (y > APP_H - 40) break
    fillRR(ctx, 216, y, 548, 116, 9, C.panel)
    strokeRR(ctx, 216, y, 548, 116, 9, C.line)
    ctx.save()
    miniPageThumb(ctx, 226, y + 10, 150, 96, i)
    ctx.restore()
    if (title) text(ctx, FIND[i % FIND.length], 392, y + 26, { size: 13.5, weight: 600 })
    text(ctx, ['“This button is hard to see.”', '“Add a yearly option here.”', '“The label is cut off.”', '“These don’t line up.”'][i % 4], 392, y + 50, { size: 12, color: C.muted })
    text(ctx, 'DONE WHEN', 392, y + 74, { size: 9.5, weight: 700, color: C.faint, font: MONO })
    text(ctx, ['solid like Start trial', 'Monthly / Yearly above plans', 'fits at 375px', 'cards share one baseline'][i % 4], 392, y + 92, { size: 11.5, color: '#c9c8d8' })
    const st = status[i]
    if (st) {
      const done = st === 'done'
      const label = done ? '✓ Done' : '● In progress'
      fillRR(ctx, 664, y + 14, 88, 22, 11, done ? '#10241a' : 'rgba(255,255,255,0.05)')
      strokeRR(ctx, 664, y + 14, 88, 22, 11, done ? 'rgba(62,224,143,0.45)' : C.line)
      text(ctx, label, 708, y + 25.5, { size: 11, color: done ? C.green : C.muted, align: 'center' })
    }
  }
}

function miniPageThumb(ctx, x, y, w, h, i) {
  rr(ctx, x, y, w, h, 5)
  ctx.clip()
  ctx.fillStyle = C.page
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, w, 16)
  bar(ctx, x + 8, y + 6, 22, 4, C.bar)
  fillRR(ctx, x + w - 30, y + 4, 22, 8, 2, '#ecebff')
  bar(ctx, x + w / 2 - 40, y + 26, 80, 6, '#cfcfda')
  ;[0, 1, 2].forEach((k) => {
    fillRR(ctx, x + 12 + k * ((w - 24) / 3), y + 42, (w - 24) / 3 - 6, h - 50, 4, '#fff')
  })
  ctx.strokeStyle = C.pen
  ctx.lineWidth = 1.6
  const marks = [[x + w - 19, y + 8, 16, 7, 'o'], [x + w / 2, y + 29, 46, 7, 'o'], [x + w / 2 - 10, y + 68, 22, 12, 'b'], [x + 30, y + 60, 24, 14, 'b']]
  const [mx, my, rx, ry, k] = marks[i % 4]
  ctx.beginPath()
  if (k === 'o') ctx.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2)
  else ctx.rect(mx - rx, my - ry, rx * 2, ry * 2)
  ctx.stroke()
}

const APP_SCENES = {
  record(ctx, t, poster) {
    const s = { feedbackMode: true, recording: true, reviewName: 'Recording…', count: null }
    appChrome(ctx, s)
    // recording toolbar (in place of the tabs while recording)
    fillRR(ctx, 296, 44, 390, 26, 8, 'rgba(14,14,20,0.92)')
    strokeRR(ctx, 296, 44, 390, 26, 8, 'rgba(229,72,77,0.6)')
    text(ctx, `● 00:${String(Math.floor(poster ? 9 : t * 1.4)).padStart(2, '0')}`, 308, 57.5, { size: 12, weight: 600, color: '#ff8c8f', font: MONO })
    waveform(ctx, 368, 57, poster ? 0.7 : 0.4 + 0.6 * Math.abs(Math.sin(t * 2)), t, 5)
    const tools = ['✎', '▢', '●', '⌫']
    tools.forEach((g, i) => {
      const on = (i === 0 && (poster || t < 2.4)) || (i === 1 && !poster && t >= 2.4)
      fillRR(ctx, 424 + i * 30, 47, 24, 20, 5, on ? 'rgba(124,140,255,0.35)' : 'transparent')
      text(ctx, g, 436 + i * 30, 57.5, { size: 12.5, color: i === 2 ? C.pen : C.text, align: 'center' })
    })
    text(ctx, 'Pen · Box', 556, 57.5, { size: 11.5, color: C.muted })
    ctx.fillStyle = C.line
    ctx.fillRect(201, 76, 579, 1)
    miniPage(ctx, 212, 86, 556, 400)
    ctx.strokeStyle = C.pen
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    const pen = poster ? 1 : inOutSine(seg(t, 0.8, 1.8))
    if (pen > 0) ellipse(ctx, 212 + 556 - 59, 86 + 23, 52, 20, pen)
    const box = poster ? 1 : inOutSine(seg(t, 2.6, 3.3))
    const cw = Math.min(140, (556 - 80) / 3)
    const bx = 212 + (556 - (cw * 3 + 24)) / 2 + cw + 12 + 10
    if (box > 0) boxStroke(ctx, bx, 86 + 136 + 100, cw - 20, 34, box)
    const speak = poster ? 0.7 : seg(t, 0.7, 0.9) * (1 - seg(t, 5.6, 5.9))
    if (speak > 0) bubble(ctx, 226, 430, !poster && t > 2.5 ? '“Like this one.”' : '“Make Sign up solid.”', { level: speak, t })
    // review targets on the right
    text(ctx, 'Review targets', 796, 56, { size: 12, color: C.text })
    ctx.fillStyle = C.line
    ctx.fillRect(781, 72, APP_W - 781, 1)
    const items = ['local  localhost:3000', '  blog', '  docs', '  pricing', 'dev  127.0.0.1:3001']
    items.forEach((it, i) => {
      const y = 96 + i * 24
      if (i === 3) fillRR(ctx, 790, y - 11, 396, 22, 5, 'rgba(255,255,255,0.06)')
      text(ctx, it, 800, y, { size: 12, color: i === 3 ? C.text : C.muted, font: MONO })
    })
    text(ctx, 'Recent', 796, 236, { size: 11, color: C.faint })
    ;['/pricing', '/docs/billing', '/blog/launch-week'].forEach((it, i) => text(ctx, it, 800, 262 + i * 22, { size: 12, color: C.muted, font: MONO }))
  },
  findings(ctx, t, poster) {
    const n = poster ? 4 : Math.min(4, Math.floor(seg(t, 0.4, 3.6) * 4 + 0.999))
    appChrome(ctx, { reviewName: 'Button fixes', count: n, total: 4 })
    centerTabs(ctx, 'findings')
    findingRows(ctx, n)
    terminal(ctx, [['1: zsh', true]], [['acme-shop % ', C.muted]], { t, cursor: !poster })
  },
  meeting(ctx, t, poster) {
    appChrome(ctx, { feedbackMode: true, recording: true, reviewName: 'Design review', count: null })
    centerTabs(ctx, 'page')
    fillRR(ctx, 212, 84, 556, 30, 8, 'rgba(255,255,255,0.04)')
    text(ctx, 'Recording · Entire screen (shared on Zoom)', 226, 99.5, { size: 12, color: C.muted })
    miniPage(ctx, 212, 120, 556, 380)
    const people = [['AK', 'Design', '“The CTA gets lost.”', [212 + 556 - 59, 120 + 23, 50, 19]], ['RM', 'Product', '“Add a yearly option.”', [212 + 278, 120 + 108, 110, 15]], ['JS', 'Eng', '“Cut off on mobile.”', [212 + 278 + 152, 120 + 136 + 117, 48, 17]]]
    const slot = (i) => [0.4 + i * 2, 2.1 + i * 2]
    people.forEach(([ini, role, said, m], i) => {
      const [a, b] = slot(i)
      const on = poster ? 0 : seg(t, a, a + 0.2) * (1 - seg(t, b, b + 0.2))
      const x = 212 + i * 188
      const y = 520
      fillRR(ctx, x, y, 176, 44, 9, C.panel)
      strokeRR(ctx, x, y, 176, 44, 9, on > 0.5 ? 'rgba(255,255,255,0.6)' : C.line, on > 0.5 ? 1.5 : 1)
      ctx.fillStyle = '#2a2a33'
      ctx.beginPath()
      ctx.arc(x + 23, y + 22, 13, 0, Math.PI * 2)
      ctx.fill()
      text(ctx, ini, x + 23, y + 22.5, { size: 10.5, weight: 700, align: 'center' })
      text(ctx, role, x + 44, y + 22.5, { size: 12, color: C.muted })
      if (on > 0) waveform(ctx, x + 130, y + 22, on, t, 5)
      const drawn = poster ? 1 : seg(t, a + 0.2, a + 0.9)
      if (drawn > 0) {
        ctx.strokeStyle = C.pen
        ctx.lineWidth = 2.4
        ellipse(ctx, m[0], m[1], m[2], m[3], drawn)
      }
      if (on > 0) bubble(ctx, 226, 446, said, { level: on, t, alpha: on })
    })
    text(ctx, 'Findings', 796, 56, { size: 12, color: C.text })
    ctx.fillStyle = C.line
    ctx.fillRect(781, 72, APP_W - 781, 1)
    people.forEach((_, i) => {
      const [, b] = slot(i)
      const p = poster ? 1 : outCubic(seg(t, b - 0.3, b + 0.3))
      if (p <= 0) return
      ctx.save()
      ctx.globalAlpha *= p
      card(ctx, 794, 90 + i * 92 + (1 - p) * 10, 392, 80, i, { mark: i })
      ctx.restore()
    })
  },
  send(ctx, t, poster) {
    appChrome(ctx, { reviewName: 'Button fixes', count: 4, total: 4 })
    centerTabs(ctx, 'findings')
    const press = poster ? 0 : Math.max(0, 1 - Math.abs(t - 1.0) / 0.25)
    findingRows(ctx, 4, { highlightSend: press })
    const started = poster || t > 1.3
    const lines = [['acme-shop % claude', C.text, 600]]
    if (started) lines.push(['agent ready · ~/acme-shop', C.faint])
    const body = [
      '> Read ".ferret/reviews/1537/feedback.md"',
      '  and the images in the same folder, then',
      '  implement every finding marked for sending.',
      '  Acceptance: verify each finding against its',
      '  "Done when" with the decision model.',
      '● received 110 words',
    ]
    const k = poster ? body.length : Math.floor(seg(t, 1.8, 3.6) * body.length + 0.0001)
    body.slice(0, k).forEach((l, i) => lines.push([l, i === body.length - 1 ? C.faint : '#c9c8d8']))
    terminal(ctx, [['1: zsh', false], ['Claude Code', started]], lines, { t, cursor: !poster })
    const toast = poster ? 1 : seg(t, 1.4, 1.7) * (1 - seg(t, 5.4, 5.8))
    if (toast > 0) {
      ctx.save()
      ctx.globalAlpha *= toast
      fillRR(ctx, 860, 600, 320, 64, 10, '#15151f')
      strokeRR(ctx, 860, 600, 320, 64, 10, 'rgba(62,224,143,0.35)')
      text(ctx, '✓ Sent the instructions to the agent', 878, 622, { size: 12.5, color: C.text })
      text(ctx, 'Claude Code was started for you.', 878, 644, { size: 11.5, color: C.muted })
      ctx.restore()
    }
  },
  verify(ctx, t, poster) {
    const at = [1.0, 1.7, 2.4, 3.1]
    const retry = 4.3
    const st = at.map((a, i) => {
      if (poster) return 'done'
      if (t < a) return 'progress'
      if (i === 2 && t < retry) return 'progress'
      return 'done'
    })
    const doneN = st.filter((x) => x === 'done').length
    appChrome(ctx, { reviewName: 'Button fixes', count: 4, total: 4, doneCount: doneN })
    centerTabs(ctx, 'findings')
    findingRows(ctx, 4, { status: st })
    const lines = [['acme-shop % claude', C.text, 600], ['  checking with your decision model…', C.faint]]
    at.forEach((a, i) => {
      if (!poster && t < a) return
      if (i === 2 && !poster && t < retry) lines.push([`  #${i + 1} 0.42 not_done  ✗ fixing…`, C.muted])
      else lines.push([`  #${i + 1} ${[0.94, 0.91, 0.89, 0.92][i]} done  ✓`, C.green])
    })
    if (doneN === 4) lines.push(['✓ Done 4/4 · verified against your screenshots', C.green, 600])
    terminal(ctx, [['1: zsh', false], ['Claude Code', true]], lines, { t, cursor: !poster })
  },
}

/** Draws one frame of the product demo for a tab. ctx is already scaled to APP_W × APP_H. */
export function drawApp(ctx, tab, t, poster = false) {
  ctx.clearRect(0, 0, APP_W, APP_H)
  ctx.save()
  APP_SCENES[tab](ctx, t, poster)
  ctx.restore()
}

/** Draws one frame of a scene. ctx is already scaled to SCENE_W × SCENE_H. */
export function drawScene(ctx, name, t, poster = false) {
  ctx.clearRect(0, 0, SCENE_W, SCENE_H)
  SCENES[name].draw(ctx, t, poster)
}

export const sceneNames = Object.keys(SCENES)

/**
 * Animates a canvas with draw(ctx, t) over a loop of `loop` seconds, only while on screen and the tab is visible.
 * onFirstFrame runs once the first frame is drawn. Returns { restart } so a caller can start the loop over.
 */
function animate(canvas, w, h, loop, draw, onFirstFrame, onLoop) {
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.roundRect !== 'function') return null
  let raf = 0
  let start = 0
  let pausedAt = 0
  let onScreen = false
  let scale = 1
  let lastT = null
  let loops = 0
  const paint = (t) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    draw(ctx, t)
    if (lastT == null) onFirstFrame?.()
    lastT = t
  }
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    scale = (canvas.clientWidth * dpr) / w
    canvas.width = Math.round(canvas.clientWidth * dpr)
    canvas.height = Math.round((canvas.clientWidth * h * dpr) / w)
    if (lastT != null) paint(lastT) // setting the size clears the canvas
  }
  const frame = (now) => {
    if (!start) start = now
    const elapsed = (now - start) / 1000
    const n = Math.floor(elapsed / loop)
    if (n !== loops) {
      loops = n
      onLoop?.()
    }
    paint(elapsed % loop)
    raf = requestAnimationFrame(frame)
  }
  const run = () => {
    if (raf || !onScreen || document.hidden) return
    if (pausedAt) start += performance.now() - pausedAt
    pausedAt = 0
    raf = requestAnimationFrame(frame)
  }
  const stop = () => {
    if (!raf) return
    cancelAnimationFrame(raf)
    raf = 0
    pausedAt = performance.now()
  }
  resize()
  new ResizeObserver(resize).observe(canvas)
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting
    onScreen ? run() : stop()
  }).observe(canvas)
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()))
  return {
    restart() {
      start = 0
      loops = 0
      pausedAt = 0
      if (lastT != null) paint(0)
    },
  }
}

/* The tabbed product demo: tabs switch the model's content; it advances on its own until someone picks a tab. */
function setupDemo(root, motion) {
  const tabs = [...root.querySelectorAll('[role="tab"]')]
  const poster = root.querySelector('.demo-poster')
  const canvas = root.querySelector('canvas[data-app]')
  const stage = root.querySelector('[data-scene-stage]')
  const caption = root.querySelector('.demo-caption')
  let current = Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'))
  let auto = true
  let anim = null
  const select = (i, { focus = false, user = false } = {}) => {
    current = (i + tabs.length) % tabs.length
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', String(k === current))
      t.tabIndex = k === current ? 0 : -1
    })
    if (focus) tabs[current].focus()
    if (user) auto = false
    // the poster URL carries ?v=<content hash> (pnpm site:hash), so a redrawn still is never served stale from the CDN
    if (poster) poster.src = tabs[current].dataset.poster
    if (poster) poster.alt = tabs[current].dataset.alt || ''
    if (caption) caption.textContent = tabs[current].dataset.caption || ''
    anim?.restart()
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(i, { user: true }))
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') select(current + 1, { focus: true, user: true })
      if (e.key === 'ArrowLeft') select(current - 1, { focus: true, user: true })
    })
  })
  if (!motion || !canvas) return
  anim = animate(canvas, APP_W, APP_H, APP_LOOP, (ctx, t) => drawApp(ctx, tabs[current].dataset.tab, t), () => stage?.classList.add('is-live'), () => {
    if (auto) select(current + 1)
  })
}

if (typeof document !== 'undefined') {
  const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches && !matchMedia('(max-width: 720px)').matches
  if (motion) {
    for (const canvas of document.querySelectorAll('canvas[data-scene]')) {
      const scene = SCENES[canvas.dataset.scene]
      const stage = canvas.closest('[data-scene-stage]')
      if (scene) animate(canvas, SCENE_W, SCENE_H, scene.loop, (ctx, t) => drawScene(ctx, canvas.dataset.scene, t), () => stage?.classList.add('is-live'))
    }
  }
  for (const root of document.querySelectorAll('[data-app-demo]')) setupDemo(root, motion)
}
