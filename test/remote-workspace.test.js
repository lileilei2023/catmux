'use strict'
// Runs the exact remote Python protocol locally against a temporary HOME and
// git repository. No SSH, no Mini, no user files.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { REMOTE } = require('../src/remote-service')

const sha = data => crypto.createHash('sha256').update(data).digest('hex')
function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-ws-')))
  const repo = path.join(home, 'project')
  fs.mkdirSync(path.join(repo, 'src/deep'), { recursive: true })
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(r.status, 0, r.stderr); return r.stdout }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\nworld\n')
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'const a = 1\n')
  fs.writeFileSync(path.join(repo, 'src/deep/old.txt'), 'old\n')
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return { home, repo, git, rm: () => fs.rmSync(home, { recursive: true, force: true }) }
}
function call(home, op, arg, input, extraEnv = {}) {
  const r = spawnSync('python3', ['-c', REMOTE, op, JSON.stringify(arg)], { input, env: { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', ...extraEnv } })
  const line = r.stdout.toString().split('\n').find(l => l.startsWith('AIHUB_RESULT:'))
  assert(line, r.stderr.toString())
  const result = JSON.parse(line.slice('AIHUB_RESULT:'.length))
  if (!result.ok) throw new Error(result.error)
  return result.data
}

test('file listing hides credentials, git internals and symlinks; directories first', t => {
  const f = setup(); t.after(f.rm)
  fs.writeFileSync(path.join(f.repo, '.env.local'), 'X=1'); fs.writeFileSync(path.join(f.repo, 'api_token.txt'), 'x')
  fs.symlinkSync('/etc', path.join(f.repo, 'link'))
  const r = call(f.home, 'files', { cwd: f.repo, path: '' })
  assert.deepEqual(r.entries.map(e => e.name), ['src', 'gone.txt', 'README.md'])
  assert.equal(r.entries[0].directory, true)
  assert.deepEqual(call(f.home, 'files', { cwd: f.repo, path: 'src' }).entries.map(e => e.path), ['src/deep', 'src/app.js'])
  for (const bad of ['../', 'src/../..', '/etc', 'link', '.git', '.env.local']) assert.throws(() => call(f.home, 'files', { cwd: f.repo, path: bad }))
})

test('session roots under Catmux worktrees are allowed; credential homes and private stores are not', t => {
  const f = setup(); t.after(f.rm)
  const wt = path.join(f.home, '.local/share/ai-hub/worktrees/abc')
  fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'a.txt'), 'a')
  assert.deepEqual(call(f.home, 'files', { cwd: wt, path: '' }).entries.map(e => e.name), ['a.txt'])
  for (const dir of ['.ssh', '.codex', '.claude', '.config/gh', '.local/share/ai-hub/file-backups', '.local/share/ai-hub/uploads']) {
    fs.mkdirSync(path.join(f.home, dir), { recursive: true })
    assert.throws(() => call(f.home, 'files', { cwd: path.join(f.home, dir), path: '' }), /受保护/)
  }
  const homeList = call(f.home, 'files', { cwd: f.home, path: '' }).entries.map(e => e.name)
  assert(homeList.includes('project') && !homeList.includes('.ssh') && !homeList.includes('.codex'), 'home is browsable without credential homes')
  assert.throws(() => call(f.home, 'files', { cwd: '/', path: '' }), /受保护/)
})

test('read-file returns UTF-8 text with hash; binary, large and non-UTF-8 files are refused', t => {
  const f = setup(); t.after(f.rm)
  fs.writeFileSync(path.join(f.repo, 'zh.md'), '中文\n')
  const r = call(f.home, 'read-file', { cwd: f.repo, path: 'zh.md' })
  assert.equal(r.content, '中文\n'); assert.equal(r.sha256, sha('中文\n'))
  fs.writeFileSync(path.join(f.repo, 'bin.dat'), Buffer.from([1, 0, 2]))
  fs.writeFileSync(path.join(f.repo, 'big.txt'), 'x'.repeat(262145))
  fs.writeFileSync(path.join(f.repo, 'latin.txt'), Buffer.from([0xe9, 0x0a]))
  assert.throws(() => call(f.home, 'read-file', { cwd: f.repo, path: 'bin.dat' }), /二进制/)
  assert.throws(() => call(f.home, 'read-file', { cwd: f.repo, path: 'big.txt' }), /256 KiB/)
  assert.throws(() => call(f.home, 'read-file', { cwd: f.repo, path: 'latin.txt' }), /UTF-8/)
  fs.linkSync(path.join(f.repo, 'zh.md'), path.join(f.repo, 'hard.md'))
  assert.throws(() => call(f.home, 'read-file', { cwd: f.repo, path: 'hard.md' }), /普通文件/)
})

test('save-file is hash-checked, preserves mode and writes a private backup', t => {
  const f = setup(); t.after(f.rm)
  const file = path.join(f.repo, 'src/app.js'); fs.chmodSync(file, 0o755)
  const before = fs.readFileSync(file)
  const r = call(f.home, 'save-file', { id: 'a'.repeat(32), cwd: f.repo, path: 'src/app.js', sha256: sha(before) }, 'const a = 2\n')
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 2\n'); assert.equal(r.sha256, sha('const a = 2\n'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o755)
  assert.equal(fs.readFileSync(r.backup, 'utf8'), before.toString())
  assert.equal(fs.statSync(r.backup).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(r.backup)).mode & 0o777, 0o700)
  assert(!r.backup.startsWith(f.repo), 'backup must stay outside the project')
  assert.deepEqual(fs.readdirSync(path.join(f.repo, 'src')).sort(), ['app.js', 'deep'], 'no temp files left behind')
  // A stale hash (agent changed the file meanwhile) is a conflict, never an overwrite.
  assert.throws(() => call(f.home, 'save-file', { id: 'a'.repeat(32), cwd: f.repo, path: 'src/app.js', sha256: sha(before) }, 'mine\n'), /^Error: CONFLICT:/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 2\n')
  assert.throws(() => call(f.home, 'save-file', { id: 'a'.repeat(32), cwd: f.repo, path: 'src/app.js', sha256: r.sha256 }, Buffer.from([0, 1])))
})

test('git changes cover staged, unstaged, untracked-in-subdir, deletes and renames with line stats', t => {
  const f = setup(); t.after(f.rm)
  fs.appendFileSync(path.join(f.repo, 'README.md'), 'more\n')
  fs.writeFileSync(path.join(f.repo, 'src/app.js'), 'const a = 3\nconst b = 4\n'); f.git('add', 'src/app.js')
  fs.mkdirSync(path.join(f.repo, 'src/new')); fs.writeFileSync(path.join(f.repo, 'src/new/n.txt'), 'n1\nn2\n')
  fs.unlinkSync(path.join(f.repo, 'gone.txt'))
  f.git('mv', 'src/deep/old.txt', 'src/deep/renamed.txt')
  fs.writeFileSync(path.join(f.repo, '.env'), 'SECRET=1')
  const g = call(f.home, 'git', { cwd: f.repo })
  assert.equal(g.branch, 'main'); assert.match(g.head, /^[0-9a-f]{7,}$/)
  const by = Object.fromEntries(g.changes.map(c => [c.path, c]))
  assert.equal(by['README.md'].status, ' M'); assert.equal(by['README.md'].added, 1); assert.equal(by['README.md'].unstaged, true)
  assert.equal(by['src/app.js'].staged, true); assert.equal(by['src/app.js'].stagedAdded, 2); assert.equal(by['src/app.js'].stagedDeleted, 1)
  assert.equal(by['src/new/n.txt'].status, '??')
  assert.equal(by['gone.txt'].status, ' D')
  assert.equal(by['src/deep/renamed.txt'].status[0], 'R'); assert.equal(by['src/deep/renamed.txt'].original, 'src/deep/old.txt')
  assert(!by['.env'], 'credential files never appear')

  const w = call(f.home, 'diff', { cwd: f.repo, path: 'README.md', staged: false })
  assert.match(w.patch, /^\+more$/m)
  const s = call(f.home, 'diff', { cwd: f.repo, path: 'src/app.js', staged: true })
  assert.match(s.patch, /^-const a = 1$/m); assert.match(s.patch, /^\+const b = 4$/m)
  assert.equal(call(f.home, 'diff', { cwd: f.repo, path: 'src/app.js', staged: false }).patch, '')
  const u = call(f.home, 'diff', { cwd: f.repo, path: 'src/new/n.txt', staged: false })
  assert.equal(u.untracked, true); assert.match(u.patch, /^\+n2$/m)
  assert.match(call(f.home, 'diff', { cwd: f.repo, path: 'gone.txt', staged: false }).patch, /^-bye$/m)
  assert.throws(() => call(f.home, 'diff', { cwd: f.repo, path: '.env', staged: false }))
})

test('git paths are relative to a session subdirectory and exclude changes outside it', t => {
  const f = setup(); t.after(f.rm)
  fs.appendFileSync(path.join(f.repo, 'README.md'), 'outside\n')
  fs.appendFileSync(path.join(f.repo, 'src/app.js'), 'inside\n')
  const g = call(f.home, 'git', { cwd: path.join(f.repo, 'src') })
  assert.deepEqual(g.changes.map(c => c.path), ['app.js'])
  assert.match(call(f.home, 'diff', { cwd: path.join(f.repo, 'src'), path: 'app.js', staged: false }).patch, /^\+inside$/m)
})

test('non-git directories report clearly and are never initialised', t => {
  const f = setup(); t.after(f.rm)
  const plain = path.join(f.home, 'plain'); fs.mkdirSync(plain)
  assert.throws(() => call(f.home, 'git', { cwd: plain }), /git/)
  assert(!fs.existsSync(path.join(plain, '.git')))
})

test('batched tree returns every requested directory plus git status in one call', t => {
  const f = setup(); t.after(f.rm)
  fs.appendFileSync(path.join(f.repo, 'src/app.js'), 'x\n')
  const r = call(f.home, 'tree', { cwd: f.repo + '/.', paths: ['', 'src', 'src/deep', 'nope'], git: true })
  assert.equal(r.root, f.repo, 'root is canonical (no trailing /.)')
  assert.deepEqual(r.dirs[''].entries.map(e => e.name), ['src', 'gone.txt', 'README.md'])
  assert.deepEqual(r.dirs['src/deep'].entries.map(e => e.name), ['old.txt'])
  assert.equal(r.dirs.nope.missing, true)
  assert.deepEqual(r.git.changes.map(c => c.path), ['src/app.js'])
  assert.match(call(f.home, 'tree', { cwd: f.repo, paths: ['../x'], git: false }).dirs['../x'].error, /越界/, 'traversal is refused per directory')
  const plain = path.join(f.home, 'plain'); fs.mkdirSync(plain)
  const p = call(f.home, 'tree', { cwd: plain, paths: [''], git: true })
  assert.match(p.gitError, /git/); assert.deepEqual(p.dirs[''].entries, [])
})

test('read-image returns verified bytes for real images and refuses mislabeled / oversized files', t => {
  const f = setup(); t.after(f.rm)
  const png = fs.readFileSync(path.join(__dirname, 'fixtures/upload-test.png'))
  fs.writeFileSync(path.join(f.repo, 'shot.png'), png)
  const r = call(f.home, 'read-image', { cwd: f.repo, path: 'shot.png' })
  assert.equal(r.mime, 'image/png'); assert.equal(r.size, png.length)
  assert.equal(Buffer.from(r.data, 'base64').equals(png), true); assert.equal(r.sha256, sha(png))
  fs.writeFileSync(path.join(f.repo, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  assert.equal(call(f.home, 'read-image', { cwd: f.repo, path: 'logo.svg' }).mime, 'image/svg+xml')
  fs.writeFileSync(path.join(f.repo, 'fake.png'), 'not a png')
  assert.throws(() => call(f.home, 'read-image', { cwd: f.repo, path: 'fake.png' }), /不符/)
  assert.throws(() => call(f.home, 'read-image', { cwd: f.repo, path: 'README.md' }), /图片格式/)
  fs.writeFileSync(path.join(f.repo, 'huge.png'), Buffer.concat([png.subarray(0, 8), Buffer.alloc(8 * 1024 * 1024)]))
  assert.throws(() => call(f.home, 'read-image', { cwd: f.repo, path: 'huge.png' }), /8 MiB/)
})

test('pane root follows the session tmux pane directory, resolved on the server', t => {
  const f = setup(); t.after(f.rm)
  const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-tmux-')), env = { ...process.env, TMUX_TMPDIR: tmuxDir }
  delete env.TMUX
  const name = 'aihub-' + 'b'.repeat(32)
  const started = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', path.join(f.repo, 'src'), 'sleep 30'], { env })
  if (started.status !== 0) { t.skip('tmux unavailable: ' + started.stderr); return }
  t.after(() => { spawnSync('tmux', ['kill-server'], { env }); fs.rmSync(tmuxDir, { recursive: true, force: true }) })
  const r = call(f.home, 'files', { cwd: f.repo, pane: name, path: '' }, null, { TMUX_TMPDIR: tmuxDir })
  assert.equal(r.root, path.join(f.repo, 'src'))
  assert.deepEqual(r.entries.map(e => e.name), ['deep', 'app.js'])
  assert.throws(() => call(f.home, 'files', { cwd: f.repo, pane: 'aihub-missing', path: '' }, null, { TMUX_TMPDIR: tmuxDir }), /终端当前目录/)
})

test('path-exists reports metadata only for pasted-path checks', t => {
  const f = setup(); t.after(f.rm)
  assert.deepEqual(call(f.home, 'path-exists', { path: '~/project/README.md' }), { exists: true, file: true })
  assert.deepEqual(call(f.home, 'path-exists', { path: '/definitely/not/here.png' }), { exists: false, file: false })
})

test('list-dirs completes directories with ~ expansion, git flags and protected homes skipped', t => {
  const f = setup(); t.after(f.rm)
  for (const d of ['workspace/alpha', 'workspace/beta', 'workspace/.hidden', '.ssh', '.codex', 'notes_token_dir']) fs.mkdirSync(path.join(f.home, d), { recursive: true })
  fs.mkdirSync(path.join(f.home, 'workspace/alpha/.git'))
  fs.writeFileSync(path.join(f.home, 'workspace/file.txt'), 'x')
  const home = call(f.home, 'list-dirs', { path: '~' })
  assert.equal(home.home, f.home); assert.equal(home.dir, f.home)
  const names = home.entries.map(e => e.name)
  assert(names.includes('workspace') && names.includes('project'))
  for (const hidden of ['.ssh', '.codex', 'notes_token_dir']) assert(!names.includes(hidden), hidden + ' must not be offered')
  const ws = call(f.home, 'list-dirs', { path: '~/workspace' })
  assert.equal(ws.dir, path.join(f.home, 'workspace'))
  assert.deepEqual(ws.entries.map(e => [e.name, e.git, e.hidden]), [['alpha', true, false], ['beta', false, false], ['.hidden', false, true]])
  assert.equal(call(f.home, 'list-dirs', { path: '~/workspace/alpha' }).git, true)
  assert.equal(call(f.home, 'list-dirs', { path: '~/nope' }).exists, false)
  assert.equal(call(f.home, 'list-dirs', { path: f.home + '/workspace/' }).entries.length, 3)
  assert.throws(() => call(f.home, 'list-dirs', { path: '~/.ssh' }), /受保护/)
  assert.throws(() => call(f.home, 'list-dirs', { path: '~root' }), /~/)
  assert.throws(() => call(f.home, 'list-dirs', { path: 'relative' }))
})

test('deep tree preloads the whole structure in one call; dependency dirs stay lazy', t => {
  const f = setup(); t.after(f.rm)
  fs.mkdirSync(path.join(f.repo, 'node_modules/pkg'), { recursive: true }); fs.writeFileSync(path.join(f.repo, 'node_modules/pkg/index.js'), '')
  fs.mkdirSync(path.join(f.repo, 'workspace/inner'), { recursive: true })
  const r = call(f.home, 'tree', { cwd: f.repo, paths: [''], git: false, deep: true })
  assert.equal(r.deep.complete, true)
  assert.deepEqual(Object.keys(r.dirs).sort(), ['', 'src', 'src/deep', 'workspace', 'workspace/inner'])
  assert(r.dirs[''].entries.some(e => e.name === 'node_modules'), 'heavy dirs are listed')
  assert.deepEqual(r.deep.lazy, ['node_modules'], 'but not descended')
  assert.equal(r.root, f.repo, 'a child folder named "workspace" does not change the root')
  const shallow = call(f.home, 'tree', { cwd: f.repo, paths: [''], git: false })
  assert.deepEqual(Object.keys(shallow.dirs), ['']); assert.equal(shallow.deep, undefined)
})
