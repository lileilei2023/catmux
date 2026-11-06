'use strict'
// Three-pane workbench: collapsible session list (left), the one real remote
// terminal (center, owned by remote-renderer.js) and a collapsible remote
// files / editor / per-file Git diff panel (right). Layout changes never
// reconnect a transport; they only change the terminal's size.
;(() => {
  const $ = id => document.getElementById(id)
  function node(tag, content, className) { const el = document.createElement(tag); if (content != null) el.textContent = content; if (className) el.className = className; return el }
  const NARROW = 1000
  let hub, toast, getSession, insertText, onLayout = () => {}, onTerminal = () => {}, offTerminal = () => {}

  // ---------- layout ----------
  const defaults = { left: true, right: true, leftW: 280, rightW: 460, explorerH: 42, wide: false, viewerMax: false }
  const layout = (() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('workbench-layout') || '{}') } } catch { return { ...defaults } }
  })()
  let focusSaved = null
  const narrow = () => window.innerWidth < NARROW
  function saveLayout() { try { localStorage.setItem('workbench-layout', JSON.stringify(layout)) } catch {} }
  function applyLayout() {
    const body = document.body, root = document.documentElement.style
    body.classList.toggle('left-collapsed', !layout.left)
    body.classList.toggle('right-collapsed', !layout.right)
    body.classList.toggle('right-wide', layout.wide)
    body.classList.toggle('viewer-max', layout.viewerMax)
    body.classList.toggle('narrow', narrow())
    root.setProperty('--left-w', layout.leftW + 'px')
    root.setProperty('--right-w', layout.rightW + 'px')
    root.setProperty('--explorer-h', layout.explorerH + '%')
    $('wb-wide').setAttribute('aria-pressed', String(layout.wide))
    $('viewer-max').setAttribute('aria-pressed', String(layout.viewerMax))
    $('terminal-focus').setAttribute('aria-pressed', String(!!focusSaved))
    $('terminal-focus').textContent = focusSaved ? '退出专注' : '专注'
    onLayout()
  }
  function setPane(side, open) {
    layout[side] = open
    // Narrow windows show side panes as overlays; only one at a time.
    if (open && narrow()) layout[side === 'left' ? 'right' : 'left'] = false
    focusSaved = null
    saveLayout(); applyLayout()
    if (side === 'right' && open) ensureLoaded()
  }
  function toggleFocus() {
    if (focusSaved) { Object.assign(layout, focusSaved); focusSaved = null }
    else { const saved = { left: layout.left, right: layout.right }; layout.left = layout.right = false; focusSaved = saved }
    saveLayout(); applyLayout()
    if (layout.right) ensureLoaded()
  }
  function drag(handle, move) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      event.preventDefault(); handle.setPointerCapture(event.pointerId)
      document.body.classList.add('resizing')
      const onMove = e => { move(e); applyLayout() }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove); document.body.classList.remove('resizing'); saveLayout()
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp, { once: true }); handle.addEventListener('pointercancel', onUp, { once: true })
    })
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)))
  function initLayout() {
    drag($('resize-left'), e => { layout.leftW = clamp(e.clientX, 200, 460) })
    drag($('resize-right'), e => { layout.rightW = clamp(window.innerWidth - e.clientX, 300, window.innerWidth * 0.72); layout.wide = false })
    drag($('resize-viewer'), e => { const r = $('wb-body').getBoundingClientRect(); layout.explorerH = clamp((e.clientY - r.top) / r.height * 100, 12, 85) })
    for (const [id, key, sign, lo, hi] of [['resize-left', 'leftW', 1, 200, 460], ['resize-right', 'rightW', -1, 300, 1400]]) {
      $(id).addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault(); layout[key] = clamp(layout[key] + (e.key === 'ArrowRight' ? 16 : -16) * sign, lo, hi); saveLayout(); applyLayout()
      })
      $(id).addEventListener('dblclick', () => setPane(key === 'leftW' ? 'left' : 'right', false))
    }
    $('collapse-left').onclick = () => setPane('left', false)
    $('expand-left').onclick = () => setPane('left', true)
    $('collapse-right').onclick = () => setPane('right', false)
    $('expand-right').onclick = () => setPane('right', true)
    $('wb-wide').onclick = () => { layout.wide = !layout.wide; saveLayout(); applyLayout() }
    $('viewer-max').onclick = () => { layout.viewerMax = !layout.viewerMax; saveLayout(); applyLayout() }
    $('view-files').onclick = () => setView('files')
    $('view-git').onclick = () => setView('git')
    $('view-term').onclick = () => setView('term')
    $('wb-refresh').onclick = () => refresh()
    if (narrow() && layout.left && layout.right) layout.right = false
    let wasNarrow = narrow()
    window.addEventListener('resize', () => {
      if (narrow() !== wasNarrow) { wasNarrow = narrow(); if (wasNarrow && layout.left && layout.right) layout.right = false }
      applyLayout()
    })
    // Shortcuts are captured before xterm sees them; only these exact combos.
    document.addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== 'KeyB') return
      e.preventDefault(); e.stopPropagation()
      if (e.altKey) setPane('right', !layout.right); else setPane('left', !layout.left)
    }, true)
    window.addEventListener('beforeunload', e => { if (dirtyCount()) { e.preventDefault(); e.returnValue = '' } })
    applyLayout()
  }

  // ---------- per-session workbench state ----------
  // Each session remembers which root it browses (worktree / original project /
  // terminal's current directory), the expanded tree, Git status and open docs.
  const spaces = new Map()
  let current = null
  const ROOT_LABEL = { cwd: '会话目录', project: '原项目', pane: '终端当前目录' }
  const session = () => getSession?.()
  function rootsOf(s) {
    if (!s) return []
    const list = [{ key: 'cwd', label: s.worktree ? 'Agent worktree（agent 在这里改）' : ROOT_LABEL.cwd, path: s.cwd }]
    if (s.project && s.project !== s.cwd) list.push({ key: 'project', label: '原项目 · ' + s.project.split('/').pop(), path: s.project })
    if (s.tmux) list.push({ key: 'pane', label: '跟随终端当前目录', path: null })
    return list
  }
  function freshTree(w, rootKey) { Object.assign(w, { rootKey, rootPath: '', dirs: new Map(), expanded: new Set(['']), git: null, gitError: '', syncError: '', syncedAt: 0, fromCache: false, deepAt: 0, needDeep: false, deepInfo: null }) }
  function space(id = current) {
    if (!id) return null
    if (!spaces.has(id)) {
      const w = { id, view: 'files', docs: [], active: null, syncing: false, pending: false }
      freshTree(w, readPref(id) || 'cwd')
      spaces.set(id, w)
      restore(w)
    }
    return spaces.get(id)
  }
  function usable(s) { return s && !['failed', 'creating'].includes(s.status) }
  function dirtyCount() { let n = 0; for (const w of spaces.values()) for (const d of w.docs) if (d.dirty) n++; return n }
  let currentUsable = null
  function usableChanged(s) { return s?.id !== current || usable(s) !== currentUsable }
  function setSession(s) {
    current = s?.id || null; currentUsable = usable(s)
    $('wb-empty').hidden = !!current
    $('wb-body').hidden = !current
    if (current && !usable(s)) { $('wb-empty').hidden = false; $('wb-body').hidden = true; $('wb-empty').textContent = '此会话尚未恢复；恢复并连接后才能浏览远端项目。' }
    else $('wb-empty').textContent = '选择左侧会话后，这里显示远端项目文件、编辑器与 Git 变更。'
    if (current) { const w = space(); if (!rootsOf(s).some(r => r.key === w.rootKey)) { freshTree(w, 'cwd'); readTreeCache(w) } }
    renderAll()
    if (layout.right) ensureLoaded()
  }
  function forget(id) {
    spaces.delete(id)
    for (const key of storageKeys()) if (key.startsWith(CACHE + id) || key.startsWith(DRAFT + id) || key === PREF + id) remove(key)
    if (current === id) setSession(null)
  }
  function ensureLoaded() {
    const w = space(), s = session()
    if (!w || !usable(s)) return
    // Cached structure is already on screen; one SSH call confirms or updates it.
    if (!w.syncedAt && !w.syncing) sync()
    activateDoc()
  }
  function setView(view) {
    const w = space(); if (!w) return
    w.view = view; renderView(); saveDocs(w.id)
    if (Date.now() - w.syncedAt > 5000) sync()
  }
  function setRoot(key) {
    const w = space(); if (!w || w.rootKey === key) return
    writeTreeCache(w); freshTree(w, key); writePref(w.id, key); readTreeCache(w)
    renderAll(); sync()
  }
  function refresh() {
    const w = space(); if (!w) return
    sync(w.id, { force: true })
    const doc = activeDoc()
    if (doc && !doc.dirty) reloadDoc(doc)
  }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  function openPaths(w) {
    // Only directories actually visible (every ancestor expanded) are fetched.
    return [...w.expanded].filter(p => { if (!p) return true; const parts = p.split('/'); for (let i = 1; i < parts.length; i++) if (!w.expanded.has(parts.slice(0, i).join('/'))) return false; return true }).slice(0, 80)
  }
  // The whole project structure (minus node_modules/.git/dist…, capped) comes
  // in one SSH call on first open, on refresh, every 2 min, and right after Git
  // status changes. In between, only expanded dirs + Git are re-checked, and
  // expanding a preloaded directory needs no request at all.
  const DEEP_EVERY = 120000
  async function sync(id = current, { force = false } = {}) {
    const w = spaces.get(id); if (!w) return
    if (w.syncing) { w.pending = true; if (force) w.needDeep = true; return }
    w.syncing = true; if (current === id) renderSync()
    const rootKey = w.rootKey, paths = openPaths(w)
    const deep = force || w.needDeep || !w.deepAt || Date.now() - w.deepAt > DEEP_EVERY
    let changed = false
    try {
      const r = await hub.tree(id, paths, rootKey, true, deep)
      if (w.rootKey !== rootKey) return
      if (w.rootPath !== r.root) { w.rootPath = r.root; changed = true }
      for (const [p, d] of Object.entries(r.dirs)) {
        if (d.missing) { if (p) { w.expanded.delete(p); if (w.dirs.delete(p)) changed = true }; continue }
        const next = d.error ? { error: d.error } : { entries: d.entries, truncated: !!d.truncated }
        if (!same(w.dirs.get(p), next)) { w.dirs.set(p, next); changed = true }
      }
      if (deep && r.deep) {
        // A complete walk is authoritative: directories it no longer saw are gone.
        if (r.deep.complete) for (const p of [...w.dirs.keys()]) if (!(p in r.dirs)) { w.dirs.delete(p); w.expanded.delete(p); changed = true }
        w.deepAt = Date.now(); w.needDeep = false; w.deepInfo = r.deep
      }
      const git = r.git || null, gitError = r.gitError || ''
      const gitChanged = !same(w.git, git) || w.gitError !== gitError
      if (gitChanged) { w.git = git; w.gitError = gitError; changed = true; if (!deep && w.deepAt) { w.needDeep = true; w.pending = true } }
      w.syncError = ''; w.fromCache = false; w.syncedAt = Date.now()
      if (changed || force) writeTreeCache(w)
      if (gitChanged && current === id) revalidateActive()
    } catch (e) {
      w.syncError = e.message; w.syncedAt = Date.now()
      if (!w.dirs.get('')?.entries) { w.dirs.set('', { error: e.message }); changed = true }
    } finally {
      w.syncing = false
      if (current === id) { if (changed) renderLists(); renderSync() }
      if (w.pending) { w.pending = false; sync(id) }
    }
  }

  // ---------- local cache (structure only; drafts separately) ----------
  // localStorage lives in this browser on this Mac only. Tree / Git metadata and
  // small previews render instantly on reload; the remote is still the truth and
  // a single SSH call re-checks it, updating the screen only when it changed.
  const CACHE = 'aihub-wb:', DRAFT = 'aihub-draft:', PREF = 'aihub-wb-root:', DOCS = 'aihub-wb-docs:'
  function storageKeys() { try { return Object.keys(localStorage) } catch { return [] } }
  function remove(key) { try { localStorage.removeItem(key) } catch {} }
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
  function write(key, value) {
    const text = JSON.stringify(value)
    try { localStorage.setItem(key, text); return true } catch {}
    // Quota: drop the oldest other sessions' caches, never drafts.
    const old = storageKeys().filter(k => (k.startsWith(CACHE) || k.startsWith(DOCS)) && k !== key).map(k => [k, read(k)?.at || 0]).sort((a, b) => a[1] - b[1])
    for (const [k] of old.slice(0, Math.max(1, Math.ceil(old.length / 2)))) remove(k)
    try { localStorage.setItem(key, text); return true } catch { return false }
  }
  const readPref = id => { try { return localStorage.getItem(PREF + id) } catch { return null } }
  const writePref = (id, key) => { try { localStorage.setItem(PREF + id, key) } catch {} }
  function writeTreeCache(w) {
    const data = { v: 1, at: Date.now(), rootPath: w.rootPath, expanded: [...w.expanded], git: w.git, gitError: w.gitError,
      dirs: Object.fromEntries([...w.dirs].filter(([, d]) => d.entries)) }
    if (JSON.stringify(data).length > 1500000) data.dirs = Object.fromEntries(Object.entries(data.dirs).filter(([p]) => w.expanded.has(p)))
    write(`${CACHE}${w.id}|${w.rootKey}`, data)
  }
  function readTreeCache(w) {
    const data = read(`${CACHE}${w.id}|${w.rootKey}`)
    if (data?.v !== 1) return
    w.rootPath = data.rootPath || ''; w.expanded = new Set(['', ...(data.expanded || [])]); w.git = data.git || null; w.gitError = data.gitError || ''
    w.dirs = new Map(Object.entries(data.dirs || {})); w.fromCache = true; w.cachedAt = data.at
  }
  const docTimers = new Map()
  function saveDocs(id) {
    clearTimeout(docTimers.get(id))
    docTimers.set(id, setTimeout(() => {
      const w = spaces.get(id); if (!w) return
      // Captured terminal history is conversation content: never persisted.
      const docs = w.docs.filter(d => d.kind !== 'text').map(d => ({ key: d.key, kind: d.kind, path: d.path, staged: d.staged, rootKey: d.rootKey, rootPath: d.rootPath,
        ...(d.kind === 'file' && typeof d.original === 'string' && d.original.length <= 32768 ? { original: d.original, sha: d.sha } : {}),
        ...(d.kind === 'diff' && typeof d.patch === 'string' && d.patch.length <= 32768 ? { patch: d.patch, note: d.note, untracked: d.untracked } : {}) }))
      write(DOCS + id, { v: 1, at: Date.now(), view: w.view, active: w.active, docs })
    }, 300))
  }
  function restore(w) {
    readTreeCache(w)
    const data = read(DOCS + w.id)
    if (data?.v === 1) {
      w.view = ['git', 'term'].includes(data.view) ? data.view : 'files'; w.active = data.active
      for (const d of data.docs || []) {
        const doc = { ...d, mode: 'preview', stale: true }
        if (d.kind === 'file' && typeof d.original === 'string') Object.assign(doc, { content: d.original, dirty: false })
        else if (d.kind === 'diff' && typeof d.patch === 'string') doc.patch = d.patch
        else doc.unloaded = true
        w.docs.push(doc)
      }
    }
    // Unsaved drafts survive reloads/crashes; they reopen in edit mode, flagged.
    for (const key of storageKeys().filter(k => k.startsWith(DRAFT + w.id + '|'))) {
      const draft = read(key); if (!draft?.content && draft?.content !== '') { remove(key); continue }
      let doc = w.docs.find(d => d.key === draft.key)
      if (!doc) { doc = { key: draft.key, kind: 'file', path: draft.path, rootKey: draft.rootKey, rootPath: draft.rootPath, stale: true }; w.docs.push(doc) }
      Object.assign(doc, { content: draft.content, sha: draft.sha, mode: 'edit', dirty: true, draft: true, draftAt: draft.at, needsBase: true, editor: null })
      if (!w.active) w.active = doc.key
    }
    if (!w.docs.some(d => d.key === w.active)) w.active = w.docs[0]?.key || null
  }
  const draftTimers = new Map()
  function saveDraft(doc) {
    const id = current
    clearTimeout(draftTimers.get(doc)); draftTimers.set(doc, setTimeout(() => {
      if (!doc.dirty) return dropDraft(id, doc)
      if (doc.content.length <= 262144) write(`${DRAFT}${id}|${doc.key}`, { v: 1, at: Date.now(), key: doc.key, path: doc.path, rootKey: doc.rootKey, rootPath: doc.rootPath, sha: doc.sha, content: doc.content })
    }, 400))
  }
  function dropDraft(id, doc) { clearTimeout(draftTimers.get(doc)); remove(`${DRAFT}${id}|${doc.key}`); doc.draft = false }

  // ---------- paths ----------
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i
  function rootPathOf(w, key = w.rootKey) {
    if (key === w.rootKey && w.rootPath) return w.rootPath
    const r = rootsOf(session()).find(x => x.key === key); return r?.path || ''
  }
  function absolute(base, rel) { return !base ? '' : rel ? (base === '/' ? '/' : base + '/') + rel : base }
  function docAbsolute(doc) { return absolute(doc.rootPath || rootPathOf(space(), doc.rootKey), doc.path) }
  async function copy(text, what) { await hub.copy(text); toast(`已复制${what}：${text}`) }
  function pathItems(abs, rel) {
    const s = session()
    return [
      { label: '插入远端绝对路径到终端', hint: '不回车', disabled: !abs, action: () => insertText(abs) },
      { label: '插入相对路径到终端', disabled: !rel, action: () => insertText(rel) },
      '-',
      { label: '复制远端绝对路径', disabled: !abs, action: () => copy(abs, '远端路径') },
      { label: '复制相对路径', disabled: !rel, action: () => copy(rel, '相对路径') },
      { label: `复制 scp 地址（${s?.host}:…）`, disabled: !abs, action: () => copy(`${s.host}:${abs}`, ' scp 地址') }
    ]
  }

  // ---------- files ----------
  async function loadDir(path) {
    const id = current, w = space(id), rootKey = w.rootKey
    if (!w.dirs.get(path)?.entries) w.dirs.set(path, { loading: true })
    if (current === id) renderTree()
    try {
      const r = await hub.files(id, path, rootKey)
      if (w.rootKey !== rootKey) return
      const next = { entries: r.entries || r, truncated: !!r.truncated }
      if (r.root) w.rootPath = r.root
      if (!same(w.dirs.get(path), next)) { w.dirs.set(path, next); writeTreeCache(w) }
    } catch (e) { if (w.rootKey === rootKey) w.dirs.set(path, { error: e.message }) }
    if (current === id) renderTree()
  }
  function changeMap(w) {
    const map = new Map(), dirs = new Set()
    for (const c of w?.git?.changes || []) {
      map.set(c.path, c)
      const parts = c.path.split('/'); parts.pop()
      while (parts.length) { dirs.add(parts.join('/')); parts.pop() }
    }
    return { map, dirs }
  }
  function statusLetter(code) {
    if (code === '??') return 'U'
    return code.replace(/\s/g, '')[0] || 'M'
  }
  function renderTree() {
    const w = space(), view = $('files-view')
    view.replaceChildren()
    if (!w) return
    const { map, dirs } = changeMap(w), doc = activeDoc(), activePath = doc?.rootKey === w.rootKey ? doc.path : null
    const walk = (path, depth) => {
      const dir = w.dirs.get(path)
      if (!dir || dir.loading) { view.append(row(depth, '加载中…', 'tree-note')); return }
      if (dir.error) {
        const r = row(depth, dir.error, 'tree-note error'); const retry = node('button', '重试', 'link'); retry.onclick = () => path ? loadDir(path) : sync(); r.append(retry); view.append(r); return
      }
      if (!dir.entries.length && !path) view.append(row(depth, '目录为空（凭据 / 模型配置与符号链接不显示）', 'tree-note'))
      for (const entry of dir.entries) {
        const el = node('button', null, 'tree-row' + (entry.directory ? ' dir' : '') + (entry.path === activePath ? ' active' : ''))
        el.style.paddingLeft = (8 + depth * 14) + 'px'
        el.dataset.path = entry.path
        el.setAttribute('role', 'treeitem')
        const open = entry.directory && w.expanded.has(entry.path)
        if (entry.directory) el.setAttribute('aria-expanded', String(open))
        el.append(node('span', entry.directory ? (open ? '▾' : '▸') : IMAGE.test(entry.name) ? '◩' : '', 'caret'), node('span', entry.name, 'name'))
        const change = map.get(entry.path)
        if (change) { el.classList.add('changed', 'st-' + statusLetter(change.status)); el.append(node('span', statusLetter(change.status), 'badge-st')) }
        else if (entry.directory && dirs.has(entry.path)) el.append(node('span', '•', 'badge-dot'))
        el.onclick = () => entry.directory ? toggleDir(entry.path) : openEntry(entry.path)
        el.oncontextmenu = e => AIHubMenu.open(e, entryMenu(entry, change))
        view.append(el)
        if (open) walk(entry.path, depth + 1)
      }
      if (dir.truncated) view.append(row(depth, '仅显示前 500 项', 'tree-note'))
    }
    // The project folder itself is the first row, so a subfolder that happens to
    // be called e.g. "workspace" is never mistaken for the root.
    // A task worktree directory is named by its task id; show the project instead.
    const rootPath = rootPathOf(w), s = session()
    const rootName = s?.worktree && w.rootKey === 'cwd' && s.project ? `${s.project.split('/').filter(Boolean).pop()} · worktree` : rootPath.split('/').filter(Boolean).pop() || '/'
    const head = node('button', null, 'tree-row tree-root'); head.dataset.path = ''
    head.append(node('span', '▾', 'caret'), node('span', rootName, 'name'))
    const info = w.deepInfo
    if (info) head.append(node('small', `${info.dirs} 个目录${info.complete ? '' : ' · 部分预加载'}`, 'tree-root-info'))
    head.title = rootPath + ' · 点击全部折叠'
    head.onclick = collapseAll
    head.oncontextmenu = e => AIHubMenu.open(e, [{ label: '新建文件夹…', action: () => newFolder('') }, { label: '刷新整个结构', action: () => sync(w.id, { force: true }) }, { label: '全部折叠', action: collapseAll }, '-', ...pathItems(rootPath, '')])
    view.append(head)
    walk('', 1)
  }
  function entryMenu(entry, change) {
    const w = space(), abs = absolute(rootPathOf(w), entry.path)
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    if (entry.directory) return [
      { label: w.expanded.has(entry.path) ? '折叠' : '展开', action: () => toggleDir(entry.path) },
      { label: '新建文件夹…', action: () => newFolder(entry.path) },
      { label: '刷新此目录', action: () => loadDir(entry.path) },
      { label: '全部折叠', action: collapseAll },
      '-', ...pathItems(abs, entry.path)
    ]
    const image = IMAGE.test(entry.name)
    return [
      { label: image ? '预览图片' : '打开预览', action: () => openEntry(entry.path) },
      image ? null : { label: '编辑', action: () => openFile(entry.path, 'edit') },
      change ? { label: '查看 Diff', action: () => openDiff(entry.path, !change.unstaged) } : null,
      '-', ...pathItems(abs, entry.path),
      '-', { label: '刷新所在目录', action: () => loadDir(parent) }
    ]
  }
  // One new folder inside a browsed directory, on the session's device.
  async function newFolder(dir) {
    const w = space(); if (!w) return
    const name = window.prompt(`在 ${absolute(rootPathOf(w), dir)} 下新建文件夹：`, '')
    if (name == null || !name.trim()) return
    try {
      const r = await hub.makeDirIn(w.id, dir, name.trim(), w.rootKey)
      w.expanded.add(dir); await loadDir(dir); toast(`已创建 ${r.path}`)
    } catch (e) { toast(e.message) }
  }
  function collapseAll() { const w = space(); w.expanded = new Set(['']); writeTreeCache(w); renderTree() }
  function row(depth, text, className) { const el = node('div', text, className); el.style.paddingLeft = (8 + depth * 14 + 16) + 'px'; return el }
  function toggleDir(path) {
    const w = space()
    if (w.expanded.has(path)) w.expanded.delete(path)
    else {
      w.expanded.add(path)
      // Cached listing shows immediately; still re-check it in the background.
      // Preloaded: instant, no request. The next periodic check covers it.
      if (!w.dirs.get(path)?.entries) { loadDir(path); return }
    }
    writeTreeCache(w); renderTree()
  }
  function reveal(path) {
    const w = space(), parts = path.split('/'); parts.pop()
    for (let i = 1; i <= parts.length; i++) w.expanded.add(parts.slice(0, i).join('/'))
    w.view = 'files'; renderAll(); sync()
    requestAnimationFrame(() => document.querySelector(`#files-view .tree-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' }))
  }

  // ---------- git ----------
  function renderGit() {
    const w = space(), view = $('git-view'), count = $('git-count')
    view.replaceChildren()
    const changes = w?.git?.changes || []
    count.hidden = !changes.length; count.textContent = String(changes.length)
    if (!w) return
    if (w.gitError) { view.append(node('div', /not a git repository|不是 git/i.test(w.gitError) ? '此目录不是 Git 仓库；不会自动 git init。' : w.gitError, 'tree-note error')); return }
    if (!w.git) { view.append(node('div', w.syncing ? '正在读取远端 Git…' : '尚未读取', 'tree-note')); return }
    const g = w.git, head = node('div', null, 'git-head')
    head.append(node('span', '⎇ ' + (g.branch || '(detached HEAD)'), 'branch'), node('small', g.head || ''))
    if (g.ahead != null) head.append(node('small', `↑${g.ahead} ↓${g.behind}`))
    view.append(head)
    if (!changes.length) { view.append(node('div', '工作区干净，没有变更。', 'tree-note')); return }
    const doc = activeDoc()
    const section = (title, items, staged) => {
      if (!items.length) return
      view.append(node('div', `${title} · ${items.length}`, 'section-title'))
      for (const c of items) {
        const letter = statusLetter(staged ? c.status[0] : c.status === '??' ? '??' : c.status[1])
        const el = node('button', null, 'change-row st-' + letter)
        if (doc?.kind === 'diff' && doc.path === c.path && doc.staged === staged && doc.rootKey === w.rootKey) el.classList.add('active')
        el.dataset.path = c.path
        const slash = c.path.lastIndexOf('/')
        const label = node('span', null, 'name')
        label.append(node('b', c.path.slice(slash + 1)), node('small', slash > 0 ? ' ' + c.path.slice(0, slash) : ''))
        const add = staged ? c.stagedAdded : c.added, del = staged ? c.stagedDeleted : c.deleted
        const stats = node('span', null, 'stats')
        if (add) stats.append(node('span', '+' + add, 'plus'))
        if (del) stats.append(node('span', '−' + del, 'minus'))
        el.append(label, stats, node('span', letter, 'badge-st'))
        if (c.original) el.title = `${c.original} → ${c.path}`
        el.onclick = () => openDiff(c.path, staged)
        el.oncontextmenu = e => AIHubMenu.open(e, [
          { label: staged ? '查看已暂存 Diff' : '查看 Diff', action: () => openDiff(c.path, staged) },
          !/D/.test(c.status) ? { label: IMAGE.test(c.path) ? '预览图片' : '打开文件', action: () => openEntry(c.path) } : null,
          !/D/.test(c.status) ? { label: '在目录树中定位', action: () => reveal(c.path) } : null,
          '-', ...pathItems(absolute(rootPathOf(w), c.path), c.path)
        ])
        view.append(el)
      }
    }
    section('已暂存', changes.filter(c => c.staged), true)
    section('更改', changes.filter(c => c.unstaged), false)
    if (g.truncated) view.append(node('div', '仅显示前 1000 项变更', 'tree-note'))
  }

  // ---------- root bar / sync state ----------
  function renderRoot() {
    const w = space(), s = session(), select = $('wb-root')
    select.replaceChildren()
    if (!w || !s) return
    for (const r of rootsOf(s)) { const o = node('option', r.label); o.value = r.key; select.append(o) }
    select.value = w.rootKey; select.disabled = select.options.length < 2
    const path = rootPathOf(w) || (w.rootKey === 'pane' ? '读取中…' : '')
    // Breadcrumb: the prefix may shrink from the left; the last segment never hides.
    const crumb = $('wb-root-path'); crumb.replaceChildren(); crumb.title = path ? `${s.host}:${path}` : ''
    if (path) {
      const cut = path.length > 1 ? path.lastIndexOf('/') : 0
      crumb.append(node('span', `\u200e${s.host}:${path.slice(0, cut + 1)}\u200e`, 'rp-prefix'), node('b', path.slice(cut + 1) || '/', 'rp-name'))
    }
    const hints = {
      cwd: s.worktree ? `独立 worktree，基于 ${s.project?.split('/').pop() || '原项目'} 的已提交版本。原项目里未提交 / 未跟踪的文件不在这里，可切换到“原项目”查看。` : '',
      project: s.worktree ? '原项目目录。agent 的修改在它自己的 worktree 中，不在这里。' : '',
      pane: '跟随 tmux 终端当前目录（每次刷新时由远端重新读取）。'
    }
    $('wb-root-hint').textContent = hints[w.rootKey] || ''
    $('wb-root-hint').hidden = !hints[w.rootKey]
    renderSync()
  }
  function renderSync() {
    const w = space(), el = $('wb-sync')
    if (!w) { el.textContent = ''; return }
    el.className = 'sync'
    if (w.syncing) { el.textContent = w.fromCache ? '缓存 · 核对中…' : '同步中…'; el.classList.add('busy') }
    else if (w.syncError) { el.textContent = w.dirs.get('')?.entries ? '离线 · 显示缓存' : '读取失败'; el.classList.add('error'); el.title = w.syncError }
    else if (w.syncedAt) { el.textContent = '已同步 ' + new Date(w.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); el.title = w.deepInfo ? `结构已预加载：${w.deepInfo.dirs} 个目录 / ${w.deepInfo.entries} 项${w.deepInfo.complete ? '' : '（达到上限，其余展开时再读取）'}` : '' }
    else if (w.fromCache) { el.textContent = '缓存'; el.title = '来自本机浏览器缓存，打开面板后自动核对' }
    else el.textContent = ''
  }

  // ---------- documents ----------
  const keyOf = (rootKey, kind, path, staged) => `${rootKey}|${kind}|${kind === 'diff' ? (staged ? 's:' : 'w:') : ''}${path}`
  function activeDoc(w = space()) { return w?.docs.find(d => d.key === w.active) || null }
  function addDoc(doc) {
    const w = space()
    const existing = w.docs.find(d => d.key === doc.key)
    if (existing) { w.active = existing.key; if (doc.mode === 'edit' && existing.kind === 'file') existing.mode = 'edit'; renderAll(); activateDoc(); saveDocs(w.id); return null }
    if (w.docs.length >= 12) { const idle = w.docs.find(d => !d.dirty && d.key !== w.active); if (idle) w.docs.splice(w.docs.indexOf(idle), 1) }
    doc.rootKey = w.rootKey; doc.rootPath = rootPathOf(w)
    w.docs.push(doc); w.active = doc.key
    if (!layout.right) setPane('right', true)
    renderAll(); saveDocs(w.id); return doc
  }
  function openEntry(path) { return IMAGE.test(path) ? openImage(path) : openFile(path) }
  async function openFile(path, mode = 'preview') {
    const w = space(), doc = addDoc({ key: keyOf(w.rootKey, 'file', path), kind: 'file', path, mode, loading: true }); if (doc) await reloadDoc(doc)
  }
  async function openImage(path) {
    const w = space(), doc = addDoc({ key: keyOf(w.rootKey, 'image', path), kind: 'image', path, loading: true, fit: true }); if (doc) await reloadDoc(doc)
  }
  async function openDiff(path, staged) {
    const w = space(), doc = addDoc({ key: keyOf(w.rootKey, 'diff', path, staged), kind: 'diff', path, staged, loading: true }); if (doc) await reloadDoc(doc)
  }
  // Restored/cached docs show immediately, then re-check quietly.
  function activateDoc() {
    const doc = activeDoc(); if (!doc || doc.loading) return
    if (doc.needsBase) return rebase(doc)
    if (doc.unloaded) return reloadDoc(doc)
    if (doc.stale) { doc.stale = false; revalidate(doc) }
  }
  function revalidateActive() { const doc = activeDoc(); if (doc && !doc.dirty && !doc.loading && doc.kind !== 'image' && doc.kind !== 'text') revalidate(doc) }
  async function revalidate(doc) {
    const id = current
    try {
      if (doc.kind === 'file') {
        if (doc.dirty) return
        const r = await hub.readFile(id, doc.path, doc.rootKey)
        if (r.sha256 === doc.sha || doc.dirty) return
        Object.assign(doc, { content: r.content, original: r.content, sha: r.sha256, size: r.size, editor: null, rootPath: r.root || doc.rootPath })
      } else if (doc.kind === 'diff') {
        const r = await hub.diff(id, doc.path, doc.staged, doc.rootKey)
        if (r.patch === doc.patch && (r.note || '') === (doc.note || '')) return
        Object.assign(doc, { patch: r.patch, note: r.note || '', untracked: !!r.untracked })
      } else return
      saveDocs(id); if (current === id) renderDoc()
    } catch { /* keep the cached view; an explicit refresh shows the error */ }
  }
  // A restored draft needs the current remote version to decide whether it is
  // still based on it. Never auto-merge; a changed base is a visible conflict.
  async function rebase(doc) {
    const id = current
    doc.needsBase = false
    try {
      const r = await hub.readFile(id, doc.path, doc.rootKey)
      doc.original = r.content; doc.rootPath = r.root || doc.rootPath
      if (r.sha256 !== doc.sha) doc.conflict = true
      doc.dirty = doc.content !== doc.original
    } catch (e) { doc.error = e.message }
    if (current === id) { renderTabs(); renderDoc() }
  }
  async function reloadDoc(doc) {
    if (doc.kind === 'text') return
    const id = current
    doc.loading = true; doc.error = ''; doc.unloaded = false; doc.stale = false; if (current === id) renderDoc()
    try {
      if (doc.kind === 'file') {
        const r = await hub.readFile(id, doc.path, doc.rootKey)
        Object.assign(doc, { content: r.content, original: r.content, sha: r.sha256, size: r.size, dirty: false, conflict: false, draft: false, rootPath: r.root || doc.rootPath })
        dropDraft(id, doc); doc.editor = null
      } else if (doc.kind === 'image') {
        const r = await hub.readImage(id, doc.path, doc.rootKey)
        Object.assign(doc, { src: `data:${r.mime};base64,${r.data}`, size: r.size, mime: r.mime, rootPath: r.root || doc.rootPath })
      } else {
        const r = await hub.diff(id, doc.path, doc.staged, doc.rootKey)
        Object.assign(doc, { patch: r.patch, note: r.note || '', untracked: !!r.untracked })
      }
    } catch (e) { doc.error = e.message }
    finally { doc.loading = false; saveDocs(id); if (current === id) renderAll() }
  }
  function closeDoc(key, ask = true) {
    const w = space(), doc = w.docs.find(d => d.key === key); if (!doc) return true
    if (doc.dirty && ask && !window.confirm(`放弃 ${doc.path} 的未保存修改？远端文件不会被改动。`)) return false
    dropDraft(w.id, doc)
    const index = w.docs.indexOf(doc); w.docs.splice(index, 1)
    if (w.active === key) w.active = w.docs[Math.min(index, w.docs.length - 1)]?.key || null
    renderAll(); activateDoc(); saveDocs(w.id); return true
  }
  function closeMany(keys) {
    const w = space(), dirty = w.docs.filter(d => keys.includes(d.key) && d.dirty)
    if (dirty.length && !window.confirm(`放弃 ${dirty.length} 个文件的未保存修改？`)) return
    for (const key of keys) closeDoc(key, false)
  }
  function renderTabs() {
    const w = space(), tabs = $('doc-tabs')
    tabs.replaceChildren()
    document.body.classList.toggle('no-docs', !w?.docs.length)
    if (!w) return
    for (const d of w.docs) {
      const tab = node('div', null, 'doc-tab' + (d.key === w.active ? ' active' : '') + (d.dirty ? ' dirty' : ''))
      tab.setAttribute('role', 'tab'); tab.dataset.key = d.key
      const name = d.path.split('/').pop()
      const prefix = (d.rootKey !== w.rootKey ? `[${ROOT_LABEL[d.rootKey]}] ` : '') + (d.kind === 'diff' ? (d.staged ? 'Δ暂存 ' : 'Δ ') : '')
      const label = node('button', prefix + name, 'doc-tab-label')
      label.title = docAbsolute(d) || d.path; label.onclick = () => { w.active = d.key; renderAll(); activateDoc(); saveDocs(w.id) }
      label.onauxclick = e => { if (e.button === 1) closeDoc(d.key) }
      const close = node('button', d.dirty ? '●' : '×', 'doc-tab-close'); close.setAttribute('aria-label', '关闭 ' + name)
      close.onclick = () => closeDoc(d.key)
      tab.oncontextmenu = e => AIHubMenu.open(e, [
        { label: '关闭', action: () => closeDoc(d.key) },
        { label: '关闭其他', disabled: w.docs.length < 2, action: () => closeMany(w.docs.filter(x => x.key !== d.key).map(x => x.key)) },
        { label: '关闭已保存的', action: () => closeMany(w.docs.filter(x => !x.dirty).map(x => x.key)) },
        { label: '全部关闭', action: () => closeMany(w.docs.map(x => x.key)) },
        '-',
        { label: '在目录树中定位', disabled: d.rootKey !== w.rootKey, action: () => reveal(d.path) },
        ...pathItems(docAbsolute(d), d.path)
      ])
      tab.append(label, close); tabs.append(tab)
    }
  }
  function action(label, fn, className = '') { const b = node('button', label, 'mini ' + className); b.onclick = fn; return b }
  function renderDoc() {
    const w = space(), doc = activeDoc(w), body = $('doc-body'), actions = $('doc-actions')
    $('doc-head').hidden = !doc
    actions.replaceChildren()
    if (!doc) { body.replaceChildren(node('div', '点击文件预览 / 编辑，点击变更查看 diff。右键有更多操作。', 'doc-placeholder')); return }
    const suffix = doc.kind === 'diff' ? (doc.staged ? ' · 已暂存 diff' : ' · 工作区 diff') : doc.kind === 'image' ? ' · 图片' : doc.mode === 'edit' ? ' · 编辑中' : ''
    $('doc-path').textContent = (doc.rootKey !== w.rootKey ? `[${ROOT_LABEL[doc.rootKey]}] ` : '') + doc.path + suffix
    $('doc-path').title = docAbsolute(doc)
    // Keep a live editor element across re-renders so the caret/undo history survive.
    if (doc.kind === 'file' && doc.mode === 'edit' && doc.editor && doc.editor.root.parentNode === body && !doc.loading && !doc.error) { fileActions(doc, actions); renderBanner(doc); return }
    body.replaceChildren()
    if (doc.loading) { body.append(node('div', '正在通过 SSH 读取…', 'doc-placeholder')); return }
    if (doc.error) {
      const box = node('div', null, 'doc-placeholder error'); box.append(node('div', doc.error), action('重试', () => reloadDoc(doc)))
      body.append(box); return
    }
    if (doc.kind === 'file') {
      if (doc.content == null) { body.append(node('div', '尚未读取', 'doc-placeholder')); return }
      fileActions(doc, actions); body.append(doc.mode === 'edit' ? editor(doc).root : codeView(doc.content, doc.path)); renderBanner(doc)
    } else if (doc.kind === 'image') { imageActions(doc, actions); body.append(imageView(doc)) }
    else if (doc.kind === 'text') {
      actions.append(action('复制全部', () => hub.copy(doc.content).then(() => toast('已复制到本机剪贴板'))))
      if (doc.note) body.append(node('div', doc.note, 'diff-summary'))
      body.append(codeView(doc.content, 'history.txt'))
    }
    else { diffActions(doc, actions); body.append(diffView(doc)) }
  }
  function fileActions(doc, actions) {
    const change = changeMap(space()).map.get(doc.path)
    if (doc.mode === 'edit') {
      actions.append(action('保存', () => save(doc), 'primary'), action('放弃修改', () => discard(doc)), action('预览', () => { doc.mode = 'preview'; renderDoc() }))
    } else {
      actions.append(action('编辑', () => { doc.mode = 'edit'; renderDoc(); doc.editor?.textarea.focus() }))
      if (change && doc.rootKey === space().rootKey) actions.append(action('Diff', () => openDiff(doc.path, !change.unstaged)))
      actions.append(action('重新读取', () => doc.dirty && !window.confirm('放弃本地未保存修改并重新读取？') ? null : reloadDoc(doc)))
    }
    actions.append(action('插入路径', () => insertText(docAbsolute(doc)), 'ghost'))
  }
  function diffActions(doc, actions) {
    const change = changeMap(space()).map.get(doc.path)
    if (change?.staged && change?.unstaged) actions.append(action(doc.staged ? '看工作区' : '看暂存', () => openDiff(doc.path, !doc.staged)))
    if (!change || !/D/.test(change.status)) actions.append(action(IMAGE.test(doc.path) ? '预览图片' : '打开文件', () => openEntry(doc.path)))
    actions.append(action('刷新', () => reloadDoc(doc)), action('插入路径', () => insertText(docAbsolute(doc)), 'ghost'))
  }
  function imageActions(doc, actions) {
    actions.append(action(doc.fit ? '原始大小' : '适应窗口', () => { doc.fit = !doc.fit; renderDoc() }),
      action('刷新', () => reloadDoc(doc)), action('插入路径', () => insertText(docAbsolute(doc)), 'ghost'))
  }
  function imageView(doc) {
    const root = node('div', null, 'image-view' + (doc.fit ? ' fit' : ''))
    const img = node('img'); img.alt = doc.path; img.src = doc.src; img.draggable = false
    const info = node('div', `${doc.mime} · ${formatSize(doc.size)}`, 'image-info')
    img.onload = () => { info.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${doc.mime} · ${formatSize(doc.size)}` }
    img.ondblclick = () => { doc.fit = !doc.fit; renderDoc() }
    img.oncontextmenu = e => AIHubMenu.open(e, [
      { label: doc.fit ? '原始大小' : '适应窗口', action: () => { doc.fit = !doc.fit; renderDoc() } },
      '-', ...pathItems(docAbsolute(doc), doc.path)
    ])
    const stage = node('div', null, 'image-stage'); stage.append(img)
    root.append(stage, info); return root
  }
  function formatSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KiB' : n + ' B' }

  // ---------- code view / editor ----------
  const LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml', vue: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql', lua: 'lua', dockerfile: 'dockerfile', makefile: 'makefile' }
  function language(path) {
    const name = path.split('/').pop().toLowerCase()
    return LANG[name] || LANG[name.split('.').pop()] || null
  }
  function highlighted(code, path) {
    const lang = language(path), el = node('code')
    if (window.hljs && lang && code.length < 160000 && hljs.getLanguage(lang)) {
      try { el.innerHTML = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; el.className = 'hljs'; return el } catch {}
    }
    el.textContent = code; return el
  }
  function gutterText(count) { return Array.from({ length: count }, (_, i) => i + 1).join('\n') }
  function lineCount(text) { let n = 1; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return text.endsWith('\n') ? n - 1 || 1 : n }
  function codeView(content, path) {
    const root = node('div', null, 'code-view')
    const pre = node('pre', null, 'code'); pre.append(highlighted(content, path))
    root.append(node('pre', gutterText(lineCount(content)), 'gutter'), pre)
    if (!content) root.append(node('div', '（空文件）', 'doc-placeholder'))
    return root
  }
  function editor(doc) {
    if (doc.editor) return doc.editor
    const root = node('div', null, 'code-view editing'), gutter = node('pre', gutterText(lineCount(doc.content)), 'gutter')
    const textarea = node('textarea', null, 'code-input')
    textarea.value = doc.content; textarea.spellcheck = false
    textarea.setAttribute('autocapitalize', 'off'); textarea.setAttribute('autocomplete', 'off'); textarea.setAttribute('aria-label', '编辑 ' + doc.path)
    let lines = lineCount(doc.content)
    textarea.addEventListener('input', () => {
      doc.content = textarea.value
      const dirty = doc.original == null || doc.content !== doc.original
      if (dirty !== doc.dirty) { doc.dirty = dirty; renderTabs() }
      saveDraft(doc)
      const n = lineCount(doc.content); if (n !== lines) { lines = n; gutter.textContent = gutterText(n) }
    })
    textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop })
    textarea.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(doc) }
      else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, e.shiftKey ? '' : '  ') }
    })
    root.append(gutter, textarea)
    doc.editor = { root, textarea, gutter }
    return doc.editor
  }
  function renderBanner(doc) {
    const body = $('doc-body'); body.querySelector('.conflict')?.remove()
    if (!doc.conflict && !doc.draft) return
    const box = node('div', null, 'conflict')
    if (doc.conflict) box.append(node('span', doc.draft ? '恢复的草稿基于旧版本；远端文件已变化（可能是 agent）。' : '远端文件已被修改（可能是 agent）。本地修改尚未保存。'),
      action('重新读取远端（丢弃本地）', () => { if (window.confirm('丢弃本地修改，载入远端最新版本？')) { doc.mode = 'preview'; reloadDoc(doc) } }),
      action('复制本地内容', () => hub.copy(doc.content).then(() => toast('本地内容已复制到剪贴板'))),
      action('继续编辑', () => { doc.conflict = false; renderBanner(doc) }, 'ghost'))
    else box.append(node('span', `已从本机浏览器恢复未保存的草稿（${new Date(doc.draftAt || Date.now()).toLocaleString()}）。保存前仍会校验远端版本。`),
      action('知道了', () => { doc.draft = false; renderBanner(doc) }, 'ghost'))
    box.classList.toggle('info', !doc.conflict)
    body.prepend(box)
  }
  async function save(doc) {
    if (doc.saving) return
    const id = current
    if (!doc.dirty) { toast('没有需要保存的修改'); return }
    if (!doc.sha) { toast('还没有读取到远端版本，无法安全保存'); return }
    doc.saving = true
    try {
      const r = await hub.saveFile(id, doc.path, doc.content, doc.sha, doc.rootKey)
      doc.sha = r.sha256; doc.original = doc.content; doc.dirty = false; doc.conflict = false
      dropDraft(id, doc); saveDocs(id)
      toast(r.backup ? `已保存到 ${session()?.host}:${docAbsolute(doc)} · 原文件私有备份：${r.backup}` : '内容与远端一致，无需写入')
      sync(id)
    } catch (e) {
      if (/^CONFLICT:/.test(e.message) || /已被远端修改|发生变化/.test(e.message)) { doc.conflict = true; toast(e.message.replace(/^CONFLICT:/, '')) }
      else toast('保存失败：' + e.message)
    } finally { doc.saving = false; if (current === id) { renderTabs(); renderDoc() } }
  }
  function discard(doc) {
    if (doc.dirty && !window.confirm('放弃本地未保存修改？')) return
    dropDraft(current, doc)
    if (doc.original == null) { doc.mode = 'preview'; reloadDoc(doc); return }
    doc.content = doc.original; doc.dirty = false; doc.conflict = false; doc.editor = null; doc.mode = 'preview'; renderAll()
  }

  // ---------- diff view ----------
  function diffView(doc) {
    const root = node('div', null, 'diff')
    if (!doc.patch) { root.append(node('div', doc.note || '没有差异', 'doc-placeholder')); return root }
    let oldNo = 0, newNo = 0, inHunk = false, added = 0, removed = 0
    const rows = []
    const line = (cls, a, b, text) => { const r = node('div', null, 'dl ' + cls); r.append(node('span', a, 'ln'), node('span', b, 'ln'), node('span', text, 'tx')); rows.push(r) }
    for (const raw of doc.patch.split('\n')) {
      if (raw.startsWith('diff --git')) { inHunk = false; continue }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
      if (hunk) { inHunk = true; oldNo = +hunk[1]; newNo = +hunk[2]; line('hunk', '', '', raw); continue }
      if (!inHunk) {
        if (/^Binary files/.test(raw)) line('meta', '', '', IMAGE.test(doc.path) ? '图片已变化（二进制），可点“预览图片”查看当前版本' : '二进制文件已变化，不展示内容')
        else if (/^(new file|deleted file|rename|similarity|old mode|new mode)/.test(raw)) line('meta', '', '', raw)
        continue
      }
      if (raw.startsWith('+')) { line('add', '', String(newNo++), raw); added++ }
      else if (raw.startsWith('-')) { line('del', String(oldNo++), '', raw); removed++ }
      else if (raw.startsWith('\\')) line('meta', '', '', raw)
      else if (raw.startsWith(' ')) line('ctx', String(oldNo++), String(newNo++), raw)
    }
    const summary = node('div', null, 'diff-summary')
    summary.append(node('span', '+' + added, 'plus'), node('span', '−' + removed, 'minus'), node('small', doc.untracked ? '未跟踪的新文件' : doc.staged ? 'git diff --cached' : 'git diff'))
    root.append(summary, ...rows)
    return root
  }

  function renderView() {
    const w = space(), view = w?.view || 'files'
    for (const b of document.querySelectorAll('.seg')) { const on = b.dataset.view === view; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)) }
    $('files-view').hidden = view !== 'files'
    $('git-view').hidden = view !== 'git'
    // "终端" tab: the renderer shows a shell for this session in #side-term.
    $('wb-body').classList.toggle('term-view', view === 'term')
    const want = view === 'term' && usable(session()) ? current : null
    if (want !== termFor) { termFor = want; if (want) onTerminal(session()); else offTerminal() }
  }
  let termFor = null
  function renderLists() { renderRoot(); renderTree(); renderGit(); renderTabs() }
  function renderAll() { renderView(); renderLists(); renderDoc() }

  // Agents change files while you watch: while the panel is on screen, one
  // short SSH command every 20 s re-checks visible directories + Git status.
  setInterval(() => {
    const w = space(), s = session()
    if (!w || !usable(s) || !layout.right || w.view === 'term' || document.visibilityState !== 'visible' || w.syncing) return
    if (Date.now() - w.syncedAt > 20000) sync()
  }, 5000)
  window.addEventListener('focus', () => { const w = space(); if (w && layout.right && w.view !== 'term' && usable(session()) && Date.now() - w.syncedAt > 5000) sync() })

  function initWorkbench() {
    $('wb-root').onchange = e => setRoot(e.target.value)
    $('wb-root-path').oncontextmenu = e => { const w = space(); if (w) AIHubMenu.open(e, pathItems(rootPathOf(w), '')) }
    $('explorer').addEventListener('contextmenu', e => {
      if (e.target.closest('.tree-row,.change-row')) return
      const w = space(); if (!w) return
      AIHubMenu.open(e, [
        { label: '刷新', hint: '↻', action: () => sync(w.id, { force: true }) },
        { label: '新建文件夹…', action: () => newFolder('') },
        { label: '全部折叠', action: collapseAll },
        '-',
        ...rootsOf(session()).filter(r => r.key !== w.rootKey).map(r => ({ label: '切换到：' + r.label, action: () => setRoot(r.key) })),
        '-', ...pathItems(rootPathOf(w), '')
      ])
    })
  }

  window.AIHubWorkbench = {
    init(options) { ({ hub, toast, getSession, insertText } = options); onLayout = options.onLayout || onLayout; onTerminal = options.onTerminal || onTerminal; offTerminal = options.offTerminal || offTerminal; initLayout(); initWorkbench() },
    setSession, usableChanged, forget, toggleFocus, dirtyCount, layout, openFile, openDiff, openImage, sync,
    // Read-only text (e.g. captured terminal history); searchable with ⌘F.
    openText(title, content, note) {
      if (!space()) return
      const key = 'text|' + title, w = space(), existing = w.docs.find(d => d.key === key)
      if (existing) Object.assign(existing, { content, note }); else addDoc({ key, kind: 'text', path: title, content, note })
      w.active = key; renderAll()
    },
    onState(id, status) { if (id === current && status === 'connected' && layout.right) ensureLoaded() }
  }
})()
