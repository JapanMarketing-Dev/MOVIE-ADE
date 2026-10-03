// Small behaviors for the docs: theme toggle (same key as ../js/app.js), collapsible page list on narrow
// screens, copy buttons on code blocks, and the active heading in "On this page".
// ../js/app.js is not loaded here because it fetches the release list.
;(() => {
  const THEME_KEY = 'ade-site-theme'
  const root = document.documentElement

  const currentTheme = () => {
    const set = root.dataset.theme
    if (set === 'light' || set === 'dark') return set
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark'
      root.dataset.theme = next
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        // Storage may be blocked; the page still switches
      }
    })
  }

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
