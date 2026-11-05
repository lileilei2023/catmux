'use strict'
// Captures promo / README screenshots from the REAL Catmux UI running in demo
// mode: remote operations are mocked with fictional devices, projects and agent
// output (nothing from a real machine). Output: promo/public/shots/*.png (2x).
//
//   node promo/capture.js            # needs Playwright + Google Chrome
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createWebServer } = require('../src/web-server')
const { JsonStore } = require('../src/web-store')
const { RemoteService } = require('../src/remote-service')
const { RemoteConnections } = require('../src/remote-connections')
const { PythonPty } = require('../src/web-pty')
const P = require('../src/remote-protocol')

const modulePaths = [process.env.CATMUX_PLAYWRIGHT_MODULES, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), path.join(__dirname, 'node_modules'), path.join(__dirname, '../node_modules')].filter(Boolean)
const { chromium } = require(require.resolve('playwright', { paths: modulePaths }))
const OUT = path.join(__dirname, 'public', 'shots')
fs.mkdirSync(OUT, { recursive: true })
// The video uses the app icon too.
fs.copyFileSync(path.join(__dirname, '../web/icon-1024.png'), path.join(__dirname, 'public', 'icon.png'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let browser, server
const id = () => crypto.randomBytes(16).toString('hex')

// ---------- fictional workspace ----------
const HOSTS = [
  { alias: 'local', hostname: 'MacBook-Pro', user: 'dev', port: '', local: true },
  { alias: 'mac-mini', hostname: 'mac-mini.lan', user: 'dev', port: '22' },
  { alias: 'gpu-server', hostname: 'gpu-server.lan', user: 'ubuntu', port: '22' },
  { alias: 'cloud-dev', hostname: 'cloud-dev.example.com', user: 'ec2-user', port: '22' }
]
const A = id(), B = id(), C = id(), D = id()
const base = { owned: true, mode: 'direct', status: 'detached', transport: 'udp' }
const SESSIONS = [
  { ...base, id: A, name: '订单服务 · 游标分页', host: 'mac-mini', tool: 'codex', group: '电商', worktree: true, base: 'develop', prTarget: 'develop', project: '/Users/dev/work/shop-api', cwd: `/Users/dev/.local/share/ai-hub/worktrees/${A}`, tmux: `aihub-${A}`, launch: P.launchFor('codex', 'full'), createdAt: 1 },
  { ...base, id: B, name: '登录页重做', host: 'local', tool: 'claude', group: '电商', worktree: true, base: 'develop', prTarget: 'develop', project: '/Users/dev/work/web-app', cwd: `/Users/dev/.local/share/ai-hub/worktrees/${B}`, tmux: `aihub-${B}`, transport: 'local', launch: P.launchFor('claude', 'full'), createdAt: 2 },
  { ...base, id: C, name: '训练脚本调参', host: 'gpu-server', tool: 'claude', group: '实验', worktree: true, base: 'main', prTarget: 'main', project: '/home/ubuntu/ml-train', cwd: `/home/ubuntu/.local/share/ai-hub/worktrees/${C}`, tmux: `aihub-${C}`, launch: P.launchFor('claude', 'auto'), createdAt: 3 },
  { ...base, id: D, name: '线上日志排查', host: 'cloud-dev', tool: 'shell', group: '运维', worktree: false, project: '/var/log/shop', cwd: '/var/log/shop', tmux: `aihub-${D}`, launch: P.launchFor('shell', 'default'), createdAt: 4 }
]
const TREE = {
  '': [d('src'), d('test'), f('package.json', 1320), f('README.md', 2400), f('tsconfig.json', 410)],
  src: [d('src/orders'), f('src/app.ts', 980), f('src/db.ts', 1460)],
  'src/orders': [f('src/orders/cursor.ts', 720), f('src/orders/query.ts', 2310), f('src/orders/routes.ts', 1180)],
  test: [f('test/orders.pagination.test.ts', 2870), f('test/orders.test.ts', 1940)]
}
function d(p) { return { name: p.split('/').pop(), path: p, directory: true, size: 0 } }
function f(p, size) { return { name: p.split('/').pop(), path: p, directory: false, size } }
const QUERY = `import { db } from '../db'
import { decodeCursor, encodeCursor } from './cursor'

export interface ListOrdersInput {
  userId: string
  limit?: number
  cursor?: string
}

/** Cursor pagination: stable order by (createdAt, id). */
export async function listOrders({ userId, limit = 20, cursor }: ListOrdersInput) {
  const size = Math.min(Math.max(limit, 1), 100)
  const after = cursor ? decodeCursor(cursor) : null
  const rows = await db.order.findMany({
    where: {
      userId,
      ...(after && { OR: [
        { createdAt: { lt: after.createdAt } },
        { createdAt: after.createdAt, id: { lt: after.id } }
      ] })
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: size + 1
  })
  const page = rows.slice(0, size)
  const last = page[page.length - 1]
  return {
    items: page,
    nextCursor: rows.length > size && last ? encodeCursor(last) : null
  }
}
`
const PATCH = `diff --git a/src/orders/query.ts b/src/orders/query.ts
--- a/src/orders/query.ts
+++ b/src/orders/query.ts
@@ -1,20 +1,32 @@
 import { db } from '../db'
+import { decodeCursor, encodeCursor } from './cursor'

 export interface ListOrdersInput {
   userId: string
-  page?: number
-  pageSize?: number
+  limit?: number
+  cursor?: string
 }

-export async function listOrders({ userId, page = 1, pageSize = 20 }: ListOrdersInput) {
-  const rows = await db.order.findMany({
-    where: { userId },
-    orderBy: { createdAt: 'desc' },
-    skip: (page - 1) * pageSize,
-    take: pageSize
-  })
-  return { items: rows, page }
+/** Cursor pagination: stable order by (createdAt, id). */
+export async function listOrders({ userId, limit = 20, cursor }: ListOrdersInput) {
+  const size = Math.min(Math.max(limit, 1), 100)
+  const after = cursor ? decodeCursor(cursor) : null
+  const rows = await db.order.findMany({
+    where: { userId, ...(after && cursorAfter(after)) },
+    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
+    take: size + 1
+  })
+  const page = rows.slice(0, size)
+  const last = page[page.length - 1]
+  return { items: page, nextCursor: rows.length > size && last ? encodeCursor(last) : null }
 }
`
const CHANGES = [
  { path: 'src/orders/query.ts', status: ' M', original: null, staged: false, unstaged: true, added: 15, deleted: 10, stagedAdded: 0, stagedDeleted: 0 },
  { path: 'src/orders/routes.ts', status: ' M', original: null, staged: false, unstaged: true, added: 9, deleted: 4, stagedAdded: 0, stagedDeleted: 0 },
  { path: 'src/orders/cursor.ts', status: '??', original: null, staged: false, unstaged: true, added: 0, deleted: 0, stagedAdded: 0, stagedDeleted: 0 },
  { path: 'test/orders.pagination.test.ts', status: '??', original: null, staged: false, unstaged: true, added: 0, deleted: 0, stagedAdded: 0, stagedDeleted: 0 }
]
// A generic AI-coding-CLI transcript, revealed step by step (ANSI colours).
const E = '\x1b[', dim = s => `${E}38;5;244m${s}${E}0m`, acc = s => `${E}38;5;209m${s}${E}0m`, ok = s => `${E}38;5;78m${s}${E}0m`, b = s => `${E}1m${s}${E}0m`, blue = s => `${E}38;5;111m${s}${E}0m`
const STEPS = [
  `\r\n  ${acc('▍')}${b('codex')} · shop-api   ${dim('worktree aihub/3f9a2c · 完全权限')}\r\n  ${dim('─'.repeat(58))}\r\n\r\n`,
  `  ${b('›')} 订单列表接口改成${b('游标分页')}，补上测试，对外字段不要变\r\n\r\n`,
  `  ${blue('•')} 读取 src/orders/query.ts, src/orders/routes.ts\r\n  ${blue('•')} 计划：① 游标编解码  ② 改 listOrders  ③ 补 6 个测试\r\n\r\n`,
  `  ${blue('•')} 编辑 src/orders/query.ts            ${ok('+15')} ${E}38;5;203m−10${E}0m\r\n  ${blue('•')} 编辑 src/orders/routes.ts           ${ok('+9')}  ${E}38;5;203m−4${E}0m\r\n  ${blue('•')} 新增 src/orders/cursor.ts           ${ok('+31')}\r\n  ${blue('•')} 新增 test/orders.pagination.test.ts ${ok('+86')}\r\n\r\n`,
  `  ${blue('•')} 运行 npm test\r\n    ${ok('✓')} 48 passed ${dim('(2.1s)')}\r\n\r\n`,
  `  ${ok('✔ 完成')}：4 个文件改动，测试全部通过。可以在右侧看 diff。\r\n\r\n  ${b('›')} `
]
const TRAIN = `\r\n  ${b('claude')} · ml-train\r\n\r\n  ${blue('•')} epoch 12/40  loss 0.412  val_acc 0.873  lr 3e-4\r\n  ${blue('•')} epoch 13/40  loss 0.398  val_acc 0.879\r\n  ${blue('•')} epoch 14/40  loss 0.391  val_acc 0.884  ${ok('best so far')}\r\n  ${blue('•')} 已保存 checkpoints/ep14.pt；下一步尝试 warmup=500 并对比 3 组学习率，完成后汇总结果表给你。\r\n`

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catmux-promo-'))
  const store = new JsonStore(dir)
  for (const s of SESSIONS) store.put(s)
  const service = new RemoteService(store)
  // Like a real team setup: this project starts tasks from develop and PRs into develop.
  service.projects.set('mac-mini', '/Users/dev/work/shop-api', { base: 'develop', prTarget: 'develop' })
  const task = { pr: null }
  service.hosts = async () => HOSTS
  service.call = async (host, op, arg) => {
    if (op === 'inspect') return { name: arg.tmux, dead: false }
    if (op === 'tree') return { root: arg.cwd, dirs: Object.fromEntries(Object.keys(TREE).map(p => [p, { path: p, entries: TREE[p], truncated: false }])), deep: { complete: true, dirs: 5, entries: 13, lazy: [] }, git: { root: arg.cwd, cwd: arg.cwd, branch: 'aihub/3f9a2c', head: 'c41e7a2', ahead: 0, behind: 0, truncated: false, changes: CHANGES } }
    if (op === 'files') return { path: arg.path, entries: TREE[arg.path] || [], truncated: false, root: arg.cwd }
    if (op === 'read-file') { const content = arg.path === 'src/orders/query.ts' ? QUERY : `// ${arg.path}\n`; return { path: arg.path, content, sha256: crypto.createHash('sha256').update(content).digest('hex'), size: content.length, root: arg.cwd } }
    if (op === 'diff') return { path: arg.path, patch: PATCH, staged: false, root: arg.cwd }
    if (op === 'list-dirs') {
      const L = { '~': ['work', 'Documents', 'Downloads'], '~/work': ['shop-api', 'web-app', 'ml-train', 'notes'] }
      const names = L[arg.path.replace(/\/$/, '')] || []
      return { dir: '/Users/dev' + arg.path.slice(1), home: '/Users/dev', exists: true, git: /shop-api|web-app|ml-train/.test(arg.path), truncated: false, entries: names.map(name => ({ name, git: /shop-api|web-app|ml-train/.test(name), hidden: false })) }
    }
    if (op === 'branches') return { root: arg.project, current: 'main', local: [{ name: 'develop', sha: 'a1b2c3d', at: 3, subject: 'release prep' }, { name: 'main', sha: '9f8e7d6', at: 2, subject: 'v2.3' }], remote: [{ name: 'origin/develop', sha: 'a1b2c3d', at: 3, subject: '' }, { name: 'origin/main', sha: '9f8e7d6', at: 2, subject: '' }] }
    if (op === 'task-status') return { root: '/Users/dev/work/shop-api', worktree: SESSIONS[0].cwd, branch: `aihub/${A}`, target: arg.target, worktreeExists: true, branchExists: true, dirty: [], dirtyCount: 0, targetRef: 'refs/remotes/origin/develop', head: 'c41e7a2', ahead: 3, pushed: false, unpushed: 3, commits: ['c41e7a2 test: cover cursor pagination', 'b7d03f1 feat(orders): cursor pagination for listOrders', '5e2a9c0 refactor: extract cursor helpers'], origin: { url: 'git@github.com:acme/shop-api.git', host: 'github.com', github: true }, gh: { available: true, error: '', prs: [] }, contentMerged: false, mergedPr: null, openPr: null, afterMerge: null, reasons: ['分支有 3 个提交，但没有找到已合并（MERGED）的 PR，内容也还不在 develop 里'], cleanable: false }
    if (op === 'task-pr') { await sleep(600); return { url: 'https://github.com/acme/shop-api/pull/128', created: true, pushed: true } }
    if (op === 'probe') return { os: 'Darwin', arch: 'arm64', home: '/Users/dev', tools: {}, tmuxVersion: 'tmux 3.5' }
    if (op === 'sessions') return []
    throw new Error('demo: ' + op)
  }
  const connections = new RemoteConnections(service, (_file, args) => {
    const sid = args.join(' ').match(/AIHUB_READY:([a-f0-9]{32})/)[1]
    return new PythonPty('/bin/sh', ['-c', `printf '\\033]777;AIHUB_READY:${sid}\\007'; exec /bin/cat`])
  })
  connections.redraw = () => false
  server = await createWebServer({ store, service, connections, port: 0, dataDir: dir })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin })
  const page = await context.newPage()
  page.on('dialog', dlg => dlg.accept())
  const shot = async (name, opts = {}) => { await sleep(350); await page.screenshot({ path: path.join(OUT, name + '.png'), ...opts }); console.log('shot', name) }
  const feed = data => connections.emit('event', { type: 'data', id: A, data })
  const hideToast = () => page.evaluate(() => { document.getElementById('toast').hidden = true })

  await page.addInitScript(([a]) => { localStorage.setItem('active-session', a); localStorage.setItem('last-host', 'mac-mini'); localStorage.setItem('terminal-font-size', '15') }, [A])
  await page.goto(server.origin)
  await page.waitForSelector('body[data-ready="true"]')
  await page.waitForFunction(() => document.getElementById('connection').textContent === '已连接')
  // Other sessions connected in the background (one produces output → "新输出").
  for (const sid of [B, C]) await connections.connect(sid)
  await sleep(300)
  connections.emit('event', { type: 'data', id: C, data: TRAIN.repeat(3) })

  // Terminal progression: one frame per step.
  for (let i = 0; i < STEPS.length; i++) { feed(STEPS[i]); await shot(`term-${i + 1}`) }

  // Right pane: Git changes → per-file diff (the hero shot).
  await page.locator('#view-git').click()
  await page.locator('#git-view .change-row[data-path="src/orders/query.ts"]').click()
  await page.locator('#doc-body .dl.add').first().waitFor()
  await hideToast(); await shot('hero')
  // Files: tree + highlighted preview.
  await page.locator('#view-files').click()
  for (const dirPath of ['src', 'src/orders', 'test']) {
    const row = page.locator(`#files-view .tree-row[data-path="${dirPath}"]`)
    await row.waitFor()
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  }
  await page.locator('#files-view .tree-row[data-path="src/orders/query.ts"]').waitFor()
  await page.locator('#files-view .tree-row[data-path="src/orders/query.ts"]').click()
  await page.locator('#doc-body code.hljs').waitFor()
  await hideToast(); await shot('files')
  // Right-click menu on a file.
  await page.locator('#files-view .tree-row[data-path="src/orders/routes.ts"]').click({ button: 'right' })
  await page.locator('.ctx-menu').waitFor(); await shot('context-menu')
  await page.keyboard.press('Escape')
  // Copy from tmux → Mac clipboard (OSC 52 toast).
  feed('\x1b]52;c;' + Buffer.from('nextCursor: rows.length > size && last ? encodeCursor(last) : null').toString('base64') + '\x07')
  await page.locator('#toast').waitFor(); await shot('copy')
  await hideToast()

  // End task → push + PR to develop.
  await page.locator('#stop').click()
  await page.locator('#end-dialog .end-summary').waitFor()
  await shot('end-task')
  await page.locator('#end-dialog .end-card button', { hasText: '推送并创建 PR' }).click()
  await page.locator('#end-dialog .end-result a').waitFor()
  await page.locator('#end-dialog .end-result').scrollIntoViewIfNeeded()
  await hideToast(); await shot('end-task-pr')
  await page.locator('#end-close').click()

  // New session: device picker, path completion, start branch, permission preset.
  await page.locator('#new-session').click()
  await page.locator('#create-host').selectOption('mac-mini')
  await page.locator('#create-name').fill('支付回调重试')
  await page.locator('#create-tool').selectOption('claude')
  await page.locator('#create-worktree').check()
  await page.locator('#create-project').fill('~/work/')
  await page.locator('#create-project').focus()
  await page.locator('#project-suggest .suggest-item', { hasText: 'shop-api' }).waitFor()
  await shot('create')
  await page.locator('#create-project').fill('~/work/shop-api')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => [...document.querySelectorAll('#create-base option')].some(o => o.value === 'develop'))
  await page.locator('#create-base').selectOption('develop'); await page.locator('#create-target').fill('develop')
  // Wait for the debounced path hint, and make the whole dialog fit for this shot.
  await page.waitForFunction(() => document.getElementById('project-hint').textContent.includes('shop-api · Git 仓库'))
  await page.setViewportSize({ width: 1440, height: 1560 }); await sleep(300)
  await page.locator('#create-dialog').screenshot({ path: path.join(OUT, 'create-dialog.png') }); console.log('shot create-dialog')
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(200)
  await page.locator('#create-cancel').click()

  // Focus mode: the terminal alone.
  await page.locator('#terminal-focus').click(); await sleep(400); await shot('focus')
  await page.locator('#terminal-focus').click()
  // Narrow window (phone-like aspect) for the vertical video.
  await page.setViewportSize({ width: 820, height: 1180 }); await sleep(500)
  await page.locator('#expand-left').click().catch(() => {}); await sleep(300); await shot('narrow-sessions')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('done →', OUT)
})().catch(e => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await browser?.close().catch(() => {}); await server?.close().catch(() => {}); process.exit() })
