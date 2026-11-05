'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { JsonStore } = require('./web-store')
const { RemoteService, LaunchSettings, ProjectSettings } = require('./remote-service')
const { RemoteConnections } = require('./remote-connections')

const ROOT = path.join(__dirname, '..')
const COOKIE = 'aihub_web_session'
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const JS = 'text/javascript; charset=utf-8'
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/src/remote.css', ['src/remote.css', 'text/css; charset=utf-8']],
  // Installable web app (PWA) shell.
  ['/manifest.webmanifest', ['web/manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['web/sw.js', JS]],
  ['/offline.html', ['web/offline.html', 'text/html; charset=utf-8']],
  ['/icons/icon-192.png', ['web/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['web/icon-512.png', 'image/png']],
  ...['web-bridge', 'remote-renderer', 'remote-workbench', 'remote-menu', 'remote-pathinput', 'remote-endtask'].map(n => [`/src/${n}.js`, [`src/${n}.js`, JS]]),
  // Third-party front-end files are vendored (see web/vendor/LICENSES.md): no npm install needed.
  ['/vendor/xterm.js', ['web/vendor/xterm.js', JS]], ['/vendor/xterm.css', ['web/vendor/xterm.css', 'text/css; charset=utf-8']],
  ['/vendor/addon-fit.js', ['web/vendor/addon-fit.js', JS]], ['/vendor/addon-unicode11.js', ['web/vendor/addon-unicode11.js', JS]],
  ['/vendor/highlight.min.js', ['web/vendor/highlight.min.js', JS]]
])
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

// Catmux was previously called "Catmux": on first start, copy its metadata
// (session records + settings; never the lock) into the new data directory.
function defaultDataDir() {
  const base = path.join(os.homedir(), 'Library', 'Application Support')
  const dir = path.join(base, 'Catmux'), legacy = path.join(base, 'Catmux')
  if (!fs.existsSync(dir) && fs.existsSync(legacy) && fs.lstatSync(legacy).isDirectory()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const name of ['remote-sessions.json', 'launch-settings.json', 'project-settings.json']) {
      const from = path.join(legacy, name)
      if (fs.existsSync(from) && fs.lstatSync(from).isFile()) { fs.copyFileSync(from, path.join(dir, name)); fs.chmodSync(path.join(dir, name), 0o600) }
    }
    fs.writeFileSync(path.join(dir, 'MIGRATED_FROM.txt'), legacy + '\n', { mode: 0o600 })
  }
  return dir
}

function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
function error(message, status = 400) { const e = new Error(message); e.status = status; return e }
async function body(req, limit) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw error('请求体过大', 413)
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw error('请求体过大', 413); chunks.push(chunk) }
  return Buffer.concat(chunks)
}

async function createWebServer(options = {}) {
  const dataDir = options.dataDir || process.env.CATMUX_DATA || process.env.AIHUB_WEB_DATA || defaultDataDir()
  const store = options.store || new JsonStore(dataDir)
  const service = options.service || new RemoteService(store, new LaunchSettings(path.join(dataDir, 'launch-settings.json')), new ProjectSettings(path.join(dataDir, 'project-settings.json')))
  const connections = options.connections || new RemoteConnections(service)
  const clients = new Set(), confirmations = new Map()
  const cookie = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(32).toString('hex')
  // Front-end build id: open windows compare it after a backend restart and
  // offer a refresh, so stale page code never keeps running against new code.
  const build = (() => { const h = crypto.createHash('sha256'); for (const [, [file]] of FILES) { try { h.update(fs.readFileSync(path.join(ROOT, file))) } catch {} } return h.digest('hex').slice(0, 12) })()
  let origin = '', closing = false

  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  function authorize(req, api = false) {
    if (req.headers.host !== new URL(origin).host) throw error('Host 不匹配；仅允许本机入口', 403)
    if (req.headers.origin && req.headers.origin !== origin) throw error('拒绝跨来源请求', 403)
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw error('拒绝跨站请求', 403)
    if (!api) return
    const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim())
    if (!cookies.some(s => s.startsWith(COOKIE + '=') && matches(s.slice(COOKIE.length + 1), cookie))) throw error('本机会话未授权，请刷新页面', 401)
    if (!matches(req.headers['x-aihub-csrf'], csrf)) throw error('请求校验失败，请刷新页面', 403)
    if (req.method === 'POST' && req.headers.origin !== origin) throw error('操作必须来自本机页面', 403)
  }
  const handlers = {
    info: () => ({ name: 'Catmux', version: VERSION, dataDir, tssh: !!service.bins.tssh, modelAccess: false, initialHost: '', initialProject: '' }),
    hosts: () => service.hosts(), sessions: () => service.list(),
    probe: ({ host }) => service.probe(host), discover: ({ host }) => service.remoteSessions(host),
    create: opts => service.create(opts), import: opts => service.importSession(opts),
    connect: ({ id }) => connections.connect(id), disconnect: ({ id }) => { service.get(id); connections.disconnect(id); return true },
    snapshot: ({ id }) => connections.snapshot(id), redraw: ({ id }) => connections.redraw(id),
    write: ({ id, data }) => connections.write(id, data), resize: ({ id, cols, rows }) => connections.resize(id, cols, rows),
    git: ({ id, root }) => service.git(id, root), files: ({ id, path, root }) => service.files(id, path, root),
    tree: ({ id, paths, root, git, deep }) => service.tree(id, paths, root, git, deep),
    roots: ({ id }) => service.roots(service.get(id)),
    'read-file': ({ id, path, root }) => service.readFile(id, path, root),
    'read-image': ({ id, path, root }) => service.readImage(id, path, root),
    diff: ({ id, path, staged, root }) => service.diff(id, path, staged, root),
    'save-file': ({ id, path, content, sha256, root }) => service.saveFile(id, path, content, sha256, root),
    'check-path': ({ id, path }) => service.checkPath(id, path),
    'list-dirs': ({ host, path }) => service.listDirs(host, path),
    branches: ({ host, project }) => service.branches(host, project),
    'project-settings': ({ host, project }) => service.projectSettings(host, project),
    'set-project-settings': ({ host, project, base, prTarget }) => service.setProjectSettings(host, project, { base, prTarget }),
    'task-status': ({ id, target }) => service.taskStatus(id, target),
    'task-pr': ({ id, target, title, body, allowDirty, stopAfter, pushOnly }) => service.taskPr(id, { target, title, body, allowDirty, stopAfter, pushOnly }),
    'task-clean': async payload => { consumeConfirmation(payload, 'clean'); connections.disconnect(payload.id); const r = await service.taskClean(payload.id, payload.target); connections.state(payload.id, 'stopped', '任务已清理：worktree 与本地分支已删除'); return r },
    capture: ({ id, lines }) => service.capture(id, lines), 'copy-mode': ({ id, pageUp }) => service.copyMode(id, pageUp),
    'launch-settings': () => service.settings.all(),
    'set-launch-default': ({ tool, preset, extra }) => service.settings.set(tool, preset, extra),
    'reset-launch-default': ({ tool }) => service.settings.reset(tool),
    'upload-local': ({ id, path }) => service.uploadLocal(id, path),
    rename: ({ id, name, group }) => service.rename(id, name, group),
    'prepare-confirm': ({ id, operation }) => {
      const s = service.get(id)
      if (!['stop', 'forget', 'clean'].includes(operation)) throw error('确认操作无效')
      const can = operation === 'stop' ? service.stoppable(s) : operation === 'clean' ? (service.isTask(s) ? { ok: true } : { ok: false, reason: '只有 Catmux 独立 worktree 任务可以清理' }) : { ok: true }
      if (!can.ok) throw error(can.reason)
      const ticket = crypto.randomBytes(24).toString('hex')
      for (const [key, value] of confirmations) if (value.expires < Date.now()) confirmations.delete(key)
      if (confirmations.size > 100) throw error('待确认操作过多')
      confirmations.set(ticket, { id, operation, expires: Date.now() + 60000 })
      return { ticket, name: s.name, operation, tmux: s.tmux, host: s.host, imported: !!can.imported, squadInstance: !!can.squadInstance }
    },
    stop: async payload => {
      consumeConfirmation(payload, 'stop'); connections.disconnect(payload.id)
      // The single-use ticket above is the user's explicit confirmation (it names imported sessions).
      const result = await service.stop(payload.id, { allowImported: true }); connections.state(payload.id, 'stopped'); return result
    },
    forget: payload => { consumeConfirmation(payload, 'forget'); connections.disconnect(payload.id); service.forget(payload.id); return true }
  }
  function consumeConfirmation({ id, ticket }, operation) {
    const value = confirmations.get(ticket)
    if (!value || value.id !== id || value.operation !== operation || value.expires < Date.now()) throw error('需要页面确认；操作未执行', 403)
    confirmations.delete(ticket)
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    try {
      authorize(req)
      const url = new URL(req.url, origin)
      if (url.origin !== origin) throw error('拒绝非本机目标', 403)
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        res.setHeader('Set-Cookie', `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/`)
        send(res, 200, { ok: true, data: { csrf, build } }); return
      }
      if (url.pathname.startsWith('/api/')) {
        authorize(req, true)
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' })
          res.write(': connected\n\n'); clients.add(res)
          const timer = setInterval(() => res.write(': keepalive\n\n'), 15000); timer.unref()
          req.on('close', () => { clearInterval(timer); clients.delete(res) }); return
        }
        if (req.method !== 'POST') throw error('仅允许 POST 操作', 405)
        if (url.pathname === '/api/upload') {
          if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/octet-stream') throw error('上传必须为二进制文件', 415)
          const bytes = await body(req, 32 * 1024 * 1024)
          const result = await service.upload(url.searchParams.get('id'), { bytes, name: url.searchParams.get('name') })
          send(res, 200, { ok: true, data: result }); return
        }
        const method = url.pathname.slice('/api/'.length)
        if (!Object.hasOwn(handlers, method)) throw error('未知操作', 404)
        if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw error('操作需要 JSON 请求', 415)
        const raw = await body(req, 512 * 1024)
        const payload = JSON.parse(raw.toString() || '{}')
        if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw error('参数格式无效')
        send(res, 200, { ok: true, data: await handlers[method](payload) }); return
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw error('静态页面仅允许 GET/HEAD', 405)
      const entry = FILES.get(url.pathname)
      if (!entry) throw error('页面不存在', 404)
      const file = path.join(ROOT, entry[0])
      const stat = fs.statSync(file)
      res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': stat.size })
      if (req.method === 'HEAD') res.end()
      else { const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res) }
    } catch (e) {
      if (!res.headersSent) send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { ok: false, error: e.message })
      else res.destroy()
    }
  })
  server.requestTimeout = 130000
  server.headersTimeout = 10000
  connections.on('event', event => {
    const text = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) { if (client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client) } else client.write(text) }
  })
  const port = options.port ?? Number(process.env.CATMUX_PORT || process.env.AIHUB_WEB_PORT || 48731)
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (options.port == null && port < 1024)) { store.close?.(); throw error('本机端口无效') }
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) }) } catch (e) { store.close?.(); throw e }
  origin = `http://127.0.0.1:${server.address().port}`
  return { server, service, store, connections, origin, async close() {
    if (closing) return; closing = true
    connections.close(); for (const client of clients) client.end(); clients.clear()
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); store.close?.()
  } }
}
if (require.main === module) {
  createWebServer().then(context => {
    console.log(`Catmux ${VERSION} 已启动：${context.origin}`)
    console.log('仅监听 127.0.0.1；不读取模型配置。Ctrl-C 停止本机服务，各设备上的 tmux 会话保留。')
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => context.close().then(() => process.exit(0)))
  }).catch(e => { console.error('WebUI 启动失败：', e.message); process.exitCode = 1 })
}
module.exports = { createWebServer, matches }
