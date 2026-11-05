'use strict'
// The renderer is shared by browser WebUI and a future thin Electron shell.
// This bridge requires a real local HTTP backend; file:// cannot fake a host list.
;(() => {
  if (window.remoteHub) return
  const subscribers = new Set(), queues = new Map()
  let csrf, build = null, streamReady = false, readyPromise
  const isWeb = ['http:', 'https:'].includes(location.protocol) && location.hostname === '127.0.0.1'
  async function bootstrap() {
    if (!isWeb) throw new Error('请从本机 WebUI 地址打开，不要直接打开 remote.html。运行 catmux start。')
    const response = await fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '本机后端不可达')
    csrf = result.data.csrf
    if (build && result.data.build && result.data.build !== build) emit({ type: 'update', build: result.data.build })
    build = build || result.data.build
  }
  // Installable app: the service worker only provides an offline "start the
  // backend" page; it never caches API calls or the event stream.
  if (isWeb && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  function ready() { if (!readyPromise) readyPromise = bootstrap().catch(e => { readyPromise = null; throw e }); return readyPromise }
  async function invoke(method, payload = {}) {
    await ready()
    const response = await fetch('/api/' + method, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-AIHub-CSRF': csrf }, body: JSON.stringify(payload) })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '本机操作失败')
    return result.data
  }
  function flush(id, q) {
    // Stay under the server's 64 KiB input limit without splitting a surrogate pair.
    let cut = Math.min(q.pending.length, 30000)
    if (cut < q.pending.length && /[\ud800-\udbff]/.test(q.pending[cut - 1])) cut--
    const data = q.pending.slice(0, cut); q.pending = q.pending.slice(cut)
    const waiters = q.pending ? [] : q.waiters.splice(0)
    q.busy = true
    invoke('write', { id, data }).then(r => waiters.forEach(w => w.resolve(r)), e => waiters.forEach(w => w.reject(e)))
      .finally(() => { q.busy = false; if (q.pending) flush(id, q) })
  }
  function emit(event) { for (const listener of subscribers) listener(event) }
  async function events() {
    let attempt = 0
    while (true) {
      try {
        await ready()
        const response = await fetch('/api/events', { credentials: 'same-origin', headers: { 'X-AIHub-CSRF': csrf }, cache: 'no-store' })
        if (response.status === 401 || response.status === 403) { await bootstrap(); continue }
        if (!response.ok || !response.body) throw new Error('事件通道未连接')
        emit({ type: 'backend', online: true }); attempt = 0
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let pending = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) throw new Error('本机后端连接断开')
          pending += decoder.decode(value, { stream: true })
          let index
          while ((index = pending.indexOf('\n\n')) >= 0) {
            const message = pending.slice(0, index); pending = pending.slice(index + 2)
            for (const line of message.split('\n')) if (line.startsWith('data: ')) emit(JSON.parse(line.slice(6)))
          }
        }
      } catch (e) {
        emit({ type: 'backend', online: false, detail: e.message })
        if (!isWeb) return
        await new Promise(resolve => setTimeout(resolve, Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4))))
      }
    }
  }
  async function upload(id, bytes, name) {
    await ready()
    const response = await fetch(`/api/upload?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || 'screenshot.png')}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-AIHub-CSRF': csrf }, body: bytes })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '上传失败')
    return result.data
  }
  async function confirmOperation(id, operation) {
    const result = await invoke('prepare-confirm', { id, operation })
    const where = `${result.host === 'local' ? '本机' : result.host} 上的 tmux 会话「${result.tmux}」`
    const message = operation !== 'stop' ? `从本机列表移除 ${result.name}？\n只移除记录，远端 agent、项目和分支保留。`
      : !result.imported ? `停止远端 ${result.name}？\n这将结束 ${where} 及其中的 agent。项目、worktree 与分支保留。`
      : `结束 ${where}？\n\n这个会话不是 Catmux 创建的（导入），结束后其中运行的 agent 会被终止。项目文件、worktree 与分支不删除。` +
        (result.squadInstance ? '\n\n它是 Claude Squad 的实例：cs 的记录仍保留，cs 里可能显示为失效，可在 cs 中用 D 清理。' : '')
    if (!window.confirm(message)) return false
    return invoke(operation, { id, ticket: result.ticket })
  }
  window.remoteHub = {
    info: () => invoke('info'), hosts: () => invoke('hosts'), probe: host => invoke('probe', { host }),
    sessions: () => invoke('sessions'), discover: host => invoke('discover', { host }),
    create: opts => invoke('create', opts), import: opts => invoke('import', opts),
    connect: id => invoke('connect', { id }), disconnect: id => invoke('disconnect', { id }),
    stop: id => confirmOperation(id, 'stop'), forget: id => confirmOperation(id, 'forget'),
    snapshot: id => invoke('snapshot', { id }), redraw: id => invoke('redraw', { id }),
    rename: (id, name, group) => invoke('rename', { id, name, group }),
    // Terminal input: one request in flight per session; anything typed in the
    // meantime is merged into the next request (order kept, far fewer requests).
    write: (id, data) => new Promise((resolve, reject) => {
      let q = queues.get(id)
      if (!q) { q = { pending: '', waiters: [], busy: false }; queues.set(id, q) }
      q.pending += data; q.waiters.push({ resolve, reject })
      if (!q.busy) flush(id, q)
    }),
    resize: (id, cols, rows) => invoke('resize', { id, cols, rows }),
    git: (id, root) => invoke('git', { id, root }), files: (id, path = '', root) => invoke('files', { id, path, root }), upload,
    tree: (id, paths, root, git = true, deep = false) => invoke('tree', { id, paths, root, git, deep }), roots: id => invoke('roots', { id }),
    readFile: (id, path, root) => invoke('read-file', { id, path, root }), readImage: (id, path, root) => invoke('read-image', { id, path, root }),
    diff: (id, path, staged, root) => invoke('diff', { id, path, staged, root }),
    saveFile: (id, path, content, sha256, root) => invoke('save-file', { id, path, content, sha256, root }),
    listDirs: (host, path) => invoke('list-dirs', { host, path }),
    branches: (host, project) => invoke('branches', { host, project }),
    projectSettings: (host, project) => invoke('project-settings', { host, project }),
    setProjectSettings: (host, project, base, prTarget) => invoke('set-project-settings', { host, project, base, prTarget }),
    taskStatus: (id, target) => invoke('task-status', { id, target }),
    taskPr: (id, opts) => invoke('task-pr', { id, ...opts }),
    taskClean: async (id, target, message) => {
      const prep = await invoke('prepare-confirm', { id, operation: 'clean' })
      if (!window.confirm(message)) return false
      return invoke('task-clean', { id, target, ticket: prep.ticket })
    },
    capture: (id, lines) => invoke('capture', { id, lines }), copyMode: (id, pageUp = true) => invoke('copy-mode', { id, pageUp }),
    launchSettings: () => invoke('launch-settings'), setLaunchDefault: (tool, preset, extra) => invoke('set-launch-default', { tool, preset, extra }),
    resetLaunchDefault: tool => invoke('reset-launch-default', { tool }),
    checkPath: (id, path) => invoke('check-path', { id, path }), uploadLocal: (id, path) => invoke('upload-local', { id, path }),
    pickUpload: id => new Promise(resolve => {
      const picker = document.createElement('input'); picker.type = 'file'
      picker.addEventListener('cancel', () => resolve(null), { once: true })
      picker.addEventListener('change', async () => {
        const file = picker.files[0]
        if (!file) { resolve(null); return }
        // Resolve with a promise so picker errors reach the UI's normal action handler.
        resolve((async () => {
          if (/^(\.env.*|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa|dsa)(\..*)?|auth\.json|credentials.*|secrets.*|settings\.json|config\.toml)$/i.test(file.name) || /\.(pem|key|env)$/i.test(file.name)) throw new Error('不允许读取或上传私钥 / 登录凭据，请选择截图或项目文件')
          if (file.size > 32 * 1024 * 1024) throw new Error('文件需小于 32 MiB')
          return upload(id, new Uint8Array(await file.arrayBuffer()), file.name)
        })())
      }, { once: true })
      picker.click()
    }),
    copy: text => navigator.clipboard.writeText(text),
    onEvent: cb => { subscribers.add(cb); if (!streamReady) { streamReady = true; events() }; return () => subscribers.delete(cb) }
  }
})()
