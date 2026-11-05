'use strict'
const hub = window.remoteHub
const workbench = window.AIHubWorkbench
const $ = id => document.getElementById(id)
const sessions = new Map(), terminals = new Map(), states = new Map()
// A proportional CJK font before Menlo makes xterm measure W ~12px but i
// ~3px, then allocate that wide W cell to every letter. Keep Latin monospace;
// the browser can still choose a CJK fallback for glyphs Menlo doesn't contain.
const TERMINAL_FONT = 'Menlo, Monaco, "SF Mono", Consolas, "Liberation Mono", monospace'
const savedFontSize = Number(localStorage.getItem('terminal-font-size'))
let terminalFontSize = Number.isInteger(savedFontSize) && savedFontSize >= 11 && savedFontSize <= 24 ? savedFontSize : 14
let active = null, hosts = [], upload = null, toastTimer, info, busy = false, initialized = false
const statusNames = { detached: '未连接', connecting: '连接中', reconnecting: '等待恢复', attached: '传输运行中', connected: '已连接', blocked: '需要处理', missing: '会话不存在', stopped: '已停止', failed: '创建失败', creating: '创建中' }
// Toasts may carry explicit choices (e.g. a local-only pasted path); nothing
// happens unless one is clicked.
function toast(message, actions = []) {
  const box = $('toast'); box.replaceChildren(node('span', message)); box.hidden = false
  for (const a of actions) {
    const b = node('button', a.label, 'toast-action')
    b.onclick = () => { box.hidden = true; action(a.action) }
    box.append(b)
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { box.hidden = true }, actions.length ? 20000 : 6000)
}
window.AIHubToast = toast
async function action(fn) { try { return await fn() } catch (e) { toast(e.message); return null } }
function node(tag, content, className) { const el = document.createElement(tag); if (content != null) el.textContent = content; if (className) el.className = className; return el }
function selected() { return sessions.get(active) }
// Devices: "local" is this Mac (local tmux), everything else an ssh-config Host.
const LOCAL = 'local'
const hostInfo = alias => hosts.find(h => h.alias === alias)
function deviceLabel(alias) { return alias === LOCAL ? `本机 · ${hostInfo(LOCAL)?.hostname || '这台 Mac'}` : alias }
function fillHosts(select, preferred) {
  select.replaceChildren()
  if (!hosts.length) { const empty = node('option', '没有可用设备，请检查本机后端'); empty.value = ''; select.append(empty); return }
  for (const h of hosts) { const opt = node('option', h.local ? `${deviceLabel(LOCAL)} · 本地终端` : `${h.alias} · ${h.user || ''}`); opt.value = h.alias; select.append(opt) }
  if (hosts.some(h => h.alias === preferred)) select.value = preferred
}
// Background sessions that produced real output since they were last viewed.
const unread = new Set(), unreadBytes = new Map()
let listFrame = 0
function scheduleList() { cancelAnimationFrame(listFrame); listFrame = requestAnimationFrame(renderList) }
function noteOutput(id, data) {
  if (id === active || unread.has(id) || !sessions.has(id)) return
  // Ignore tmux status-line ticks: count visible text only, over a threshold.
  const text = data.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b./g, '').replace(/\s+/g, '')
  const total = (unreadBytes.get(id) || 0) + text.length
  unreadBytes.set(id, total)
  if (total > 400) { unread.add(id); scheduleList() }
}
function deviceMenu(host) {
  const pick = () => { if (hosts.some(h => h.alias === host)) $('host').value = host }
  return [
    { label: `在 ${deviceLabel(host)} 新建会话`, action: () => showCreate(host) },
    { label: '检查环境', action: () => { pick(); return showProbe() } },
    { label: '发现已有 tmux 会话', action: () => { pick(); return discover() } },
    host === LOCAL ? null : '-',
    host === LOCAL ? null : { label: '复制 SSH 命令', action: () => copyText(`ssh ${host}`, ' SSH 命令') }
  ]
}
function renderList() {
  const filter = $('filter').value.toLowerCase()
  const devices = new Map()
  for (const s of sessions.values()) {
    if (filter && ![s.name,s.host,deviceLabel(s.host),s.cwd,s.tool,s.group].join(' ').toLowerCase().includes(filter)) continue
    if (!devices.has(s.host)) devices.set(s.host, [])
    devices.get(s.host).push(s)
  }
  const rank = h => h === LOCAL ? -1 : (i => i < 0 ? 1e6 : i)(hosts.findIndex(x => x.alias === h))
  const list = $('session-list'), scroll = list.scrollTop
  list.replaceChildren()
  for (const host of [...devices.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const items = devices.get(host).sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.createdAt || 0) - (b.createdAt || 0))
    const online = items.filter(s => states.get(s.id) === 'connected').length
    const head = node('div', null, 'group-title device'); head.dataset.host = host
    const add = node('button', '＋', 'icon-btn device-add'); add.title = `在 ${deviceLabel(host)} 新建会话`; add.setAttribute('aria-label', add.title)
    add.onclick = e => { e.stopPropagation(); showCreate(host) }
    head.append(node('span', deviceLabel(host), 'device-name'), node('small', `${items.length}${online ? ` · ${online} 在线` : ''}`), add)
    head.oncontextmenu = e => AIHubMenu.open(e, deviceMenu(host))
    list.append(head)
    for (const s of items) {
      const card = node('button', null, `session-card${s.id === active ? ' active' : ''}${unread.has(s.id) ? ' unread' : ''}`)
      card.dataset.id = s.id
      const title = node('b', s.name), meta = node('span', `${s.tool.toUpperCase()}${s.owned ? '' : ' · 导入'}`)
      if (s.group) meta.append(node('em', s.group, 'group-tag'))
      if (s.squadInstance || /^claudesquad_/.test(s.tmux || '')) meta.append(node('em', 'Squad 实例', 'group-tag'))
      if (s.launch?.danger) { const tag = node('em', '完全权限', 'launch-tag'); tag.title = commandLine(s.tool, s.launch.args); meta.append(tag) }
      const path = node('small', s.cwd)
      const dot = node('i', null, 'dot' + (states.get(s.id) === 'connected' ? ' online' : ''))
      title.prepend(dot); card.append(title,meta,path)
      if (unread.has(s.id)) title.append(node('span', '新输出', 'unread-tag'))
      card.addEventListener('click', () => select(s.id))
      card.addEventListener('contextmenu', e => AIHubMenu.open(e, sessionMenu(s)))
      list.append(card)
    }
  }
  list.scrollTop = scroll
}
function sessionMenu(s) {
  const online = ['connected', 'attached', 'connecting', 'reconnecting'].includes(states.get(s.id))
  const attach = s.tmux ? `${s.transport === 'udp' ? 'tssh --udp' : 'ssh'} -t ${s.host} 'tmux attach -t =${s.tmux}'` : ''
  return [
    { label: '打开', action: () => select(s.id) },
    { label: '连接', disabled: online || ['stopped'].includes(s.status), action: async () => { await select(s.id); if (!online) await hub.connect(s.id) } },
    { label: '断开（远端 agent 保留）', disabled: !online, action: () => hub.disconnect(s.id) },
    '-',
    { label: '重命名…', action: () => renameSession(s, 'name') },
    { label: '修改分组…', action: () => renameSession(s, 'group') },
    '-',
    { label: '复制远端目录', action: () => copyText(s.cwd, '远端目录') },
    { label: '复制 scp 地址', action: () => copyText(`${s.host}:${s.cwd}`, ' scp 地址') },
    { label: '复制终端附着命令', disabled: !attach, action: () => copyText(attach, '附着命令') },
    { label: '复制 agent 启动命令', disabled: s.tool === 'shell' || !s.owned, action: () => copyText(commandLine(s.tool, s.launch?.args), '启动命令') },
    '-',
    isTask(s) ? { label: '结束任务…（停止 / 清理 / 推送并开 PR）', danger: true, action: () => endTask(s) } : null,
    isTask(s) ? null : { label: s.owned ? '停止远端 agent…' : '结束这个 tmux 会话（导入）…', danger: true, disabled: !s.tmux || s.status === 'stopped', action: () => stopSession(s.id) },
    { label: '从本机列表移除…', danger: true, action: () => forgetSession(s.id) }
  ]
}
// Plain-text copies of the session's tmux pane — only on explicit request.
async function copyRecentOutput(s) {
  const r = await hub.capture(s.id, 3000)
  await hub.copy(r.text)
  toast(`已复制${r.alternate ? '当前屏幕' : '最近输出'}（${r.text.split('\n').length} 行）${r.alternate ? '：该程序使用全屏界面，更早的内容在程序自己的滚动里' : ''}`)
}
async function showHistory(s) {
  const r = await hub.capture(s.id, 20000)
  workbench.openText(`${s.name} · 终端历史`, r.text, r.alternate ? '全屏程序：仅当前屏幕' : `最近 ${r.text.split('\n').length} 行`)
}
async function copyText(text, what) { await hub.copy(text); toast(`已复制${what}：${text}`) }
async function renameSession(s, field) {
  const value = window.prompt(field === 'name' ? '会话名称' : '分组（留空为未分组）', field === 'name' ? s.name : (s.group || ''))
  if (value == null) return
  if (field === 'name' && !value.trim()) throw new Error('名称不能为空')
  await hub.rename(s.id, field === 'name' ? value.trim() : s.name, field === 'group' ? value.trim() : (s.group || ''))
  await reload()
}
function updateToolbar() {
  const s = selected(), status = s ? states.get(s.id) || s.status || 'detached' : 'detached'
  $('session-name').textContent = s?.name || '你的 tmux / AI 工作台'
  $('session-host').textContent = s ? `${s.host === LOCAL ? '本机' : s.host} / ${s.tool.toUpperCase()} / TMUX${s.launch?.danger ? ' / 完全权限' : ''}` : 'LOCAL CONTROL / TMUX ON ANY DEVICE'
  $('session-host').title = s?.launch?.args?.length ? commandLine(s.tool, s.launch.args) : ''
  $('connection').textContent = statusNames[status] || status
  $('connection').classList.toggle('online', status === 'connected')
  $('connect').textContent = s && ['failed', 'creating'].includes(s.status) ? '恢复并连接' : '连接'
  // While booting from cache the record may be stale: show it, but no actions yet.
  const booting = document.body.classList.contains('booting')
  $('terminal-focus').disabled = !s || booting
  for (const id of ['connect','disconnect','forget','attach']) $(id).disabled = !s || booting
  $('stop').disabled = booting || !s || !s.tmux || s.status === 'stopped'
  $('stop').textContent = isTask(s) ? '结束任务…' : s && !s.owned ? '结束会话' : '停止远端'
  $('stop').title = s && !s.owned ? '导入的 tmux 会话：确认后结束它（会终止其中的 agent）' : ''
  // The cwd is ellipsized from the left (rtl); LRM marks keep "/" where it belongs.
  $('remote-cwd').textContent = s?.cwd ? `\u200e${s.cwd}\u200e` : '本机仅负责显示与管理'; $('remote-cwd').title = s?.cwd || ''
}
function ensureTerminal(id) {
  if (terminals.has(id)) return terminals.get(id)
  const el = node('div', null, 'remote-terminal'); el.dataset.id = id; $('terminal-deck').append(el)
  const term = new Terminal({ cursorBlink: true, fontSize: terminalFontSize, fontFamily: TERMINAL_FONT,
    fontWeight: 'normal', fontWeightBold: 'bold', letterSpacing: 0, lineHeight: 1.2, scrollback: 50000,
    // When the CLI / tmux grabs the mouse, ⌥-drag still makes a normal text selection (⌘C copies it).
    macOptionClickForcesSelection: true,
    allowProposedApi: true, theme: { background: '#0b0c0e', foreground: '#eceef2', cursor: '#f0703a', selectionBackground: '#f0703a66' } })
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit)
  try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11' } catch {}
  term.open(el)
  const item = { term, fit, el, restored: false, resizeTimer: null }; terminals.set(id, item)
  // OSC 52: tmux copy-mode (drag / y) sends the copied text here → Mac clipboard.
  // Ignored during history replay and for terminals not on screen.
  term.parser.registerOscHandler(52, data => {
    const i = data.indexOf(';'), payload = i < 0 ? '' : data.slice(i + 1)
    if (!payload || payload === '?' || item.replaying || id !== active || document.visibilityState !== 'visible') return true
    try {
      const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
      if (bytes.length > 4 * 1024 * 1024) return true
      const text = new TextDecoder().decode(bytes)
      navigator.clipboard.writeText(text).then(() => toast(`已复制到本机剪贴板（${text.length} 字）`), () => toast('浏览器拒绝写入剪贴板：请先点一下窗口再复制'))
    } catch {}
    return true
  })
  // xterm emits both keystrokes and automatic replies to terminal queries.
  // Never answer while replaying history, and only from a visible page, so a
  // reload or a second tab cannot inject stray replies into the remote CLI.
  // Apps like Claude Code turn on "report every mouse move" (1003 + SGR). Send
  // only the latest motion per ~50 ms; clicks / keys go out at once, and a
  // pending hover position is dropped when real input arrives.
  let motion = null, motionTimer = null
  const send = data => hub.write(id, data).catch(() => {})
  term.onData(data => {
    if (item.replaying || document.visibilityState !== 'visible') return
    const m = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data)
    if (m && (Number(m[1]) & 32)) {
      motion = data
      if (!motionTimer) motionTimer = setTimeout(() => { motionTimer = null; if (motion) { send(motion); motion = null } }, 50)
      return
    }
    if (motion && !m) motion = null   // hover position is stale once a key is pressed
    if (motion) { send(motion); motion = null }  // keep a drag's last point before the release
    send(data)
  })
  // Dragging a pane edge refits every frame; send the PTY only the settled size
  // so the remote tmux/CLI does not redraw dozens of times per drag.
  term.onResize(({ cols, rows }) => {
    clearTimeout(item.resizeTimer)
    item.resizeTimer = setTimeout(() => hub.resize(id, cols, rows).catch(() => {}), 90)
  })
  return item
}
// Synchronized output (DEC 2026): xterm.js 5.5 does not implement it, so hold
// everything between "begin" and "end" and hand xterm the whole frame at once.
// tmux emits these markers because we attach with -T sync.
const BSU = '\x1b[?2026h', ESU = '\x1b[?2026l'
function heldPrefix(data, marker) {
  for (let k = Math.min(data.length, marker.length - 1); k > 0; k--) if (data.endsWith(marker.slice(0, k))) return k
  return 0
}
function flushSync(item) { clearTimeout(item.syncTimer); if (item.sync) item.term.write(item.sync); item.sync = null }
function feed(item, chunk) {
  let data = (item.held || '') + chunk, out = ''
  item.held = ''
  while (data) {
    if (item.sync == null) {
      const i = data.indexOf(BSU)
      if (i < 0) { const k = heldPrefix(data, BSU); out += data.slice(0, data.length - k); item.held = data.slice(data.length - k); break }
      out += data.slice(0, i + BSU.length); data = data.slice(i + BSU.length)
      item.sync = ''; clearTimeout(item.syncTimer)
      item.syncTimer = setTimeout(() => flushSync(item), 120) // never hold a frame longer than this
    } else {
      const j = data.indexOf(ESU)
      if (j < 0) {
        const k = heldPrefix(data, ESU); item.sync += data.slice(0, data.length - k); item.held = data.slice(data.length - k)
        if (item.sync.length > 1048576) { out += item.sync; item.sync = ''; }
        break
      }
      out += item.sync + data.slice(0, j + ESU.length); data = data.slice(j + ESU.length)
      item.sync = null; clearTimeout(item.syncTimer)
    }
  }
  if (out) item.term.write(out)
}
let fitFrame = 0
function fitActive() {
  cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => { const t = active && terminals.get(active); if (t && !$('terminal-deck').hidden) { try { t.fit.fit() } catch {} } })
}
function updateFontControls() {
  $('terminal-font-size').textContent = `${terminalFontSize} px`
  $('terminal-font-smaller').disabled = terminalFontSize <= 11
  $('terminal-font-larger').disabled = terminalFontSize >= 24
}
function setTerminalFontSize(value) {
  terminalFontSize = Math.max(11, Math.min(24, Math.round(value)))
  localStorage.setItem('terminal-font-size', String(terminalFontSize))
  for (const {term} of terminals.values()) term.options.fontSize = terminalFontSize
  updateFontControls(); requestAnimationFrame(fitActive)
  terminals.get(active)?.term.focus()
}
function toggleTerminalFocus() {
  if (!selected()) return
  workbench.toggleFocus(); fitActive()
  terminals.get(active)?.term.focus()
}
async function select(id) {
  active = id; unread.delete(id); unreadBytes.delete(id)
  const s = selected(); if (!s) return
  if (hosts.some(h => h.alias === s.host)) { $('host').value = s.host; localStorage.setItem('last-host', s.host) }
  // Show the deck before creating/sizing the terminal: xterm measures its real
  // size first, so history is laid out once and the PTY is not resized again.
  $('welcome').hidden = true; $('terminal-deck').hidden = false
  const terminal = ensureTerminal(id)
  for (const [key,t] of terminals) t.el.classList.toggle('active', key === id)
  renderList(); updateToolbar(); workbench.setSession(s)
  try { terminal.fit.fit() } catch {}
  if (hub.snapshot && !terminal.restored) {
    // Replay history invisibly, then let tmux repaint once, then reveal.
    terminal.el.classList.add('restoring')
    const snapshot = await action(() => hub.snapshot(id))
    if (snapshot) {
      flushSync(terminal); terminal.held = ''
      terminal.term.reset(); terminal.replaying = true
      await new Promise(resolve => terminal.term.write(snapshot.data, resolve))
      terminal.replaying = false
      states.set(id, s.recoveryError && snapshot.status === 'detached' ? 'blocked' : snapshot.status)
      $('status-detail').textContent = s.recoveryError || snapshot.detail || s.error || ''
      terminal.restored = true
      if (snapshot.status === 'connected' && snapshot.data && hub.redraw) {
        if (await hub.redraw(id).catch(() => false)) await new Promise(r => setTimeout(r, 160))
      }
    }
    terminal.el.classList.remove('restoring')
    if (active === id) { renderList(); updateToolbar() }
  }
  fitActive()
  localStorage.setItem('active-session', id)
  if ((!states.has(id) || states.get(id) === 'detached') && s.status !== 'stopped' && s.status !== 'failed') await action(() => hub.connect(id))
}
async function reload() {
  const list = await hub.sessions(); sessions.clear()
  for (const s of list) sessions.set(s.id, s)
  cacheSessions(); renderList(); updateToolbar()
  const s = selected()
  // Status can change after recovery; refresh the side panel's availability.
  if (s && workbench.usableChanged?.(s)) workbench.setSession(s)
}
// Recent remote projects per host, newest first (local browser only).
function recentProjects(host) {
  let list = []
  try { list = JSON.parse(localStorage.getItem('recent-projects:' + host) || '[]') } catch {}
  const last = localStorage.getItem('last-project:' + host)
  const fromSessions = [...sessions.values()].filter(s => s.host === host && s.project).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(s => s.project)
  return [...new Set([...(last ? [last] : []), ...list, ...fromSessions])].filter(p => typeof p === 'string' && p.startsWith('/')).slice(0, 8)
}
function rememberProject(host, project) {
  try { localStorage.setItem('recent-projects:' + host, JSON.stringify([project, ...recentProjects(host).filter(p => p !== project)].slice(0, 8))) } catch {}
}
const projectInput = AIHubPathInput.attach({ input: $('create-project'), list: $('project-suggest'), hint: $('project-hint'), hub,
  host: () => $('create-host').value, recent: () => recentProjects($('create-host').value) })
function updateTransport() {
  const sel = $('create-transport'), local = $('create-host').value === LOCAL
  if (local === (sel.value === 'local')) return
  sel.replaceChildren()
  const options = local ? [['local', '本机直接运行 · 本地 tmux']] : [['udp', 'tssh UDP · 自动漫游'], ['ssh', 'SSH TCP · 明确选择']]
  for (const [value, label] of options) { const o = node('option', label); o.value = value; sel.append(o) }
  sel.disabled = local
}
function showCreate(host) {
  if (!initialized || !hosts.length) { toast('设备列表尚未就绪。请先检查本机后端并刷新 SSH 配置。'); return }
  fillHosts($('create-host'), typeof host === 'string' ? host : $('host').value || info?.initialHost)
  updateTransport()
  $('create-project').value = selected()?.project || localStorage.getItem('last-project:' + $('create-host').value) || info?.initialProject || ''
  $('create-error').textContent = ''; $('create-dialog').showModal(); $('create-name').focus()
  projectInput.prefetch(); projectInput.refresh()
  $('create-save-project').checked = false; delete $('create-target').dataset.touched; delete $('create-base').dataset.touched; scheduleBranches()
  $('create-save-default').checked = false; fillLaunch(true)
}
// ---- launch arguments: permission preset + extra args passed through as argv ----
let launchConfig = null
function splitArgs(text) {
  const out = []; let cur = '', quote = null, has = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]; else cur += c; continue }
    if (c === '"' || c === "'") { quote = c; has = true; continue }
    if (c === '\\' && i + 1 < text.length) { cur += text[++i]; has = true; continue }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false } continue }
    cur += c
  }
  if (quote) throw new Error('额外参数的引号没有闭合')
  if (cur || has) out.push(cur)
  return out
}
const shellWord = a => /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
function commandLine(tool, args) { return [tool, ...(args || [])].map(shellWord).join(' ') }
function fillLaunch(reset) {
  const tool = $('create-tool').value, presets = launchConfig?.presets?.[tool] || [{ key: 'default', label: '默认', args: [] }]
  const select = $('create-preset'), previous = select.value
  select.replaceChildren()
  for (const p of presets) { const o = node('option', p.label); o.value = p.key; select.append(o) }
  const d = launchConfig?.defaults?.[tool] || { preset: 'default', extra: [] }
  select.value = !reset && presets.some(p => p.key === previous) ? previous : d.preset
  if (reset) $('create-args').value = d.extra.map(shellWord).join(' ')
  $('launch-block').hidden = tool === 'shell'
  updateLaunchPreview()
}
function currentLaunch() {
  const tool = $('create-tool').value, preset = (launchConfig?.presets?.[tool] || []).find(p => p.key === $('create-preset').value)
  const extra = splitArgs($('create-args').value)
  const args = [...(preset?.args || []), ...extra]
  return { tool, preset: preset?.key || 'default', extra, args, danger: !!preset?.danger || extra.some(a => /^--(dangerously|yolo)/.test(a)) }
}
function updateLaunchPreview() {
  const box = $('launch-preview')
  if ($('create-tool').value === 'shell') { box.textContent = ''; return }
  try {
    const l = currentLaunch()
    box.replaceChildren(node('span', '远端执行：', 'muted-label'), node('code', commandLine(l.tool, l.args)))
    box.className = 'launch-preview' + (l.danger ? ' danger' : '')
    if (l.danger) box.append(node('small', 'agent 可不经确认在远端执行任意命令、修改任意文件。建议保持“独立 git worktree”。'))
  } catch (e) { box.replaceChildren(node('small', e.message)); box.className = 'launch-preview error' }
}
// ---- worktree start branch / PR target (per-project defaults) ----
let branchSeq = 0, branchTimer = null
function branchBlockVisible() { return !$('create-worktree').disabled && $('create-worktree').checked }
function scheduleBranches() { clearTimeout(branchTimer); branchTimer = setTimeout(loadBranches, 350) }
async function loadBranches() {
  const block = $('branch-block'); block.hidden = !branchBlockVisible()
  if (block.hidden) return
  const host = $('create-host').value, project = $('create-project').value.trim(), my = ++branchSeq, hint = $('branch-hint'), select = $('create-base')
  if (!/^(\/|~(\/|$))/.test(project)) { hint.textContent = '填写项目路径后读取分支'; hint.className = 'path-hint'; return }
  hint.textContent = `正在读取 ${host === 'local' ? '本机' : host}:${project} 的分支…`; hint.className = 'path-hint busy'
  try {
    const r = await hub.branches(host, project)
    if (my !== branchSeq) return
    const previous = select.value
    select.replaceChildren()
    const head = node('option', `当前检出：${r.current || '（detached HEAD）'}`); head.value = ''; select.append(head)
    const group = (label, items) => { if (!items.length) return; const g = document.createElement('optgroup'); g.label = label; for (const b of items) { const o = node('option', b.name); o.value = b.name; o.title = `${b.sha} ${b.subject}`; g.append(o) } select.append(g) }
    group('本地分支', r.local); group('远端跟踪分支', r.remote)
    const names = new Set([...r.local, ...r.remote].map(b => b.name))
    // Keep a start branch the user picked by hand if the new list still has it.
    const picked = select.dataset.touched && previous
    select.value = picked && names.has(picked) ? picked : r.defaults.base && names.has(r.defaults.base) ? r.defaults.base : ''
    $('create-target-list').replaceChildren(...[...new Set([...r.local.map(b => b.name), ...r.remote.map(b => b.name.replace(/^origin\//, ''))])].slice(0, 200).map(n => { const o = document.createElement('option'); o.value = n; return o }))
    if (!$('create-target').dataset.touched) $('create-target').value = r.defaults.prTarget || ''
    updateBranchHint()
  } catch (e) {
    if (my !== branchSeq) return
    hint.textContent = e.message.replace(/^MOUNT:/, ''); hint.className = 'path-hint ' + (/^MOUNT:/.test(e.message) ? 'warn' : 'error')
  }
}
function updateBranchHint() {
  const base = $('create-base').value, target = $('create-target').value.trim(), hint = $('branch-hint')
  hint.textContent = `从 ${base || '当前检出的分支'} 创建 aihub/<任务ID>${target ? `；结束时 PR 合并到 ${target}` : '；未设置 PR 目标分支（结束时可再选）'}`
  hint.className = 'path-hint ok'
}
function updateMode() {
  const disabled = $('create-tool').value === 'shell'
  $('create-worktree').disabled = disabled
  scheduleBranches()
  $('worktree-hint').textContent = disabled ? '远程 shell 不自动创建 worktree，目录不必是 Git 仓库。' : '会在远端私有目录创建工作副本；不移动、重置原项目。非 Git 目录不会自动初始化。'
}
async function create(event) {
  event.preventDefault(); if (busy) return
  busy = true; $('create-submit').disabled = true; $('create-error').textContent = ''
  const opts = { name: $('create-name').value.trim(), host: $('create-host').value, project: $('create-project').value.trim(),
    tool: $('create-tool').value, mode: 'direct', transport: $('create-transport').value,
    group: $('create-group').value.trim(), worktree: !$('create-worktree').disabled && $('create-worktree').checked }
  let launch = null
  if (opts.tool !== 'shell') {
    try { launch = currentLaunch() } catch (e) { $('create-error').textContent = e.message; busy = false; $('create-submit').disabled = false; return }
    opts.preset = launch.preset; opts.extra = launch.extra
    if (opts.worktree) {
      opts.base = $('create-base').value
      const t = $('create-target').value.trim(); if (t) opts.prTarget = t
      opts.saveProjectDefaults = $('create-save-project').checked
    }
  }
  try {
    if (launch && $('create-save-default').checked) launchConfig = await hub.setLaunchDefault(launch.tool, launch.preset, launch.extra)
    const s = await hub.create(opts); localStorage.setItem('last-project:' + s.host, s.project); rememberProject(s.host, s.project)
    await reload(); $('create-dialog').close(); await select(s.id); toast('Agent 已在远端创建；关闭本机窗口不会停止它')
  } catch (e) {
    $('create-error').textContent = `${e.message}\n创建可能已部分完成。请勿重复创建；点“取消”，选择左侧这条记录，再点“恢复并连接”。只核对并连接原会话，不重建 agent。`
    await reload()
  }
  finally { busy = false; $('create-submit').disabled = false }
}
// Remote reads can take a while over a relayed connection: show that we are working.
function waiting(el, text) {
  const start = Date.now()
  const paint = () => { const s = Math.round((Date.now() - start) / 1000); el.textContent = s < 2 ? text : `${text}（已等待 ${s} 秒${s >= 6 ? ' · 网络较慢，可能正经 Tailscale 中转' : ''}）` }
  paint(); const timer = setInterval(paint, 1000)
  return () => clearInterval(timer)
}
async function showProbe() {
  $('info-title').textContent = `${deviceLabel($('host').value)} · 环境（不检查模型与登录）`; $('info-dialog').showModal()
  const done = waiting($('info-content'), '检查登录 shell 的可执行路径…')
  const r = await action(() => hub.probe($('host').value)); done()
  if (!r) { $('info-content').textContent = '连接检查失败；没有修改任何远端配置。'; return }
  $('info-content').replaceChildren(node('pre',`${r.os} / ${r.arch}\n${r.tmuxVersion || '未安装 tmux'}\n\n${Object.entries(r.tools).map(([t,p]) => `${t.padEnd(9)} ${p || '未安装'}`).join('\n')}\n\n模型配置、登录状态、请求均未检查。`))
}
async function discover() {
  const host = $('host').value
  $('info-title').textContent = `${deviceLabel(host)} · 已有 tmux 会话`; $('info-dialog').showModal()
  const done = waiting($('info-content'), '读取会话元数据…')
  const list = await action(() => hub.discover(host)); done(); $('info-content').replaceChildren()
  if (!list) { $('info-content').textContent = '无法连接；没有创建或停止远端会话。'; return }
  if (!list.length) $('info-content').textContent = '没有运行中的 tmux 会话。'
  for (const s of list) {
    const row = node('div',null,'discovered'), text = node('div'), button = node('button','加入本机列表')
    text.append(node('b',s.name),node('small',`${s.command}${s.dead ? ' · 已退出' : ' · 运行中'} / ${s.cwd}`))
    if (/^claudesquad_/.test(s.name)) text.append(node('small', 'Claude Squad 留下的实例（Catmux 已不再集成 cs）：可加入列表查看或用“结束会话”结束；若 cs 仍在运行，两边会互相改窗口大小。', 'squad-note'))
    const exists = [...sessions.values()].some(x => x.host === host && x.tmux === s.name)
    if (exists) { button.disabled = true; button.textContent = '已在列表' }
    button.onclick = () => action(async () => { const record = await hub.import({ host, tmux: s.name }); await reload(); $('info-dialog').close(); await select(record.id) })
    row.append(text,button); $('info-content').append(row)
  }
}
function showUpload(id, result, file) {
  if (!result) return
  const host = sessions.get(id)?.host || ''
  upload = { id, host, ...result }
  $('upload-host').textContent = host + ':'; $('upload-path').textContent = result.path; $('upload-path').title = `${host}:${result.path}`
  $('upload-thumb').hidden = true
  // Local thumbnail only (data: URL, CSP-safe); the remote copy is the verified one.
  if (file?.type?.startsWith('image/') && file.size <= 8 * 1024 * 1024) {
    const reader = new FileReader(); reader.onload = () => { if (upload?.path === result.path) { $('upload-thumb').src = reader.result; $('upload-thumb').hidden = false } }; reader.readAsDataURL(file)
  }
  $('upload-result').hidden = false
  toast(`已上传到 ${host}，${result.size} 字节，远端 SHA-256 已匹配。尚未发送给 AI。`)
  if (autoInsert() && id === active) action(() => insertPath(result.path))
}
const autoInsert = () => { try { return localStorage.getItem('upload-auto-insert') === '1' } catch { return false } }
async function uploadBlob(file) {
  const id = active; if (!id) { toast('请先选择一个远端会话'); return }
  if (/^(\.env.*|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa|dsa)(\..*)?|auth\.json|credentials.*|secrets.*|settings\.json|config\.toml)$/i.test(file.name) || /\.(pem|key|env)$/i.test(file.name)) throw new Error('不允许读取或上传私钥 / 登录凭据，请选择截图或项目文件')
  if (!file.size || file.size > 32 * 1024 * 1024) throw new Error('文件需小于 32 MiB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  toast('正在通过 SSH 上传并校验文件…')
  showUpload(id, await hub.upload(id,bytes,file.name || 'screenshot.png'), file)
}
// ---- paste: images/files upload; text paths are checked against the SSH host ----
function pasteText(id, text) { terminals.get(id)?.term.paste(text) }
function pastedPath(text) {
  let p = text.trim()
  if (!p || p.length > 1024 || /[\r\n]/.test(p)) return null
  if (/^'.*'$|^".*"$/.test(p)) p = p.slice(1, -1)
  p = p.replace(/\\ /g, ' ')
  return /^(\/|~\/)/.test(p) && /\.[A-Za-z0-9]{1,8}$/.test(p) ? p : null
}
async function guardedPaste(id, text) {
  const file = pastedPath(text)
  if (!file) return pasteText(id, text)
  let r
  try { r = await hub.checkPath(id, file) } catch { return pasteText(id, text) }
  if (r.remote.exists || !r.local.exists) return pasteText(id, text)
  // The path exists only on this Mac: the remote CLI could never open it.
  const keep = { label: '仍然粘贴原文', action: () => pasteText(id, text) }
  if (r.local.image && r.local.file) toast(`这是本机路径，${r.host} 上不存在，远端无法读取。`, [
    { label: `上传到 ${r.host} 并插入远端路径`, action: async () => { toast(`正在通过 SSH 上传到 ${r.host}…`); const result = await hub.uploadLocal(id, file); showUpload(id, result); if (!autoInsert()) await insertPath(result.path) } }, keep])
  else toast(`这是本机路径，${r.host} 上不存在，远端程序无法读取它。`, [keep])
}
async function pasteClipboard(imagesOnly) {
  const id = active; if (!id) throw new Error('请先选择会话')
  let items = []
  try { items = await navigator.clipboard.read() } catch { if (imagesOnly) throw new Error('浏览器未允许读取剪贴板；可直接在终端按 ⌘V 粘贴图片') }
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (type) { const blob = await item.getType(type); return uploadBlob(new File([blob], 'clipboard.' + (type.split('/')[1] || 'png').replace('jpeg', 'jpg'), { type })) }
  }
  if (imagesOnly) throw new Error('剪贴板里没有图片')
  const text = await navigator.clipboard.readText()
  if (text) await guardedPaste(id, text)
}
$('new-session').onclick = showCreate; $('welcome-create').onclick = showCreate
$('terminal-font-smaller').onclick = () => setTerminalFontSize(terminalFontSize - 1)
$('terminal-font-larger').onclick = () => setTerminalFontSize(terminalFontSize + 1)
$('terminal-font-reset').onclick = () => setTerminalFontSize(14)
$('terminal-focus').onclick = toggleTerminalFocus
updateFontControls()
// System fonts can finish resolving after a terminal opens. Re-fit on readiness
// without disconnecting/recreating a PTY or sending input to the remote CLI.
document.fonts?.ready.then(() => {
  for (const {term} of terminals.values()) term.refresh(0, term.rows - 1)
  requestAnimationFrame(fitActive)
})
$('create-form').onsubmit = create; $('create-cancel').onclick = () => $('create-dialog').close()
$('create-tool').onchange = () => { updateMode(); fillLaunch(true) }
$('create-preset').onchange = updateLaunchPreview; $('create-args').oninput = updateLaunchPreview
$('launch-reset').onclick = () => action(async () => { launchConfig = await hub.resetLaunchDefault($('create-tool').value); fillLaunch(true); toast('已恢复该工具的内置默认启动方式') })
$('create-project').addEventListener('change', scheduleBranches); $('create-project').addEventListener('input', scheduleBranches)
$('create-worktree').addEventListener('change', scheduleBranches)
$('create-base').onchange = () => { $('create-base').dataset.touched = '1'; updateBranchHint() }
$('create-target').oninput = () => { $('create-target').dataset.touched = '1'; updateBranchHint() }
$('create-host').onchange = () => { updateTransport(); scheduleBranches(); $('create-project').value = localStorage.getItem('last-project:' + $('create-host').value) || ($('create-host').value === info?.initialHost ? info.initialProject : '') ; projectInput.prefetch(); projectInput.refresh() }
$('filter').oninput = renderList
$('refresh-hosts').onclick = () => action(refreshHosts)
$('probe').onclick = () => action(showProbe); $('discover').onclick = () => action(discover)
$('info-close').onclick = () => $('info-dialog').close()
$('connect').onclick = () => action(async () => {
  try { await hub.connect(active) } finally { await reload() }
  fitActive(); terminals.get(active)?.term.focus()
  if (selected()?.recoveryNote) toast(selected().recoveryNote)
})
$('disconnect').onclick = () => action(() => hub.disconnect(active))
async function stopSession(id) { const r = await hub.stop(id); await reload(); return r }
// Catmux worktree tasks end through a dialog (stop only / clean up / push + PR).
const isTask = s => !!(s && s.owned && s.worktree && s.mode === 'direct' && s.tmux === `aihub-${s.id}`)
function endTask(s) { AIHubEndTask.open(s, { hub, toast, stopSession, reload, copyText }) }
$('stop').onclick = () => action(() => isTask(selected()) ? endTask(selected()) : stopSession(active))
async function forgetSession(id) {
  if (workbench.dirtyCount() && !window.confirm('右侧有未保存的编辑。仍然移除此会话记录？')) return
  if (!(await hub.forget(id))) return
  terminals.get(id)?.term.dispose(); terminals.get(id)?.el.remove(); terminals.delete(id); states.delete(id)
  workbench.forget(id)
  if (active === id) { active = null; localStorage.removeItem('active-session'); $('welcome').hidden = false; $('terminal-deck').hidden = true; workbench.setSession(null) }
  await reload()
}
$('forget').onclick = () => action(() => forgetSession(active))
$('attach').onclick = () => action(async () => { const id = active; toast('选择文件后通过 SSH 上传…'); showUpload(id,await hub.pickUpload(id)) })
$('copy-upload').onclick = () => action(() => hub.copy(upload.path))
$('insert-upload').onclick = () => action(async () => {
  if (!upload || upload.id !== active) throw new Error('请选择这个附件所属的会话')
  // Only a literal remote path. No Enter, no model request, no @ for tools that do not support it.
  await insertPath(upload.path)
})
// Only a literal path. No Enter, no model request, no tool-specific flags.
async function insertPath(file) {
  const s = selected(); if (!s) throw new Error('请先选择会话')
  const quoted = /^[A-Za-z0-9_@%+=:,./-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`
  await hub.write(s.id, s.tool === 'claude' ? `@${quoted} ` : `${quoted} `)
  terminals.get(s.id)?.term.focus(); toast(`已插入 ${s.host} 上的路径，没有按回车或发送提示`)
}
$('dismiss-upload').onclick = () => { $('upload-result').hidden = true }
document.addEventListener('paste', event => {
  // Only the terminal is special. Inputs, dialogs and the right-hand editor
  // keep ordinary paste behaviour.
  if (!active || $('create-dialog').open || $('info-dialog').open) return
  const target = event.target
  if (!target.closest?.('#terminal-deck') && target !== document.body) return
  const files = [...(event.clipboardData?.files || [])]
  if (files.length) {
    event.preventDefault(); event.stopImmediatePropagation()
    for (const file of files) action(() => uploadBlob(file))
    return
  }
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!pastedPath(text)) return
  event.preventDefault(); event.stopImmediatePropagation()
  action(() => guardedPaste(active, text))
}, true)
$('terminal-deck').addEventListener('contextmenu', e => {
  const t = terminals.get(active), s = selected(); if (!t || !s) return
  const selection = t.term.getSelection()
  AIHubMenu.open(e, [
    { label: '复制', hint: '⌘C', disabled: !selection, action: () => copyText(selection, '选中文本') },
    { label: '粘贴', hint: '⌘V', action: () => pasteClipboard(false) },
    { label: `粘贴图片（上传到 ${s.host}）`, action: () => pasteClipboard(true) },
    { label: '全选', action: () => t.term.selectAll() },
    '-',
    { label: '复制最近输出（纯文本）', disabled: !s.tmux, action: () => copyRecentOutput(s) },
    { label: '在右侧查看终端历史', disabled: !s.tmux, action: () => showHistory(s) },
    { label: '滚动查看历史（tmux 复制模式）', hint: 'q 退出', disabled: !s.tmux, action: async () => { await hub.copyMode(s.id, true); t.term.focus(); toast('已进入 tmux 复制模式：滚轮 / PgUp 翻页，拖动选择即复制到本机，q 退出') } },
    '-',
    { label: `上传文件到 ${s.host}…`, action: () => $('attach').click() },
    { label: autoInsert() ? '✓ 上传后自动插入远端路径' : '上传后自动插入远端路径', action: () => { try { localStorage.setItem('upload-auto-insert', autoInsert() ? '0' : '1') } catch {}; toast(autoInsert() ? '已开启：上传完成后自动插入远端路径（不回车）' : '已关闭自动插入') } },
    { label: '清除本机滚动缓冲', hint: '不影响远端', action: () => t.term.clear() },
    '-',
    { label: '放大字号', hint: 'A＋', disabled: terminalFontSize >= 24, action: () => setTerminalFontSize(terminalFontSize + 1) },
    { label: '缩小字号', hint: 'A−', disabled: terminalFontSize <= 11, action: () => setTerminalFontSize(terminalFontSize - 1) },
    { label: $('terminal-focus').getAttribute('aria-pressed') === 'true' ? '退出专注' : '专注（收起两侧）', action: toggleTerminalFocus }
  ])
})
document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() })
document.addEventListener('drop', e => { if (!e.dataTransfer?.files.length || !active) return; e.preventDefault(); for (const file of e.dataTransfer.files) action(() => uploadBlob(file)) })
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!$('create-dialog').open) showCreate() } })
new ResizeObserver(fitActive).observe($('workspace'))
workbench.init({ hub, toast, getSession: selected, insertText: file => action(() => insertPath(file)), onLayout: fitActive })
hub.onEvent(evt => {
  if (evt.type === 'backend') {
    if (!evt.online) $('backend-status').textContent = '本机后端断开，正在重连；远端 agent 保留'
    else if (initialized) $('backend-status').textContent = `本机后端已连接 · ${hosts.length} 个 SSH 别名`
  }
  // Output is broadcast for every connected session; render only terminals this
  // page has opened (selecting one later restores its tail from the snapshot).
  if (evt.type === 'update') toast('Catmux 已更新到新版本。刷新窗口以加载新界面（未保存的编辑草稿会保留）。', [{ label: '立即刷新', action: () => location.reload() }])
  if (evt.type === 'data') { const t = terminals.get(evt.id); if (t) feed(t, evt.data); noteOutput(evt.id, evt.data) }
  if (evt.type === 'state') { states.set(evt.id,evt.status); scheduleList(); workbench.onState(evt.id, evt.status); if (evt.id === active) { updateToolbar(); $('status-detail').textContent = evt.detail || statusNames[evt.status]; fitActive() } }
})
// First paint from the local cache (names / paths only) so a reload does not
// flash an empty sidebar and the welcome screen before the backend answers.
function paintFromCache() {
  try {
    const cached = JSON.parse(localStorage.getItem('sessions-cache') || '[]'), last = localStorage.getItem('active-session')
    for (const s of cached) if (s && /^[a-f0-9]{32}$/.test(s.id)) sessions.set(s.id, s)
    if (last && sessions.has(last)) { active = last; $('welcome').hidden = true }
    renderList(); updateToolbar()
  } catch {}
}
function cacheSessions() {
  try { localStorage.setItem('sessions-cache', JSON.stringify([...sessions.values()].map(({ id, name, host, tool, cwd, project, group, owned, mode, status, launch, createdAt, tmux }) => ({ id, name, host, tool, cwd, project, group, owned, mode, status, launch, createdAt, tmux })))) } catch {}
}
async function init() {
  if (!hub) throw new Error('未连接后端。请运行 catmux start 后打开 http://127.0.0.1:48731。')
  paintFromCache()
  info = await hub.info(); await refreshHosts()
  launchConfig = await hub.launchSettings?.().catch(() => null)
  await reload()
  initialized = true
  const last = localStorage.getItem('active-session')
  if (last && sessions.has(last)) await select(last)
  if (active && !sessions.has(active)) { active = null; $('welcome').hidden = false; updateToolbar() }
  if (!active) $('welcome').hidden = false
  document.body.classList.remove('booting'); updateToolbar()
  if (!info.tssh) toast('本机缺少 tssh，仅本机终端可用；远端 UDP 连接需要安装 tssh')
  document.body.dataset.ready = 'true'
}
async function refreshHosts() {
  const preferred = $('host').value || localStorage.getItem('last-host') || info?.initialHost
  hosts = await hub.hosts()
  fillHosts($('host'), preferred); fillHosts($('create-host'), preferred)
  $('host').disabled = !hosts.length
  for (const id of ['new-session','welcome-create','probe','discover']) $(id).disabled = !hosts.length
  $('backend-status').textContent = hosts.length ? `本机后端已连接 · ${hosts.length} 个 SSH 别名` : 'SSH 配置中没有可用主机；创建已禁用'
  if (!initialized && info) initialized = true
}
init().catch(e => { document.body.classList.remove('booting'); updateToolbar(); $('welcome').hidden = !!active; toast(`启动检查失败：${e.message}`); $('backend-status').textContent = e.message; document.body.dataset.ready = 'error' })
