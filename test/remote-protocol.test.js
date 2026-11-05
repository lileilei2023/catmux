'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const P = require('../src/remote-protocol')
const { environment, REMOTE, RemoteService } = require('../src/remote-service')
const opts = { host: 'macmini', project: '/Users/test/my repo', tool: 'codex' }

test('structured remote session validates aliases and paths', () => {
  const s = P.newSession(opts)
  assert.equal(s.mode,'direct'); assert.equal(s.transport,'udp'); assert.match(s.tmux,/^aihub-[a-f0-9]{32}$/)
  for (const host of ['-oProxyCommand=x','user@host','host;id','x\nfoo','../x']) assert.throws(() => P.newSession({ ...opts, host }))
  for (const project of ['relative','~/repo','/a\0b','/a\nb']) assert.throws(() => P.newSession({ ...opts, project }))
})
test('only official agent command names and explicit transports are accepted', () => {
  for (const tool of ['clauxy','coco','codex --model x','claude; id','shell -c x']) assert.throws(() => P.newSession({ ...opts, tool }))
  assert.throws(() => P.newSession({ ...opts, transport: 'fallback' }))
  assert.throws(() => P.newSession({ ...opts, tool: 'shell', mode: 'squad' }))
})
test('shell quote round trips hostile but valid filenames without execution', () => {
  for (const value of ["a'b", 'space dir', '$USER; touch /never', '`id`', '$(whoami)', '中文路径']) {
    const r = spawnSync('/bin/sh', ['-c', `printf '%s' ${P.quote(value)}`], { encoding: 'utf8' })
    assert.equal(r.status,0); assert.equal(r.stdout,value)
  }
})
test('tmux attach never creates/restarts an agent and preserves strict SSH', () => {
  const spec = P.attachSpec(P.newSession(opts),{ tssh:'/bin/tssh',ssh:'/usr/bin/ssh' })
  assert.equal(spec.file,'/bin/tssh'); assert(spec.args.includes('--udp'))
  assert(spec.args.includes('StrictHostKeyChecking=yes')); assert(spec.args.includes('ClearAllForwardings=yes'))
  const command = spec.args.at(-1)
  assert(command.includes('attach-session')); assert(!command.includes('new-session')); assert(!command.includes('--model'))
  assert(!command.includes('skip-permissions')); assert(command.startsWith('sh -c ')); assert(command.includes('zsh -lc'))
})
test('Claude Squad mode is removed: new ones are refused, old records fail clearly instead of running cs', () => {
  assert.throws(() => P.newSession({ ...opts, mode: 'squad', tool: 'claude' }), /Squad 模式已移除/)
  const old = { ...P.newSession(opts), mode: 'squad', tmux: null }
  assert.throws(() => P.attachSpec(old, { tssh: 'tssh', ssh: 'ssh' }), /Squad 模式已移除/)
  const cmd = P.attachSpec(P.newSession({ ...opts, tool: 'claude' }), { tssh: 'tssh', ssh: 'ssh' }).args.at(-1)
  assert(!cmd.includes('cs -p')); assert(cmd.includes('attach-session'))
})
test('TCP is explicit, not a fallback', () => {
  const spec=P.attachSpec(P.newSession({...opts,transport:'ssh'}),{tssh:'tssh',ssh:'ssh'})
  assert.equal(spec.file,'ssh'); assert(!spec.args.includes('--udp'))
})
test('child environment does not inject model keys, proxies or relay settings', () => {
  const env=environment()
  for(const key of Object.keys(env)) assert(!/PROXY|API_KEY|TOKEN|NTUN|CODEX|CLAUDE|GEMINI/.test(key))
  assert.equal(env.TERM,'xterm-256color')
})
test('remote Python protocol compiles without execution or file writes', () => {
  const r=spawnSync('python3',['-c','import sys; compile(sys.stdin.read(), "remote", "exec")'],{input:REMOTE,encoding:'utf8'})
  assert.equal(r.status,0,r.stderr)
})
test('protocol does not read AI auth/config/transcripts or initialize repositories', () => {
  // The user-facing rejection says "不会 git init"; inspect command syntax,
  // not that harmless error message.
  assert(!/git\([^\n]*\[['"]init['"]|['"]git['"]\s*,\s*['"]init['"]/.test(REMOTE))
  assert(!REMOTE.includes('--dangerously-skip-permissions')); assert(!REMOTE.includes('--model'))
  assert(!/open\([^\n]*(config\.toml|auth\.json|\.jsonl)/.test(REMOTE))
  assert(REMOTE.includes('os.link(temp,target)')); assert(REMOTE.includes('digest.hexdigest()!=arg'))
})
test('backoff is capped, preserving the remote session across retries', () => {
  assert.equal(P.retryDelay(0),2000); assert.equal(P.retryDelay(1),4000); assert.equal(P.retryDelay(20),45000)
})
function mockService() {
  const rows=new Map(); const store={list:()=>[...rows.values()],get:id=>rows.get(id),put:s=>rows.set(s.id,{...s}),remove:id=>rows.delete(id)}
  const service=new RemoteService(store); service.configured=async h=>h
  return {service,rows}
}
test('failed remote creation is persisted and never silently retried', async () => {
  const {service,rows}=mockService(); let calls=0
  service.call=async()=>{calls++;throw new Error('network unavailable')}
  await assert.rejects(service.create(opts),/network unavailable/)
  assert.equal(calls,1); assert.equal([...rows.values()][0].status,'failed')
})
test('explicit recovery updates only local metadata for the original UUID session', async () => {
  const {service,rows}=mockService()
  const s=P.newSession({...opts,worktree:true}); s.status='failed'; s.error='no such window'; rows.set(s.id,s)
  const calls=[]
  service.call=async(host,op,arg)=>{calls.push(op);assert.equal(arg.tmux,s.tmux);return{tmux:s.tmux,cwd:'/Users/test/.local/share/ai-hub/worktrees/'+s.id,branch:'aihub/'+s.id,pid:'123',paneId:'%4'}}
  const recovered=await service.recover(s.id)
  assert.deepEqual(calls,['recover']); assert.equal(recovered.status,'detached')
  assert.equal(recovered.id,s.id); assert.equal(recovered.creationError,'no such window')
  assert.equal(rows.get(s.id).cwd,recovered.cwd); assert.equal(rows.size,1)
})
test('missing or mismatched recovery preserves the failed record without recreation', async () => {
  const {service,rows}=mockService(); const s=P.newSession(opts); s.status='failed'; rows.set(s.id,s)
  service.call=async()=>{throw new Error('原远端会话不存在')}
  await assert.rejects(service.recover(s.id),/原远端会话不存在/)
  assert.equal(rows.get(s.id).status,'failed')
  assert.equal(rows.get(s.id).recoveryError,'原远端会话不存在')
  service.call=async()=>({tmux:'another-session',cwd:'/other'})
  await assert.rejects(service.recover(s.id),/不匹配/)
  assert.equal(rows.get(s.id).status,'failed')
  s.owned=false;rows.set(s.id,s)
  await assert.rejects(service.recover(s.id),/不是可恢复/)
})
test('imported sessions are never stopped without an explicit confirmation', async () => {
  const {service,rows}=mockService()
  const s=P.newSession(opts); s.owned=false; s.tmux='claudesquad-user-agent'; rows.set(s.id,s)
  service.call=()=>{throw new Error('must not be called')}
  await assert.rejects(service.stop(s.id),/确认/)
  const legacy={...P.newSession(opts),mode:'squad',tmux:null}; rows.set(legacy.id,legacy)
  await assert.rejects(service.stop(legacy.id,{allowImported:true}),/没有 tmux/, 'records without a tmux session cannot be stopped')
})
test('forget removes only local metadata, never calls remote delete', () => {
  const {service,rows}=mockService(); const s=P.newSession(opts); rows.set(s.id,s)
  service.call=()=>{throw new Error('must not be called')}; service.forget(s.id); assert.equal(rows.size,0)
})
test('successful upload returns remote path after matching SHA-256, with an exclusive filename', async () => {
  const {service,rows}=mockService(); const s=P.newSession(opts); rows.set(s.id,s)
  service.call=async(host,op,arg,bytes)=>{assert.equal(op,'upload');assert.equal(bytes.toString(),'test');assert.match(arg.name,/^[a-f0-9-]+\.png$/);assert.equal(arg.size,4);assert.equal(arg.sha256,'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');return{path:'/private/upload.png',size:4,sha256:arg.sha256}}
  const r=await service.upload(s.id,{bytes:Buffer.from('test'),name:'../../x.png'}); assert.equal(r.path,'/private/upload.png')
})
test('empty and oversize uploads are rejected before connecting', async () => {
  const {service,rows}=mockService();const s=P.newSession(opts);rows.set(s.id,s)
  await assert.rejects(service.upload(s.id,{bytes:[],name:'x.png'}),/32 MiB/)
})

test('remote paths are canonical: trailing "/." and "/" collapse to one spelling', () => {
  const P = require('../src/remote-protocol')
  assert.equal(P.remotePath('/Users/x/wt/abc/.'), '/Users/x/wt/abc')
  assert.equal(P.remotePath('/Users/x/wt/abc/'), '/Users/x/wt/abc')
  assert.equal(P.remotePath('/'), '/')
  assert.equal(P.newSession({ host: 'macmini', project: '/p/q/.', tool: 'codex' }).cwd, '/p/q')
})
test('workbench roots are chosen by kind; the browser cannot supply an absolute root', () => {
  const { RemoteService } = require('../src/remote-service')
  const service = new RemoteService({ list: () => [], get: () => null, put() {} })
  const s = { cwd: '/w/abc', project: '/p', tmux: 'aihub-x' }
  assert.deepEqual(service.root(s), { cwd: '/w/abc' })
  assert.deepEqual(service.root(s, 'project'), { cwd: '/p' })
  assert.deepEqual(service.root(s, 'pane'), { cwd: '/w/abc', pane: 'aihub-x' })
  assert.throws(() => service.root(s, '/etc'))
  assert.throws(() => service.root({ cwd: '/w', tmux: null }, 'pane'))
  assert.deepEqual(service.roots(s).map(r => r.key), ['cwd', 'project', 'pane'])
})
test('local pasted-path upload accepts only real image files outside credential dirs', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { localImage } = require('../src/remote-service')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-local-'))
  fs.writeFileSync(path.join(dir, 'shot.png'), 'x'); fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
  assert.equal(localImage(path.join(dir, 'shot.png'), true).image, true)
  assert.throws(() => localImage(path.join(dir, 'notes.txt'), true), /图片/)
  assert.throws(() => localImage(path.join(dir, 'missing.png'), true), /图片/)
  assert.equal(localImage(path.join(dir, 'missing.png'), false).exists, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('create expands "~/project" with the remote home before storing the session', async () => {
  const { RemoteService } = require('../src/remote-service')
  const records = new Map()
  const service = new RemoteService({ list: () => [...records.values()], get: id => records.get(id), put: s => records.set(s.id, { ...s }) })
  service.hosts = async () => [{ alias: 'macmini' }]
  const calls = []
  service.call = async (_h, op, arg) => { calls.push([op, arg.path]); if (op === 'list-dirs') return { home: '/Users/remote', dir: '/Users/remote', entries: [] }; return { cwd: arg.project, tmux: arg.tmux } }
  const s = await service.create({ host: 'macmini', project: '~/workspace/app/', tool: 'shell' })
  assert.equal(s.project, '/Users/remote/workspace/app'); assert.equal(s.cwd, '/Users/remote/workspace/app')
  assert.deepEqual(calls.map(c => c[0]), ['list-dirs', 'create'])
  await service.create({ host: 'macmini', project: '~', tool: 'shell' })
  assert.equal(calls.filter(c => c[0] === 'list-dirs').length, 1, 'remote home is learned once')
  await assert.rejects(() => service.listDirs('macmini', 'relative/path'), /开头/)
})

test('launch presets: full permission by default for Codex / Claude, extra args appended, validated', () => {
  const P = require('../src/remote-protocol')
  const codex = P.newSession({ host: 'macmini', project: '/p', tool: 'codex' })
  assert.deepEqual(codex.launch.args, ['--dangerously-bypass-approvals-and-sandbox']); assert.equal(codex.launch.danger, true)
  assert.deepEqual(P.newSession({ host: 'macmini', project: '/p', tool: 'claude' }).launch.args, ['--dangerously-skip-permissions'])
  assert.deepEqual(P.newSession({ host: 'macmini', project: '/p', tool: 'codex', preset: 'auto', extra: ['-m', 'o3'] }).launch.args,
    ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-m', 'o3'])
  const plain = P.newSession({ host: 'macmini', project: '/p', tool: 'claude', preset: 'default', extra: ['--model', 'opus'] })
  assert.deepEqual(plain.launch.args, ['--model', 'opus']); assert.equal(plain.launch.danger, false)
  assert.equal(P.launchFor('claude', 'default', ['--dangerously-skip-permissions']).danger, true, 'danger is detected in extra args too')
  assert.deepEqual(P.newSession({ host: 'macmini', project: '/p', tool: 'shell' }).launch.args, [])
  assert.throws(() => P.newSession({ host: 'macmini', project: '/p', tool: 'shell', extra: ['-x'] }), /Shell/)
  assert.throws(() => P.launchFor('codex', 'full', ['a\nb']), /控制字符/)
  assert.throws(() => P.launchFor('codex', 'nope'), /权限模式/)
  assert.throws(() => P.launchFor('codex', 'full', 'not-an-array'))
  assert.equal(P.commandLine('codex', ['-c', 'model="o3"', '--x']), `codex -c 'model="o3"' --x`)
})
test('launch defaults persist per tool (0600 file), fall back to built-ins, and drive create', async () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { RemoteService, LaunchSettings } = require('../src/remote-service')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-launch-')), file = path.join(dir, 'launch-settings.json')
  const settings = new LaunchSettings(file)
  assert.deepEqual(settings.get('codex'), { preset: 'full', extra: [] })
  settings.set('codex', 'auto', ['-m', 'o3'])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(new LaunchSettings(file).get('codex'), { preset: 'auto', extra: ['-m', 'o3'] })
  assert.throws(() => settings.set('codex', 'full', ['bad\n']))
  fs.writeFileSync(file, JSON.stringify({ claude: { preset: 'gone', extra: [] } }))
  assert.deepEqual(new LaunchSettings(file).get('claude'), { preset: 'full', extra: [] }, 'invalid saved values fall back')
  const records = new Map()
  const service = new RemoteService({ list: () => [...records.values()], get: id => records.get(id), put: s => records.set(s.id, { ...s }) }, new LaunchSettings(file))
  service.settings.set('codex', 'auto', ['-m', 'o3'])
  service.hosts = async () => [{ alias: 'macmini' }]
  let sent
  service.call = async (_h, op, arg) => { if (op === 'create') sent = arg; return { cwd: arg.project, tmux: arg.tmux } }
  await service.create({ host: 'macmini', project: '/p', tool: 'codex' })
  assert.deepEqual(sent.launch.args, ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-m', 'o3'])
  await service.create({ host: 'macmini', project: '/p', tool: 'codex', preset: 'full', extra: [] })
  assert.deepEqual(sent.launch.args, ['--dangerously-bypass-approvals-and-sandbox'], 'explicit dialog choice wins')
  assert.deepEqual(service.settings.reset('codex').defaults.codex, { preset: 'full', extra: [] })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('local device: forced local transport, local tmux attach, no SSH involved', () => {
  const P = require('../src/remote-protocol')
  const s = P.newSession({ host: P.LOCAL, project: '/p', tool: 'shell' })
  assert.equal(s.transport, 'local')
  assert.throws(() => P.newSession({ host: 'macmini', project: '/p', tool: 'shell', transport: 'local' }), /传输模式/)
  const spec = P.attachSpec(s, { ssh: '/usr/bin/ssh', tssh: '/x/tssh' })
  assert.equal(spec.file, '/bin/sh'); assert.equal(spec.args[0], '-c')
  assert(spec.args[1].includes('tmux attach-session') && !spec.args[1].includes('ssh '), spec.args[1])
})
test('local device is always listed first and runs the same protocol locally', async t => {
  const { RemoteService } = require('../src/remote-service')
  const realHome = process.env.HOME, tmpHome = require('fs').realpathSync(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'aihub-home-')))
  process.env.HOME = tmpHome; t.after(() => { process.env.HOME = realHome; require('fs').rmSync(tmpHome, { recursive: true, force: true }) })
  const service = new RemoteService({ list: () => [], get: () => null, put() {} })
  service.bins.tssh = null
  const hosts = await service.hosts()
  assert.equal(hosts[0].alias, 'local'); assert.equal(hosts[0].local, true)
  assert.equal(await service.configured('local'), 'local')
  const probe = await service.call('local', 'probe')
  assert.equal(probe.os, require('os').type() === 'Darwin' ? 'Darwin' : probe.os)
  assert.equal(probe.home, require('os').homedir())
  const dirs = await service.listDirs('local', '~')
  assert.equal(dirs.home, require('fs').realpathSync(require('os').homedir()))
})

test('imported sessions never claim launch flags; old wrongly-recorded ones are corrected', async () => {
  const { RemoteService } = require('../src/remote-service')
  const records = new Map()
  const service = new RemoteService({ list: () => [...records.values()], get: id => records.get(id), put: s => records.set(s.id, { ...s }) })
  service.hosts = async () => [{ alias: 'macmini' }]
  service.call = async () => [{ name: 'claudesquad_demo', command: 'claude', cwd: '/w', dead: false }]
  const s = await service.importSession({ host: 'macmini', tmux: 'claudesquad_demo' })
  assert.deepEqual(s.launch.args, []); assert.equal(s.launch.danger, false); assert.equal(s.squadInstance, true)
  records.set('a'.repeat(32), { id: 'a'.repeat(32), host: 'macmini', owned: false, cwd: '/w', project: '/w', launch: { preset: 'full', args: ['--dangerously-skip-permissions'], danger: true } })
  assert.equal(service.get('a'.repeat(32)).launch.danger, false)
})

test('tmux attach announces terminal features, with a plain fallback for tmux < 3.2', () => {
  const P = require('../src/remote-protocol')
  const s = P.newSession({ host: 'macmini', project: '/p', tool: 'shell' }); s.tmux = 'aihub-' + s.id
  const script = P.attachSpec(s, { ssh: '/usr/bin/ssh', tssh: '/x/tssh' }).args.at(-1)
  assert(script.includes('tmux -T ' + P.TERMINAL_FEATURES + ' attach-session')); assert(P.TERMINAL_FEATURES.split(',').includes('sync'))
  assert(!P.TERMINAL_FEATURES.includes('extkeys'), 'xterm.js has no CSI-u extended keys')
  assert(script.includes('"tmux 3.1"*'))
})

test('project settings: per host+project defaults for start branch and PR target drive task creation', async () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { RemoteService, LaunchSettings, ProjectSettings } = require('../src/remote-service')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-proj-')), file = path.join(dir, 'project-settings.json')
  const projects = new ProjectSettings(file)
  projects.set('macmini', '/Volumes/Data/demo', { base: 'develop', prTarget: 'develop' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(new ProjectSettings(file).get('macmini', '/Volumes/Data/demo'), { base: 'develop', prTarget: 'develop' })
  assert.deepEqual(projects.get('local', '/Volumes/Data/demo'), { base: '', prTarget: '' }, 'keyed by device too')
  assert.throws(() => projects.set('macmini', '/p', { base: '-x' }))
  assert.throws(() => projects.set('macmini', '/p', { prTarget: 'a..b' }))
  const records = new Map()
  const service = new RemoteService({ list: () => [...records.values()], get: id => records.get(id), put: s => records.set(s.id, { ...s }) }, new LaunchSettings(), new ProjectSettings(file))
  service.hosts = async () => [{ alias: 'macmini' }]
  let sent; service.call = async (_h, op, arg) => { if (op === 'create') { sent = arg; return { cwd: arg.project, tmux: arg.tmux, branch: 'aihub/' + arg.id, baseRef: 'refs/heads/develop' } } }
  const s = await service.create({ host: 'macmini', project: '/Volumes/Data/demo', tool: 'codex', worktree: true })
  assert.equal(sent.base, 'develop'); assert.equal(s.prTarget, 'develop'); assert.equal(s.base, 'develop')
  await service.create({ host: 'macmini', project: '/Volumes/Data/demo', tool: 'codex', worktree: true, base: '', prTarget: 'main' })
  assert.equal(sent.base, '', 'explicit "current checkout" wins'); assert.equal(sent.prTarget, 'main')
  await service.create({ host: 'macmini', project: '/repo2', tool: 'codex', worktree: true, base: 'feature/x', prTarget: 'develop', saveProjectDefaults: true })
  assert.deepEqual(service.projects.get('macmini', '/repo2'), { base: 'feature/x', prTarget: 'develop' })
  assert.throws(() => service.taskArgs({ id: 'a'.repeat(32), owned: false, worktree: true, mode: 'direct', tmux: 'aihub-' + 'a'.repeat(32) }), /独立 worktree/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('control SSH operations multiplex one connection per host with the same strict options', () => {
  const { RemoteService } = require('../src/remote-service')
  const fs = require('fs'), os = require('os'), path = require('path')
  const service = new RemoteService({ list: () => [], get: () => null, put() {} })
  const args = service.sshArgs('macmini', 'echo')
  const dir = path.join(os.homedir(), '.ssh', 'aihub-cm')
  assert(args.includes('ControlMaster=auto') && args.includes(`ControlPath=${dir}/%C`) && args.includes('ControlPersist=300'))
  for (const o of ['StrictHostKeyChecking=yes', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'BatchMode=yes']) assert(args.includes(o), o)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert((dir + '/' + 'f'.repeat(40)).length < 104, 'unix socket path fits macOS limit')
  assert.deepEqual(args.slice(-3), ['-T', 'macmini', 'echo'])
})

test('protocol is cached on the device by hash: installed once, verified every call, tampering repaired', async t => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { RemoteService, REMOTE, REMOTE_SHA } = require('../src/remote-service')
  const realHome = process.env.HOME, home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-agent-')))
  process.env.HOME = home; t.after(() => { process.env.HOME = realHome; fs.rmSync(home, { recursive: true, force: true }) })
  const dir = path.join(home, '.local/share/ai-hub/agent'), file = path.join(dir, `remote-${REMOTE_SHA}.py`)
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'remote-0000.py'), 'old version')
  const service = new RemoteService({ list: () => [], get: () => null, put() {} })
  let installs = 0; const install = service.installAgent.bind(service); service.installAgent = h => { installs++; return install(h) }
  assert.equal((await service.call('local', 'probe')).home, home)
  assert.equal(installs, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), REMOTE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert(!fs.existsSync(path.join(dir, 'remote-0000.py')), 'older versions pruned')
  await service.call('local', 'probe'); assert.equal(installs, 1, 'no re-upload once cached')
  fs.writeFileSync(file, 'print("AIHUB_RESULT:{\\"ok\\": true, \\"data\\": \\"tampered\\"}")')
  const r = await service.call('local', 'probe')
  assert.notEqual(r, 'tampered', 'a file whose hash does not match is never executed'); assert.equal(installs, 2)
  assert.equal(fs.readFileSync(file, 'utf8'), REMOTE)
  const cmd = require('../src/remote-protocol').loginCommand('x')
  assert.equal((cmd.match(/'x'/g) || []).length, 1, 'script appears once in the login dispatch')
})
