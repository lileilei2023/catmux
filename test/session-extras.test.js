'use strict'
// Right-hand terminal (companion shell), creating remote directories, and
// agents in plain (non-Git) directories. Local only: temporary HOME, private
// tmux socket, fake CLI. No SSH, no real agent, no model requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const P = require('../src/remote-protocol')
const { REMOTE, RemoteService, binary } = require('../src/remote-service')

function mockService() {
  const rows = new Map(), store = { list: () => [...rows.values()], get: id => rows.get(id), put: s => rows.set(s.id, { ...s }), remove: id => rows.delete(id) }
  const service = new RemoteService(store); service.configured = async h => h
  return { service, rows }
}
function ready(service, rows, extra = {}) {
  const s = { ...P.newSession({ host: 'macmini', project: '/Users/test/app', tool: 'codex' }), status: 'detached', ...extra }
  rows.set(s.id, s); return s
}

test('companion terminal: one shell per session in its directory, reused while alive, replaced when dead', async () => {
  const { service, rows } = mockService(), s = ready(service, rows, { cwd: '/Users/test/.local/share/ai-hub/worktrees/x', worktree: true })
  const calls = [], alive = new Map()
  service.call = async (host, op, arg) => {
    calls.push(op)
    if (op === 'create') { alive.set(arg.tmux, { dead: false }); return { cwd: arg.project, tmux: arg.tmux } }
    if (op === 'inspect') return alive.get(arg.tmux) || null
    if (op === 'stop') { alive.delete(arg.tmux); return true }
    throw new Error('unexpected ' + op)
  }
  const c = await service.companion(s.id)
  assert.equal(c.companionOf, s.id); assert.equal(c.tool, 'shell'); assert.equal(c.worktree, false)
  assert.equal(c.cwd, s.cwd, 'opens in the session directory (the task worktree)')
  assert.equal(c.host, s.host); assert.match(c.tmux, /^aihub-[a-f0-9]{32}$/)
  assert.equal((await service.companion(s.id)).id, c.id, 'reused while its tmux session is alive')
  alive.get(c.tmux).dead = true
  const next = await service.companion(s.id)
  assert.notEqual(next.id, c.id, 'a shell that exited is replaced')
  assert(!rows.has(c.id) && rows.has(next.id))
  await assert.rejects(service.companion(next.id), /附属终端/)
})

test('ending or forgetting a session ends its companion shell too', async () => {
  const { service, rows } = mockService(), stopped = []
  service.call = async (host, op, arg) => {
    if (op === 'create') return { cwd: arg.project, tmux: arg.tmux }
    if (op === 'inspect') return { dead: false }
    if (op === 'stop') { stopped.push(arg.tmux); return true }
    throw new Error('unexpected ' + op)
  }
  const a = ready(service, rows), ca = await service.companion(a.id)
  await service.stop(a.id)
  assert.deepEqual(stopped, [a.tmux, ca.tmux]); assert(!rows.has(ca.id))
  const b = ready(service, rows), cb = await service.companion(b.id)
  stopped.length = 0
  await service.forget(b.id)
  assert.deepEqual(stopped, [cb.tmux], 'forget keeps the agent but ends the shell Catmux opened for it')
  assert(!rows.has(b.id) && !rows.has(cb.id))
  const stoppedSession = ready(service, rows, { status: 'stopped' })
  await assert.rejects(service.companion(ready(service, rows, { status: 'failed' }).id), /尚未就绪/)
  assert(stoppedSession)
})

function call(home, op, arg) {
  const r = spawnSync('python3', ['-c', REMOTE, op, JSON.stringify(arg)], { env: { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8' } })
  const line = r.stdout.toString().split('\n').find(l => l.startsWith('AIHUB_RESULT:'))
  assert(line, r.stderr.toString())
  const result = JSON.parse(line.slice('AIHUB_RESULT:'.length))
  if (!result.ok) throw new Error(result.error)
  return result.data
}

test('mkdir creates the typed project directory only under the remote home', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-mk-'))); t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const r = call(home, 'mkdir', { path: '~/workspace/new-app' })
  assert.equal(r.path, path.join(home, 'workspace/new-app')); assert(fs.statSync(r.path).isDirectory())
  assert.throws(() => call(home, 'mkdir', { path: '~/workspace/new-app' }), /已存在/)
  assert.throws(() => call(home, 'mkdir', { path: '~' }), /已存在/)
  assert.throws(() => call(home, 'mkdir', { path: path.join(os.tmpdir(), 'aihub-outside-' + crypto.randomUUID()) }), /主目录/)
  assert.throws(() => call(home, 'mkdir', { path: '~/.ssh/x' }), /受保护|凭据/)
  assert.throws(() => call(home, 'mkdir', { path: '~/work/secrets' }), /凭据/)
  assert.throws(() => call(home, 'mkdir', { path: '~/a/../../etc-x' }), /主目录/)
  fs.writeFileSync(path.join(home, 'file'), 'x')
  assert.throws(() => call(home, 'mkdir', { path: '~/file/sub' }))
})

test('mkdir-in creates one folder inside the browsed root, never outside or over an entry', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-mk-'))); t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, 'proj'); fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  assert.equal(call(home, 'mkdir-in', { cwd: root, path: 'src', name: 'utils' }).path, 'src/utils')
  assert(fs.statSync(path.join(root, 'src/utils')).isDirectory())
  assert.equal(call(home, 'mkdir-in', { cwd: root, path: '', name: '新 目录' }).path, '新 目录')
  assert.throws(() => call(home, 'mkdir-in', { cwd: root, path: 'src', name: 'utils' }), /已存在/)
  for (const name of ['..', '.', 'a/b', '', '.env', 'id_rsa']) assert.throws(() => call(home, 'mkdir-in', { cwd: root, path: '', name }), /无效|凭据/, name)
  assert.throws(() => call(home, 'mkdir-in', { cwd: root, path: '../', name: 'x' }), /越界/)
  fs.symlinkSync(home, path.join(root, 'up'))
  assert.throws(() => call(home, 'mkdir-in', { cwd: root, path: 'up', name: 'x' }))
  assert(!fs.existsSync(path.join(home, 'x')))
})

const tmux = binary('tmux')
test('agents start in a plain (non-Git) directory without a worktree; a worktree still needs Git', { skip: !tmux }, () => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-plain-')))
  const bin = path.join(fixture, 'bin'), project = path.join(fixture, 'notes'); fs.mkdirSync(bin); fs.mkdirSync(project)
  // Stand-in for the official CLI: just stays alive. Never a real agent.
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
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
  const create = worktree => {
    const id = crypto.randomUUID().replaceAll('-', '')
    const s = { id, tmux: 'aihub-' + id, project, tool: 'codex', mode: 'direct', worktree, launch: { args: [] } }
    const r = spawnSync('python3', ['-c', wrapper, tmux, socket, JSON.stringify(s)], { env, encoding: 'utf8', input: REMOTE, timeout: 10000 })
    return JSON.parse(r.stdout.split('\n').find(l => l.startsWith('AIHUB_RESULT:')).slice(13))
  }
  try {
    const plain = create(false)
    assert.equal(plain.ok, true, plain.error); assert.equal(plain.data.cwd, project); assert.equal(plain.data.branch, null)
    assert.equal(command(['display-message', '-p', '-t', '=' + plain.data.tmux + ':', '#{pane_current_path}']).stdout.trim(), project)
    const isolated = create(true)
    assert.equal(isolated.ok, false); assert.match(isolated.error, /不是 git 仓库/); assert.match(isolated.error, /取消勾选/)
    assert(!fs.existsSync(path.join(project, '.git')), 'never runs git init')
  } finally {
    command(['kill-server'])
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

test('after a reboot (tmux gone) a session is rebuilt in its directory and the CLI resumes its conversation', { skip: !tmux }, async () => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-revive-')))
  const bin = path.join(fixture, 'bin'), project = path.join(fixture, 'app'), log = path.join(fixture, 'argv.log'); fs.mkdirSync(bin); fs.mkdirSync(project)
  // Stand-ins for the official CLIs: record argv; "nothing to resume" fails at once.
  for (const tool of ['claude', 'codex']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> ${log}\ncase " $* " in *" --continue "*|*" resume "*) [ -f ${fixture}/has-${tool} ] || exit 1;; esac\nexec sleep 30\n`, { mode: 0o755 })
  const socket = 'aihub-test-' + crypto.randomUUID().replaceAll('-', '')
  const env = { PATH: bin + ':' + process.env.PATH, HOME: fixture, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }
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
exec(compile(source,'real-revive-protocol','exec'))
`
  const call = (op, s) => {
    const r = spawnSync('python3', ['-c', wrapper, tmux, socket, op, JSON.stringify(s)], { env, encoding: 'utf8', input: REMOTE, timeout: 10000 })
    return JSON.parse(r.stdout.split('\n').find(l => l.startsWith('AIHUB_RESULT:')).slice(13))
  }
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  const until = async (fn, what) => { for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 100)) } assert.fail(what + '\n' + lines().join('\n')) }
  const session = (tool, worktree = false) => ({ ...P.newSession({ host: 'macmini', project, tool, preset: 'full' }), worktree, status: 'detached' })
  try {
    const claude = session('claude'), sid = claude.agentSession
    assert.match(sid, /^[0-9a-f-]{36}$/)
    assert.equal(call('create', claude).ok, true)
    await until(() => lines().length === 1, 'claude started')
    assert.equal(lines()[0], `claude --dangerously-skip-permissions --session-id ${sid}`)
    assert.match(call('revive', claude).error, /仍在运行/)
    command(['kill-server']) // the reboot
    fs.writeFileSync(path.join(fixture, 'has-claude'), '')
    const revived = call('revive', claude)
    assert.equal(revived.ok, true, revived.error); assert.equal(revived.data.resumed, true)
    await until(() => lines().length === 2, 'claude resumed')
    assert.equal(lines()[1], `claude --dangerously-skip-permissions --resume ${sid}`)
    assert.equal(command(['display-message', '-p', '-t', '=' + claude.tmux + ':', '#{pane_current_path}']).stdout.trim(), project)
    // A worktree session owns its directory: the latest conversation there (follows /clear).
    const codex = session('codex', true); fs.writeFileSync(path.join(fixture, 'has-codex'), '')
    const tree = { ...codex, worktree: false }
    assert.equal(call('create', tree).ok, true)
    command(['kill-server'])
    assert.equal(call('revive', codex).ok, true)
    await until(() => lines().some(l => l === 'codex resume --last --dangerously-bypass-approvals-and-sandbox'), 'codex resumed')
    // Nothing to resume yet: a fresh agent starts in the same tmux session.
    fs.rmSync(path.join(fixture, 'has-claude'))
    command(['kill-server']); fs.rmSync(log)
    assert.equal(call('revive', { ...claude, worktree: true }).ok, true)
    await until(() => lines().length === 2, 'fresh claude after failed resume')
    assert.deepEqual(lines(), ['claude --dangerously-skip-permissions --continue', `claude --dangerously-skip-permissions --session-id ${sid}`])
    // Only Catmux's own records, and only when the directory still exists.
    assert.match(call('revive', { ...claude, owned: false }).error, /只能恢复/)
    command(['kill-server'])
    assert.match(call('revive', { ...claude, cwd: path.join(fixture, 'gone') }).error, /目录已不存在/)
  } finally {
    command(['kill-server'])
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})
