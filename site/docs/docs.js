// Small behaviors for the docs: collapsible page list on narrow screens, lazy feature clips, copy buttons on code blocks, and the active heading in "On this page".
// ../js/app.js is not loaded here because it fetches the release list.
;(() => {
  for (const node of document.querySelectorAll('[data-year]')) node.textContent = String(new Date().getFullYear())

  // Collapse the page list on narrow screens. Without JS it stays open
  const sidebar = document.getElementById('docs-sidebar')
  const toggle = document.querySelector('[data-docs-nav-toggle]')
  if (sidebar && toggle) {
    sidebar.classList.add('is-collapsed')
    toggle.setAttribute('aria-expanded', 'false')
    toggle.addEventListener('click', () => {
      const open = sidebar.classList.toggle('is-collapsed') === false
      toggle.setAttribute('aria-expanded', String(open))
    })
  }

  // Copy buttons on code blocks
  for (const pre of document.querySelectorAll('.docs-content pre')) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'docs-copy'
    button.textContent = 'Copy'
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText)
        button.textContent = 'Copied'
      } catch {
        button.textContent = 'Copy failed'
      }
      setTimeout(() => (button.textContent = 'Copy'), 1500)
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
    { rootMargin: '-64px 0px -60% 0px' },
  )
  for (const id of links.keys()) {
    const h = document.getElementById(id)
    if (h) observer.observe(h)
  }
})()
