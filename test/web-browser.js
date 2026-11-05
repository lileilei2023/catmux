'use strict'
// Real isolated Chrome → HTTP bridge → real JSON store / stdlib PTY.
// Remote SSH operations are explicitly mocked; live Mini acceptance is separate.
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const crypto = require('crypto')
const { createWebServer } = require('../src/web-server')
const { JsonStore } = require('../src/web-store')
const { RemoteService } = require('../src/remote-service')
const { RemoteConnections } = require('../src/remote-connections')
const { PythonPty } = require('../src/web-pty')

fs.mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true })
const modulePaths = [process.env.CATMUX_PLAYWRIGHT_MODULES || process.env.AIHUB_PLAYWRIGHT_MODULES, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), path.join(__dirname, '../node_modules')].filter(Boolean)
const { chromium } = require(require.resolve('playwright', { paths: modulePaths }))
let browser, server, testPage
const tests = [], failures = []
const pass = name => { tests.push(name); console.log('PASS ' + name) }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-web-browser-'))

;(async () => {
  const store = new JsonStore(directory), service = new RemoteService(store)
  let creates = 0, ptys = 0, uploads = 0, uploadBytes, writes = [], failNextCreate = false, recovers = 0, expectedFailure = null
  const sha = text => crypto.createHash('sha256').update(text).digest('hex')
  const fixturePng = fs.readFileSync(path.join(__dirname, 'fixtures/upload-test.png'))
  let slowTree = 0, treeCalls = 0, promptAnswer = null
  const task = { dirty: true, merged: false, github: true, prCalls: [], cleans: 0 }
  const tree = { '': [{ name: 'src', path: 'src', directory: true, size: 96 }, { name: 'README.md', path: 'README.md', directory: false, size: 16 }, { name: 'shot.png', path: 'shot.png', directory: false, size: fixturePng.length }],
    src: [{ name: 'app.js', path: 'src/app.js', directory: false, size: 38 }] }
  const contents = { 'README.md': '# Fixture\nhello\n', 'src/app.js': 'const answer = 42\nconsole.log(answer)\n' }
  const saves = [], fileOps = []
  const appPatch = 'diff --git a/src/app.js b/src/app.js\nindex 1..2 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,2 @@\n-const answer = 41\n+const answer = 42\n console.log(answer)\n'
  service.hosts = async () => [{ alias: 'local', hostname: 'fixture-air', user: 'test', port: '', local: true }, { alias: 'macmini', hostname: 'mac-mini.fixture.ts.net', user: 'test', port: '22' }]
  let redraws = 0
  service.call = async (_host, op, arg, bytes) => {
    if (op === 'create') {
      creates++
      if (failNextCreate) { failNextCreate = false; throw new Error('no such window: =' + arg.tmux) }
      return { cwd: arg.project, tmux: arg.tmux }
    }
    if (op === 'recover') { recovers++; return { tmux: arg.tmux, cwd: '/test/worktrees/' + arg.id, branch: 'aihub/' + arg.id } }
    if (op === 'inspect') return { name: arg.tmux, dead: false }
    if (['git', 'files', 'read-file', 'save-file', 'diff'].includes(op)) fileOps.push(op)
    if (op === 'git') return { root: arg.cwd, cwd: arg.cwd, branch: 'web-fixture', head: 'abc1234', ahead: 0, behind: 0, truncated: false, changes: [
      { path: 'src/app.js', status: ' M', original: null, staged: false, unstaged: true, added: 1, deleted: 1, stagedAdded: 0, stagedDeleted: 0 },
      { path: 'NEW.md', status: '??', original: null, staged: false, unstaged: true, added: 0, deleted: 0, stagedAdded: 0, stagedDeleted: 0 }] }
    if (op === 'files') return { path: arg.path, entries: tree[arg.path] || [], truncated: false, root: arg.pane ? '/test/pane-dir' : arg.cwd }
    if (op === 'tree') {
      treeCalls++
      if (slowTree) await new Promise(r => setTimeout(r, slowTree))
      if (arg.pane) return { root: '/test/pane-dir', dirs: Object.fromEntries(arg.paths.map(p => [p, p ? { error: '目录已不存在', missing: true } : { path: '', entries: [{ name: 'pane-only.txt', path: 'pane-only.txt', directory: false, size: 1 }], truncated: false }])), gitError: 'fatal: not a git repository' }
      const dirs = Object.fromEntries(arg.paths.map(p => [p, tree[p] ? { path: p, entries: tree[p], truncated: false } : { error: '目录已不存在', missing: true }]))
      if (arg.deep) for (const p of Object.keys(tree)) dirs[p] = { path: p, entries: tree[p], truncated: false }
      return { root: arg.cwd, dirs, git: await service.call(_host, 'git', arg), ...(arg.deep ? { deep: { complete: true, dirs: Object.keys(tree).length, entries: 4, lazy: [] } } : {}) }
    }
    if (op === 'read-image') return { path: arg.path, mime: 'image/png', size: fixturePng.length, sha256: sha(fixturePng), data: fixturePng.toString('base64'), root: arg.cwd }
    if (op === 'list-dirs') {
      const listings = { '~': ['workspace', 'Documents', '.config-like'], '~/workspace': ['my-app', 'my-api', 'notes'], '/test': ['web-fixture'] }
      const home = '/Users/fixture', dir = arg.path.startsWith('~') ? home + arg.path.slice(1) : arg.path
      const names = listings[arg.path.replace(/\/$/, '')]
      return { dir, home, exists: !!names || arg.path.startsWith('/test/'), git: /my-app|web-fixture/.test(arg.path), truncated: false,
        entries: (names || []).map(name => ({ name, git: /my-app|web-fixture/.test(name), hidden: name.startsWith('.') })) }
    }
    if (op === 'branches') return { root: arg.project, current: 'feat/now', local: [{ name: 'main', sha: 'a1', at: 2, subject: 'm' }, { name: 'develop', sha: 'b2', at: 3, subject: 'd' }], remote: [{ name: 'origin/develop', sha: 'b2', at: 3, subject: 'd' }] }
    if (op === 'task-status') {
      const reasons = [...(task.dirty ? ['worktree 里有 1 个未提交 / 未跟踪的改动'] : []), ...(task.merged ? [] : ['分支有 2 个提交，但没有找到已合并（MERGED）的 PR'])]
      const merged = task.merged ? { number: 9, state: 'MERGED', url: 'https://github.com/t/r/pull/9', headRefOid: 'h', baseRefName: arg.target, title: 't' } : null
      return { root: '/test/repo', worktree: '/test/wt/' + arg.id, branch: 'aihub/' + arg.id, target: arg.target, worktreeExists: true, branchExists: true,
        dirty: task.dirty ? [' M wip.txt'] : [], dirtyCount: task.dirty ? 1 : 0, targetRef: 'refs/remotes/origin/' + arg.target, head: 'h', ahead: 2, pushed: false, unpushed: 2,
        commits: ['abc1 feat: one', 'abc2 fix: two'], origin: task.github ? { url: 'git@github.com:t/r.git', host: 'github.com', github: true } : { url: 'git@gitee.com:t/r.git', host: 'gitee.com', github: false },
        gh: task.github ? { available: true, error: '', prs: merged ? [merged] : [] } : { available: false, error: 'origin 不是 GitHub（gitee.com），无法用 gh 查 PR', prs: [] }, contentMerged: false,
        mergedPr: merged, openPr: null, afterMerge: merged ? 0 : null, reasons, cleanable: !reasons.length }
    }
    if (op === 'task-pr') {
      task.prCalls.push(arg); if (task.dirty && !arg.allowDirty) throw new Error('DIRTY:[" M wip.txt"]')
      if (arg.pushOnly) return { url: 'https://gitee.com/t/r/pull/new/' + arg.id, links: ['https://gitee.com/t/r/pull/new/aihub'], created: false, pushed: true, pushOnly: true, remote: 'gitee.com' }
      return { url: 'https://github.com/t/r/pull/10', created: true, pushed: true }
    }
    if (op === 'task-clean') { task.cleans++; return { removedWorktree: true, deletedBranch: true, worktree: '/test/wt/' + arg.id, branch: 'aihub/' + arg.id } }
    if (op === 'capture') return { text: 'AI said: hello world\nsecond line of output', truncated: false, alternate: false }
    if (op === 'copy-mode') return true
    if (op === 'path-exists') return { exists: arg.path.startsWith('/test/'), file: true }
    if (op === 'read-file') return { path: arg.path, content: contents[arg.path], sha256: sha(contents[arg.path]), size: Buffer.byteLength(contents[arg.path]) }
    if (op === 'save-file') {
      if (arg.sha256 !== sha(contents[arg.path])) throw new Error('CONFLICT:文件已被远端修改；保存已取消。请重新读取并合并，不会覆盖 agent 的修改')
      contents[arg.path] = bytes.toString('utf8'); saves.push({ path: arg.path, content: contents[arg.path], expected: arg.sha256 })
      return { path: arg.path, sha256: sha(contents[arg.path]), size: bytes.length, backup: '/test/.local/share/ai-hub/file-backups/' + arg.id + '/1.bak' }
    }
    if (op === 'diff') return arg.path === 'src/app.js' ? { path: arg.path, patch: arg.staged ? '' : appPatch, staged: arg.staged } : { path: arg.path, patch: '--- /dev/null\n+++ b/NEW.md\n@@ -0,0 +1,1 @@\n+new\n', staged: false, untracked: true }
    if (op === 'upload') { uploads++; uploadBytes = bytes; return { path: '/test/uploads/' + arg.name, size: bytes.length, sha256: arg.sha256 } }
    throw new Error('Unexpected offline operation: ' + op)
  }
  const connections = new RemoteConnections(service, (_file, args) => {
    ptys++
    const id = args.join(' ').match(/AIHUB_READY:([a-f0-9]{32})/)[1]
    const box = '  Menlo · natural spacing · real local PTY  ', border = '─'.repeat(box.length)
    const typography = String.raw`WEB_TERMINAL_FIXTURE\r\n\r\n\033[1mRemote tmux / typography fixture\033[0m\r\n\r\nW i l 0 1  |  中文等宽测试\r\n\r\n┌${border}┐\r\n│${box}│\r\n└${border}┘\r\n\r\n\033[38;5;244mMock remote only — no model requests\033[0m\r\n`
    return new PythonPty('/bin/sh', ['-c', `printf '\\033]777;AIHUB_READY:${id}\\007'; printf '${typography}'; exec /bin/cat`])
  })
  const redraw = connections.redraw.bind(connections)
  connections.redraw = id => { redraws++; return redraw(id) }
  let apiWrites = 0
  const write = connections.write.bind(connections)
  connections.write = (id, data) => { apiWrites++; writes.push(data); return write(id, data) }
  server = await createWebServer({ store, service, connections, port: 0, dataDir: directory })
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1480, height: 920 }, deviceScaleFactor: 2 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin })
  const page = await context.newPage()
  testPage = page
  // Records whether the welcome screen is ever painted during the first seconds of a load.
  await page.addInitScript(() => {
    window.__welcomeSeen = false
    const tick = () => { const w = document.getElementById('welcome'); if (w && !w.hidden && getComputedStyle(w).visibility !== 'hidden' && localStorage.getItem('active-session')) window.__welcomeSeen = true; if (performance.now() < 4000) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? promptAnswer ?? '' : undefined))
  page.on('pageerror', error => failures.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error' || message.text().includes('favicon.ico')) return
    // This scenario deliberately returns one HTTP 500 to exercise partial
    // creation. Exempt only that exact endpoint/status while the flag is set.
    if (expectedFailure && message.location().url === server.origin + expectedFailure && message.text().includes('status of 500')) return
    failures.push(message.text())
  })
  await page.goto(server.origin)
  await page.waitForSelector('body[data-ready="true"]')
  assert.equal(await page.locator('#host').inputValue(), 'local', 'without a remembered device, the first one (this Mac) is selected')
  await page.locator('#host').selectOption('macmini')
  assert.equal(await page.locator('#new-session').isEnabled(), true)
  pass('real browser loads WebUI, authenticated backend and a nonempty SSH selector')

  await page.locator('#new-session').click()
  assert.equal(await page.locator('#create-host').inputValue(), 'macmini')
  await page.locator('#create-name').fill('WebUI 隔离验收')
  // Remote path completion: "~/" lists the remote home; filter, arrow, Tab, descend.
  await page.locator('#create-project').fill('')
  await page.locator('#create-project').focus()
  await page.locator('#project-suggest .suggest-item', { hasText: '~/workspace/' }).waitFor()
  await page.locator('#create-project').fill('~/work')
  await page.keyboard.press('Tab') // immediately: must use candidates for "~/work", not the stale list
  assert.equal(await page.locator('#create-project').inputValue(), '~/workspace/')
  await page.locator('#project-suggest .suggest-item', { hasText: 'my-app' }).waitFor()
  assert(await page.locator('#project-suggest .suggest-item', { hasText: 'my-app' }).locator('.suggest-git').count(), 'git repos are marked')
  await page.keyboard.type('my')
  await page.waitForFunction(() => document.querySelectorAll('#project-suggest .suggest-item').length === 2)
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  assert.equal(await page.locator('#create-project').inputValue(), '~/workspace/my-api/')
  assert(await page.locator('#create-dialog').evaluate(d => d.open), 'Enter on a candidate does not submit')
  await page.locator('#create-project').fill('~/workspace/my-app')
  await page.waitForFunction(() => document.getElementById('project-hint').textContent.includes('macmini:/Users/fixture/workspace/my-app · Git 仓库'))
  await page.keyboard.press('Escape')
  assert(await page.locator('#create-dialog').evaluate(d => d.open), 'Escape closes the list, not the dialog')
  assert.equal(await page.locator('#project-suggest').isVisible(), false)
  pass('remote project field completes directories (~/ expanded remotely), marks Git repos, keyboard select without submitting')
  await page.locator('#create-project').fill('/test/web-fixture')
  await page.waitForFunction(() => document.getElementById('project-hint').textContent.includes('macmini:/test/web-fixture'), null, { timeout: 3000 })
  // Launch arguments: Codex defaults to full permission; preview shows the exact remote argv.
  assert.equal(await page.locator('#create-tool').inputValue(), 'codex')
  assert.equal(await page.locator('#create-preset').inputValue(), 'full')
  assert((await page.locator('#launch-preview code').innerText()) === 'codex --dangerously-bypass-approvals-and-sandbox')
  assert(await page.locator('#launch-preview.danger').count(), 'full permission is visibly flagged')
  await page.locator('#create-preset').selectOption('auto')
  await page.locator('#create-args').fill(`-m o3 -c 'model_reasoning_effort="high"'`)
  assert.equal(await page.locator('#launch-preview code').innerText(), `codex --sandbox workspace-write --ask-for-approval on-request -m o3 -c 'model_reasoning_effort="high"'`)
  await page.locator('#create-tool').selectOption('claude')
  assert.equal(await page.locator('#create-preset').inputValue(), 'full')
  assert.equal(await page.locator('#project-suggest').isVisible(), false, 'candidate list closes when focus leaves the path field')
  await page.locator('#create-dialog').screenshot({ path: path.join(__dirname, 'artifacts/ai-hub-launch-args.png') })
  assert.equal(await page.locator('#launch-preview code').innerText(), 'claude --dangerously-skip-permissions')
  await page.locator('#create-tool').selectOption('shell')
  assert.equal(await page.locator('#launch-block').isVisible(), false)
  pass('create dialog: per-tool permission presets (full by default), extra args, exact command preview')
  assert.equal(await page.locator('#create-worktree').isDisabled(), true)
  await page.locator('#create-submit').click()
  await page.waitForFunction(() => document.getElementById('connection').textContent === '已连接')
  await page.waitForFunction(() => [...terminals.values()].some(({term}) => Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()).join('\n').includes('WEB_TERMINAL_FIXTURE')))
  assert.equal(creates, 1); assert.equal(ptys, 1)
  pass('create form → HTTP backend → persisted session → real PTY → SSE → rendered terminal (mock remote)')

  const font = await page.evaluate(() => {
    const {term} = [...terminals.values()][0], ctx = document.createElement('canvas').getContext('2d')
    ctx.font = `${term.options.fontSize}px ${term.options.fontFamily}`
    const widths = ['W','i','l','0','1'].map(s=>ctx.measureText(s).width)
    const cjk = []
    for(let i=0;i<term.buffer.active.length;i++){
      const line=term.buffer.active.getLine(i)
      for(let j=0;j<line.length;j++)if(line.getCell(j)?.getChars()==='中')cjk.push(line.getCell(j).getWidth())
    }
    return {family:term.options.fontFamily,size:term.options.fontSize,letterSpacing:term.options.letterSpacing,widths,cjk,cell:term._core._renderService.dimensions.css.cell.width}
  })
  assert(font.family.startsWith('Menlo,')); assert.equal(font.size,14); assert.equal(font.letterSpacing,0)
  assert(Math.max(...font.widths)-Math.min(...font.widths)<0.05,'Latin glyphs must have equal advance, not proportional CJK fallback')
  assert(Math.abs(font.cell-font.widths[0])<1,'xterm cell must track the monospace glyph metric')
  assert(font.cjk.length>0); assert(font.cjk.every(width=>width===2),'CJK glyphs use two terminal cells')
  pass('Retina browser uses equal-width Latin cells and two-cell CJK with real Menlo rendering')
  const typographyArtifacts=path.join(__dirname, 'artifacts')
  fs.mkdirSync(typographyArtifacts,{recursive:true})
  await page.screenshot({path:path.join(typographyArtifacts,'ai-hub-typography.png')})

  const fontCols=connections.links.get(service.list()[0].id).cols
  await page.locator('#terminal-font-larger').click()
  await page.waitForFunction(()=>[...terminals.values()][0].term.options.fontSize===15)
  await page.waitForFunction(old=>[...terminals.values()][0].term.cols<old,fontCols)
  await page.locator('#terminal-font-reset').click()
  await page.waitForFunction(()=>[...terminals.values()][0].term.options.fontSize===14)
  await page.locator('#terminal-font-larger').click()
  await page.waitForFunction(()=>[...terminals.values()][0].term.options.fontSize===15)
  assert.equal(creates,1); assert.equal(ptys,1)
  pass('font controls resize existing PTY without input / duplicate agent or transport')

  const normalWidth=await page.locator('.remote-terminal.active .xterm-screen').evaluate(e=>e.getBoundingClientRect().width)
  await page.locator('#terminal-focus').click()
  assert.equal(await page.locator('#pane-left').isVisible(),false)
  assert.equal(await page.locator('#pane-right').isVisible(),false)
  assert.equal(await page.locator('#terminal-focus').getAttribute('aria-pressed'),'true')
  await page.waitForFunction(old=>document.querySelector('.remote-terminal.active .xterm-screen').getBoundingClientRect().width>old,normalWidth)
  await page.screenshot({path:path.join(typographyArtifacts,'ai-hub-tmux-focus.png')})
  await page.locator('#terminal-focus').click()
  assert.equal(await page.locator('#pane-left').isVisible(),true)
  assert.equal(await page.locator('#pane-right').isVisible(),true)
  assert.equal(creates,1);assert.equal(ptys,1)
  pass('focus mode collapses both side panes around the same terminal, preserving tmux identity / transport')

  // ---- three-pane layout: collapse / shortcuts / drag never touch the transport ----
  const screenWidth = () => page.locator('.remote-terminal.active .xterm-screen').evaluate(e => e.getBoundingClientRect().width)
  for (const pane of ['#pane-left', '.remote-terminal.active', '#pane-right']) assert(await page.locator(pane).isVisible(), pane + ' visible in three-pane layout')
  await page.waitForFunction(() => document.querySelector('.remote-terminal.active .xterm-screen').getBoundingClientRect().width <= document.getElementById('terminal-deck').clientWidth)
  const before3 = await screenWidth(), writes3 = writes.length
  await page.locator('#collapse-left').click()
  assert.equal(await page.locator('#pane-left').isVisible(), false)
  assert(await page.locator('#expand-left').isVisible())
  await page.waitForFunction(old => document.querySelector('.remote-terminal.active .xterm-screen').getBoundingClientRect().width > old, before3)
  await page.locator('.remote-terminal.active .xterm-screen').click()
  await page.keyboard.press('Meta+b')
  await page.locator('#pane-left').waitFor()
  await page.keyboard.press('Meta+Alt+b')
  await page.locator('#pane-right').waitFor({ state: 'hidden' })
  await page.keyboard.press('Meta+Alt+b')
  await page.locator('#pane-right').waitFor()
  assert.equal(writes.length, writes3, 'pane shortcuts must not type into the remote terminal')
  const handle = await page.locator('#resize-right').boundingBox(), rightBefore = (await page.locator('#pane-right').boundingBox()).width
  const colsBefore = connections.links.get(service.list()[0].id).cols
  await page.mouse.move(handle.x + 2, handle.y + 200); await page.mouse.down()
  await page.mouse.move(handle.x - 60, handle.y + 200, { steps: 4 }); await page.mouse.move(handle.x - 150, handle.y + 200, { steps: 4 }); await page.mouse.up()
  assert(Math.abs((await page.locator('#pane-right').boundingBox()).width - rightBefore - 150) < 8)
  await page.waitForFunction(() => document.querySelectorAll('.resizing').length === 0)
  await new Promise(r => setTimeout(r, 250))
  assert(connections.links.get(service.list()[0].id).cols < colsBefore, 'settled pane width reaches the PTY')
  assert.equal(creates, 1); assert.equal(ptys, 1)
  pass('left/right panes collapse, ⌘B / ⌘⌥B toggle over xterm, drag-resize refits the same PTY (no reconnect)')

  await page.locator('.remote-terminal.active .xterm-screen').click()
  await page.keyboard.type('web-ui-input-中文')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...terminals.values()].some(({term}) => Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()).join('\n').includes('web-ui-input-中文')))
  pass('real keyboard input and UTF-8 round-trip over PTY / HTTP / event stream')

  // Claude Code enables "report every mouse movement" (1003 + SGR 1006).
  // Hovering must not flood the PTY with one HTTP request per pixel, and
  // keystrokes typed meanwhile must arrive promptly and in order.
  {
    const mid = service.list()[0].id
    const writeCalls = () => fileOps.filter(x => x === 'write').length
    connections.emit('event', { type: 'data', id: mid, data: '\x1b[?1003h\x1b[?1006h' })
    await new Promise(r => setTimeout(r, 100))
    const box = await page.locator('.remote-terminal.active .xterm-screen').boundingBox()
    const before = writes.length, posts0 = apiWrites
    const t0 = Date.now()
    for (let i = 0; i < 80; i++) await page.mouse.move(box.x + 20 + i * 4, box.y + 40 + (i % 7) * 3)
    await page.keyboard.type('mouse-ok')
    for (let i = 0; i < 100 && !writes.slice(before).join('').includes('k'); i++) await new Promise(r => setTimeout(r, 20))
    const sent = writes.slice(before).join('')
    console.log('MOUSE', JSON.stringify({ posts: apiWrites - posts0, writes: writes.length - before, motions: (sent.match(/\x1b\[<3[2-5];/g) || []).length, ms: Date.now() - t0 }))
    assert(sent.replace(/\x1b\[<[0-9;]*[Mm]/g, '').endsWith('mouse-ok'), 'typed text arrives intact after mouse motion')
    assert(apiWrites - posts0 < 25, `mouse motion is coalesced (sent ${apiWrites - posts0} write requests for 80 moves + 8 keys)`)
    connections.emit('event', { type: 'data', id: mid, data: '\x1b[?1003l\x1b[?1006l' })
    pass('any-motion mouse mode: hover is coalesced, keystrokes stay prompt and ordered')
  }

  // Synchronized output: a frame between ?2026h and ?2026l is painted only when complete.
  {
    const sid = service.list()[0].id
    const screen = () => page.evaluate(() => { const t = terminals.get(active).term, b = t.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\n') })
    connections.emit('event', { type: 'data', id: sid, data: '\x1b[?20' })
    connections.emit('event', { type: 'data', id: sid, data: '26hSYNC-FRAME-A' })
    await new Promise(r => setTimeout(r, 70))
    assert(!(await screen()).includes('SYNC-FRAME-A'), 'half frame is held back (marker split across chunks)')
    connections.emit('event', { type: 'data', id: sid, data: 'B\x1b[?20' })
    connections.emit('event', { type: 'data', id: sid, data: '26l\r\n' })
    await page.waitForFunction(() => { const b = terminals.get(active).term.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\n').includes('SYNC-FRAME-AB') })
    connections.emit('event', { type: 'data', id: sid, data: '\x1b[?2026hUNTERMINATED\r\n' })
    await page.waitForFunction(() => { const b = terminals.get(active).term.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\n').includes('UNTERMINATED') }, null, { timeout: 2000 })
    pass('synchronized output: frames are painted whole; split markers handled; safety flush after 120 ms')
  }

  // ---- copy & scroll ----
  {
    const sid = service.list()[0].id
    assert.equal(await page.evaluate(() => terminals.get(active).term.options.macOptionClickForcesSelection), true, '⌥-drag forces native selection')
    connections.emit('event', { type: 'data', id: sid, data: '\x1b]52;c;' + Buffer.from('copied via tmux 中文').toString('base64') + '\x07' })
    await page.waitForFunction(() => navigator.clipboard.readText().then(t => t === 'copied via tmux 中文'))
    await page.locator('.remote-terminal.active .xterm-screen').click({ button: 'right' })
    await page.locator('.ctx-menu').getByText('复制最近输出（纯文本）').click()
    await page.waitForFunction(() => navigator.clipboard.readText().then(t => t.startsWith('AI said: hello world')))
    await page.locator('.remote-terminal.active .xterm-screen').click({ button: 'right' })
    await page.locator('.ctx-menu').getByText('在右侧查看终端历史').click()
    await page.locator('#doc-body .code').getByText('second line of output').waitFor()
    await new Promise(r => setTimeout(r, 500))
    assert(!(await page.evaluate(() => Object.entries(localStorage).some(([k, v]) => k.startsWith('aihub-wb-docs:') && v.includes('second line of output')))), 'terminal history is never cached in localStorage')
    await page.locator('.doc-tab.active .doc-tab-close').click()
    pass('copy: OSC 52 from tmux reaches the Mac clipboard; copy recent output / view history on request; ⌥-drag selection')
  }
  const id = service.list()[0].id, oldCols = connections.links.get(id).cols
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.waitForFunction(() => [...terminals.values()].some(({term})=>term.cols<120))
  await new Promise(r=>setTimeout(r,150))
  assert.notEqual(connections.links.get(id).cols,oldCols)
  pass('viewport resize reaches real PTY dimensions')
  await page.setViewportSize({width:980,height:820})
  await page.waitForFunction(()=>document.body.classList.contains('narrow'))
  assert.equal(await page.locator('#pane-right').isVisible(),false,'narrow window keeps one overlay pane at most')
  await page.locator('#collapse-left').click()
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth)
  for(const button of ['connect','terminal-font-smaller','terminal-font-larger','terminal-focus','attach','expand-left','expand-right']) {
    const r=await page.locator('#'+button).boundingBox()
    assert(r&&r.x>=0&&r.x+r.width<=980,button+' must not be clipped in a narrow window')
  }
  await page.locator('#expand-right').click()
  assert(await page.locator('#pane-right').isVisible()); assert.equal(await page.locator('#pane-left').isVisible(),false)
  await page.setViewportSize({width:1480,height:920})
  await page.locator('#expand-left').click()
  for (const pane of ['#pane-left', '#pane-right']) assert(await page.locator(pane).isVisible())
  pass('narrow window turns side panes into single overlays without clipping terminal controls')

  // ---- right pane: tree → preview → explicit edit → hash-checked save ----
  await page.locator('#files-view .tree-row[data-path="README.md"]').waitFor()
  assert.equal(await page.locator('#files-view .tree-root .name').innerText(), 'web-fixture', 'project folder is shown as the root row')
  assert.equal(await page.locator('#wb-root-path .rp-name').innerText(), 'web-fixture', 'breadcrumb keeps the last segment')
  await page.waitForFunction(() => !document.getElementById('wb-sync').textContent.includes('中'))
  const opsBeforeExpand = fileOps.length, treeBeforeExpand = treeCalls
  await page.locator('#files-view .tree-row[data-path="src"]').click()
  await page.locator('#files-view .tree-row[data-path="src/app.js"]').waitFor()
  assert.equal(fileOps.length, opsBeforeExpand, 'expanding a preloaded directory sends no request')
  assert.equal(treeCalls, treeBeforeExpand)
  await page.locator('#files-view .tree-row[data-path="src/app.js"]').click()
  await page.locator('#doc-body .code-view .code').getByText('answer', { exact: false }).first().waitFor()
  assert.equal(await page.locator('#doc-body .gutter').innerText(), '1\n2')
  assert(await page.locator('#doc-body code.hljs').count(), 'preview is syntax highlighted')
  assert(await page.locator('#files-view .tree-row[data-path="src/app.js"].changed').count(), 'tree shows git status badge')
  assert.equal(saves.length, 0, 'opening a file never writes')
  await page.locator('#doc-actions').getByText('编辑', { exact: true }).click()
  const editorBox = page.locator('#doc-body textarea.code-input')
  await editorBox.fill('const answer = 43\nconsole.log(answer)\n')
  await page.locator('.doc-tab.active.dirty').waitFor()
  await editorBox.press('Meta+s')
  await page.waitForFunction(() => !document.querySelector('.doc-tab.dirty'))
  assert.equal(saves.length, 1); assert.equal(saves[0].content, 'const answer = 43\nconsole.log(answer)\n')
  assert.equal(saves[0].expected, sha('const answer = 42\nconsole.log(answer)\n'))
  assert((await page.locator('#toast').innerText()).includes('私有备份'))
  pass('file tree → highlighted preview → explicit edit → ⌘S hash-checked save with backup (mock remote)')

  contents['src/app.js'] = 'agent changed this\n'
  expectedFailure = '/api/save-file'
  await editorBox.fill('my local edit\n')
  await editorBox.press('Meta+s')
  await page.locator('#doc-body .conflict').waitFor()
  expectedFailure = null
  assert.equal(await editorBox.inputValue(), 'my local edit\n', 'local buffer survives a conflict')
  assert.equal(contents['src/app.js'], 'agent changed this\n', 'remote change is never overwritten')
  await page.locator('#doc-body .conflict').getByText('重新读取远端（丢弃本地）').click()
  await page.locator('#doc-body .code').getByText('agent changed this').waitFor()
  assert.equal(saves.length, 1)
  pass('remote modification during editing is a visible conflict, never an overwrite')

  await page.locator('#view-git').click()
  await page.waitForFunction(() => document.getElementById('git-count').textContent === '2')
  await page.locator('#git-view .change-row[data-path="src/app.js"]').click()
  await page.locator('#doc-body .dl.add').first().waitFor()
  assert.equal(await page.locator('#doc-body .dl.add .tx').innerText(), '+const answer = 42')
  assert.equal(await page.locator('#doc-body .dl.del .tx').innerText(), '-const answer = 41')
  assert.equal(await page.locator('#doc-body .dl.ctx .ln').first().innerText(), '2')
  await page.locator('#git-view .change-row[data-path="NEW.md"]').click()
  await page.locator('#doc-body .diff-summary').getByText('未跟踪的新文件').waitFor()
  assert.equal(await page.locator('.doc-tab').count(), 3)
  await page.locator('#viewer-max').click()
  assert.equal(await page.locator('#explorer').isVisible(), false)
  await page.locator('#viewer-max').click()
  await page.locator('#wb-wide').click()
  for (const id of ['collapse-right', 'viewer-max']) { const r = await page.locator('#' + id).boundingBox(); assert(r.x + r.width <= 1480, id + ' stays inside the window when widened') }
  assert((await page.locator('.remote-terminal.active').boundingBox()).width >= 300, 'terminal keeps a usable width')
  await page.screenshot({ path: path.join(typographyArtifacts, 'ai-hub-workbench.png') })
  await page.locator('#wb-wide').click()
  assert.equal(creates, 1); assert.equal(ptys, 1)
  pass('Git change list with counts → per-file unified diff with line numbers; viewer maximise / widen (mock remote)')

  const writesBefore = writes.length
  await page.locator('#doc-actions').getByText('插入路径').click()
  for (let i = 0; i < 50 && writes.length === writesBefore; i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(writes.at(-1), '/test/web-fixture/NEW.md ', 'inserted path is the absolute path on the SSH host'); assert(!/[\r\n]/.test(writes.at(-1)))
  pass('insert path from the viewer types the remote absolute path into the terminal without Enter')

  // ---- right-click menus ----
  await page.locator('#view-files').click()
  await page.locator('#files-view .tree-row[data-path="src/app.js"]').click({ button: 'right' })
  await page.locator('.ctx-menu').waitFor()
  assert(await page.locator('.ctx-menu').getByText('复制 scp 地址').count())
  await page.screenshot({ path: path.join(typographyArtifacts, 'ai-hub-context-menu.png') })
  await page.locator('.ctx-menu').getByText('复制远端绝对路径').click()
  await page.waitForFunction(() => !document.querySelector('.ctx-menu'))
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '/test/web-fixture/src/app.js')
  const menuWrites = writes.length
  await page.locator('#files-view .tree-row[data-path="src"]').click({ button: 'right' })
  await page.locator('.ctx-menu').getByText('插入远端绝对路径到终端').click()
  for (let i = 0; i < 50 && writes.length === menuWrites; i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(writes.at(-1), '/test/web-fixture/src ')
  await page.locator('#git-count').waitFor()
  await page.locator('.doc-tab').first().click({ button: 'right' })
  await page.locator('.ctx-menu').getByText('关闭其他').click()
  assert.equal(await page.locator('.doc-tab').count(), 1)
  await page.locator('.remote-terminal.active .xterm-screen').click({ button: 'right' })
  await page.locator('.ctx-menu').getByText('粘贴图片（上传到 macmini）').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.ctx-menu'))
  promptAnswer = '右键重命名'
  await page.locator('.session-card').first().click({ button: 'right' })
  await page.locator('.ctx-menu').getByText('重命名…').click()
  await page.locator('.session-card b', { hasText: '右键重命名' }).waitFor()
  assert.equal(service.list()[0].name, '右键重命名')
  assert.equal(await page.locator('.group-title .device-name').first().innerText(), 'macmini', 'renaming keeps the device grouping')
  assert.equal(creates, 1); assert.equal(ptys, 1)
  pass('right-click menus on tree / tabs / terminal / sessions: copy & insert remote paths, close others, rename')

  // ---- devices: local + SSH in one entry point ----
  await page.locator('.group-title.device[data-host="macmini"] .device-add').click()
  assert.equal(await page.locator('#create-host').inputValue(), 'macmini', 'device ＋ preselects that device')
  assert.equal(await page.locator('#create-transport').isDisabled(), false)
  await page.locator('#create-host').selectOption('local')
  assert.equal(await page.locator('#create-transport').inputValue(), 'local')
  assert.equal(await page.locator('#create-transport').isDisabled(), true)
  assert((await page.locator('#create-host option[value="local"]').innerText()).startsWith('本机'))
  await page.locator('#create-host').selectOption('macmini')
  assert.equal(await page.locator('#create-transport').inputValue(), 'udp')
  await page.locator('#create-cancel').click()
  pass('device headers with ＋; local device uses a fixed local transport; SSH devices keep UDP / TCP choice')

  // ---- images and roots ----
  await page.locator('#files-view .tree-row[data-path="shot.png"]').click()
  await page.waitForFunction(() => document.querySelector('#doc-body .image-view img')?.naturalWidth > 0)
  assert((await page.locator('#doc-body .image-info').innerText()).includes('image/png'))
  await page.screenshot({ path: path.join(typographyArtifacts, 'ai-hub-image-preview.png') })
  assert.equal((await page.locator('#wb-root-path').textContent()).replace(/\u200e/g, ''), 'macmini:/test/web-fixture')
  await page.locator('#wb-root').selectOption('pane')
  await page.locator('#files-view .tree-row[data-path="pane-only.txt"]').waitFor()
  assert.equal((await page.locator('#wb-root-path').textContent()).replace(/\u200e/g, ''), 'macmini:/test/pane-dir')
  await page.locator('#wb-root').selectOption('cwd')
  await page.locator('#files-view .tree-row[data-path="README.md"]').waitFor()
  pass('remote image preview; root picker switches between session dir and the tmux pane directory (resolved remotely)')

  // ---- pasted paths: remote path passes through, local-only path is caught ----
  const pasteInto = text => page.evaluate(t => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.querySelector('.remote-terminal.active textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) }, text)
  await page.locator('.remote-terminal.active .xterm-screen').click()
  let before = writes.length
  await pasteInto('/test/web-fixture/README.md')
  for (let i = 0; i < 100 && writes.length === before; i++) await new Promise(r => setTimeout(r, 20))
  assert(writes.slice(before).join('').includes('/test/web-fixture/README.md'), 'path that exists on the SSH host is pasted unchanged')
  const localShot = path.join(__dirname, 'fixtures/upload-test.png')
  before = writes.length; const uploadsBefore = uploads
  await pasteInto(localShot)
  await page.locator('#toast').getByText('这是本机路径').waitFor()
  await new Promise(r => setTimeout(r, 200))
  assert.equal(writes.length, before, 'local-only path is NOT typed into the remote terminal')
  await page.locator('#toast .toast-action', { hasText: '上传到 macmini' }).click()
  for (let i = 0; i < 100 && writes.length === before; i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(uploads, uploadsBefore + 1)
  assert(writes.at(-1).startsWith('/test/uploads/'), 'the remote copy path is inserted instead')
  assert.equal(await page.locator('#upload-host').innerText(), 'macmini:')
  pass('pasted local-only path is intercepted; one click uploads it and inserts the remote path')

  const image = path.join(__dirname, 'fixtures/upload-test.png')
  const chooser = page.waitForEvent('filechooser'), pickedBefore = uploads
  await page.locator('#attach').click()
  await (await chooser).setFiles(image)
  for (let i = 0; i < 100 && uploads === pickedBefore; i++) await new Promise(r => setTimeout(r, 20))
  await page.waitForSelector('#upload-result:not([hidden])')
  assert.equal(uploads,pickedBefore+1)
  assert.equal(crypto.createHash('sha256').update(uploadBytes).digest('hex'),'61e4117ebc041924fee828e481733201fdd98d2eb9ec1f0e4e9f9edf054928d7')
  const uploadWrites = writes.length
  await page.locator('#insert-upload').click()
  for (let i = 0; i < 50 && writes.length === uploadWrites; i++) await new Promise(r => setTimeout(r, 20))
  assert(writes.at(-1).startsWith('/test/uploads/')); assert(!/[\r\n]/.test(writes.at(-1)))
  pass('real file picker → binary upload/hash → remote path insertion without Enter (mock remote)')

  // Leave an unsaved draft and a cached tree behind, then reload with a slow remote.
  await page.locator('#files-view .tree-row[data-path="src"]').waitFor()
  await page.locator('#files-view .tree-row[data-path="README.md"]').click()
  await page.locator('#doc-actions').getByText('编辑', { exact: true }).click()
  await page.locator('#doc-body textarea.code-input').fill('# draft survives reload\n')
  await new Promise(r => setTimeout(r, 700))
  slowTree = 1500; const treeBefore = treeCalls
  await page.reload()
  await page.waitForSelector('body[data-ready="true"]')
  await page.locator('#files-view .tree-row[data-path="src/app.js"]').waitFor({ timeout: 1000 })
  assert((await page.locator('#wb-sync').innerText()).includes('缓存'), 'tree is rendered from cache while the remote check runs')
  await page.waitForFunction(() => document.getElementById('wb-sync').textContent.startsWith('已同步'))
  assert.equal(treeCalls, treeBefore + 1, 'one batched SSH call revalidates the cached tree + git')
  slowTree = 0
  await page.locator('.doc-tab.dirty').waitFor()
  assert.equal(await page.locator('#doc-body textarea.code-input').inputValue(), '# draft survives reload\n')
  assert((await page.locator('#doc-body .conflict.info').innerText()).includes('恢复未保存的草稿'))
  await page.locator('#doc-actions').getByText('放弃修改').click()
  await page.waitForFunction(() => !document.querySelector('.doc-tab.dirty'))
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('aihub-draft:')).length), 0)
  pass('reload renders cached tree instantly, revalidates in one call, restores unsaved draft until discarded')
  assert(redraws >= 1, 'restoring a connected terminal asks tmux for one clean repaint')
  assert.equal(await page.evaluate(() => window.__welcomeSeen), false, 'reload with an active session never flashes the welcome screen')
  assert.equal(await page.locator('.remote-terminal.restoring').count(), 0)
  assert.equal(await page.locator('.session-card').count(),1)
  assert.equal(creates,1); assert.equal(ptys,1)
  assert.equal(await page.locator('#terminal-font-size').innerText(),'15 px')
  assert.equal(await page.evaluate(()=>[...terminals.values()][0].term.options.fontSize),15)
  await page.waitForFunction(()=>document.getElementById('connection').textContent==='已连接')
  pass('browser reload restores metadata and terminal without duplicate agent / transport')

  // Terminal query replies (e.g. DA "\x1b[c" → "\x1b[?1;2c") must only come from
  // live output in a visible, opened terminal — never from history replay or
  // from sessions this page never opened (output is broadcast to every page).
  const writesBeforeReplay = writes.length
  connections.links.get(id).tail += '\x1b[c'
  await page.reload(); await page.waitForSelector('body[data-ready="true"]')
  await page.waitForFunction(() => document.getElementById('connection').textContent === '已连接')
  await new Promise(r => setTimeout(r, 400))
  assert(!writes.slice(writesBeforeReplay).some(w => w.includes('\x1b[?')), 'replayed history never answers terminal queries')
  connections.emit('event', { type: 'data', id: 'f'.repeat(32), data: '\x1b[c' })
  await new Promise(r => setTimeout(r, 300))
  assert.equal(await page.evaluate(() => terminals.has('f'.repeat(32))), false, 'no hidden terminal for an unopened session')
  assert(!writes.slice(writesBeforeReplay).some(w => w.includes('\x1b[?')))
  connections.emit('event', { type: 'data', id, data: '\x1b[c' })
  for (let i = 0; i < 50 && !writes.slice(writesBeforeReplay).some(w => w.includes('\x1b[?')); i++) await new Promise(r => setTimeout(r, 20))
  assert(writes.slice(writesBeforeReplay).some(w => w.includes('\x1b[?')), 'live query on the visible terminal is still answered')
  pass('no stray terminal replies: history replay and unopened sessions never write to the remote PTY')

  await page.locator('#disconnect').click()
  await page.waitForFunction(()=>document.getElementById('connection').textContent==='未连接')
  assert.equal(store.get(id).tmux,service.list()[0].tmux)
  pass('disconnect preserves remote identity / worktree metadata')

  failNextCreate = true; expectedFailure = '/api/create'
  await page.locator('#new-session').click()
  await page.locator('#create-name').fill('部分创建回归')
  await page.locator('#create-tool').selectOption('codex')
  await page.locator('#create-args').fill('--search')
  await page.locator('#create-save-default').check()
  await page.locator('#create-worktree').check()
  // Worktree start branch + PR target, saved as this project's defaults.
  await page.locator('#branch-block').waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('#create-base option')].some(o => o.value === 'origin/develop'))
  assert((await page.locator('#create-base option').first().innerText()).includes('feat/now'), 'current checkout offered first')
  await page.locator('#create-base').selectOption('develop')
  await page.locator('#create-target').fill('develop')
  // Editing the path reloads branches; a start branch picked by hand is kept.
  await page.locator('#create-project').fill('/test/web-fixture')
  await new Promise(r => setTimeout(r, 900))
  assert.equal(await page.locator('#create-base').inputValue(), 'develop', 'hand-picked start branch survives a branch reload')
  await page.locator('#create-save-project').check()
  assert((await page.locator('#branch-hint').innerText()).includes('从 develop 创建'))
  await page.locator('#create-submit').click()
  await page.waitForFunction(() => document.getElementById('create-error').textContent.includes('恢复并连接'))
  expectedFailure = null
  assert.equal(creates, 2); assert.equal(recovers, 0)
  const failed = service.list().find(s => s.status === 'failed')
  assert(failed)
  assert.deepEqual(failed.launch.args, ['--dangerously-bypass-approvals-and-sandbox', '--search'], 'chosen launch args are stored with the session')
  assert.equal(failed.base, 'develop'); assert.equal(failed.prTarget, 'develop')
  assert.deepEqual(service.projects.get('macmini', failed.project), { base: 'develop', prTarget: 'develop' }, 'saved as project defaults')
  assert.deepEqual(service.settings.get('codex'), { preset: 'full', extra: ['--search'] }, 'saved as the Codex default')
  assert(await page.locator(`.session-card[data-id="${failed.id}"] .launch-tag`).count(), 'card marks full-permission sessions')
  await page.locator('#create-cancel').click()
  await page.locator(`.session-card[data-id="${failed.id}"]`).click()
  await page.waitForFunction(() => document.getElementById('connect').textContent === '恢复并连接')
  assert.equal(ptys, 1, 'Selecting failed record must not auto-connect or recreate')
  pass('partial creation error explains recovery and never automatically recreates / connects')
  await page.locator('#connect').click()
  await page.waitForFunction(() => document.getElementById('connection').textContent === '已连接')
  await page.waitForFunction(() => document.getElementById('connect').textContent === '连接')
  assert.equal(recovers, 1); assert.equal(creates, 2); assert.equal(ptys, 2)
  assert.equal(service.get(failed.id).tmux, failed.tmux)
  assert.equal(service.get(failed.id).cwd, '/test/worktrees/' + failed.id)
  assert.equal((await page.locator('#remote-cwd').innerText()).replace(/\u200e/g, ''), '/test/worktrees/' + failed.id)
  pass('explicit recovery keeps original ID/tmux, corrects cwd and connects existing agent (mock remote)')

  await page.locator('#view-files').click()
  await page.locator('#files-view .tree-row[data-path="README.md"]').click()
  await page.locator('#doc-actions').getByText('编辑', { exact: true }).click()
  await page.locator('#doc-body textarea.code-input').fill('# unsaved draft\n')
  await page.locator(`.session-card[data-id="${id}"]`).click()
  await page.waitForFunction(() => !document.querySelector('.doc-tab.dirty'))
  await page.locator(`.session-card[data-id="${failed.id}"]`).click()
  await page.locator('.doc-tab.dirty').waitFor()
  assert.equal(await page.locator('#doc-body textarea.code-input').inputValue(), '# unsaved draft\n')
  assert(!saves.some(s => s.content.includes('unsaved draft')))
  pass('unsaved editor buffers are kept per session across session switches')
  // failed.id is active now; the first session is connected in the background.
  connections.emit('event', { type: 'data', id, data: 'agent finished a long step: ' + 'x'.repeat(500) + '\r\n' })
  await page.locator(`.session-card[data-id="${id}"].unread`).waitFor()
  await page.locator(`.session-card[data-id="${id}"]`).click()
  await page.waitForFunction(i => !document.querySelector(`.session-card[data-id="${i}"]`).classList.contains('unread'), id)
  pass('background session output marks the card as unread; opening it clears the mark')

  // ---- end task: stop only / clean up / push + PR ----
  await page.locator(`.session-card[data-id="${failed.id}"]`).click()
  await page.waitForFunction(() => document.getElementById('stop').textContent === '结束任务…')
  await page.locator('#stop').click()
  await page.locator('#end-dialog .end-summary').waitFor()
  assert((await page.locator('#end-dialog .end-summary').innerText()).includes('aihub/' + failed.id))
  assert.equal(await page.locator('#end-dialog .end-target input').inputValue(), 'develop', 'PR target from the task / project')
  const reasons = await page.locator('#end-dialog .end-reasons li').allInnerTexts()
  assert(reasons.some(r => r.includes('未提交')) && reasons.some(r => r.includes('MERGED')), 'clean is blocked with concrete reasons: ' + reasons)
  const prButton = page.locator('#end-dialog .end-card button', { hasText: '推送并创建 PR' })
  await page.locator('#end-dialog').screenshot({ path: path.join(__dirname, 'artifacts/ai-hub-end-task.png') })
  assert.equal(await prButton.isDisabled(), true, 'uncommitted changes must be acknowledged first')
  await page.locator('#end-dialog .end-banner.warn input[type=checkbox]').check()
  await prButton.click()
  await page.locator('#end-dialog .end-result a').waitFor()
  assert.equal(task.prCalls.length, 1); assert.equal(task.prCalls[0].target, 'develop'); assert.equal(task.prCalls[0].allowDirty, true)
  assert(task.prCalls[0].body.includes('feat: one'))
  assert.equal(await page.locator('#end-dialog .end-result a').getAttribute('href'), 'https://github.com/t/r/pull/10')
  await page.locator('#end-close').click()
  // Non-GitHub remote: the card becomes "推送分支" and shows the service's merge-request link.
  task.github = false; task.dirty = false
  await page.locator('#stop').click()
  await page.locator('#end-dialog .end-card button', { hasText: '推送分支' }).click()
  await page.locator('#end-dialog .end-result a').waitFor()
  assert.equal(task.prCalls.at(-1).pushOnly, true)
  assert((await page.locator('#end-dialog .end-result a').getAttribute('href')).startsWith('https://gitee.com/'))
  await page.locator('#end-close').click()
  task.github = true; task.dirty = false; task.merged = true
  await page.locator('#stop').click()
  await page.locator('#end-dialog .end-ok').waitFor()
  await page.locator('#end-dialog .end-card button', { hasText: '清理' }).click()
  await page.waitForFunction(() => !document.getElementById('end-dialog').open)
  assert.equal(task.cleans, 1)
  await page.waitForFunction(() => document.getElementById('connection').textContent === '已停止' || document.getElementById('connection').textContent === '未连接')
  pass('end task: blocked reasons listed; PR needs consent for uncommitted changes and targets develop; push-only for non-GitHub; clean once merged')
  await page.locator('#disconnect').click()
  await page.waitForFunction(() => document.getElementById('connection').textContent === '未连接')

  service.hosts = async () => []
  await page.locator('#refresh-hosts').click()
  await page.waitForFunction(()=>document.getElementById('new-session').disabled)
  assert.equal(await page.locator('#host').inputValue(),'')
  assert((await page.locator('#backend-status').textContent()).includes('没有可用主机'))
  pass('empty host list is explained and creation disabled (regression from user screenshot)')
  assert.equal(failures.length,0,failures.join('\n'))
  const artifacts=path.join(__dirname, 'artifacts')
  fs.mkdirSync(artifacts,{recursive:true})
  service.hosts=async()=>[{alias:'macmini',hostname:'mac-mini.fixture.ts.net',user:'test',port:'22'}]
  await page.locator('#refresh-hosts').click()
  await page.waitForFunction(()=>!document.getElementById('new-session').disabled)
  await page.screenshot({path:path.join(artifacts,'ai-hub-web-fixture.png')})

  // Installable web app: manifest + service worker; with the backend gone the
  // app window shows the "start the backend" page instead of a browser error.
  assert.equal(await page.evaluate(() => document.querySelector('link[rel=manifest]').href), server.origin + '/manifest.webmanifest')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload(); await page.waitForSelector('body[data-ready="true"]')
  assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the app page')
  await server.close()
  await page.reload()
  await page.getByText('本机后端未运行').waitFor()
  assert(await page.getByText('catmux start').isVisible())
  pass('installable web app: service worker registered; offline page tells how to start the backend')
  console.log('RESULT '+JSON.stringify({passed:tests.length,remote:'explicitly mocked; no Mini writes',dataDir:directory}))
})().catch(async e=>{
  console.error('FAIL',e.stack)
  if (testPage) {
    const debug = await testPage.evaluate(()=>({
      rectangles: Object.fromEntries(['workspace','terminal-deck','welcome'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return[id,{width:r.width,height:r.height,hidden:e.hidden,display:getComputedStyle(e).display}]})),
      terminal: [...document.querySelectorAll('.terminal,.xterm,.xterm-screen')].map(e=>{const r=e.getBoundingClientRect();return{className:e.className,width:r.width,height:r.height,display:getComputedStyle(e).display}}),
      sizes:[...terminals.values()].map(t=>({cols:t.term.cols,rows:t.term.rows,proposed:t.fit.proposeDimensions()}))
    }))
    console.error('UI_DIAGNOSTIC '+JSON.stringify(debug))
    console.error('UI_ERRORS '+JSON.stringify(failures))
    const artifacts=path.join(__dirname, 'artifacts');fs.mkdirSync(artifacts,{recursive:true})
    await testPage.screenshot({path:path.join(artifacts,'ai-hub-web-failure.png')})
  }
  process.exitCode=1
}).finally(async()=>{await browser?.close();await server?.close()})
