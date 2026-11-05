'use strict'
// Task lifecycle against REAL git (bare origin + project + linked worktree) and a
// fake `gh` whose PR list we control. Runs the exact remote Python locally.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { REMOTE } = require('../src/remote-service')

function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-task-')))
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  const run = (cwd, ...args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, args.join(' ') + '\n' + r.stderr); return r.stdout.trim() }
  const origin = path.join(home, 'origin.git'), project = path.join(home, 'project')
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env })
  spawnSync('git', ['init', '-q', '-b', 'main', project], { env })
  fs.writeFileSync(path.join(project, 'README.md'), 'hi\n'); run(project, 'add', '.'); run(project, 'commit', '-qm', 'init')
  run(project, 'remote', 'add', 'origin', origin); run(project, 'push', '-q', 'origin', 'main')
  run(project, 'checkout', '-qb', 'develop'); fs.writeFileSync(path.join(project, 'dev.txt'), 'dev\n'); run(project, 'add', '.'); run(project, 'commit', '-qm', 'dev work')
  run(project, 'push', '-q', 'origin', 'develop'); run(project, 'checkout', '-q', 'main')
  // Pretend origin is GitHub; insteadOf makes pushes go to the local bare repo.
  const remoteUrl = url => { run(project, 'remote', 'set-url', 'origin', url); run(project, 'config', `url.${origin}.insteadOf`, url) }
  remoteUrl('https://github.com/test/repo.git')
  const id = crypto.randomBytes(16).toString('hex'), branch = 'aihub/' + id
  const wt = path.join(home, '.local/share/ai-hub/worktrees', id)
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  run(project, 'worktree', 'add', '-q', '-b', branch, wt, 'develop')
  const bin = path.join(home, 'bin'), state = path.join(home, 'gh-state'); fs.mkdirSync(bin); fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, 'prs.json'), '[]')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "pr list") cat "${state}/prs.json" ;;
  "pr create") printf '%s\\n' "$@" > "${state}/create-args"; echo "https://github.com/test/repo/pull/7" ;;
  *) echo "unsupported: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  const call = (op, arg, extraPath = bin) => {
    const r = spawnSync('python3', ['-c', REMOTE, op, JSON.stringify(arg)], { env: { ...env, PATH: extraPath + ':' + process.env.PATH, LANG: 'en_US.UTF-8' } })
    const line = r.stdout.toString().split('\n').find(l => l.startsWith('AIHUB_RESULT:')); assert(line, r.stderr.toString())
    const result = JSON.parse(line.slice(13)); if (!result.ok) throw new Error(result.error); return result.data
  }
  const prs = list => fs.writeFileSync(path.join(state, 'prs.json'), JSON.stringify(list))
  const commitInWorktree = (file, text) => { fs.writeFileSync(path.join(wt, file), text); run(wt, 'add', '.'); run(wt, 'commit', '-qm', 'agent: ' + file); return run(wt, 'rev-parse', 'HEAD') }
  const arg = extra => ({ id, tmux: 'aihub-' + id, project, target: 'develop', ...extra })
  return { remoteUrl, home, origin, project, id, branch, wt, run, call, prs, commitInWorktree, arg, state, bin, rm: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('branches lists local + remote branches and the current one', t => {
  const f = setup(); t.after(f.rm)
  const r = f.call('branches', { project: f.project })
  assert.equal(r.current, 'main')
  assert(r.local.some(b => b.name === 'develop') && r.remote.some(b => b.name === 'origin/develop'))
  assert(!r.remote.some(b => b.name.endsWith('/HEAD')))
})

test('status: ahead / dirty / unpushed; not cleanable without a MERGED PR', t => {
  const f = setup(); t.after(f.rm)
  let st = f.call('task-status', f.arg())
  assert.equal(st.ahead, 0); assert.equal(st.dirtyCount, 0); assert.equal(st.cleanable, true, 'no own commits and clean → safe')
  f.commitInWorktree('feature.txt', 'x\n')
  fs.writeFileSync(path.join(f.wt, 'scratch.tmp'), 'untracked')
  st = f.call('task-status', f.arg())
  assert.equal(st.ahead, 1); assert.equal(st.unpushed, 1); assert.equal(st.pushed, false); assert.equal(st.dirtyCount, 1)
  assert.equal(st.targetRef, 'refs/remotes/origin/develop')
  assert.equal(st.cleanable, false)
  assert(st.reasons.some(r => r.includes('未提交')), st.reasons)
  assert(st.reasons.some(r => r.includes('MERGED')), st.reasons)
})

test('clean is blocked with reasons, then allowed once gh reports a squash-MERGED PR', t => {
  const f = setup(); t.after(f.rm)
  const head = f.commitInWorktree('feature.txt', 'x\n')
  assert.throws(() => f.call('task-clean', f.arg()), e => e.message.startsWith('BLOCKED:') && JSON.parse(e.message.slice(8)).some(r => r.includes('MERGED')))
  assert(fs.existsSync(f.wt), 'nothing removed while blocked')
  f.prs([{ number: 3, state: 'OPEN', url: 'u', headRefOid: head, baseRefName: 'develop', title: 't' }])
  assert(f.call('task-status', f.arg()).reasons.some(r => r.includes('OPEN')))
  // Squash merge: GitHub says MERGED although the commit is not in develop.
  f.prs([{ number: 3, state: 'MERGED', url: 'u', headRefOid: head, baseRefName: 'develop', title: 't' }])
  const st = f.call('task-status', f.arg())
  assert.equal(st.cleanable, true, st.reasons); assert.equal(st.mergedPr.number, 3)
  const r = f.call('task-clean', f.arg())
  assert.equal(r.removedWorktree, true); assert.equal(r.deletedBranch, true)
  assert(!fs.existsSync(f.wt))
  assert.equal(spawnSync('git', ['-C', f.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + f.branch]).status, 1, 'local branch deleted')
  assert.equal(f.run(f.project, 'branch', '--show-current'), 'main', 'main repository untouched')
})

test('clean refuses after-merge commits, uncommitted changes, and other task branches', t => {
  const f = setup(); t.after(f.rm)
  const head = f.commitInWorktree('feature.txt', 'x\n')
  f.prs([{ number: 4, state: 'MERGED', url: 'u', headRefOid: head, baseRefName: 'develop', title: 't' }])
  f.commitInWorktree('later.txt', 'after merge\n')
  assert(f.call('task-status', f.arg()).reasons.some(r => r.includes('合并后')))
  fs.writeFileSync(path.join(f.wt, 'README.md'), 'edited\n')
  const st = f.call('task-status', f.arg())
  assert.equal(st.reasons.length, 2)
  assert.throws(() => f.call('task-clean', f.arg({ tmux: 'someone-else' })), /只处理 Catmux/)
  assert.throws(() => f.call('task-clean', f.arg({ id: 'nope' })), /任务 ID/)
  assert(fs.existsSync(f.wt))
})

test('push + PR: dirty worktree needs explicit consent; pushes without force; gh gets --base develop', t => {
  const f = setup(); t.after(f.rm)
  assert.throws(() => f.call('task-pr', f.arg({ title: 'T' })), /没有新提交/)
  f.commitInWorktree('feature.txt', 'x\n')
  fs.writeFileSync(path.join(f.wt, 'wip.txt'), 'not committed')
  assert.throws(() => f.call('task-pr', f.arg({ title: 'T' })), e => e.message.startsWith('DIRTY:') && JSON.parse(e.message.slice(6))[0].includes('wip.txt'))
  assert.equal(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + f.branch]).status, 1, 'nothing pushed yet')
  const r = f.call('task-pr', f.arg({ title: 'Add feature', body: 'body text', allowDirty: true }))
  assert.equal(r.url, 'https://github.com/test/repo/pull/7'); assert.equal(r.created, true)
  assert.equal(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + f.branch]).status, 0, 'branch pushed to origin')
  const args = fs.readFileSync(path.join(f.state, 'create-args'), 'utf8').split('\n')
  assert.deepEqual(args.slice(0, 10), ['pr', 'create', '--base', 'develop', '--head', f.branch, '--title', 'Add feature', '--body', 'body text'])
  assert(fs.existsSync(path.join(f.wt, 'wip.txt')), 'uncommitted file left alone (never auto-committed)')
  f.prs([{ number: 7, state: 'OPEN', url: 'https://github.com/test/repo/pull/7', headRefOid: 'x', baseRefName: 'develop', title: 'Add feature' }])
  fs.rmSync(path.join(f.state, 'create-args'))
  const again = f.call('task-pr', f.arg({ title: 'Add feature', allowDirty: true }))
  assert.equal(again.created, false); assert(!fs.existsSync(path.join(f.state, 'create-args')), 'existing open PR is reused')
})

test('missing gh or target branch gives clear reasons instead of errors', t => {
  const f = setup(); t.after(f.rm)
  f.commitInWorktree('feature.txt', 'x\n')
  const noGh = f.call('task-status', f.arg(), '/usr/bin:/bin')
  assert(noGh.reasons.some(r => r.includes('gh')), noGh.reasons)
  const noTarget = f.call('task-status', f.arg({ target: 'release' }))
  assert(noTarget.reasons.some(r => r.includes('release')), noTarget.reasons)
  assert.throws(() => f.call('task-status', f.arg({ target: '../evil' })), /分支名无效/)
})

test('unmounted disk: clear message for the main repo and for a worktree pointing at it', t => {
  const f = setup(); t.after(f.rm)
  const gone = '/Volumes/aihub-test-unmounted-' + crypto.randomBytes(4).toString('hex')
  assert.throws(() => f.call('branches', { project: gone + '/repo' }), e => e.message.startsWith('MOUNT:') && e.message.includes(gone))
  assert.throws(() => f.call('task-status', f.arg({ project: gone + '/repo' })), /^Error: MOUNT:/)
  const orphan = path.join(f.home, 'orphan-wt'); fs.mkdirSync(orphan)
  fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${gone}/repo/.git/worktrees/x\n`)
  assert.throws(() => f.call('git', { cwd: orphan }), e => e.message.startsWith('MOUNT:') && e.message.includes('未挂载'))
})

test('without GitHub: squash-merged locally into develop is detected by git and can be cleaned', t => {
  const f = setup(); t.after(f.rm)
  f.remoteUrl('git@gitee.com:test/repo.git')
  f.commitInWorktree('feature.txt', 'feature\n'); f.commitInWorktree('more.txt', 'more\n')
  let st = f.call('task-status', f.arg())
  assert.equal(st.origin.github, false); assert.equal(st.origin.host, 'gitee.com')
  assert.equal(st.contentMerged, false); assert.equal(st.cleanable, false)
  assert(st.reasons[0].includes('gitee.com'), st.reasons)
  // Squash-merge on the local develop, push develop: origin/develop now has the content.
  f.run(f.project, 'checkout', '-q', 'develop'); f.run(f.project, 'merge', '-q', '--squash', f.branch); f.run(f.project, 'commit', '-qm', 'squash: task')
  f.run(f.project, 'push', '-q', 'origin', 'develop'); f.run(f.project, 'fetch', '-q', 'origin'); f.run(f.project, 'checkout', '-q', 'main')
  const objects = () => spawnSync('git', ['-C', f.project, 'count-objects', '-v'], { encoding: 'utf8' }).stdout
  const before = objects()
  st = f.call('task-status', f.arg())
  assert.equal(st.contentMerged, true); assert.equal(st.cleanable, true, st.reasons)
  assert.equal(objects(), before, 'the merge check writes no objects into the repository')
  const r = f.call('task-clean', f.arg())
  assert.equal(r.removedWorktree, true); assert.equal(r.deletedBranch, true)
})

test('no remote at all: a plain local merge is enough (commits stay in develop history, even if later reverted)', t => {
  const f = setup(); t.after(f.rm)
  f.run(f.project, 'remote', 'remove', 'origin')
  f.commitInWorktree('feature.txt', 'feature\n')
  const st = f.call('task-status', f.arg())
  assert.equal(st.targetRef, 'refs/heads/develop', 'falls back to the local target branch')
  assert(st.reasons[0].includes('没有 origin'), st.reasons)
  assert.throws(() => f.call('task-pr', f.arg({ title: 'x', pushOnly: true })), /没有 origin/)
  f.run(f.project, 'checkout', '-q', 'develop'); f.run(f.project, 'merge', '-q', '--no-ff', '-m', 'merge task', f.branch)
  assert.equal(f.call('task-status', f.arg()).cleanable, true)
  // Reverting a real merge keeps the commits reachable from develop: deleting the branch loses nothing.
  f.run(f.project, 'revert', '--no-edit', '-m', '1', 'HEAD'); f.run(f.project, 'checkout', '-q', 'main')
  assert.equal(f.call('task-status', f.arg()).cleanable, true)
})

test('squash-merged then reverted: the work exists nowhere else, so clean stays blocked', t => {
  const f = setup(); t.after(f.rm)
  f.run(f.project, 'remote', 'remove', 'origin')
  f.commitInWorktree('feature.txt', 'feature\n')
  f.run(f.project, 'checkout', '-q', 'develop'); f.run(f.project, 'merge', '-q', '--squash', f.branch); f.run(f.project, 'commit', '-qm', 'squash')
  assert.equal(f.call('task-status', f.arg()).contentMerged, true)
  f.run(f.project, 'revert', '--no-edit', 'HEAD'); f.run(f.project, 'checkout', '-q', 'main')
  const st = f.call('task-status', f.arg())
  assert.equal(st.contentMerged, false); assert.equal(st.cleanable, false, 'would lose the only copy of the work')
  assert.throws(() => f.call('task-clean', f.arg()), /^Error: BLOCKED:/)
  assert(fs.existsSync(f.wt))
})

test('non-GitHub remote: PR needs explicit push-only; pushes without gh', t => {
  const f = setup(); t.after(f.rm)
  f.remoteUrl('https://gitlab.example.com/test/repo.git')
  f.commitInWorktree('feature.txt', 'feature\n')
  assert.throws(() => f.call('task-pr', f.arg({ title: 'T' })), e => e.message.startsWith('NOGH:') && e.message.includes('gitlab.example.com'))
  const r = f.call('task-pr', f.arg({ title: 'T', pushOnly: true }))
  assert.equal(r.pushed, true); assert.equal(r.pushOnly, true); assert.equal(r.remote, 'gitlab.example.com')
  assert.equal(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + f.branch]).status, 0)
  assert(!fs.existsSync(path.join(f.state, 'create-args')), 'gh is not used for non-GitHub remotes')
})
