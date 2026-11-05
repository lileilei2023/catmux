'use strict'
// Remote directory completion for the "new session" project field.
// One SSH call lists a whole remote directory; further typing inside it is
// filtered locally. "~" and "~/x" are expanded on the server, never locally.
;(() => {
  const cache = new Map() // host + dir -> { at, promise }
  const TTL = 30000
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el }
  function split(value) {
    if (value === '~') return { dir: '~/', prefix: '' }
    const i = value.lastIndexOf('/')
    return i < 0 ? null : { dir: value.slice(0, i + 1), prefix: value.slice(i + 1) }
  }
  const request = dir => dir === '/' ? '/' : dir.replace(/\/+$/, '') || '/'
  const join = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name

  function attach({ input, list, hint, hub, host, recent }) {
    let items = [], index = -1, seq = 0, timer = null, open = false, itemsFor = null
    function listing(dir, fresh = false) {
      const key = host() + '\n' + request(dir), hit = cache.get(key)
      if (hit && !fresh && Date.now() - hit.at < TTL) return hit.promise
      const promise = hub.listDirs(host(), request(dir))
      cache.set(key, { at: Date.now(), promise }); promise.catch(() => cache.delete(key))
      return promise
    }
    function setHint(text, kind = '') { hint.textContent = text; hint.className = 'path-hint' + (kind ? ' ' + kind : '') }
    function close() { open = false; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant') }
    function show(next, title) {
      itemsFor = input.value; items = next; index = next.length && input.value && !input.value.endsWith('/') ? 0 : -1
      list.replaceChildren()
      if (!items.length || document.activeElement !== input) { close(); return }
      if (title) list.append(node('div', title, 'suggest-title'))
      items.forEach((item, i) => {
        const el = node('div', null, 'suggest-item'); el.id = 'suggest-' + i; el.setAttribute('role', 'option')
        el.append(node('span', item.label, 'suggest-name'))
        if (item.detail) el.append(node('small', item.detail))
        if (item.git) el.append(node('span', 'git', 'suggest-git'))
        el.addEventListener('mousedown', e => { e.preventDefault(); accept(item) })
        list.append(el)
      })
      open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); highlight()
    }
    function highlight() {
      list.querySelectorAll('.suggest-item').forEach((el, i) => el.classList.toggle('active', i === index))
      const el = list.querySelector('.suggest-item.active')
      if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }) } else input.removeAttribute('aria-activedescendant')
    }
    function accept(item) {
      input.value = item.value
      input.dispatchEvent(new Event('change'))
      if (item.value.endsWith('/')) update() // descend into the chosen directory
      else { close(); update(false) }
      input.focus(); input.setSelectionRange(input.value.length, input.value.length)
    }
    function recentItems() {
      const seen = new Set(), out = []
      for (const p of recent()) if (p && !seen.has(p)) { seen.add(p); out.push({ value: p, label: p, detail: '最近' }) }
      for (const p of ['~/', '~/workspace/']) if (!seen.has(p)) out.push({ value: p, label: p, detail: '远端主目录' })
      return out.slice(0, 10)
    }
    async function update(showList = true) {
      const value = input.value, my = ++seq
      if (!value.trim()) { if (showList) show(recentItems(), '最近使用 / 常用'); setHint('支持 ~/ 开头，例如 ~/workspace/my-project；↑↓ 选择，Tab 补全'); return }
      if (!/^[/~]/.test(value)) { close(); setHint('远端路径需以 / 或 ~/ 开头', 'error'); return }
      if (/^~[^/]/.test(value)) { close(); setHint('只支持当前远端用户的 ~/', 'error'); return }
      const part = split(value); if (!part) { close(); return }
      const key = host() + '\n' + request(part.dir)
      if (!cache.has(key)) setHint(`正在读取 ${host()}:${part.dir}…`, 'busy')
      let data
      try { data = await listing(part.dir) } catch (e) { if (my === seq) { close(); setHint(e.message, 'error') } return }
      if (my !== seq) return
      const lower = part.prefix.toLowerCase(), hidden = part.prefix.startsWith('.')
      const visible = data.entries.filter(e => hidden || !e.hidden)
      const starts = visible.filter(e => e.name.toLowerCase().startsWith(lower))
      const contains = lower ? visible.filter(e => !e.name.toLowerCase().startsWith(lower) && e.name.toLowerCase().includes(lower)) : []
      if (showList) show([...starts, ...contains].slice(0, 80).map(e => ({ value: part.dir + e.name + '/', label: e.name, git: e.git })), null)
      const exact = part.prefix && data.entries.find(e => e.name === part.prefix)
      const where = `${host()}:${exact ? join(data.dir, exact.name) : data.dir}`
      if (!data.exists) setHint(`${host()} 上不存在 ${data.dir}`, 'error')
      else if (exact || !part.prefix) {
        const git = exact ? exact.git : data.git
        setHint(`${where} · ${git ? 'Git 仓库，可创建 worktree' : '非 Git 目录（Codex/Claude 需要 Git 仓库；远程 Shell 可用）'}`, git ? 'ok' : 'warn')
      } else setHint(starts.length + contains.length ? `${starts.length + contains.length} 个候选 · ↑↓ 选择，Tab 补全` : `${data.dir} 下没有匹配的目录`, starts.length + contains.length ? '' : 'warn')
      if (data.truncated && showList) setHint(hint.textContent + ' · 仅列出前 1000 个目录')
    }
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false'); input.autocomplete = 'off'; input.spellcheck = false
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; update() }, 90) })
    input.addEventListener('focus', () => update())
    // Option clicks use mousedown + preventDefault, so focus never leaves for them;
    // any real blur closes the list at once.
    input.addEventListener('blur', close)
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!open) { update(); return }
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1)
        if (index === items.length) index = -1
        highlight()
      } else if (e.key === 'Tab' && !e.shiftKey && (open || timer) && itemsFor !== input.value && input.value) {
        // Typed faster than the debounce: complete against the current text.
        e.preventDefault(); clearTimeout(timer); timer = null
        update().then(() => { if (open && items.length && itemsFor === input.value) accept(items[Math.max(index, 0)]) })
      } else if (e.key === 'Tab' && open && items.length && !e.shiftKey) {
        e.preventDefault(); accept(items[Math.max(index, 0)])
      } else if (e.key === 'Enter' && open && index >= 0 && itemsFor === input.value) {
        e.preventDefault(); accept(items[index])
      } else if (e.key === 'Escape' && open) {
        // Close the list only; keep the dialog open.
        e.preventDefault(); e.stopPropagation(); close()
      }
    })
    return {
      refresh() { if (document.activeElement === input) update(); else update(false) },
      prefetch() { listing('~/').catch(() => {}); const part = split(input.value); if (part && /^[/~]/.test(input.value)) listing(part.dir).catch(() => {}) },
      close
    }
  }
  window.AIHubPathInput = { attach }
})()
