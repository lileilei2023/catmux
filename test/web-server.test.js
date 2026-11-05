'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const { createWebServer } = require('../src/web-server')
const { JsonStore } = require('../src/web-store')
const { RemoteService } = require('../src/remote-service')
const { RemoteConnections } = require('../src/remote-connections')
const { PythonPty } = require('../src/web-pty')
const P = require('../src/remote-protocol')

function mockStore() { const map = new Map(); return { list: () => [...map.values()].map(s=>({...s})), get: id=>map.get(id), put:s=>map.set(s.id,{...s}), remove:id=>map.delete(id), close(){} } }
async function fixture(t) {
  const store = mockStore(), service = new RemoteService(store)
  service.hosts = async () => [{alias:'macmini',hostname:'mac-mini.test.ts.net',user:'test',port:'22'}]
  service.call = async (_host, op, arg, bytes) => {
    if (op === 'create') return { cwd: arg.project, tmux: arg.tmux }
    if (op === 'inspect') return { name:arg.tmux,dead:false }
    if (op === 'upload') return {path:'/test/uploads/'+arg.name,size:bytes.length,sha256:arg.sha256}
    if (op === 'stop') return true
    throw new Error('unexpected test operation: '+op)
  }
  const connections = new RemoteConnections(service, () => { const e=new EventEmitter();e.resize=()=>{};e.write=()=>{};e.kill=()=>{};return e })
  const context = await createWebServer({store,service,connections,port:0})
  t.after(()=>context.close())
  const boot = await fetch(context.origin+'/api/bootstrap')
  const token = (await boot.json()).data.csrf
  const cookie = boot.headers.get('set-cookie').split(';')[0]
  async function api(method,payload={},extra={}) { return fetch(context.origin+'/api/'+method,{method:'POST',headers:{'Content-Type':'application/json','X-AIHub-CSRF':token,Cookie:cookie,Origin:context.origin,...extra},body:JSON.stringify(payload)}) }
  return { ...context,api,token,cookie }
}
test('Web server binds only IPv4 loopback and serves an actual backend host list', async t => {
  const f=await fixture(t)
  assert.equal(f.server.address().address,'127.0.0.1')
  const r=await f.api('hosts');assert.equal(r.status,200)
  const hosts=(await r.json()).data;assert.equal(hosts[0].alias,'macmini');assert(!JSON.stringify(hosts).includes('IdentityFile'))
})
test('unauthorized and cross-origin terminal/control requests are rejected', async t => {
  const f=await fixture(t)
  assert.equal((await fetch(f.origin+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.origin},body:'{}'})).status,401)
  assert.equal((await f.api('sessions',{}, {Origin:'https://attacker.invalid'})).status,403)
  assert.equal((await f.api('sessions',{}, {'X-AIHub-CSRF':'wrong'})).status,403)
  assert.equal((await f.api('sessions',{}, {'Sec-Fetch-Site':'cross-site'})).status,403)
  // Node fetch normalizes Host to its destination. Use a raw HTTP request to
  // verify the actual rebinding boundary instead of testing a stripped header.
  const status = await new Promise((resolve,reject)=>{
    const req=http.request(f.origin+'/api/sessions',{method:'POST',headers:{Host:'attacker.invalid',Origin:f.origin,Cookie:f.cookie,'X-AIHub-CSRF':f.token,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode)})
    req.on('error',reject);req.end('{}')
  })
  assert.equal(status,403)
})
test('static whitelist cannot expose application source, state, private files or arbitrary paths', async t => {
  const f=await fixture(t)
  for(const p of ['/src/remote-service.js','/package.json','/HANDOFF.md','/.ssh/id_ed25519','/src/../src/remote-store.js']) assert.equal((await fetch(f.origin+p)).status,404)
  const page=await fetch(f.origin);assert.equal(page.status,200)
  assert(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));assert.equal(page.headers.get('x-frame-options'),'DENY')
  assert((await page.text()).includes('src/web-bridge.js'))
})
test('unknown methods and malformed payloads fail without command execution',async t=>{
  const f=await fixture(t)
  assert.equal((await f.api('exec',{cmd:'id'})).status,404)
  assert.equal((await f.api('constructor',{})).status,404)
  assert.equal((await f.api('sessions',[],{})).status,400)
  assert.equal((await f.api('sessions',{}, {'Content-Type':'text/plain'})).status,415)
})
test('remote stop requires a matching single-use UI confirmation ticket',async t=>{
  const f=await fixture(t)
  const r=await f.api('create',{host:'macmini',project:'/test/repo',tool:'codex',worktree:false})
  const s=(await r.json()).data
  assert.equal((await f.api('stop',{id:s.id})).status,403)
  const prep=(await (await f.api('prepare-confirm',{id:s.id,operation:'stop'})).json()).data
  assert.equal((await f.api('stop',{id:s.id,ticket:prep.ticket})).status,200)
  assert.equal((await f.api('stop',{id:s.id,ticket:prep.ticket})).status,403)
})
test('binary upload authenticates, checks size/hash and blocks sensitive filenames',async t=>{
  const f=await fixture(t)
  const s=(await (await f.api('create',{host:'macmini',project:'/test/repo',tool:'shell'})).json()).data
  const upload=name=>fetch(f.origin+'/api/upload?id='+s.id+'&name='+name,{method:'POST',headers:{Origin:f.origin,Cookie:f.cookie,'X-AIHub-CSRF':f.token,'Content-Type':'application/octet-stream'},body:new Uint8Array([1,2,3])})
  const r=await upload('test.png');assert.equal(r.status,200);assert.equal((await r.json()).data.size,3)
  const blocked=await upload('id_ed25519');assert.equal(blocked.status,500);assert((await blocked.json()).error.includes('私钥'))
})
test('Web metadata uses private atomic JSON, locks and survives restart without native dependencies',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aihub-store-'))
  let store=new JsonStore(dir)
  const s=P.newSession({host:'macmini',project:'/test/repo',tool:'shell'})
  store.put(s);assert.equal(fs.statSync(store.file).mode&0o777,0o600)
  assert.throws(()=>new JsonStore(dir),/已由另一个进程/)
  store.close();store=new JsonStore(dir);assert.equal(store.get(s.id).tmux,s.tmux)
  store.remove(s.id);store.close()
  fs.rmSync(dir,{recursive:true,force:true}) // only this test's mkdtemp fixture
})
test('real stdlib PTY supports interactive writes, UTF-8 and terminal resizing without Electron/node-pty',async()=>{
  const pty=new PythonPty('/bin/sh',['-c','printf "PTY_READY\\n"; stty size; exec cat'])
  let text='';pty.on('data',data=>text+=data)
  const failure=new Promise((_resolve,reject)=>pty.once('error',reject))
  const completed=new Promise((resolve,reject)=>{
    const end=Date.now()+5000
    const timer=setInterval(()=>{
      if(text.includes('PTY_READY')&&text.includes('中文')){clearInterval(timer);resolve()}
      else if(Date.now()>end){clearInterval(timer);reject(new Error('PTY fixture timed out'))}
    },20)
  })
  pty.resize(91,33);pty.write('中文\n')
  try{await Promise.race([completed,failure]);assert(text.includes('PTY_READY'))}finally{pty.kill()}
})
test('reconnect attaches an existing session only; disconnect never stops remote agent',async()=>{
  const store=mockStore(),service=new RemoteService(store),s=P.newSession({host:'macmini',project:'/test/repo',tool:'codex'})
  s.status='detached' // successful creation, not an unfinished creating record
  store.put(s);let inspectCalls=0,created=0
  service.call=async()=>{throw new Error('offline test must never execute SSH')}
  service.inspect=async()=>{inspectCalls++;return {name:s.tmux}}
  service.create=async()=>{throw new Error('must not recreate agent')}
  let proc
  const links=new RemoteConnections(service,()=>{created++;proc=new EventEmitter();proc.resize=()=>{};proc.write=()=>{};proc.kill=()=>{};return proc})
  await links.connect(s.id);proc.emit('data',`\x1b]777;AIHUB_READY:${s.id}\x07`)
  assert.equal(links.snapshot(s.id).status,'connected')
  await links.connect(s.id);assert.equal(created,1)
  links.disconnect(s.id);assert.equal(store.get(s.id).tmux,s.tmux)
  await links.connect(s.id);assert.equal(created,2);assert.equal(inspectCalls,2);links.close()
})
test('sensitive file rejection uses names and does not inspect or transfer key contents',()=>{
  for(const name of ['id_ed25519','id_rsa','.env','auth.json','config.toml','secret.pem','credentials.json']) assert.throws(()=>P.attachmentName(name),/不允许上传/)
  assert.equal(P.attachmentName('../../image.png'),'image.png')
})
test('failed recovery reports a persistent blocked state and never starts a transport',async()=>{
  const store=mockStore(),service=new RemoteService(store),s=P.newSession({host:'macmini',project:'/test/repo',tool:'codex'})
  s.status='failed';store.put(s)
  service.configured=async h=>h
  service.call=async()=>{throw new Error('连接或操作超时')}
  let started=0;const events=[]
  const links=new RemoteConnections(service,()=>{started++;throw new Error('must not start PTY')})
  links.on('event',e=>events.push(e))
  await assert.rejects(links.connect(s.id),/连接或操作超时/)
  assert.equal(started,0);assert.equal(events.at(-1).status,'blocked')
  assert.equal(store.get(s.id).recoveryError,'连接或操作超时');assert.equal(store.get(s.id).status,'failed')
  links.close()
})

test('installable web app: manifest, service worker, offline page and icons are served safely', async t => {
  const f = await fixture(t)
  const manifest = await fetch(f.origin + '/manifest.webmanifest')
  assert.equal(manifest.status, 200); assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/)
  const m = await manifest.json()
  assert.equal(m.start_url, '/'); assert.equal(m.display, 'standalone'); assert(m.icons.some(i => i.sizes === '512x512'))
  const sw = await fetch(f.origin + '/sw.js')
  assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/)
  const code = await sw.text()
  assert(code.includes("mode !== 'navigate'"), 'service worker only handles page navigations, never API / event stream')
  for (const p of ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png']) assert.equal((await fetch(f.origin + p)).status, 200, p)
  const csp = (await fetch(f.origin)).headers.get('content-security-policy')
  assert(csp.includes("manifest-src 'self'") && csp.includes("worker-src 'self'"))
  for (const p of ['/web/sw.js', '/bin/catmux', '/web/vendor/xterm.js', '/node_modules/@xterm/xterm/lib/xterm.js']) assert.equal((await fetch(f.origin + p)).status, 404)
})
test('catmux control script parses and reports status without touching anything', () => {
  const { spawnSync } = require('node:child_process')
  const script = path.join(__dirname, '../bin/catmux')
  assert.equal(spawnSync('zsh', ['-n', script]).status, 0)
  const help = spawnSync('zsh', [script, 'help'], { encoding: 'utf8' })
  assert.equal(help.status, 0); assert.match(help.stdout, /catmux open/)
  const status = spawnSync('zsh', [script, 'status'], { encoding: 'utf8', env: { ...process.env, CATMUX_PORT: '1' } })
  assert.equal(status.status, 0); assert.match(status.stdout, /未运行/)
})

test('bootstrap reports a front-end build id so stale windows can offer a refresh', async t => {
  const f = await fixture(t)
  const data = (await (await fetch(f.origin + '/api/bootstrap')).json()).data
  assert.match(data.build, /^[0-9a-f]{12}$/)
  assert.equal((await (await fetch(f.origin + '/api/bootstrap')).json()).data.build, data.build, 'stable for one backend run')
})

test('imported sessions can be stopped only through a named single-use confirmation', async t => {
  const f = await fixture(t)
  let sent = null
  const call = f.service.call
  f.service.call = async (host, op, arg, bytes) => {
    if (op === 'sessions') return [{ name: 'claudesquad_x', command: 'claude', cwd: '/w', dead: false }]
    if (op === 'stop') { sent = arg; return true }
    return call(host, op, arg, bytes)
  }
  const s = (await (await f.api('import', { host: 'macmini', tmux: 'claudesquad_x' })).json()).data
  assert.equal(s.owned, false)
  assert.equal((await f.api('stop', { id: s.id })).status, 403)
  const prep = (await (await f.api('prepare-confirm', { id: s.id, operation: 'stop' })).json()).data
  assert.equal(prep.imported, true); assert.equal(prep.squadInstance, true); assert.equal(prep.tmux, 'claudesquad_x')
  assert.equal((await f.api('stop', { id: s.id, ticket: prep.ticket })).status, 200)
  assert.equal(sent.allowImported, true); assert.equal(sent.tmux, 'claudesquad_x')
  await assert.rejects(() => f.service.stop(s.id, {}), /已停止|确认/)
})

test('task clean requires a single-use confirmation and only applies to Catmux worktree tasks', async t => {
  const f = await fixture(t)
  let cleaned = 0
  const call = f.service.call
  f.service.call = async (host, op, arg, bytes) => { if (op === 'task-clean') { cleaned++; return { removedWorktree: true, deletedBranch: true } } return call(host, op, arg, bytes) }
  const task = (await (await f.api('create', { host: 'macmini', project: '/test/repo', tool: 'codex', worktree: true })).json()).data
  assert.equal((await f.api('task-clean', { id: task.id })).status, 403)
  const prep = (await (await f.api('prepare-confirm', { id: task.id, operation: 'clean' })).json()).data
  assert.equal((await f.api('task-clean', { id: task.id, ticket: prep.ticket })).status, 200)
  assert.equal((await f.api('task-clean', { id: task.id, ticket: prep.ticket })).status, 403, 'ticket is single-use')
  assert.equal(cleaned, 1)
  const plain = (await (await f.api('create', { host: 'macmini', project: '/test/repo', tool: 'codex', worktree: false })).json()).data
  assert.equal((await f.api('prepare-confirm', { id: plain.id, operation: 'clean' })).status, 400)
})

test('vendored front-end assets are served without node_modules', async t => {
  const f = await fixture(t)
  for (const p of ['/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js', '/vendor/addon-unicode11.js', '/vendor/highlight.min.js']) assert.equal((await fetch(f.origin + p)).status, 200, p)
  const html = await (await fetch(f.origin + '/')).text()
  assert(html.includes('vendor/xterm.js') && !html.includes('node_modules'))
  const info = await (await f.api('info')).json()
  assert.equal(info.data.name, 'Catmux'); assert.match(info.data.version, /^\d+\.\d+\.\d+$/); assert.equal(info.data.initialHost, '')
})
