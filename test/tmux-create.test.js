'use strict'
// Execute the real Python create protocol with a private LOCAL tmux server.
// No SSH, remote writes, real AI executable or model requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { REMOTE, binary } = require('../src/remote-service')

const tmux = binary('tmux')
test('real isolated tmux executes create and window/session options with exact targets', { skip: !tmux }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-tmux-test-'))
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
  const env = { PATH: process.env.PATH, HOME: fixture, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
  const command = args => spawnSync(tmux, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const wrapper = String.raw`
import sys, json, subprocess
source=sys.stdin.read()
tmux, socket, arg=sys.argv[1:]
original_run=subprocess.run
def isolated(args, *a, **kw):
    if args[0]=='tmux': args=[tmux,'-L',socket,'-f','/dev/null']+args[1:]
    return original_run(args,*a,**kw)
subprocess.run=isolated
sys.argv=['remote','create',arg]
exec(compile(source,'real-create-protocol','exec'))
`
  const id = crypto.randomUUID().replaceAll('-', ''), name = 'aihub-' + id
  const s = { id, tmux: name, project: fixture, tool: 'shell', mode: 'direct', worktree: false }
  try {
    const result = spawnSync('python3', ['-c', wrapper, tmux, socket, JSON.stringify(s)], { env, encoding: 'utf8', input: REMOTE, timeout: 10000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const response = JSON.parse(result.stdout.split('\n').find(s => s.startsWith('AIHUB_RESULT:')).slice(13))
    assert.equal(response.ok, true)
    assert.equal(response.data.tmux, name)
    assert.equal(command(['show-options', '-w', '-v', '-t', '=' + name + ':', 'remain-on-exit']).stdout.trim(), 'on')
    assert.equal(command(['show-options', '-v', '-t', '=' + name + ':', 'mouse']).stdout.trim(), 'on')
    assert.equal(command(['show-options', '-v', '-t', '=' + name + ':', 'history-limit']).stdout.trim(), '50000')
    assert.equal(command(['list-sessions', '-F', '#{session_name}']).stdout.trim(), name)
  } finally {
    // Only this UUID-named test server, never the user's default tmux socket.
    command(['kill-server'])
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('launch arguments reach the CLI as exact argv inside tmux (no shell injection)', { skip: !tmux }, () => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-launch-test-')))
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
  const bin = path.join(fixture, 'bin'); fs.mkdirSync(bin)
  // Fake "codex": records argv one per line, then waits. Never a real AI CLI.
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${fixture}/argv.txt"\nsleep 20\n`, { mode: 0o755 })
  spawnSync('git', ['init', '-q', fixture])
  const env = { PATH: bin + ':' + process.env.PATH, HOME: fixture, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
  const command = args => spawnSync(tmux, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const wrapper = String.raw`
import sys, subprocess
source=sys.stdin.read()
tmux, socket, arg=sys.argv[1:]
original_run=subprocess.run
def isolated(args, *a, **kw):
    if args[0]=='tmux': args=[tmux,'-L',socket,'-f','/dev/null']+args[1:]
    return original_run(args,*a,**kw)
subprocess.run=isolated
sys.argv=['remote','create',arg]
exec(compile(source,'real-create-protocol','exec'))
`
  const P = require('../src/remote-protocol')
  const marker = path.join(fixture, 'injected')
  const extra = ['-c', `model="o3"; touch ${marker}`, "it's here", '$(touch ' + marker + ')']
  const launch = P.launchFor('codex', 'full', extra)
  const id = crypto.randomUUID().replaceAll('-', ''), name = 'aihub-' + id
  const s = { id, tmux: name, project: fixture, tool: 'codex', mode: 'direct', worktree: false, launch }
  try {
    const result = spawnSync('python3', ['-c', wrapper, tmux, socket, JSON.stringify(s)], { env, encoding: 'utf8', input: REMOTE, timeout: 10000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const file = path.join(fixture, 'argv.txt')
    for (let i = 0; i < 60 && !fs.existsSync(file); i++) spawnSync('sleep', ['0.1'])
    const argv = fs.readFileSync(file, 'utf8').split('\n').slice(0, -1)
    assert.deepEqual(argv, ['--dangerously-bypass-approvals-and-sandbox', ...extra])
    assert(!fs.existsSync(marker), 'extra arguments are never interpreted by a shell')
  } finally {
    command(['kill-server'])
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('stop: imported tmux sessions need explicit confirmation; only that exact session ends', { skip: !tmux }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-stop-test-'))
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
  const env = { PATH: process.env.PATH, HOME: fixture, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
  const command = args => spawnSync(tmux, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const wrapper = String.raw`
import sys, subprocess
source=sys.stdin.read()
tmux, socket, op, arg=sys.argv[1:]
original_run=subprocess.run
def isolated(args, *a, **kw):
    if args[0]=='tmux': args=[tmux,'-L',socket,'-f','/dev/null']+args[1:]
    return original_run(args,*a,**kw)
subprocess.run=isolated
sys.argv=['remote',op,arg]
exec(compile(source,'real-protocol','exec'))
`
  const call = arg => { const r = spawnSync('python3', ['-c', wrapper, tmux, socket, 'stop', JSON.stringify(arg)], { env, encoding: 'utf8', input: REMOTE, timeout: 10000 }); return JSON.parse(r.stdout.split('\n').find(l => l.startsWith('AIHUB_RESULT:')).slice(13)) }
  try {
    for (const name of ['claudesquad_demo', 'claudesquad_demo2', 'other']) command(['new-session', '-d', '-s', name, 'sleep 60'])
    assert.match(call({ tmux: 'claudesquad_demo', owned: false }).error, /确认/)
    assert.match(call({ tmux: 'other', owned: true }).error, /Catmux 创建/)
    assert.equal(call({ tmux: 'claudesquad_demo', owned: false, allowImported: true }).ok, true)
    const left = command(['list-sessions', '-F', '#{session_name}']).stdout.trim().split('\n').sort()
    assert.deepEqual(left, ['claudesquad_demo2', 'other'], 'exact-name match: a prefix-sharing session survives')
    assert.match(call({ tmux: 'claudesquad_demo', owned: false, allowImported: true }).error, /不存在/)
  } finally { command(['kill-server']); fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('attach announces xterm.js features to tmux (sync, RGB) via the real attach command', { skip: !tmux }, async () => {
  const P = require('../src/remote-protocol')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-feat-'))
  const env = { PATH: path.dirname(tmux) + ':' + process.env.PATH, HOME: dir, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TMUX_TMPDIR: dir }
  const t = args => spawnSync(tmux, ['-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const id = crypto.randomUUID().replaceAll('-', ''), name = 'aihub-' + id
  assert.equal(t(['new-session', '-d', '-s', name, 'sleep 60']).status, 0)
  const s = { id, host: P.LOCAL, mode: 'direct', tmux: name, transport: 'local' }
  const spec = P.attachSpec(s, {})
  const { spawn } = require('node:child_process')
  // Exactly what the backend runs, through the same stdlib PTY helper, with an isolated tmux socket dir.
  const child = spawn('python3', [path.join(__dirname, '../src/pty-helper.py'), spec.file, ...spec.args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', c => { output += c })
  try {
    let features = ''
    for (let i = 0; i < 50 && !features; i++) { await new Promise(r => setTimeout(r, 100)); features = t(['list-clients', '-t', '=' + name, '-F', '#{client_termfeatures}']).stdout.trim() }
    assert(features.split(',').includes('sync'), 'tmux treats our client as sync-capable: ' + features + ' / ' + output.slice(-400))
    assert(features.split(',').includes('RGB'), features)
    // tmux copies (copy-mode / set-buffer -w) reach our client as OSC 52 → Mac clipboard.
    t(['set-buffer', '-w', 'copied-by-tmux'])
    let osc = ''
    for (let i = 0; i < 30 && !osc; i++) {
      await new Promise(r => setTimeout(r, 100))
      osc = output.split('\n').filter(Boolean).map(l => { try { const e = JSON.parse(l); return e.type === 'data' ? Buffer.from(e.data, 'base64').toString() : '' } catch { return '' } }).join('').match(/\x1b\]52;[a-z]*;([A-Za-z0-9+/=]+)/)?.[1] || ''
    }
    assert.equal(Buffer.from(osc, 'base64').toString(), 'copied-by-tmux', 'tmux sends copied text as OSC 52')
  } finally { child.kill(); t(['kill-server']); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('capture copies pane text (history, or the visible alternate screen) and copy-mode enters tmux scrollback', { skip: !tmux }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-capture-test-'))
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
  const env = { PATH: process.env.PATH, HOME: fixture, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
  const command = args => spawnSync(tmux, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const wrapper = String.raw`
import sys, subprocess
source=sys.stdin.read()
tmux, socket, op, arg=sys.argv[1:]
original_run=subprocess.run
def isolated(args, *a, **kw):
    if args[0]=='tmux': args=[tmux,'-L',socket,'-f','/dev/null']+args[1:]
    return original_run(args,*a,**kw)
subprocess.run=isolated
sys.argv=['remote',op,arg]
exec(compile(source,'real-protocol','exec'))
`
  const call = (op, arg) => JSON.parse(spawnSync('python3', ['-c', wrapper, tmux, socket, op, JSON.stringify(arg)], { env, encoding: 'utf8', input: REMOTE, timeout: 10000 }).stdout.split('\n').find(l => l.startsWith('AIHUB_RESULT:')).slice(13))
  try {
    command(['new-session', '-d', '-x', '80', '-y', '10', '-s', 'plain', "sh -c 'i=1; while [ $i -le 60 ]; do echo line$i; i=$((i+1)); done; sleep 30'"])
    command(['new-session', '-d', '-x', '80', '-y', '10', '-s', 'full', "sh -c 'echo behind; printf \"\\033[?1049hON-ALT-SCREEN\"; sleep 30'"])
    await new Promise(r => setTimeout(r, 600))
    const plain = call('capture', { tmux: 'plain', lines: 200 })
    assert.equal(plain.ok, true); assert.equal(plain.data.alternate, false)
    assert(plain.data.text.includes('line1\n') && plain.data.text.includes('line60'), 'includes scrolled-off history')
    const full = call('capture', { tmux: 'full', lines: 200 })
    assert.equal(full.data.alternate, true); assert(full.data.text.includes('ON-ALT-SCREEN')); assert(!full.data.text.includes('behind'))
    assert.equal(call('copy-mode', { tmux: 'plain', pageUp: true }).ok, true)
    assert.equal(command(['display-message', '-p', '-t', '=plain:', '#{pane_in_mode}']).stdout.trim(), '1')
  } finally { command(['kill-server']); fs.rmSync(fixture, { recursive: true, force: true }) }
})

test('create starts the task worktree from the chosen branch; newer origin/<name> wins over a stale local one', { skip: !tmux }, () => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-base-test-')))
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
  const env = { PATH: process.env.PATH, HOME: fixture, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' }
  const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' }).stdout.trim()
  const command = args => spawnSync(tmux, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const project = path.join(fixture, 'p'), origin = path.join(fixture, 'o.git')
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env }); spawnSync('git', ['init', '-q', '-b', 'main', project], { env })
  fs.writeFileSync(path.join(project, 'a'), '1'); g(project, 'add', '.'); g(project, 'commit', '-qm', 'init'); g(project, 'remote', 'add', 'origin', origin)
  g(project, 'branch', 'develop'); g(project, 'push', '-q', 'origin', 'main', 'develop')
  // origin/develop moves ahead; local develop stays behind (no fetch needed: update the tracking ref).
  const clone = path.join(fixture, 'c'); spawnSync('git', ['clone', '-q', '-b', 'develop', origin, clone], { env })
  fs.writeFileSync(path.join(clone, 'b'), '2'); g(clone, 'add', '.'); g(clone, 'commit', '-qm', 'newer develop'); g(clone, 'push', '-q', 'origin', 'develop')
  g(project, 'fetch', '-q', 'origin')
  const newer = g(project, 'rev-parse', 'origin/develop')
  const wrapper = String.raw`
import sys, subprocess
source=sys.stdin.read()
tmux, socket, arg=sys.argv[1:]
original_run=subprocess.run
def isolated(args, *a, **kw):
    if args[0]=='tmux': args=[tmux,'-L',socket,'-f','/dev/null']+args[1:]
    return original_run(args,*a,**kw)
subprocess.run=isolated
sys.argv=['remote','create',arg]
exec(compile(source,'real-create-protocol','exec'))
`
  try {
    const id = crypto.randomUUID().replaceAll('-', '')
    const r = spawnSync('python3', ['-c', wrapper, tmux, socket, JSON.stringify({ id, tmux: 'aihub-' + id, project, tool: 'shell', mode: 'direct', worktree: true, base: 'develop' })], { env, encoding: 'utf8', input: REMOTE, timeout: 15000 })
    const res = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('AIHUB_RESULT:')).slice(13))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.data.baseRef, 'refs/remotes/origin/develop')
    assert.equal(g(project, 'rev-parse', 'aihub/' + id), newer, 'task branch starts at the newer origin/develop')
    assert.equal(g(project, 'branch', '--show-current'), 'main', 'main checkout untouched')
    const bad = spawnSync('python3', ['-c', wrapper, tmux, socket, JSON.stringify({ id: crypto.randomUUID().replaceAll('-', ''), tmux: 'aihub-x', project, tool: 'shell', mode: 'direct', worktree: true, base: 'nope' })], { env, encoding: 'utf8', input: REMOTE, timeout: 15000 })
    assert.match(JSON.parse(bad.stdout.split('\n').find(l => l.startsWith('AIHUB_RESULT:')).slice(13)).error, /起点分支 nope 不存在/)
  } finally { command(['kill-server']); fs.rmSync(fixture, { recursive: true, force: true }) }
})
