/*
 * Ferret — landing page hero animation
 *
 * Created with Claude Opus 5.5 (Anthropic) for Ferret. Original artwork drawn in code:
 * no stock imagery, no external assets, no dependencies. Released under the MIT License with the rest of Ferret.
 *
 * The story, on an 8.8 s loop:
 *   1. A browser shows a pricing page (the frame stays put between loops; only the overlays reset).
 *   2. A pen circles the "Sign up" button and the plans while you talk (mic level in the REC pill, your words in a bubble).
 *   3. When you stop, your words turn into text and pair up with your marks: two finding cards, each with a still,
 *      the words you said and a "Done when".
 *   4. The cards fly into a terminal where an agent (claude / codex / gemini, in turn) implements them.
 *   5. The page gets fixed, the agent compares it with your screenshot (score 0.94), and "✓ Done" is verified.
 *
 * Canvas 2D in a fixed 1000×640 scene scaled to the element. Rendering stops while the canvas is offscreen or the
 * tab is hidden. With prefers-reduced-motion (or without JS) the page keeps the static poster image instead.
 * Each loop fires a "hero:done" event on the canvas at the Done moment so the page can echo it.
 * drawHero() / heroState() / posterState() are exported so the poster and the README GIF come from the same code
 * (see tools/docs/render-hero.mjs).
 */

export const HERO_W = 1000
export const HERO_H = 640
export const HERO_LOOP = 8.8
export const DONE_AT = 6.5

const C = {
  ink: '#0b0b12',
  chrome: '#15151f',
  chromeLine: 'rgba(255,255,255,0.08)',
  page: '#f6f6f9',
  pageLine: '#e6e6ee',
  bar: '#d9d9e3',
  // A calm, mostly monochrome palette: the pen is the one accent, green is only for Done
  violet: '#1c1c24',
  violetSoft: '#9a99ab',
  magenta: '#c9c8d4',
  badge: '#34343f',
  green: '#3ee08f',
  pen: '#ff3d8b',
  text: '#ecebf5',
  muted: '#8d8ca3',
}
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

/* ── math ────────────────────────────────────────────── */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const seg = (t, a, b) => clamp((t - a) / (b - a))
const outCubic = (p) => 1 - (1 - p) ** 3
const inOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)
const inOutSine = (p) => -(Math.cos(Math.PI * p) - 1) / 2
const outBack = (p) => {
  const c = 1.70158
  return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2
}
const lerp = (a, b, p) => a + (b - a) * p

/* ── layout (scene coordinates) ──────────────────────── */

const BROWSER = { x: 28, y: 36, w: 600, h: 408 }
const PAGE_Y = BROWSER.y + 38
const SIGNUP = { x: BROWSER.x + BROWSER.w - 141, y: PAGE_Y + 14, w: 84, h: 28 }
const CARDS = [
  { x: 640, y: 54 },
  { x: 640, y: 178 },
]
const CARD_W = 352
const CARD_H = 112
const TERM = { x: 372, y: 326, w: 600, h: 278 }
const PROMPT = { x: TERM.x + 40, y: TERM.y + 74 }
// What you say while circling (no typing: feedback is voice and pen)
const SAID = [
  [0.95, 1.95, 'Make Sign up stand out…'],
  [2.0, 2.85, '…and add a yearly toggle here.'],
]
const PLANS = { cx: BROWSER.x + 1 + 299, cy: PAGE_Y + 140, rx: 150, ry: 20 }
const FINDINGS = [
  { title: 'Sign up is easy to miss', said: '“Make Sign up stand out”', done: 'Solid brand color, white text' },
  { title: 'Add a yearly toggle', said: '“…and add a yearly toggle here”', done: 'Monthly / Yearly above plans' },
]

/* ── state over time ─────────────────────────────────── */

/** Everything the renderer needs at time t (seconds within the loop). */
export function heroState(t, loopIndex = 0) {
  const agent = ['claude', 'codex', 'gemini'][loopIndex % 3]
  const first = loopIndex === 0
  // the overlays of this loop fade out together at the end, so the next loop starts from the clean page
  const reset = 1 - inOutSine(seg(t, 7.9, 8.75))
  const card = (i) => ({
    appear: outBack(seg(t, 3.15 + i * 0.16, 3.75 + i * 0.16)),
    fly: inOutCubic(seg(t, 4.25 + i * 0.22, 5.05 + i * 0.22)),
  })
  return {
    agent,
    browser: first ? outCubic(seg(t, 0, 0.7)) : 1,
    rec: seg(t, 0.55, 0.8) * (1 - seg(t, 2.95, 3.2)),
    recTime: Math.floor(clamp(t - 0.55, 0, 9)),
    speak: seg(t, 0.8, 1.05) * (1 - seg(t, 2.6, 2.9)),
    cursor: seg(t, 0.6, 0.8) * (1 - seg(t, 2.75, 2.95)),
    cursorFrom: seg(t, 0.6, 1.0),
    pen: inOutSine(seg(t, 1.0, 1.9)),
    pen2: inOutSine(seg(t, 2.05, 2.7)),
    penFade: 1 - seg(t, 5.55, 5.95),
    caption: seg(t, 0.9, 1.1) * (1 - seg(t, 3.0, 3.25)),
    xfer: seg(t, 3.0, 3.65),
    flash: Math.max(0, 1 - Math.abs(t - 3.02) / 0.16),
    cards: [card(0), card(1)],
    term: first ? outCubic(seg(t, 3.55, 4.05)) : 1,
    termText: reset,
    cmdChars: Math.round(agent.length * seg(t, 3.85, 4.2)),
    lines: [5.1, 5.5, 5.95, DONE_AT].map((s) => seg(t, s, s + 0.2)),
    score: outCubic(seg(t, 5.95, 6.4)),
    fix: inOutCubic(seg(t, 5.75, 6.25)) * reset,
    done: seg(t, DONE_AT, DONE_AT + 0.5),
    doneFade: reset,
    t,
  }
}

/** A composed still for the poster: every step of the story visible at once. */
export function posterState() {
  const s = heroState(7.6, 1)
  return {
    ...s,
    agent: 'claude',
    cmdChars: 6,
    rec: 1,
    recTime: 4,
    speak: 0.7,
    pen: 1,
    pen2: 1,
    penFade: 1,
    caption: 1,
    xfer: 0,
    t: 1.9,
    cards: [{ appear: 1, fly: 0 }, { appear: 1, fly: 0 }],
    fix: 0,
    done: 0,
    poster: true,
  }
}

/* ── drawing helpers ─────────────────────────────────── */

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function bar(ctx, x, y, w, h, color) {
  ctx.fillStyle = color
  rr(ctx, x, y, w, h, h / 2)
  ctx.fill()
}

function text(ctx, str, x, y, { size = 13, weight = 500, color = C.text, font = SANS, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${font}`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(str, x, y)
}

function windowFrame(ctx, { x, y, w, h }, title) {
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 40
  ctx.shadowOffsetY = 18
  ctx.fillStyle = C.chrome
  rr(ctx, x, y, w, h, 12)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = C.chromeLine
  ctx.lineWidth = 1
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12)
  ctx.stroke()
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.arc(x + 18 + i * 16, y + 19, 4.5, 0, Math.PI * 2)
    ctx.fill()
  })
  if (title) text(ctx, title, x + 74, y + 19, { size: 13, color: C.muted, font: MONO })
}

/* A pen ellipse, drawn progressively and a little hand-made. */
function ellipsePath(p, cx, cy, rx, ry, start = -2.5) {
  const pts = []
  const n = 72
  const span = Math.PI * 2 * 1.1
  for (let i = 0; i <= n * p; i++) {
    const a = start + (i / n) * span
    const wob = 1 + 0.05 * Math.sin(i * 0.35) + (i / n) * 0.06
    pts.push([cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob])
  }
  return pts
}
const penPath = (p) => ellipsePath(p, SIGNUP.x + SIGNUP.w / 2, SIGNUP.y + SIGNUP.h / 2, 62, 26)
const plansPath = (p) => ellipsePath(p, PLANS.cx, PLANS.cy, PLANS.rx, PLANS.ry, -2.9)

function drawPen(ctx, x, y) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(-0.75)
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 6
  ctx.shadowOffsetY = 2
  ctx.fillStyle = '#1f1d2b'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  rr(ctx, -4.5, -34, 9, 27, 2.5)
  ctx.fill()
  ctx.stroke()
  ctx.shadowColor = 'transparent'
  ctx.fillStyle = C.pen
  ctx.beginPath()
  ctx.moveTo(-4.5, -7)
  ctx.lineTo(4.5, -7)
  ctx.lineTo(0, 2)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

/* ── scene parts ─────────────────────────────────────── */

function drawPage(ctx, s, { x, y, w, h }, scale = 1) {
  // A pricing page, light like a real dev server page. Coordinates are relative to the page box.
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.translate(x, y)
  ctx.scale(scale, scale)
  const pw = w / scale
  ctx.fillStyle = C.page
  ctx.fillRect(0, 0, pw, h / scale)
  // nav
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pw, 56)
  ctx.fillStyle = C.pageLine
  ctx.fillRect(0, 56, pw, 1)
  text(ctx, 'acme.', 24, 28, { size: 17, weight: 800, color: '#14141c' })
  ;[0, 1, 2].forEach((i) => bar(ctx, 190 + i * 62, 24, 44, 8, C.bar))
  // the Sign up button: pale (the problem), then fixed with a solid gradient
  const bx = pw - 140
  const by = 14
  const f = s.fix
  ctx.fillStyle = '#ecebff'
  rr(ctx, bx, by, 84, 28, 7)
  ctx.fill()
  if (f > 0) {
    ctx.save()
    ctx.globalAlpha *= f
    ctx.fillStyle = C.violet
    rr(ctx, bx, by, 84, 28, 7)
    ctx.fill()
    ctx.restore()
  }
  text(ctx, 'Sign up', bx + 42, by + 14.5, { size: 12.5, weight: 650, color: f > 0.5 ? '#ffffff' : '#7a72d9', align: 'center' })
  // headline
  text(ctx, 'Pricing that grows with you', pw / 2, 106, { size: 25, weight: 800, color: '#14141c', align: 'center' })
  // the subline becomes a Monthly / Yearly toggle once the second finding is fixed
  if (f < 1) {
    ctx.save()
    ctx.globalAlpha *= 1 - f
    bar(ctx, pw / 2 - 120, 136, 240, 9, C.bar)
    ctx.restore()
  }
  if (f > 0) {
    ctx.save()
    ctx.globalAlpha *= f
    ctx.fillStyle = '#ffffff'
    rr(ctx, pw / 2 - 78, 128, 156, 26, 13)
    ctx.fill()
    ctx.strokeStyle = C.pageLine
    ctx.lineWidth = 1
    rr(ctx, pw / 2 - 77.5, 128.5, 155, 25, 12.5)
    ctx.stroke()
    ctx.fillStyle = C.violet
    rr(ctx, pw / 2 + 2, 131, 73, 20, 10)
    ctx.fill()
    text(ctx, 'Monthly', pw / 2 - 38, 141.5, { size: 11, weight: 600, color: '#6b6b7b', align: 'center' })
    text(ctx, 'Yearly', pw / 2 + 38.5, 141.5, { size: 11, weight: 650, color: '#ffffff', align: 'center' })
    ctx.restore()
  }
  // cards
  const cw = 160
  const gap = 18
  const x0 = (pw - (cw * 3 + gap * 2)) / 2
  ;['$0', '$19', '$49'].forEach((price, i) => {
    const cx = x0 + i * (cw + gap)
    const cy = 176
    ctx.fillStyle = '#ffffff'
    rr(ctx, cx, cy, cw, 172, 10)
    ctx.fill()
    ctx.strokeStyle = i === 1 ? C.violet : C.pageLine
    ctx.lineWidth = i === 1 ? 2 : 1
    rr(ctx, cx, cy, cw, 172, 10)
    ctx.stroke()
    bar(ctx, cx + 16, cy + 20, 48, 8, C.bar)
    text(ctx, price, cx + 16, cy + 52, { size: 24, weight: 800, color: '#14141c' })
    ;[0, 1, 2].forEach((j) => bar(ctx, cx + 16, cy + 82 + j * 16, 96 - j * 14, 6, '#e4e4ec'))
    ctx.fillStyle = i === 1 ? C.violet : '#ffffff'
    rr(ctx, cx + 16, cy + 132, cw - 32, 26, 6)
    ctx.fill()
    if (i !== 1) {
      ctx.strokeStyle = '#d6d6e0'
      ctx.lineWidth = 1
      rr(ctx, cx + 16.5, cy + 132.5, cw - 33, 25, 6)
      ctx.stroke()
    }
  })
  ctx.restore()
}

function drawBrowser(ctx, s) {
  const b = BROWSER
  ctx.save()
  ctx.globalAlpha *= s.browser
  ctx.translate(0, (1 - s.browser) * 18)
  windowFrame(ctx, b)
  // URL pill
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  rr(ctx, b.x + 72, b.y + 8, 260, 22, 6)
  ctx.fill()
  text(ctx, 'localhost:3000/pricing', b.x + 84, b.y + 19.5, { size: 13, color: '#b9b8cc', font: MONO })
  // REC pill + voice waveform
  if (s.rec > 0) {
    ctx.save()
    ctx.globalAlpha *= s.rec
    const rx = b.x + b.w - 150
    ctx.fillStyle = 'rgba(255,61,139,0.14)'
    rr(ctx, rx, b.y + 8, 136, 22, 11)
    ctx.fill()
    ctx.save()
    ctx.globalAlpha *= 0.6 + 0.4 * Math.abs(Math.sin(s.t * 4))
    ctx.fillStyle = C.pen
    ctx.beginPath()
    ctx.arc(rx + 13, b.y + 19, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    text(ctx, `REC 00:0${s.recTime}`, rx + 23, b.y + 19.5, { size: 11, weight: 600, color: '#ffc2da', font: MONO })
    for (let i = 0; i < 9; i++) {
      const amp = s.speak * (0.35 + 0.65 * Math.abs(Math.sin(s.t * 9 + i * 1.7) * Math.cos(s.t * 3.1 + i)))
      const h = 3 + amp * 13
      bar(ctx, rx + 94 + i * 4.2, b.y + 19 - h / 2, 2.4, h, C.pen)
    }
    ctx.restore()
  }
  ctx.save()
  rr(ctx, b.x + 1, PAGE_Y, b.w - 2, b.h - 39, [0, 0, 11, 11])
  ctx.clip()
  drawPage(ctx, s, { x: b.x + 1, y: PAGE_Y, w: b.w - 2, h: b.h - 39 })
  ctx.restore()
  ctx.strokeStyle = C.chromeLine
  rr(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 12)
  ctx.stroke()

  // pen marks: the Sign up button, then the plans heading
  const stroke = (pts) => {
    ctx.beginPath()
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)))
    ctx.stroke()
  }
  if (s.penFade > 0 && (s.pen > 0 || s.pen2 > 0)) {
    ctx.save()
    ctx.globalAlpha *= s.penFade
    ctx.strokeStyle = C.pen
    ctx.lineWidth = 3.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.pen > 0) stroke(penPath(s.pen))
    if (s.pen2 > 0) stroke(plansPath(s.pen2))
    ctx.restore()
  }
  // cursor (pen tip) follows whichever mark is being drawn
  if (s.cursor > 0 && !s.poster) {
    const pts = s.pen2 > 0 ? plansPath(s.pen2) : penPath(Math.max(s.pen, 0.001))
    const [ex, ey] = pts[pts.length - 1]
    const from = outCubic(s.cursorFrom)
    const px = s.pen > 0 ? ex : lerp(b.x + 300, ex, from)
    const py = s.pen > 0 ? ey : lerp(b.y + 300, ey, from)
    ctx.save()
    ctx.globalAlpha *= s.cursor
    drawPen(ctx, px, py)
    ctx.restore()
  }
  // what you say while you circle, as a speech bubble (the app shows a live mic level in the REC pill;
  // the words themselves are transcribed after you stop and show up in each finding)
  if (s.caption > 0) {
    const line = [...SAID].reverse().find(([from]) => s.t >= from) ?? SAID[0]
    const [from, to, words] = line
    const shown = s.poster ? words : words.slice(0, Math.max(1, Math.round(words.length * seg(s.t, from, to))))
    ctx.save()
    ctx.globalAlpha *= s.caption
    ctx.font = `500 15px ${SANS}`
    const w = ctx.measureText(`“${words}”`).width + 58
    const x = b.x + 18
    const y = b.y + b.h - 54
    ctx.shadowColor = 'rgba(0,0,0,0.25)'
    ctx.shadowBlur = 12
    ctx.shadowOffsetY = 4
    ctx.fillStyle = '#ffffff'
    rr(ctx, x, y, w, 36, 12)
    ctx.fill()
    ctx.beginPath() // tail
    ctx.moveTo(x + 18, y + 36)
    ctx.lineTo(x + 30, y + 36)
    ctx.lineTo(x + 16, y + 46)
    ctx.closePath()
    ctx.fill()
    ctx.shadowColor = 'transparent'
    // mic level next to the words
    for (let i = 0; i < 4; i++) {
      const lv = s.poster ? 0.6 : s.speak * (0.3 + 0.7 * Math.abs(Math.sin(s.t * 10 + i * 1.9)))
      const h = 4 + lv * 14
      bar(ctx, x + 14 + i * 5, y + 18 - h / 2, 3, h, C.pen)
    }
    text(ctx, `“${shown}${shown.length === words.length ? '”' : ''}`, x + 42, y + 19, { size: 15, weight: 500, color: '#14141c' })
    ctx.restore()
  }
  // Done badge
  if (s.done > 0 && s.doneFade > 0) {
    const p = outCubic(s.done)
    const cx = SIGNUP.x + 64
    const cy = SIGNUP.y + 62
    ctx.save()
    ctx.globalAlpha *= s.doneFade * p
    ctx.translate(cx, cy + (1 - p) * 6)
    ctx.fillStyle = '#10241a'
    rr(ctx, -54, -16, 108, 32, 16)
    ctx.fill()
    ctx.strokeStyle = 'rgba(62,224,143,0.45)'
    ctx.lineWidth = 1
    rr(ctx, -53.5, -15.5, 107, 31, 15.5)
    ctx.stroke()
    text(ctx, '✓ Done', 0, 1, { size: 14, weight: 600, color: C.green, align: 'center' })
    ctx.restore()
  }
  ctx.restore()
}

function drawCard(ctx, s, i, x, y) {
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = 28
  ctx.shadowOffsetY = 12
  ctx.fillStyle = '#16151f'
  rr(ctx, x, y, CARD_W, CARD_H, 12)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  rr(ctx, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, 12)
  ctx.stroke()
  // still: a tiny page with the pen mark
  const tx = x + 10
  const ty = y + 16
  const k = 120 / 598
  ctx.save()
  rr(ctx, tx, ty, 120, 80, 7)
  ctx.clip()
  drawPage(ctx, { ...s, fix: 0 }, { x: tx, y: ty, w: 120, h: 80 }, k)
  ctx.strokeStyle = C.pen
  ctx.lineWidth = 1.6
  ctx.beginPath()
  if (i === 0) ctx.ellipse(tx + 100.3, ty + 5.6, 13, 6, 0, 0, Math.PI * 2)
  else ctx.ellipse(tx + 60, ty + 26, 34, 7, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  // number badge
  ctx.fillStyle = C.badge
  rr(ctx, tx + 4, ty + 4, 16, 16, 4)
  ctx.fill()
  text(ctx, String(i + 1), tx + 12, ty + 12.5, { size: 10, weight: 700, color: '#ffffff', align: 'center' })
  // request + done when
  const f = FINDINGS[i]
  const lx = x + 142
  text(ctx, f.title, lx, y + 24, { size: 15.5, weight: 650 })
  text(ctx, f.said, lx, y + 45, { size: 12.5, color: C.violetSoft })
  text(ctx, 'DONE WHEN', lx, y + 69, { size: 9.5, weight: 700, color: C.violetSoft, font: MONO })
  text(ctx, f.done, lx, y + 87, { size: 13, color: '#d4d3e2' })
}

function drawCards(ctx, s) {
  s.cards.forEach((c, i) => {
    if (c.appear <= 0 || c.fly >= 1) return
    const { x: x0, y: y0 } = CARDS[i]
    // fly along a curve into the terminal prompt
    const p = c.fly
    const ex = PROMPT.x + 70
    const ey = PROMPT.y + 2
    const mx = lerp(x0, ex, 0.5) + 120
    const my = Math.min(y0, ey) - 40
    const q = (a, b, m) => (1 - p) ** 2 * a + 2 * (1 - p) * p * m + p * p * b
    const x = q(x0 + CARD_W / 2, ex, mx)
    const y = q(y0 + CARD_H / 2, ey, my)
    const sc = lerp(1, 0.12, p) * lerp(0.85, 1, clamp(c.appear, 0, 1.2))
    ctx.save()
    ctx.globalAlpha *= clamp(c.appear) * (1 - seg(p, 0.75, 1))
    ctx.translate(x, y)
    ctx.scale(sc, sc)
    ctx.rotate(p * 0.25 * (i ? -1 : 1))
    drawCard(ctx, s, i, -CARD_W / 2, -CARD_H / 2)
    ctx.restore()
  })
}

/* At stop, the words become text and travel with the marks to their finding cards. */
function drawTransfer(ctx, s) {
  if (s.xfer <= 0 || s.xfer >= 1) return
  const p = inOutCubic(s.xfer)
  const fade = 1 - seg(s.xfer, 0.75, 1)
  const b = BROWSER
  const marks = [
    { from: [SIGNUP.x + SIGNUP.w / 2, SIGNUP.y + SIGNUP.h / 2, 62, 26], to: [CARDS[0].x + 10 + 100.3, CARDS[0].y + 16 + 5.6, 13, 6] },
    { from: [PLANS.cx, PLANS.cy, PLANS.rx, PLANS.ry], to: [CARDS[1].x + 10 + 60, CARDS[1].y + 16 + 26, 34, 7] },
  ]
  FINDINGS.forEach((f, i) => {
    const d = clamp((p - i * 0.12) / 0.88)
    if (d <= 0) return
    ctx.save()
    ctx.globalAlpha *= fade
    // the mark shrinks into the still
    const m = marks[i]
    ctx.strokeStyle = C.pen
    ctx.lineWidth = lerp(3, 1.6, d)
    ctx.beginPath()
    ctx.ellipse(lerp(m.from[0], m.to[0], d), lerp(m.from[1], m.to[1], d), lerp(m.from[2], m.to[2], d), lerp(m.from[3], m.to[3], d), 0, 0, Math.PI * 2)
    ctx.stroke()
    // the words, now text, move to the card
    const x = lerp(b.x + 24, CARDS[i].x + 142, d)
    const y = lerp(b.y + b.h - 36 - (1 - i) * 30, CARDS[i].y + 45, d)
    ctx.font = `500 13px ${SANS}`
    const w = ctx.measureText(f.said).width + 20
    ctx.fillStyle = 'rgba(22,21,31,0.95)'
    rr(ctx, x - 10, y - 12, w, 24, 8)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1
    rr(ctx, x - 9.5, y - 11.5, w - 1, 23, 7.5)
    ctx.stroke()
    text(ctx, f.said, x, y + 0.5, { size: 13, color: '#ecebf5' })
    ctx.restore()
  })
}

function drawTerminal(ctx, s) {
  if (s.term <= 0) return
  const t = TERM
  ctx.save()
  ctx.globalAlpha *= s.term
  ctx.translate(0, (1 - s.term) * 24)
  windowFrame(ctx, t, `1: ${s.agent}`)
  ctx.fillStyle = C.ink
  rr(ctx, t.x + 1, t.y + 38, t.w - 2, t.h - 39, [0, 0, 11, 11])
  ctx.fill()
  ctx.fillStyle = C.chromeLine
  ctx.fillRect(t.x + 1, t.y + 38, t.w - 2, 1)
  const lx = t.x + 22
  let ly = t.y + 70
  text(ctx, 'acme-shop', lx, ly, { size: 15, color: C.violetSoft, font: MONO })
  text(ctx, '%', lx + 92, ly, { size: 15, color: C.muted, font: MONO })
  ctx.save()
  ctx.globalAlpha *= s.termText
  const cmd = s.agent.slice(0, s.cmdChars)
  text(ctx, cmd, lx + 112, ly, { size: 15, weight: 600, color: C.text, font: MONO })
  const score = (0.94 * s.score).toFixed(2)
  const out = [
    [['›', C.violetSoft], [' Read 2 findings from .ferret/reviews/', C.text]],
    [['  ✎', C.magenta], [' Header.tsx  Pricing.tsx', C.text], ['  +18 −3', C.muted]],
    [['  ⟳', C.violetSoft], [' Compared with your screenshot · score ', C.muted], [score, C.text]],
    [['✓', C.green], [' Done 2/2', C.green], [' · verified against your screenshots', C.muted]],
  ]
  out.forEach((parts, i) => {
    const a = s.lines[i]
    if (a <= 0) return
    ly += 34
    ctx.save()
    ctx.globalAlpha *= a
    let x = lx + (1 - a) * 8
    for (const [str, color] of parts) {
      const bold = i === 3 && color === C.green
      text(ctx, str, x, ly, { size: 15, weight: bold ? 700 : 500, color, font: MONO })
      x += ctx.measureText(str).width
    }
    if (i === 2) {
      // a small score bar
      bar(ctx, x + 12, ly - 3, 80, 6, 'rgba(255,255,255,0.08)')
      if (s.score > 0) bar(ctx, x + 12, ly - 3, Math.max(6, 80 * 0.94 * s.score), 6, '#c9c8d4')
    }
    ctx.restore()
  })
  // block cursor
  if (!s.poster && Math.floor(s.t * 2.5) % 2 === 0) {
    ctx.font = `600 15px ${MONO}`
    ctx.fillStyle = 'rgba(236,235,245,0.75)'
    const typed = s.lines[0] > 0
    const cy = typed ? ly + 34 : t.y + 70
    const cx = typed ? lx : lx + 112 + ctx.measureText(cmd).width + 4
    ctx.fillRect(cx, cy - 9, 9, 18)
  }
  ctx.restore()
  ctx.restore()
}

/** Draws one frame. ctx is already scaled so that the scene is HERO_W × HERO_H. */
export function drawHero(ctx, s) {
  ctx.clearRect(0, 0, HERO_W, HERO_H)
  ctx.save()
  drawBrowser(ctx, s)
  drawTerminal(ctx, s)
  drawCards(ctx, s)
  drawTransfer(ctx, s)
  if (s.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${s.flash * 0.18})`
    rr(ctx, BROWSER.x, BROWSER.y, BROWSER.w, BROWSER.h, 12)
    ctx.fill()
  }
  ctx.restore()
}

/* ── mounting ────────────────────────────────────────── */

/**
 * Starts the animation on a canvas. It only draws while the canvas is on screen and the tab is visible.
 * onFirstFrame runs once, right after the first frame is actually drawn, so the page can swap the poster
 * for the canvas without ever showing an empty canvas. While paused the canvas keeps its last frame,
 * and a resize redraws that frame instead of leaving the cleared canvas blank.
 */
export function mountHero(canvas, { onFirstFrame } = {}) {
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.roundRect !== 'function') return false
  let raf = 0
  let last = null
  let start = 0
  let pausedAt = 0
  let onScreen = false
  let scale = 1
  let lastDoneLoop = -1

  const draw = (state) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    drawHero(ctx, state)
    if (!last && onFirstFrame) onFirstFrame()
    last = state
  }
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    scale = (w * dpr) / HERO_W
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round((w * HERO_H * dpr) / HERO_W)
    if (last) draw(last) // setting the size clears the canvas
  }
  const frame = (now) => {
    if (!start) start = now
    const elapsed = (now - start) / 1000
    const loop = Math.floor(elapsed / HERO_LOOP)
    const t = elapsed % HERO_LOOP
    draw(heroState(t, loop))
    if (t >= DONE_AT && loop !== lastDoneLoop) {
      lastDoneLoop = loop
      canvas.dispatchEvent(new CustomEvent('hero:done', { bubbles: true }))
    }
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
  new ResizeObserver(() => resize()).observe(canvas)
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting
    onScreen ? run() : stop()
  }).observe(canvas)
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()))
  return true
}

const canvas = typeof document !== 'undefined' ? document.querySelector('[data-hero-canvas]') : null
if (canvas) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  // Reduced motion and phone widths keep the static poster; the canvas replaces it only after its first frame is drawn
  const small = matchMedia('(max-width: 720px)')
  const stage = canvas.closest('[data-hero-stage]')
  const live = !reduce.matches && !small.matches && mountHero(canvas, { onFirstFrame: () => stage?.classList.add('is-live') })
  if (live) {
    // Echo the Done moment on the page (e.g. the headline's "done" word)
    const echo = document.querySelector('[data-hero-done]')
    if (echo) {
      canvas.addEventListener('hero:done', () => {
        echo.classList.remove('is-done')
        void echo.offsetWidth
        echo.classList.add('is-done')
      })
    }
  }
}
