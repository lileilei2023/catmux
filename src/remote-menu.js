'use strict'
// Minimal right-click menu shared by the session list, terminal and workbench.
// Items: { label, hint, action, disabled, danger } or '-' for a separator.
;(() => {
  let menu = null, restoreFocus = null
  function close() {
    if (!menu) return
    menu.remove(); menu = null
    document.removeEventListener('mousedown', outside, true)
    window.removeEventListener('blur', close); window.removeEventListener('resize', close)
    document.removeEventListener('scroll', close, true)
    restoreFocus?.focus?.(); restoreFocus = null
  }
  function outside(e) { if (menu && !menu.contains(e.target)) close() }
  function open(event, items) {
    event.preventDefault(); event.stopPropagation()
    close()
    const list = items.filter(Boolean).filter((item, i, all) => item !== '-' || (i > 0 && all[i - 1] !== '-' && i < all.length - 1))
    if (!list.length) return
    restoreFocus = document.activeElement
    menu = document.createElement('div'); menu.className = 'ctx-menu'; menu.setAttribute('role', 'menu')
    for (const item of list) {
      if (item === '-') { const hr = document.createElement('div'); hr.className = 'ctx-sep'; hr.setAttribute('role', 'separator'); menu.append(hr); continue }
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ctx-item' + (item.danger ? ' danger' : '')
      b.setAttribute('role', 'menuitem'); b.disabled = !!item.disabled
      const label = document.createElement('span'); label.textContent = item.label; b.append(label)
      if (item.hint) { const hint = document.createElement('kbd'); hint.textContent = item.hint; b.append(hint) }
      b.addEventListener('click', () => { close(); Promise.resolve().then(item.action).catch(e => window.AIHubToast?.(e.message)) })
      menu.append(b)
    }
    menu.addEventListener('keydown', e => {
      const buttons = [...menu.querySelectorAll('.ctx-item:not(:disabled)')], index = buttons.indexOf(document.activeElement)
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus() }
      e.stopPropagation()
    })
    document.body.append(menu)
    const r = menu.getBoundingClientRect()
    menu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - r.width - 4)) + 'px'
    menu.style.top = Math.max(4, Math.min(event.clientY, innerHeight - r.height - 4)) + 'px'
    menu.querySelector('.ctx-item:not(:disabled)')?.focus({ preventScroll: true })
    document.addEventListener('mousedown', outside, true)
    window.addEventListener('blur', close); window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
  }
  window.AIHubMenu = { open, close, get isOpen() { return !!menu } }
})()
