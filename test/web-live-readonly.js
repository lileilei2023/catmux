'use strict'
// Explicit live acceptance: existing local WebUI -> real Mini, metadata only.
// No agent creation, attachment, input, upload, file read/save, model/login/config inspection.
// Workbench checks are directory listing and git status only.
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
fs.mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true })
const modulePaths = [process.env.CATMUX_PLAYWRIGHT_MODULES || process.env.AIHUB_PLAYWRIGHT_MODULES, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), path.join(__dirname, '../node_modules')].filter(Boolean)
const { chromium } = require(require.resolve('playwright', { paths: modulePaths }))
const origin = process.env.CATMUX_LIVE_URL || process.env.AIHUB_LIVE_URL || 'http://127.0.0.1:48731'
// Which SSH device to check (an alias from ~/.ssh/config), e.g. CATMUX_LIVE_HOST=mybox
const LIVE_HOST = process.env.CATMUX_LIVE_HOST
if (!LIVE_HOST) { console.error('Set CATMUX_LIVE_HOST to an SSH alias from ~/.ssh/config'); process.exit(2) }
const target = new URL(origin)
assert.equal(target.hostname, '127.0.0.1', 'Live acceptance must use the local loopback backend')
assert.equal(target.protocol, 'http:')
let browser
;(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1480, height: 920 } })
  const page = await context.newPage()
  const failures = [], methods = new Set()
  page.on('pageerror', e => failures.push(e.message))
  page.on('request', req => {
    const url = new URL(req.url())
    if (url.pathname.startsWith('/api/')) methods.add(url.pathname)
  })
  await page.goto(origin)
  await page.waitForSelector('body[data-ready="true"]')
  await page.locator('#host').selectOption(LIVE_HOST)
  assert.equal(await page.locator('#host').inputValue(), LIVE_HOST)
  assert(await page.locator('#new-session').isEnabled())
  console.log(`PASS live WebUI loads with real SSH config and ${LIVE_HOST} selected`)

  await page.locator('#probe').click()
  await page.waitForFunction(() => document.getElementById('info-content').textContent.includes('模型配置、登录状态、请求均未检查。'), null, { timeout: 25000 })
  const probeText = await page.locator('#info-content').innerText()
  assert(probeText.includes('Darwin / arm64'))
  for (const tool of ['codex', 'claude', 'tmux', 'python3', 'tsshd']) {
    assert(new RegExp('^' + tool + '\\s+/', 'm').test(probeText), `Mini login shell must resolve ${tool}`)
  }
  console.log('PASS browser environment check reaches real Mini zsh login shell (paths only)')
  await page.locator('#info-close').click()
  await page.locator('#discover').click()
  await page.waitForFunction(() => !document.getElementById('info-content').textContent.includes('读取会话元数据'), null, { timeout: 25000 })
  assert(!(await page.locator('#info-content').innerText()).includes('无法连接'))
  const count = await page.locator('.discovered').count()
  console.log(`PASS live tmux discovery reads metadata only (${count} sessions; none imported or attached)`)
  await page.locator('#info-close').click()

  // Project-path completion: directory names only, on the real Mini.
  const dirs = await page.evaluate(host => window.remoteHub.listDirs(host, '~/workspace'), LIVE_HOST)
  assert(dirs.exists && dirs.dir.endsWith('/workspace') && dirs.entries.length > 0)
  console.log(`PASS live ~/workspace completion: ${dirs.dir} → ${dirs.entries.length} dirs, git: ${dirs.entries.filter(e => e.git).map(e => e.name).join(', ')}`)
  await page.locator('#new-session').click()
  await page.locator('#create-project').fill('~/workspace/')
  await page.locator('#project-suggest .suggest-item').first().waitFor({ timeout: 25000 })
  await page.screenshot({ path: path.join(__dirname, 'artifacts/ai-hub-path-complete.png') })
  await page.locator('#create-cancel').click()

  // Workbench read-only: list files and Git status of an existing Catmux
  // worktree record through the backend API. The session is NOT selected in
  // the UI, so no terminal attaches; no file is read, saved or diffed.
  const target = await page.evaluate(async wanted => {
    const list = await window.remoteHub.sessions()
    return list.find(s => s.id === wanted) || list.find(s => s.owned && s.status === 'detached' && s.cwd.includes('/.local/share/ai-hub/worktrees/')) || null
  }, (process.env.CATMUX_LIVE_SESSION || process.env.AIHUB_LIVE_SESSION) || '')
  if (target) {
    const result = await page.evaluate(async id => {
      const files = await window.remoteHub.files(id, '')
      let git = null, gitError = null
      try { git = await window.remoteHub.git(id) } catch (e) { gitError = e.message }
      const roots = {}
      for (const root of ['cwd', 'project', 'pane']) {
        try { const t = await window.remoteHub.tree(id, [''], root, true); roots[root] = { root: t.root, entries: t.dirs[''].entries?.length ?? t.dirs[''].error, changes: t.git?.changes.length ?? t.gitError } }
        catch (e) { roots[root] = { error: e.message } }
      }
      return { files, git, gitError, roots }
    }, target.id)
    assert(Array.isArray(result.files.entries))
    assert(!result.files.entries.some(e => /^(\.git|\.env.*|\.ssh)$/.test(e.name)), 'protected entries stay hidden')
    console.log(`PASS live workbench lists ${result.files.entries.length} entries in an Catmux worktree root (${target.name})`)
    if (result.git) console.log(`PASS live workbench Git status: branch ${result.git.branch || '(detached)'}, ${result.git.changes.length} changes`)
    else console.log('INFO live Git status unavailable: ' + result.gitError)
    for (const [key, r] of Object.entries(result.roots)) console.log(`${r.error ? 'INFO' : 'PASS'} live root ${key}: ${JSON.stringify(r)}`)
    assert(!result.roots.cwd.error && result.roots.cwd.root === target.cwd, 'session root is canonical')
  } else console.log('SKIP no Catmux worktree session record for live workbench listing')
  // Whole-structure preload timing on real projects (read-only listing).
  const deepRuns = await page.evaluate(async () => {
    const out = []
    for (const s of (await window.remoteHub.sessions()).filter(x => x.status !== 'failed')) {
      const t0 = performance.now()
      try { const r = await window.remoteHub.tree(s.id, [''], 'cwd', true, true); out.push({ name: s.name, root: r.root, top: r.dirs[''].entries?.map(e => e.name).slice(0, 6), deep: r.deep, ms: Math.round(performance.now() - t0) }) }
      catch (e) { out.push({ name: s.name, error: e.message }) }
    }
    return out
  })
  for (const r of deepRuns) console.log(`${r.error ? 'INFO' : 'PASS'} live deep preload ${JSON.stringify(r)}`)
  const allowed = new Set(['/api/bootstrap', '/api/events', '/api/info', '/api/hosts', '/api/sessions', '/api/probe', '/api/discover', '/api/files', '/api/git', '/api/tree', '/api/list-dirs', '/api/launch-settings', '/api/branches'])
  assert([...methods].every(method => allowed.has(method)), 'No remote mutation or terminal operations are allowed: ' + [...methods].filter(m => !allowed.has(m)).join(', '))
  assert.equal(failures.length, 0, failures.join('\n'))
  const artifacts = path.join(__dirname, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: path.join(artifacts, 'ai-hub-web-live.png') })
  console.log('RESULT live readonly checks passed; no Mini writes / terminal / model requests')
})().catch(e => { console.error('FAIL live readonly acceptance:', e.message); process.exitCode = 1 })
  .finally(async () => { await browser?.close() })
