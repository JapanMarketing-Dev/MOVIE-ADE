// Small behaviors for the docs: shortcuts for the reader's OS, collapsible page list on narrow screens, lazy feature clips, copy buttons on code blocks, and the active heading in "On this page".
// ../js/app.js is not loaded here because it fetches the release list.
// The language is never picked from the browser: pages only change language through the menu in the header.
;(() => {
  for (const node of document.querySelectorAll('[data-year]')) node.textContent = String(new Date().getFullYear())

  // Shortcuts: the pages list both macOS and Windows / Linux keys. Keep the reader's OS (or the one picked with the switch)
  const OS_KEY = 'ferret-docs-os'
  const store = {
    get: () => {
      try {
        return localStorage.getItem(OS_KEY)
      } catch {
        return null
      }
    },
    set: (value) => {
      try {
        localStorage.setItem(OS_KEY, value)
      } catch {}
    },
  }
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
  const detected = /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'win'
  const setOs = (os) => {
    document.documentElement.dataset.os = os
    for (const b of document.querySelectorAll('[data-os-choice]')) b.setAttribute('aria-pressed', String(b.dataset.osChoice === os))
  }
  const saved = store.get()
  setOs(saved === 'mac' || saved === 'win' ? saved : detected)
  for (const sw of document.querySelectorAll('[data-docs-os]')) sw.hidden = false
  for (const b of document.querySelectorAll('[data-os-choice]'))
    b.addEventListener('click', () => {
      setOs(b.dataset.osChoice)
      store.set(b.dataset.osChoice)
    })

  // Language menu: close it on Escape or a click outside
  const langMenu = document.querySelector('.docs-lang')
  if (langMenu) {
    document.addEventListener('click', (e) => {
      if (langMenu.open && !langMenu.contains(e.target)) langMenu.open = false
    })
    langMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && langMenu.open) {
        langMenu.open = false
        langMenu.querySelector('summary')?.focus()
      }
    })
  }

  // Collapse the page list on narrow screens. Without JS it stays open
  const sidebar = document.getElementById('docs-sidebar')
  const toggle = document.querySelector('[data-docs-nav-toggle]')
  if (sidebar && toggle) {
    sidebar.classList.add('is-collapsed')
    toggle.setAttribute('aria-expanded', 'false')
    toggle.addEventListener('click', () => {
      const open = sidebar.classList.toggle('is-collapsed') === false
      sidebar.classList.toggle('is-open', open)
      toggle.setAttribute('aria-expanded', String(open))
    })
  }

  // Copy buttons on code blocks
  const label = { copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', ...document.body.dataset }
  for (const pre of document.querySelectorAll('.docs-content pre')) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'docs-copy'
    button.textContent = label.copy
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText)
        button.textContent = label.copied
      } catch {
        button.textContent = label.copyFailed
      }
      setTimeout(() => (button.textContent = label.copy), 1500)
    })
    pre.append(button)
  }

  // Feature clips: load and play only while on screen. With reduced motion, keep the poster image only
  const clips = [...document.querySelectorAll('video.docs-clip-video[data-src]')]
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (clips.length && !reduceMotion && 'IntersectionObserver' in window) {
    const load = (video) => {
      if (video.dataset.loaded) return
      video.dataset.loaded = '1'
      if (video.dataset.srcWebm) video.append(Object.assign(document.createElement('source'), { src: video.dataset.srcWebm, type: 'video/webm' }))
      video.append(Object.assign(document.createElement('source'), { src: video.dataset.src, type: 'video/mp4' }))
      video.load()
    }
    const clipObserver = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (isIntersecting) {
            load(target)
            target.play().catch(() => {})
          } else target.pause()
        }
      },
      { rootMargin: '200px 0px' },
    )
    for (const video of clips) clipObserver.observe(video)
  }

  // "On this page": highlight the first heading near the top of the viewport
  const links = new Map()
  for (const a of document.querySelectorAll('.docs-toc a[href^="#"]')) links.set(a.getAttribute('href').slice(1), a)
  if (!links.size || !('IntersectionObserver' in window)) return
  const visible = new Set()
  const update = () => {
    const first = [...links.keys()].find((id) => visible.has(id))
    if (!first) return
    for (const [id, a] of links) a.classList.toggle('is-active', id === first)
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id)
      update()
    },
    { rootMargin: '-76px 0px -60% 0px' },
  )
  for (const id of links.keys()) {
    const h = document.getElementById(id)
    if (h) observer.observe(h)
  }
})()
