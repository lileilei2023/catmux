'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const P = require('./remote-protocol')
const { WORKSPACE } = require('./remote-workspace')
const { TASKS } = require('./remote-tasks')

// Runs inside the remote login shell. Only metadata and explicit user actions;
// never reads CLI configuration, login credentials or conversation transcripts.
const REMOTE = String.raw`
import sys, os, json, subprocess, shutil, hashlib, tempfile
op, arg = sys.argv[1], json.loads(sys.argv[2])
def run(args, check=True):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode: raise RuntimeError(p.stderr.decode('utf-8','replace').strip() or 'command failed')
    return p.stdout.decode('utf-8','replace').strip()
def git(cwd, args): return run(['git','-C',cwd]+args)
def repo(cwd):
    mount_guard(cwd)
    if not os.path.isdir(cwd): raise RuntimeError('远程目录不存在')
    if run(['git','-C',cwd,'rev-parse','--is-inside-work-tree'],False) != 'true': raise RuntimeError('目标不是 git 仓库，不能创建独立 worktree（不会 git init）。取消勾选“创建独立 git worktree”即可直接在该目录运行')
    return git(cwd,['rev-parse','--show-toplevel'])
def exact(name): return '='+name
${WORKSPACE}
${TASKS}
def sessions():
    if not shutil.which('tmux'): return []
    raw=run(['tmux','list-sessions','-F','#{session_name}\t#{session_attached}\t#{session_windows}'],False)
    result=[]
    for line in raw.splitlines():
        cols=line.split('\t')
        if len(cols)!=3: continue
        panes=run(['tmux','list-panes','-t',exact(cols[0])+':','-F','#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}\t#{pane_pid}\t#{pane_id}'],False).splitlines()
        info=panes[0].split('\t') if panes else ['','','1','','']
        result.append(dict(name=cols[0], attached=int(cols[1]), windows=int(cols[2]), command=info[0], cwd=info[1], dead=info[2]=='1',pid=info[3] if len(info)>3 else '',paneId=info[4] if len(info)>4 else ''))
    return result
def launch_argv(arg, resume=False):
    # Official CLI plus the user's chosen permission / extra arguments. A Claude
    # session gets a fixed conversation id so it can be resumed after a reboot.
    tool=arg['tool']; extra=[str(a) for a in (arg.get('launch') or {}).get('args',[])]; sid=arg.get('agentSession')
    if not resume: return [tool]+extra+(['--session-id',sid] if tool=='claude' and sid else [])
    # A worktree directory belongs to this session alone: "latest in this
    # directory" also follows a /clear. Shared directories use the fixed id.
    if tool=='codex': return ['codex','resume','--last']+extra
    if tool=='claude': return ['claude']+extra+(['--resume',sid] if sid and not arg['worktree'] else ['--continue'])
    return None
def start_tmux(arg, cwd, argv, fresh=None):
    import shlex
    login='zsh' if sys.platform=='darwin' else 'bash'
    # Each argument shell-quoted: arguments never become shell syntax.
    q=lambda a: ' '.join(shlex.quote(x) for x in a)
    if arg['tool']=='shell': launch='exec '+login+' -l'
    elif not fresh: launch='exec '+q(argv)
    # Resume; if it fails at once (nothing to resume yet), start a new conversation.
    else: launch='t=$(date +%s); '+q(argv)+'; r=$?; if [ $r -ne 0 ] && [ $(($(date +%s)-t)) -lt 15 ]; then printf "\\n[Catmux] 没有可接上的对话，已重新启动 agent\\n\\n"; exec '+q(fresh)+'; fi; exit $r'
    command='exec '+login+' -lc '+shlex.quote(launch)
    run(['tmux','new-session','-d','-s',arg['tmux'],'-c',cwd,command,
        ';','set-option','-w','-t',exact(arg['tmux'])+':','remain-on-exit','on',
        ';','set-option','-t',exact(arg['tmux'])+':','mouse','on',
        ';','set-option','-t',exact(arg['tmux'])+':','history-limit','50000'])
try:
    if op=='probe':
        result=dict(os=run(['uname','-s']),arch=run(['uname','-m']),home=os.path.expanduser('~'),
            tools={t:shutil.which(t) for t in ['tmux','codex','claude','gemini','git','python3','tsshd']},
            tmuxVersion=run(['tmux','-V']) if shutil.which('tmux') else None)
    elif op=='sessions': result=sessions()
    elif op=='create':
        cwd=arg['project']
        # Git is only needed for an isolated worktree; agents can run in any directory.
        if arg['worktree']: root=repo(cwd)
        else:
            mount_guard(cwd)
            if not os.path.isdir(cwd): raise RuntimeError('远程目录不存在')
        if not shutil.which('tmux'): raise RuntimeError('登录 shell 找不到 tmux')
        if arg['tool']!='shell' and not shutil.which(arg['tool']): raise RuntimeError('登录 shell 找不到 '+arg['tool'])
        if arg.get('mode','direct')!='direct': raise RuntimeError('Claude Squad 模式已移除')
        if run(['tmux','has-session','-t',exact(arg['tmux'])],False) or any(s['name']==arg['tmux'] for s in sessions()):
            raise RuntimeError('会话名称已存在；不会重建 agent')
        branch=None; start=None
        cwd=os.path.normpath(cwd)
        if arg['worktree']:
            wt=os.path.join(os.path.expanduser('~'),'.local','share','ai-hub','worktrees',arg['id'])
            os.makedirs(os.path.dirname(wt),mode=0o700,exist_ok=True)
            branch='aihub/'+arg['id']
            # Start from the chosen branch (project default, e.g. develop), not
            # whatever happens to be checked out in the main repository.
            start=resolve_base(root,arg['base']) if arg.get('base') else 'HEAD'
            git(root,['worktree','add','-b',branch,wt,start])
            cwd=os.path.normpath(os.path.join(wt,os.path.relpath(cwd,root)))
        start_tmux(arg,cwd,launch_argv(arg))
        result=dict(cwd=cwd,tmux=arg['tmux'],branch=branch,baseRef=start)
    elif op=='recover':
        # Read-only reconciliation of partial creation. Never create, respawn,
        # change tmux options, remove worktrees, or start another agent here.
        if not arg['owned'] or arg['mode']!='direct' or arg['tmux']!='aihub-'+arg['id']:
            raise RuntimeError('只能恢复此记录对应的原始 Catmux 会话')
        found=next((s for s in sessions() if s['name']==arg['tmux']),None)
        if not found: raise RuntimeError('原远端会话不存在；没有新建或重启 agent')
        expected=arg['project']
        branch=None
        if arg['worktree']:
            root=repo(arg['project'])
            expected=os.path.join(os.path.expanduser('~'),'.local','share','ai-hub','worktrees',arg['id'],os.path.relpath(arg['project'],root))
        if os.path.realpath(found['cwd'])!=os.path.realpath(expected):
            raise RuntimeError('原会话目录与此记录不匹配；不会接管其他会话')
        if arg['worktree']: branch=git(found['cwd'],['branch','--show-current'])
        result=dict(cwd=found['cwd'],tmux=found['name'],branch=branch,pid=found['pid'],paneId=found['paneId'],remoteDead=found['dead'])
    elif op=='revive':
        # The device rebooted (or the agent exited): same tmux name, same
        # directory, and the CLI's own resume of this directory's conversation.
        if not arg['owned'] or arg['mode']!='direct' or arg['tmux']!='aihub-'+arg['id']: raise RuntimeError('只能恢复 Catmux 创建的会话')
        found=next((s for s in sessions() if s['name']==arg['tmux']),None)
        if found and not found['dead']: raise RuntimeError('原会话仍在运行，直接连接即可')
        cwd=arg['cwd']; mount_guard(cwd)
        if not os.path.isdir(cwd): raise RuntimeError('会话目录已不存在（worktree 可能已被清理），无法恢复')
        if not shutil.which('tmux'): raise RuntimeError('登录 shell 找不到 tmux')
        if arg['tool']!='shell' and not shutil.which(arg['tool']): raise RuntimeError('登录 shell 找不到 '+arg['tool'])
        if found: run(['tmux','kill-session','-t',exact(arg['tmux'])]) # only its own pane, already exited
        resume=launch_argv(arg,True)
        start_tmux(arg,cwd,resume or launch_argv(arg),launch_argv(arg) if resume else None)
        result=dict(resumed=bool(resume),replacedDead=bool(found))
    elif op=='inspect':
        found=[s for s in sessions() if s['name']==arg['tmux']]
        result=found[0] if found else None
    elif op=='stop':
        # Own sessions: only Catmux's UUID tmux. Imported ones: only after an
        # explicit, named confirmation, and only that exact existing session.
        if not arg.get('tmux'): raise RuntimeError('此记录没有 tmux 会话，无法停止')
        if arg['owned'] and not arg['tmux'].startswith('aihub-'): raise RuntimeError('只停止 Catmux 创建的 tmux 会话')
        if not arg['owned'] and not arg.get('allowImported'): raise RuntimeError('导入的外部会话需要单独确认后才能停止')
        if subprocess.run(['tmux','has-session','-t',exact(arg['tmux'])],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode: raise RuntimeError('远端 tmux 会话已不存在')
        run(['tmux','kill-session','-t',exact(arg['tmux'])])
        result=True
    elif op in ('git','diff','files','read-file','save-file','tree','read-image','mkdir-in'):
        arg['cwd']=session_root(arg)
        if op=='git':
            with workspace_dir(arg['cwd']): result=git_changes(arg['cwd'])
        elif op=='diff': result=git_diff(arg['cwd'],arg['path'],arg['staged'])
        elif op=='files': result=list_files(arg['cwd'],arg.get('path',''))
        elif op=='read-file': result=read_file(arg['cwd'],arg['path'])
        elif op=='read-image': result=read_image(arg['cwd'],arg['path'])
        elif op=='mkdir-in': result=make_dir_in(arg['cwd'],arg['path'],arg['name'])
        elif op=='tree':
            with workspace_dir(arg['cwd']): result=tree(arg['cwd'],arg['paths'],arg['git'],bool(arg.get('deep')))
        else:
            raw=sys.stdin.buffer.read(MAX_TEXT+1)
            result=save_file(arg['cwd'],arg['path'],arg['sha256'],raw)
        if isinstance(result,dict) and 'root' not in result: result['root']=os.path.realpath(arg['cwd'])
    elif op=='list-dirs': result=list_dirs(arg['path'])
    elif op=='mkdir': result=make_dir(arg['path'])
    elif op=='branches': result=list_branches(arg['project'])
    elif op=='task-status': result=task_status(arg)
    elif op=='task-clean': result=task_clean(arg)
    elif op=='task-pr': result=task_pr(arg)
    elif op=='capture':
        # Explicit user action only ("copy recent output"): plain text of this
        # session's own pane, soft-wrapped lines joined, bounded size.
        target=exact(arg['tmux'])+':'
        # Default capture = what is visible (for full-screen CLIs that is their
        # alternate screen, which has no tmux history; tmux -a would return the
        # hidden normal screen instead). -S adds history for normal output.
        alt=run(['tmux','display-message','-p','-t',target,'#{alternate_on}'],False)=='1'
        text=run(['tmux','capture-pane','-p','-J','-S','-'+str(int(arg['lines'])),'-t',target])
        result=dict(text=text[-2000000:],truncated=len(text)>2000000,alternate=alt)
    elif op=='copy-mode':
        run(['tmux','copy-mode']+(['-u'] if arg.get('pageUp') else [])+['-t',exact(arg['tmux'])+':'])
        result=True
    elif op=='path-exists':
        # Metadata only: used to warn before a local-only path is pasted into a remote terminal.
        p=os.path.expanduser(arg['path'])
        result=dict(exists=os.path.lexists(p),file=os.path.isfile(p))
    elif op=='upload':
        base=os.path.join(os.path.expanduser('~'),'.local','share','ai-hub','uploads',arg['id'])
        os.makedirs(base,mode=0o700,exist_ok=True)
        if os.path.realpath(base)!=base: raise RuntimeError('上传目录含符号链接')
        target=os.path.join(base,arg['name'])
        fd,temp=tempfile.mkstemp(prefix='.upload-',dir=base)
        try:
            digest=hashlib.sha256(); size=0
            with os.fdopen(fd,'wb') as f:
                while True:
                    chunk=sys.stdin.buffer.read(65536)
                    if not chunk: break
                    size+=len(chunk)
                    if size>arg['size']: raise RuntimeError('文件大小超出声明')
                    f.write(chunk); digest.update(chunk)
                f.flush(); os.fsync(f.fileno())
            if size!=arg['size'] or digest.hexdigest()!=arg['sha256']: raise RuntimeError('上传校验失败')
            os.link(temp,target) # exclusive publish; never overwrite an existing file
            result=dict(path=target,size=size,sha256=digest.hexdigest())
        finally:
            os.unlink(temp)
    else: raise RuntimeError('unknown operation')
    print('AIHUB_RESULT:'+json.dumps(dict(ok=True,data=result),ensure_ascii=True))
except Exception as e:
    print('AIHUB_RESULT:'+json.dumps(dict(ok=False,error=str(e)),ensure_ascii=True)); sys.exit(1)
`

const REMOTE_SHA = crypto.createHash('sha256').update(REMOTE).digest('hex')
const AGENT_DIR = "os.path.join(os.path.expanduser('~'),'.local','share','ai-hub','agent')"
const AGENT_BOOTSTRAP = `import hashlib,os,sys
p=os.path.join(${AGENT_DIR},'remote-${REMOTE_SHA}.py')
try: d=open(p,'rb').read()
except OSError: d=b''
if hashlib.sha256(d).hexdigest()!='${REMOTE_SHA}':
    print('AIHUB_NEED_AGENT'); sys.exit(3)
sys.argv=[p]+sys.argv[1:]
exec(compile(d,p,'exec'))`
// Writes the protocol received on stdin to the private agent dir after checking
// its hash; exclusive temp file + atomic rename; prunes older versions.
const AGENT_INSTALL = `import hashlib,os,sys,tempfile
d=sys.stdin.buffer.read()
if hashlib.sha256(d).hexdigest()!='${REMOTE_SHA}': print('AIHUB_AGENT_BAD'); sys.exit(4)
base=${AGENT_DIR}
os.makedirs(base,mode=0o700,exist_ok=True)
st=os.lstat(base)
if not os.path.isdir(base) or os.path.islink(base) or st.st_uid!=os.getuid(): print('AIHUB_AGENT_BAD dir'); sys.exit(4)
os.chmod(base,0o700)
fd,tmp=tempfile.mkstemp(prefix='.remote-',dir=base)
with os.fdopen(fd,'wb') as f: f.write(d); f.flush(); os.fsync(f.fileno())
os.chmod(tmp,0o600); os.replace(tmp,os.path.join(base,'remote-${REMOTE_SHA}.py'))
for n in os.listdir(base):
    if n.startswith('remote-') and n.endswith('.py') and n!='remote-${REMOTE_SHA}.py': os.unlink(os.path.join(base,n))
print('AIHUB_AGENT_OK')`

function binary(name) {
  const dirs = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(process.env.PATH || '').split(path.delimiter)]
  for (const dir of dirs) {
    const f = path.join(dir, name)
    try { fs.accessSync(f, fs.constants.X_OK); return f } catch {}
  }
  return null
}
function environment() {
  // Do not inject proxies, model keys, credentials or agent forwarding into local children.
  const env = {}
  for (const k of ['HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','SSH_AUTH_SOCK']) if (process.env[k]) env[k] = process.env[k]
  env.PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':')
  env.TERM = 'xterm-256color'
  return env
}
function exec(file, args, input = null, timeout = 20000, maxOut = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('缺少本机可执行程序'))
    const child = spawn(file, args, { env: environment(), stdio: ['pipe','pipe','pipe'] })
    let out = Buffer.alloc(0), err = '', failure = null, settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    const timer = setTimeout(() => { failure = new Error('连接或操作超时'); child.kill('SIGKILL') }, timeout)
    child.stdout.on('data', c => { out = Buffer.concat([out,c]); if (out.length > maxOut) { failure = new Error('远端输出过大'); child.kill('SIGKILL') } })
    child.stderr.on('data', c => { err = (err + c.toString()).slice(-8192) })
    child.on('error', e => finish(e))
    child.on('close', code => finish(failure, { code, out: out.toString('utf8'), err }))
    child.stdin.on('error', () => {}) // ssh owns the final failure, not an unhandled EPIPE
    child.stdin.end(input)
  })
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i
// Only images the user explicitly pasted by path, never credentials/config dirs.
function localImage(file, strict) {
  const expanded = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file
  let stat = null, real = expanded
  try { stat = fs.statSync(expanded); real = fs.realpathSync(expanded) } catch {}
  const image = IMAGE_EXT.test(real)
  const info = { exists: !!stat, file: !!stat?.isFile(), image, size: stat?.size || 0, real }
  if (!strict) return info
  const home = os.homedir()
  if (!info.file || !image) throw new Error('只支持上传本机已存在的图片文件')
  if (info.size < 1 || info.size > 32 * 1024 * 1024) throw new Error('图片需介于 1 字节与 32 MiB 之间')
  if (['.ssh', '.aws', '.gnupg', '.codex', '.claude', '.gemini', '.config', 'Library/Keychains'].some(d => real.startsWith(path.join(home, d) + path.sep))) throw new Error('不从凭据 / 配置目录读取文件')
  P.attachmentName(path.basename(real))
  return info
}

// Per-tool launch defaults (permission preset + extra args). Web mode persists
// them next to the session metadata; otherwise they live in memory.
class LaunchSettings {
  constructor(file = null) {
    this.file = file; this.values = {}
    if (file && fs.existsSync(file)) {
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink() || st.size > 65536 || (process.getuid && st.uid !== process.getuid())) throw new Error('启动参数设置文件无效')
      try { this.values = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { this.values = {} }
    }
  }
  get(tool) {
    const saved = this.values[tool], fallback = P.LAUNCH_DEFAULTS[tool]
    try { if (saved) { P.launchFor(tool, saved.preset, saved.extra); return { preset: saved.preset, extra: [...saved.extra] } } } catch {}
    return { preset: fallback.preset, extra: [...fallback.extra] }
  }
  all() { return { presets: P.LAUNCH_PRESETS, defaults: Object.fromEntries(P.TOOLS.map(t => [t, this.get(t)])), builtIn: P.LAUNCH_DEFAULTS } }
  set(tool, preset, extra) {
    const launch = P.launchFor(tool, preset, extra)
    this.values[tool] = { preset: launch.preset, extra: launch.extra }
    if (this.file) {
      const tmp = `${this.file}.${crypto.randomUUID()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file)
    }
    return this.all()
  }
  reset(tool) { delete this.values[tool]; return this.set(tool, P.LAUNCH_DEFAULTS[tool].preset, P.LAUNCH_DEFAULTS[tool].extra) }
}

// Per-project defaults: start branch for new task worktrees and PR target.
class ProjectSettings {
  constructor(file = null) {
    this.file = file; this.values = {}
    if (file && fs.existsSync(file)) {
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink() || st.size > 262144 || (process.getuid && st.uid !== process.getuid())) throw new Error('项目设置文件无效')
      try { this.values = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { this.values = {} }
    }
  }
  key(host, project) { return `${P.hostAlias(host)}\n${P.remotePath(project)}` }
  get(host, project) {
    const v = this.values[this.key(host, project)] || {}
    const ok = x => { try { return x ? P.branchName(x) : '' } catch { return '' } }
    return { base: ok(v.base), prTarget: ok(v.prTarget) }
  }
  set(host, project, { base = '', prTarget = '' } = {}) {
    const value = { base: base ? P.branchName(base, '起点分支') : '', prTarget: prTarget ? P.branchName(prTarget, 'PR 目标分支') : '' }
    this.values[this.key(host, project)] = value
    if (this.file) {
      const tmp = `${this.file}.${crypto.randomUUID()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file)
    }
    return value
  }
}

class RemoteService {
  constructor(store, settings = new LaunchSettings(), projects = new ProjectSettings()) {
    this.settings = settings; this.projects = projects; this.store = store; this.bins = { ssh: binary('ssh'), tssh: binary('tssh') }; this.probes = new Map(); this.busy = new Set(); this.slots = new Map(); this.homes = new Map() }
  // Each control/file operation is a short ordinary SSH session. Opening many
  // directories at once must not trip sshd MaxStartups, so cap per host.
  async slot(host, fn) {
    const q = this.slots.get(host) || { active: 0, waiting: [] }; this.slots.set(host, q)
    if (q.active >= 4) await new Promise(resolve => q.waiting.push(resolve))
    q.active++
    try { return await fn() } finally { q.active--; q.waiting.shift()?.() }
  }
  list() { return this.store.list().map(s => this.canonical(s)) }
  get(id) { P.sessionId(id); const s = this.store.get(id); if (!s) throw new Error('会话不存在'); return this.canonical(s) }
  // Older records stored ".../worktrees/<id>/." — same directory, one spelling.
  canonical(s) {
    for (const k of ['cwd', 'project']) if (typeof s[k] === 'string' && s[k].length > 1 && /(\/\.)+$|\/$/.test(s[k])) { s[k] = P.remotePath(s[k]); this.store.put(s) }
    // Imported sessions were started elsewhere; an earlier version recorded the
    // default launch flags on them, which falsely showed "完全权限".
    if (!s.owned && s.launch && !s.launch.imported) { s.launch = { preset: 'default', extra: [], args: [], danger: false, imported: true }; this.store.put(s) }
    return s
  }
  // Devices: this Mac first, then every Host from ~/.ssh/config (via tssh).
  async hosts() {
    const local = { alias: P.LOCAL, hostname: os.hostname().replace(/\.local$/, ''), user: os.userInfo().username, port: '', local: true }
    if (!this.bins.tssh) return [local]
    const r = await exec(this.bins.tssh, ['--list-hosts'])
    if (r.code) return [local]
    // tssh parses Include/Host patterns. Do not send private key paths or proxy commands to the renderer.
    return [local, ...JSON.parse(r.out).map(h => ({ alias: h.Alias, hostname: h.Host, user: h.User, port: h.Port || '22' }))
      .filter(h => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(h.alias) && h.alias !== P.LOCAL)]
  }
  async configured(host) {
    P.hostAlias(host)
    if (host === P.LOCAL) return host
    if (!(await this.hosts()).some(h => h.alias === host)) throw new Error('主机不在 ~/.ssh/config 中')
    return host
  }
  // Control/file operations share one authenticated SSH connection per host
  // (ControlMaster). Over a slow Tailscale relay this turns 5–9 s per operation
  // into ~1 s. Same strict options; the socket lives in a private 0700 dir.
  controlDir() {
    if (this.cmDir !== undefined) return this.cmDir
    const dir = path.join(os.homedir(), '.ssh', 'aihub-cm')
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = fs.lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('bad control dir')
      if (st.mode & 0o077) fs.chmodSync(dir, 0o700)
      this.cmDir = dir
    } catch { this.cmDir = null } // fall back to one connection per operation
    return this.cmDir
  }
  sshArgs(host, command) {
    const dir = this.controlDir()
    const mux = dir ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/%C`, '-o', 'ControlPersist=300'] : []
    return [...P.SAFE_SSH, ...mux, '-T', host, command]
  }
  async call(host, op, arg = {}, input = null) {
    P.hostAlias(host)
    let r = await this.run(host, op, arg, input)
    if (r.out.includes('AIHUB_NEED_AGENT')) { await this.installAgent(host); r = await this.run(host, op, arg, input) }
    const line = r.out.split(/\r?\n/).filter(x => x.startsWith('AIHUB_RESULT:')).pop()
    if (!line) {
      const error = new Error(r.err.trim() || `SSH 操作失败 (${r.code})`)
      error.code = /Permission denied|Host key verification|REMOTE HOST IDENTIFICATION|Bad configuration|not resolve/i.test(r.err) ? 'permanent' : 'network'
      throw error
    }
    const result = JSON.parse(line.slice('AIHUB_RESULT:'.length))
    if (!result.ok || r.code !== 0) throw new Error(result.error || `远端操作失败 (${r.code})`)
    return result.data
  }
  // The 40 KB protocol is cached on each device as remote-<sha256>.py and only a
  // tiny bootstrap travels per call; the bootstrap checks the hash before running
  // it, so a missing / changed file is re-sent, never executed.
  run(host, op, arg, input) {
    const command = P.loginCommand(`exec python3 -c ${P.quote(AGENT_BOOTSTRAP)} ${P.quote(op)} ${P.quote(JSON.stringify(arg))}`)
    // Generous budget: over a Tailscale DERP relay one SSH handshake alone can take 5–13 s.
    const timeout = op === 'upload' ? 120000 : op === 'task-pr' ? 300000 : op.startsWith('task-') ? 90000 : 45000, maxOut = op === 'read-image' ? 16 * 1024 * 1024 : 4 * 1024 * 1024
    // Local device: the very same Python protocol through a local login shell.
    return this.slot(host, () => host === P.LOCAL
      ? exec('/bin/sh', ['-c', command], input, timeout, maxOut)
      : exec(this.bins.ssh, this.sshArgs(host, command), input, timeout, maxOut))
  }
  async installAgent(host) {
    const command = P.loginCommand(`exec python3 -c ${P.quote(AGENT_INSTALL)}`)
    const r = await this.slot(host, () => host === P.LOCAL
      ? exec('/bin/sh', ['-c', command], Buffer.from(REMOTE), 120000)
      : exec(this.bins.ssh, this.sshArgs(host, command), Buffer.from(REMOTE), 120000))
    if (!r.out.includes('AIHUB_AGENT_OK')) throw new Error('无法在设备上缓存 Catmux 协议脚本：' + (r.err.trim() || r.out.trim()).slice(-300))
  }
  async probe(host) { await this.configured(host); const result = await this.call(host, 'probe'); this.probes.set(host, result); return result }
  async remoteSessions(host) { await this.configured(host); return this.call(host, 'sessions') }
  // Directory candidates for the create form. Also learns the remote home so a
  // "~/workspace" project can be stored as the absolute path it really is.
  async listDirs(host, value) {
    await this.configured(host)
    P.text(value, '远程路径', 4096)
    if (!/^(\/|~(\/|$))/.test(value)) throw new Error('路径需以 / 或 ~/ 开头')
    const r = await this.call(host, 'list-dirs', { path: value })
    this.homes.set(host, r.home)
    return r
  }
  // "New session" path field: create the typed project directory on that device.
  async makeDir(host, value) {
    await this.configured(host)
    P.text(value, '远程路径', 4096)
    if (!/^(\/|~\/)/.test(value)) throw new Error('路径需以 / 或 ~/ 开头')
    return this.call(host, 'mkdir', { path: value })
  }
  async expandHome(host, value) {
    if (typeof value !== 'string' || !/^~(\/|$)/.test(value)) return value
    if (!this.homes.has(host)) await this.listDirs(host, '~')
    return this.homes.get(host) + value.slice(1)
  }
  async create(opts, internal = {}) {
    if (opts && typeof opts.project === 'string' && opts.host) opts = { ...opts, project: await this.expandHome(P.hostAlias(opts.host), opts.project.trim()) }
    // Worktree start branch / PR target: explicit choice, else the project's defaults.
    if (opts && opts.host && typeof opts.project === 'string' && opts.project.startsWith('/')) {
      const d = this.projects.get(opts.host, P.remotePath(opts.project))
      const base = opts.base === undefined ? d.base : opts.base, prTarget = opts.prTarget === undefined ? d.prTarget : opts.prTarget
      opts = { ...opts, base: base ? P.branchName(base, '起点分支') : '', prTarget: prTarget ? P.branchName(prTarget, 'PR 目标分支') : '' }
      if (opts.saveProjectDefaults) this.projects.set(opts.host, P.remotePath(opts.project), { base: opts.base, prTarget: opts.prTarget })
    }
    // No explicit choice → this tool's saved default (built-in: full for Codex / Claude).
    if (opts && P.TOOLS.includes(opts.tool || 'codex') && opts.preset == null) { const d = this.settings.get(opts.tool || 'codex'); opts = { ...opts, preset: d.preset, extra: opts.extra ?? d.extra } }
    const s = P.newSession(opts)
    if (s.worktree) { s.base = opts.base || ''; s.prTarget = opts.prTarget || '' }
    if (internal.companionOf) s.companionOf = internal.companionOf
    await this.configured(s.host)
    this.store.put(s)
    try {
      const info = await this.call(s.host, 'create', s)
      Object.assign(s, info, { status: 'detached' }); this.store.put(s); return s
    } catch (e) { s.status = 'failed'; s.error = e.message; this.store.put(s); throw e }
  }
  async recover(id) {
    const s = this.get(id)
    if (!['failed', 'creating'].includes(s.status) || !s.owned || s.mode !== 'direct' || s.tmux !== `aihub-${s.id}`) throw new Error('此记录不是可恢复的部分创建会话')
    try {
      await this.configured(s.host)
      const found = await this.call(s.host, 'recover', s)
      if (!found || found.tmux !== s.tmux) throw new Error('恢复结果与原会话不匹配')
      P.remotePath(found.cwd)
      Object.assign(s, found, { status: 'detached', creationError: s.error || '',
        recoveryNote: '已读取并恢复原远端会话；未重建 agent，未补写远端 tmux 设置' })
      delete s.error; delete s.recoveryError
      this.store.put(s)
      return s
    } catch (e) {
      // Keep the original failure/identity/cwd, but retain the latest diagnostic
      // so a disappearing toast cannot hide why recovery stopped.
      s.recoveryError = e.message; this.store.put(s); throw e
    }
  }
  async importSession(opts) {
    const host = await this.configured(opts.host)
    const existing = this.list().find(s => s.host === host && s.tmux === opts.tmux)
    if (existing) return existing
    const found = (await this.call(host, 'sessions')).find(s => s.name === opts.tmux)
    if (!found) throw new Error('远端 tmux 会话已不存在')
    const s = P.newSession({ host, name: found.name, project: found.cwd, tool: P.TOOLS.includes(found.command) ? found.command : 'shell', transport: opts.transport || 'udp', preset: 'default' })
    // Imported sessions were started elsewhere: Catmux knows nothing about their flags.
    s.launch = { preset: 'default', extra: [], args: [], danger: false, imported: true }
    if (/^claudesquad_/.test(found.name)) s.squadInstance = true
    Object.assign(s, { tmux: found.name, owned: false, status: 'detached' }); this.store.put(s); return s
  }
  // The tmux session is gone (device rebooted) or its agent exited: start it
  // again under the same name and directory, resuming the CLI's conversation.
  revivable(s) { return !!(s.owned && s.mode === 'direct' && s.tmux === `aihub-${s.id}` && s.cwd && !['stopped', 'failed', 'creating'].includes(s.status)) }
  async revive(id) {
    const s = this.get(id)
    if (!this.revivable(s)) throw new Error('只有 Catmux 创建、未停止的会话可以恢复')
    if (s.agentSession != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.agentSession)) throw new Error('会话记录无效')
    await this.configured(s.host)
    const r = await this.call(s.host, 'revive', { ...s, cwd: P.remotePath(s.cwd) })
    s.revivedAt = Date.now(); this.store.put(s); return r
  }
  async inspect(id) { const s = this.get(id); return this.call(s.host, 'inspect', s) }
  // Right-hand terminal: a plain shell in the session's directory on the same
  // device, its own Catmux tmux session (survives disconnects like the agent).
  companions(id) { return this.list().filter(c => c.companionOf === id) }
  async companion(id) {
    const s = this.get(id)
    if (s.companionOf) throw new Error('附属终端没有自己的附属终端')
    if (!s.cwd || ['failed', 'creating'].includes(s.status)) throw new Error('会话尚未就绪，不能打开终端')
    for (const c of this.companions(id)) {
      if (c.status !== 'stopped' && c.cwd === s.cwd) {
        const info = await this.call(c.host, 'inspect', c)
        if (info && !info.dead) return c
        if (info) await this.call(c.host, 'stop', { ...c, allowImported: false }).catch(() => {})
      }
      this.store.remove(c.id)
    }
    return this.create({ host: s.host, project: s.cwd, tool: 'shell', transport: s.transport, name: `${s.name} · 终端`, worktree: false }, { companionOf: s.id })
  }
  // Ending or forgetting a session also ends its shell (it lives in that directory).
  // Records go at once; the remote stop is best effort (the device may be offline).
  endCompanions(id) {
    const list = this.companions(id)
    for (const c of list) this.store.remove(c.id)
    return Promise.all(list.filter(c => c.status !== 'stopped').map(c => this.call(c.host, 'stop', { ...c, allowImported: false }).catch(() => {})))
  }
  stoppable(s) {
    if (!s.tmux) return { ok: false, reason: '此记录没有 tmux 会话，无法停止' }
    if (s.status === 'stopped') return { ok: false, reason: '会话已停止' }
    return { ok: true, imported: !s.owned, squadInstance: !!s.squadInstance || /^claudesquad_/.test(s.tmux) }
  }
  async stop(id, { allowImported = false } = {}) {
    const s = this.get(id), can = this.stoppable(s)
    if (!can.ok) throw new Error(can.reason)
    if (can.imported && !allowImported) throw new Error('导入的外部会话需要单独确认后才能停止')
    await this.call(s.host, 'stop', { ...s, allowImported: can.imported && allowImported }); s.status = 'stopped'; this.store.put(s)
    await this.endCompanions(id); return s
  }
  rename(id, name, group) { const s = this.get(id); s.name = P.text(name, '名称', 100); s.group = group ? P.text(group, '分组', 100) : ''; this.store.put(s); return s }
  forget(id) { this.get(id); const ended = this.endCompanions(id); this.store.remove(id); return ended }
  // Workbench roots: the browser chooses a kind, never an absolute path.
  // cwd = the session's working directory (an Catmux worktree when isolated),
  // project = the original project the session was created from,
  // pane = whatever directory the session's tmux pane is in right now.
  roots(s) {
    const list = [{ key: 'cwd', path: s.cwd }]
    if (s.project && s.project !== s.cwd) list.push({ key: 'project', path: s.project })
    if (s.tmux) list.push({ key: 'pane', path: null })
    return list
  }
  root(s, key = 'cwd') {
    if (key == null || key === 'cwd') return { cwd: P.remotePath(s.cwd) }
    if (key === 'project' && s.project) return { cwd: P.remotePath(s.project) }
    if (key === 'pane' && s.tmux) return { cwd: P.remotePath(s.cwd), pane: P.text(s.tmux, 'tmux 名称', 200) }
    throw new Error('目录根选项无效')
  }
  async git(id, root) { const s = this.get(id); return this.call(s.host, 'git', this.root(s, root)) }
  async files(id, relative = '', root) { const s = this.get(id); return this.call(s.host, 'files', { ...this.root(s, root), path: P.workspacePath(relative, true) }) }
  async tree(id, paths, root, withGit = true, deep = false) {
    const s = this.get(id)
    if (!Array.isArray(paths) || paths.length > 80) throw new Error('目录列表无效')
    return this.call(s.host, 'tree', { ...this.root(s, root), paths: paths.map(p => P.workspacePath(p, true)), git: !!withGit, deep: !!deep })
  }
  async readFile(id, relative, root) { const s = this.get(id); return this.call(s.host, 'read-file', { ...this.root(s, root), path: P.workspacePath(relative) }) }
  async makeDirIn(id, relative, name, root) { const s = this.get(id); return this.call(s.host, 'mkdir-in', { ...this.root(s, root), path: P.workspacePath(relative, true), name: P.text(name, '文件夹名称', 255) }) }
  async readImage(id, relative, root) { const s = this.get(id); return this.call(s.host, 'read-image', { ...this.root(s, root), path: P.workspacePath(relative) }) }
  async diff(id, relative, staged = false, root) { const s = this.get(id); return this.call(s.host, 'diff', { ...this.root(s, root), path: P.workspacePath(relative), staged: !!staged }) }
  async saveFile(id, relative, content, sha256, root) {
    const s = this.get(id)
    P.workspacePath(relative)
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 262144 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('文件内容 / 版本校验无效（UTF-8，最大 256 KiB）')
    return this.call(s.host, 'save-file', { ...this.root(s, root), id: s.id, path: relative, sha256 }, Buffer.from(content))
  }
  async capture(id, lines = 3000) {
    const s = this.get(id)
    if (!s.tmux) throw new Error('此记录没有 tmux 会话')
    if (!Number.isInteger(lines) || lines < 1 || lines > 50000) throw new Error('行数需在 1–50000 之间')
    return this.call(s.host, 'capture', { tmux: P.text(s.tmux, 'tmux 名称', 200), lines })
  }
  async copyMode(id, pageUp = true) {
    const s = this.get(id)
    if (!s.tmux) throw new Error('此记录没有 tmux 会话')
    return this.call(s.host, 'copy-mode', { tmux: P.text(s.tmux, 'tmux 名称', 200), pageUp: !!pageUp })
  }
  // ---- task lifecycle (start branch, end-of-task status, clean-up, push + PR) ----
  async branches(host, project) {
    await this.configured(host)
    const path = P.remotePath(await this.expandHome(host, project))
    return { ...(await this.call(host, 'branches', { project: path })), defaults: this.projects.get(host, path), project: path }
  }
  projectSettings(host, project) { return this.projects.get(host, project) }
  setProjectSettings(host, project, values) { return this.projects.set(host, project, values) }
  isTask(s) { return !!(s.owned && s.worktree && s.mode === 'direct' && s.tmux === `aihub-${s.id}`) }
  taskArgs(s, target) {
    if (!this.isTask(s)) throw new Error('只有 Catmux 创建的独立 worktree 任务支持清理 / 开 PR；其他会话只能停止')
    const d = this.projects.get(s.host, s.project)
    return { id: s.id, tmux: s.tmux, project: P.remotePath(s.project), target: P.branchName(target || s.prTarget || d.prTarget || 'main', 'PR 目标分支') }
  }
  async taskStatus(id, target) {
    const s = this.get(id)
    if (!this.isTask(s)) return { task: false, reason: '这个会话没有 Catmux 独立 worktree（导入的会话或未勾选 worktree），结束时只能停止' }
    return { task: true, base: s.base || '', ...(await this.call(s.host, 'task-status', this.taskArgs(s, target))) }
  }
  async taskClean(id, target) {
    const s = this.get(id)
    await this.endCompanions(id)
    const r = await this.call(s.host, 'task-clean', this.taskArgs(s, target))
    s.status = 'stopped'; s.cleaned = { at: Date.now(), ...r }; this.store.put(s); return r
  }
  async taskPr(id, { target, title, body = '', allowDirty = false, stopAfter = false, pushOnly = false } = {}) {
    const s = this.get(id)
    P.text(title, 'PR 标题', 250)
    if (typeof body !== 'string' || body.length > 60000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) throw new Error('PR 描述无效')
    const r = await this.call(s.host, 'task-pr', { ...this.taskArgs(s, target), title, body, allowDirty: !!allowDirty, stopAfter: !!stopAfter, pushOnly: !!pushOnly })
    s.pr = { url: r.url, at: Date.now(), target: target || s.prTarget }; if (r.stopped) s.status = 'stopped'; this.store.put(s)
    if (r.stopped) await this.endCompanions(id)
    return r
  }
  // A pasted absolute path may only exist on this Mac. Report where it exists so
  // the UI never silently types a local-only path into the remote terminal.
  async checkPath(id, file) {
    const s = this.get(id)
    if (typeof file !== 'string' || !/^(\/|~\/)/.test(file) || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)) throw new Error('路径无效')
    const local = localImage(file, false)
    const remote = await this.call(s.host, 'path-exists', { path: file })
    return { local: { exists: local.exists, file: local.file, image: local.image, size: local.size }, remote, host: s.host }
  }
  async uploadLocal(id, file) {
    const info = localImage(file, true)
    return this.upload(id, { bytes: fs.readFileSync(info.real), name: path.basename(info.real) })
  }
  async upload(id, { bytes, name }) {
    const s = this.get(id)
    const selectedName = P.attachmentName(name)
    if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) throw new Error('文件数据无效')
    if (bytes.length > 32 * 1024 * 1024) throw new Error('文件需小于 32 MiB')
    const buffer = Buffer.from(bytes)
    if (!buffer.length || buffer.length > 32 * 1024 * 1024) throw new Error('文件必须介于 1 字节与 32 MiB 之间')
    const ext = path.extname(selectedName).replace(/[^.A-Za-z0-9]/g, '').slice(0, 12)
    const safeName = `${crypto.randomUUID()}${ext}`
    return this.call(s.host, 'upload', { id: s.id, name: safeName, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }, buffer)
  }
}

module.exports = { REMOTE_SHA, RemoteService, LaunchSettings, ProjectSettings, REMOTE, exec, environment, binary, localImage }
