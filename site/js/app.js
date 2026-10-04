// 画面の組み立て。判別・整形は releases.js の純粋関数に任せ、ここは DOM・fetch・保存だけを扱う。
import { DOWNLOAD_BASE, REPO_URL } from './config.js?v=412f94b4'
import {
  BUILD_DOC_URL,
  CURRENT_PRODUCT,
  SLOTS,
  OS_LABEL,
  assetForSlot,
  normalizeIndex,
  normalizeManifest,
  detectPlatform,
  recommendedSlot,
  formatBytes,
  formatDate,
  excerptNotes,
} from './releases.js?v=4fd86d60'
import { fetchBoundedJson, fetchVerifiedBytes, verifyRelease } from './verify.js?v=de71aa1d'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/** 要素を作る小さな関数。文字は必ず textContent で入れる（リリースノートを HTML として扱わない） */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c)
  return node
}

function icon(id, extra = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', `icon ${extra}`.trim())
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

/* ── スクロールで現れる演出 ───────────────────────── */

/** .reveal を画面に入ったときに表示する。動きを減らす設定・IntersectionObserver が無い環境では最初から表示する */
function setupReveal() {
  const nodes = $$('.reveal')
  if (!nodes.length) return
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    for (const n of nodes) n.classList.add('is-in')
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('is-in')
        io.unobserve(e.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  )
  for (const n of nodes) io.observe(n)
}

/* ── 端末と索引の取得 ───────────────────────────────── */

async function readPlatform() {
  const env = { userAgent: navigator.userAgent, platform: navigator.platform }
  const data = navigator.userAgentData
  if (data) {
    env.uaPlatform = data.platform
    try {
      const high = await data.getHighEntropyValues(['architecture', 'bitness'])
      env.uaArch = high.architecture
      env.uaBitness = high.bitness
    } catch {
      // CPU が分からないだけ。OS の判別は続ける
    }
  }
  return detectPlatform(env)
}

/**
 * R2 の JSON を読む。まだ置かれていない（404・403）ときは null、通信の失敗は例外。
 * 本文は大きさと時間の上限つきで読む（res.json() は最後まで溜めるので使わない。security-5 [12]。verify.js）
 * @param {string} url
 */
const fetchJson = (url) => fetchBoundedJson(url)

/** @returns {Promise<{ state: 'ok'|'empty'|'error', release?: any }>} */
async function loadLatest() {
  try {
    const data = await fetchJson(`${DOWNLOAD_BASE}/latest.json`)
    const release = normalizeManifest(data, DOWNLOAD_BASE)
    // 署名で確かめたファイルだけを出す（security-4 [2]。verify.js）
    return release ? { state: 'ok', release: await verifyRelease(release, DOWNLOAD_BASE) } : { state: 'empty' }
  } catch {
    return { state: 'error' }
  }
}

/** @returns {Promise<{ state: 'ok'|'empty'|'error', latest?: any, all?: any[] }>} */
async function loadIndex() {
  try {
    const data = await fetchJson(`${DOWNLOAD_BASE}/versions.json`)
    const { latest, all } = normalizeIndex(data, DOWNLOAD_BASE)
    if (!latest) return { state: 'empty' }
    const release = normalizeManifest(await fetchJson(latest.manifestUrl), DOWNLOAD_BASE)
    if (!release) return { state: 'error' }
    return { state: 'ok', latest: await verifyRelease(release, DOWNLOAD_BASE), all }
  } catch {
    return { state: 'error' }
  }
}

/** 外部へのリンクは新しいタブで開き、そのことを読み上げにも伝える（インストーラ本体へのリンクには使わない） */
const newTabNote = () => el('span', { class: 'sr-only', text: ' (opens in a new tab)' })

function externalLink(props, ...children) {
  return el('a', { ...props, target: '_blank', rel: 'noopener noreferrer' }, ...children, newTabNote())
}

/* ── 確かめてから保存するダウンロード ─────────────────── */

/**
 * リンクを、署名で確かめたファイルのダウンロードにする（security-4 [2]）。
 * href にはインストーラーの URL を置かない。クリックで中身を取り、SHA-256 が署名の値と同じときだけ保存する。
 * 取っている間は label に進み具合を出す
 * @param {HTMLAnchorElement} anchor
 * @param {{ name: string, url: string, size: number, sha256: string }} asset
 * @param {Element} [label]
 */
function bindDownload(anchor, asset, label = anchor) {
  anchor.href = '#'
  anchor.removeAttribute('target')
  anchor.onclick = async (event) => {
    event.preventDefault()
    if (anchor.getAttribute('aria-busy') === 'true') return
    const original = label.textContent
    anchor.setAttribute('aria-busy', 'true')
    try {
      const blob = await fetchVerifiedBytes(asset, (fraction) => {
        label.textContent = `Downloading… ${Math.floor(fraction * 100)}%`
      })
      const url = URL.createObjectURL(blob)
      const save = el('a', { href: url, download: asset.name, hidden: true })
      document.body.append(save)
      save.click()
      save.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      label.textContent = original
    } catch {
      label.textContent = 'Couldn’t download. Try again.'
      setTimeout(() => { label.textContent = original }, 4000)
    } finally {
      anchor.removeAttribute('aria-busy')
    }
  }
}

/* ── トップ: ヒーローのボタン ───────────────────────── */

function renderHero(result, platform) {
  const button = $('[data-hero-download]')
  const label = $('[data-hero-label]')
  const meta = $('[data-hero-meta]')
  if (!button) return

  if (result.state === 'empty') {
    button.href = BUILD_DOC_URL
    button.target = '_blank'
    button.rel = 'noopener noreferrer'
    button.querySelector('use')?.setAttribute('href', '#i-code')
    label.textContent = 'Build from source'
    if (!button.querySelector('.sr-only')) button.append(newTabNote())
    meta.textContent = 'Build it from source on GitHub.'
    return
  }
  if (result.state === 'error') {
    button.href = 'download.html'
    label.textContent = 'Download'
    meta.textContent = ''
    return
  }

  const { release } = result
  const slot = recommendedSlot(platform)
  const asset = slot ? assetForSlot(release.assets, slot) : null
  if (slot && asset) {
    label.textContent = `Download for ${slot.label}`
    bindDownload(button, asset, label)
    meta.textContent = [release.tag, slot.detail, formatBytes(asset.size)].filter(Boolean).join(' · ')
  } else {
    button.href = 'download.html'
    label.textContent = 'Download'
    meta.textContent = release.tag
  }
}

/* ── ダウンロードページ ─────────────────────────────── */

function showStatus(kind, platform) {
  const box = $('[data-status]')
  if (!box) return
  box.replaceChildren()
  if (kind === 'empty') {
    box.append(
      icon('i-info'),
      el('div', {},
        el('p', {}, el('strong', { text: 'Build Ferret from source on GitHub.' })),
        el('p', {}, 'See the ', externalLink({ href: BUILD_DOC_URL }, 'build instructions'), ' in the README (Node.js 22 and pnpm required).'),
        el('pre', {}, el('code', { text: `git clone ${REPO_URL}.git\ncd ferret\npnpm install\npnpm dev` })),
      ),
    )
  } else if (kind === 'error') {
    box.append(
      icon('i-info'),
      el('div', {},
        el('p', {}, el('strong', { text: 'Couldn’t load the list of versions.' })),
        el('p', { text: 'Check your connection and reload the page.' }),
      ),
    )
  } else if (platform?.mobile) {
    box.append(icon('i-info'), el('div', {}, el('p', { text: 'Ferret is a desktop app. Download it on your computer.' })))
  } else {
    box.hidden = true
    return
  }
  box.hidden = false
}

/** 大きなボタンの横に添える、開き方の1行 */
const OPEN_HINT = {
  mac: 'Open the .dmg and drag Ferret to Applications.',
  win: 'Run it. Ferret installs and opens.',
  linux: 'Double-click it to install, then open Ferret from your app menu.',
}

/** 見ている OS に合う1つの大きなボタン。OS が分からない・その版に無いときは出さない（下の一覧から選ぶ） */
function renderPrimary(release, platform) {
  const box = $('[data-primary]')
  if (!box) return
  const slot = recommendedSlot(platform)
  const asset = release && slot ? assetForSlot(release.assets, slot) : null
  if (!slot || !asset) {
    box.hidden = true
    return
  }
  $('[data-primary-label]').textContent = `Download for ${slot.label}`
  bindDownload($('[data-primary-download]'), asset, $('[data-primary-label]'))
  $('[data-primary-meta]').textContent = [release.tag, slot.detail, formatBytes(asset.size)].filter(Boolean).join(' · ')
  $('[data-primary-hint]').textContent = OPEN_HINT[slot.os] ?? ''
  box.hidden = false
}

function renderSlots(release, platform, missingText = '—') {
  const recommended = recommendedSlot(platform)
  for (const slot of SLOTS) {
    const node = $(`[data-slot="${slot.id}"]`)
    if (!node) continue
    const asset = release ? assetForSlot(release.assets, slot) : null
    const isRecommended = Boolean(asset && recommended && recommended.id === slot.id)
    node.classList.toggle('is-recommended', isRecommended)
    const fileText = asset
      ? [asset.name, formatBytes(asset.size)].filter(Boolean).join(' · ')
      : release === undefined ? 'Loading…' : release ? 'Not in this release' : missingText
    node.replaceChildren(
      el('span', { class: 'slot-name' }, slot.detail, isRecommended ? el('span', { class: 'badge badge-accent', text: 'Your device' }) : null),
      el('span', { class: 'slot-file', text: fileText }),
      asset ? slotLink(asset, slot, isRecommended) : el('span', { class: 'unavailable', text: '—' }),
    )
  }
}

function slotLink(asset, slot, isRecommended) {
  const text = el('span', { text: 'Download' })
  const link = el('a', { class: `btn btn-sm${isRecommended ? ' btn-primary' : ''}`, 'aria-label': `Download for ${slot.label} ${slot.detail}` }, icon('i-download'), text)
  bindDownload(link, asset, text)
  return link
}

function fileLink(asset) {
  const link = el('a', { text: asset.name })
  bindDownload(link, asset)
  return link
}

const OS_ORDER = { mac: 0, win: 1, linux: 2 }

function fileLabel(info) {
  const arch = info.os === 'mac' ? { arm64: 'Apple silicon', x64: 'Intel', universal: 'Universal' }[info.arch] : { arm64: 'Arm64', x64: 'x64', universal: 'Universal' }[info.arch]
  return `${OS_LABEL[info.os]} ${arch}`
}

function versionBody(release) {
  const notes = excerptNotes(release.notes)
  const files = [...release.assets].sort((a, b) => OS_ORDER[a.info.os] - OS_ORDER[b.info.os] || a.name.localeCompare(b.name))
  return [
    el('div', {},
      el('h4', { text: 'Release notes' }),
      notes.length ? el('ul', { class: 'notes' }, notes.map((t) => el('li', { text: t }))) : el('p', { class: 'muted', text: 'No release notes.' }),
      release.notesUrl ? externalLink({ class: 'version-link', href: release.notesUrl }, 'Full release notes', icon('i-external')) : null,
    ),
    el('div', {},
      el('h4', { text: 'Files' }),
      files.length
        ? el('ul', { class: 'files' }, files.map((f) => el('li', {},
            el('span', { class: 'os' }, fileLabel(f.info)),
            fileLink(f),
            el('span', { class: 'size', text: formatBytes(f.size) }),
          )))
        : el('p', { class: 'muted', text: 'No downloadable files.' }),
    ),
  ]
}

function renderVersions(all, latest) {
  const box = $('[data-versions]')
  if (!box) return
  if (!all.length) {
    box.replaceChildren(el('p', { class: 'loading', text: 'No versions published yet.' }))
    return
  }
  box.replaceChildren(
    ...all.map((entry) => {
      const isLatest = entry.version === latest.version
      const body = el('div', { class: 'version-body' })
      const details = el('details', { class: 'version', open: isLatest },
        el('summary', {},
          el('span', { class: 'version-name', text: entry.tag }),
          // 改名前（0.1.x）の版には旧名を添える
          entry.product !== CURRENT_PRODUCT ? el('span', { class: 'badge', title: 'Former name', text: entry.product }) : null,
          isLatest ? el('span', { class: 'badge badge-accent', text: 'Latest' }) : null,
          entry.prerelease ? el('span', { class: 'badge badge-warn', text: 'Pre-release' }) : null,
          el('span', { class: 'version-date', text: formatDate(entry.date) }),
          icon('i-chev', 'chev'),
        ),
        body,
      )
      // 最新版はもう読んである。過去の版は開いたときに manifest を読む
      if (isLatest) body.append(...versionBody(latest))
      else {
        body.append(el('p', { class: 'loading', text: 'Loading…' }))
        let loaded = false
        details.addEventListener('toggle', async () => {
          if (!details.open || loaded) return
          loaded = true
          try {
            const parsed = normalizeManifest(await fetchJson(entry.manifestUrl), DOWNLOAD_BASE)
            const release = parsed ? await verifyRelease(parsed, DOWNLOAD_BASE) : null
            body.replaceChildren(...(release ? versionBody(release) : [el('p', { class: 'muted', text: 'This version’s details aren’t available.' })]))
          } catch {
            loaded = false
            body.replaceChildren(el('p', { class: 'muted', text: 'Couldn’t load this version. Close and reopen to retry.' }))
          }
        })
      }
      return details
    }),
  )
}

function renderDownloadPage(result, platform) {
  const meta = $('[data-latest-meta]')
  if (result.state === 'ok') {
    const { latest } = result
    meta.textContent = [latest.tag, formatDate(latest.date)].filter(Boolean).join(' · ')
    showStatus(null, platform)
    renderPrimary(latest, platform)
    renderSlots(latest, platform)
    renderVersions(result.all, latest)
  } else if (result.state === 'empty') {
    meta.textContent = ''
    showStatus('empty', platform)
    renderSlots(null, platform)
    renderVersions([], null)
  } else {
    meta.textContent = 'Unavailable'
    showStatus('error', platform)
    renderSlots(null, platform, 'Unavailable')
    $('[data-versions]')?.replaceChildren(el('p', { class: 'loading', text: 'Couldn’t load the list of versions.' }))
  }
}

/* ── ヘッダーの現在地 ───────────────────────────────── */

/**
 * ダウンロードのページでは、ヘッダーの「Download」と「Changelog」のどちらか一方だけを現在地にする。
 * 版の一覧（#versions）が画面の上半分に入ったら Changelog、それより上なら Download。
 */
function setupNavCurrent() {
  const download = $('.site-nav a[href="download.html"]')
  const changelog = $('.site-nav a[href="download.html#versions"]')
  const versions = document.getElementById('versions')
  if (!download || !changelog || !versions) return
  const update = () => {
    const inChangelog = versions.getBoundingClientRect().top < window.innerHeight / 2
    for (const [link, on] of [[download, !inChangelog], [changelog, inChangelog]]) {
      if (on) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
  }
  update()
  window.addEventListener('scroll', update, { passive: true })
  window.addEventListener('hashchange', update)
  window.addEventListener('resize', update)
}

/* ── 起動 ───────────────────────────────────────────── */

async function main() {
  setupReveal()
  for (const node of $$('[data-year]')) node.textContent = String(new Date().getFullYear())

  const page = document.body.dataset.page
  if (page === 'download') {
    setupNavCurrent()
    renderSlots(undefined, null) // 取得までの枠
    const [platform, result] = await Promise.all([readPlatform(), loadIndex()])
    renderDownloadPage(result, platform)
  } else if (page === 'home') {
    const [platform, result] = await Promise.all([readPlatform(), loadLatest()])
    renderHero(result, platform)
  }
}

main()
