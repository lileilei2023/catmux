'use strict'

// Executed through the existing SSH Python protocol, not a remote service.
// The cwd is supplied by the persisted session, never by the browser.
const WORKSPACE = String.raw`
import re, stat, contextlib, uuid, base64
MAX_TEXT=262144
MAX_ENTRIES=500
MAX_CHANGES=1000
PROTECTED=('.git','.ssh','.aws','.azure','.gnupg','.config','.local','.codex','.claude','.gemini','.docker','.kube','.npmrc','.netrc','auth.json','settings.json','config.toml')
# Session roots may legitimately live in ~/.local/share/ai-hub/worktrees, so the
# root check is narrower than the per-entry check. Credential/model homes stay out.
PROTECTED_ROOTS=('.ssh','.aws','.azure','.gnupg','.codex','.claude','.gemini','.docker','.kube','.config')
def protected_name(name):
    name=name.lower()
    return name in PROTECTED or name.startswith(('.env','id_rsa','id_ed25519','id_ecdsa','id_dsa')) or bool(re.search(r'credential|secret|token|password',name)) or name.endswith(('.pem','.key','.env','.p12','.pfx'))
def allowed_path(value):
    if not isinstance(value,str) or len(value)>4096 or value.startswith('/') or re.search(r'[\x00-\x1f\x7f]',value): return False
    for part in value.split('/') if value else []:
        if part in ('','.','..') or protected_name(part): return False
    return True
def allowed_root(root):
    home=os.path.realpath(os.path.expanduser('~'))
    # Home is browsable (its credential/model entries are still filtered out per
    # entry); the filesystem root is not a project.
    if root=='/' or len(root)>4096: return False
    rel=os.path.relpath(root,home)
    parts=rel.split('/') if not rel.startswith('..') else root.strip('/').split('/')
    for part in parts:
        if part.lower() in PROTECTED_ROOTS: return False
    # Never treat Catmux's own private backup/upload stores as projects.
    if rel.startswith('.local/share/ai-hub/') and not rel.startswith('.local/share/ai-hub/worktrees/'): return False
    return True
@contextlib.contextmanager
def workspace_dir(cwd,relative=''):
    if not allowed_path(relative): raise RuntimeError('路径越界或属于凭据 / 模型配置，拒绝访问')
    # Resolve the trusted session root once; every descendant is opened via
    # directory descriptors and O_NOFOLLOW, preventing traversal/symlink races.
    root=os.path.realpath(cwd)
    if not allowed_root(root): raise RuntimeError('此会话目录属于受保护配置，拒绝浏览')
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in relative.split('/') if relative else []:
            nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=nextfd
        yield fd
    finally: os.close(fd)
@contextlib.contextmanager
def workspace_file(cwd,relative):
    if not relative or not allowed_path(relative): raise RuntimeError('路径越界或属于凭据 / 模型配置，拒绝访问')
    parent,name=os.path.split(relative)
    with workspace_dir(cwd,parent) as directory:
        fd=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=directory)
        try:
            meta=os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or meta.st_nlink!=1: raise RuntimeError('只支持普通文件，不访问链接 / 设备')
            if meta.st_size>MAX_TEXT: raise RuntimeError('文件超过 256 KiB，请在终端中用远端编辑器打开')
            with os.fdopen(os.dup(fd),'rb') as stream: raw=stream.read(MAX_TEXT+1)
            if len(raw)>MAX_TEXT or b'\0' in raw: raise RuntimeError('二进制或过大文件，不能预览 / 编辑')
            try: content=raw.decode('utf-8')
            except UnicodeDecodeError: raise RuntimeError('只支持 UTF-8 文本，不改写其他编码')
            yield directory,name,meta,raw,content
        finally: os.close(fd)
def read_file(cwd,relative):
    with workspace_file(cwd,relative) as (_,__,meta,raw,content):
        return dict(path=relative,content=content,sha256=hashlib.sha256(raw).hexdigest(),size=len(raw),mtime=int(meta.st_mtime))
def list_files(cwd,relative):
    entries=[]; truncated=False
    with workspace_dir(cwd,relative) as directory:
        for name in os.listdir(directory):
            child=relative+'/'+name if relative else name
            if not allowed_path(child): continue
            try: meta=os.stat(name,dir_fd=directory,follow_symlinks=False)
            except FileNotFoundError: continue
            if stat.S_ISLNK(meta.st_mode) or not (stat.S_ISREG(meta.st_mode) or stat.S_ISDIR(meta.st_mode)): continue
            if len(entries)>=MAX_ENTRIES: truncated=True; break
            entries.append(dict(name=name,path=child,directory=stat.S_ISDIR(meta.st_mode),size=meta.st_size))
    entries.sort(key=lambda e:(not e['directory'],e['name'].lower()))
    return dict(path=relative,entries=entries,truncated=truncated)
def list_dirs(value):
    # Directory names only, for the "new session" path field. Accepts ~ / ~/x for
    # the remote login user; never descends into credential / model homes.
    if not isinstance(value,str) or len(value)>4096 or re.search(r'[\x00-\x1f\x7f]',value) or not value.startswith(('/','~')): raise RuntimeError('路径需以 / 或 ~ 开头')
    home=os.path.realpath(os.path.expanduser('~'))
    if value=='~' or value.startswith('~/'): absolute=home+value[1:]
    elif value.startswith('~'): raise RuntimeError('只支持当前用户的 ~，不支持 ~user')
    else: absolute=value
    absolute=os.path.normpath(absolute)
    real=os.path.realpath(absolute)
    rel=os.path.relpath(real,home)
    parts=real.strip('/').split('/') if rel.startswith('..') else rel.split('/')
    if any(p.lower() in PROTECTED_ROOTS for p in parts): raise RuntimeError('受保护目录，不提供补全')
    if not os.path.isdir(real): return dict(dir=absolute,home=home,exists=False,git=False,entries=[],truncated=False)
    try: names=os.listdir(real)
    except PermissionError: raise RuntimeError('没有权限读取该目录')
    entries=[]; truncated=False
    for name in names:
        if protected_name(name): continue
        full=os.path.join(real,name)
        try: meta=os.stat(full)
        except OSError: continue
        if not stat.S_ISDIR(meta.st_mode): continue
        if len(entries)>=1000: truncated=True; break
        entries.append(dict(name=name,git=os.path.exists(os.path.join(full,'.git')),hidden=name.startswith('.')))
    entries.sort(key=lambda e:(e['hidden'],e['name'].lower()))
    return dict(dir=absolute,home=home,exists=True,git=os.path.exists(os.path.join(real,'.git')),entries=entries,truncated=truncated)
def session_root(arg):
    # The browser only picks a root *kind*; absolute roots come from the stored
    # session or from the session's own tmux pane, resolved here on the server.
    if arg.get('pane'):
        path=run(['tmux','display-message','-p','-t',exact(arg['pane'])+':','#{pane_current_path}'],False)
        if not path.startswith('/'): raise RuntimeError('读取终端当前目录失败（tmux 会话不存在？）')
        return os.path.normpath(path)
    return os.path.normpath(arg['cwd'])
# Listed but not preloaded: huge generated / dependency trees stay lazy.
HEAVY=('node_modules','__pycache__','.venv','venv','env','dist','build','out','.next','.nuxt','target','.cache','Pods','.gradle','.idea','vendor','.tox','.mypy_cache','.pytest_cache','.ruff_cache','coverage','.turbo','.parcel-cache','DerivedData','Library','Applications','.Trash')
MAX_DEEP_DIRS=1000
MAX_DEEP_ENTRIES=8000
def list_or_error(cwd,p):
    try: return list_files(cwd,p)
    except FileNotFoundError: return dict(error='目录已不存在',missing=True)
    except (RuntimeError,OSError) as e: return dict(error=str(e))
def tree(cwd,paths,with_git,deep=False):
    dirs={}
    for p in paths[:80]: dirs[p]=list_or_error(cwd,p)
    result=dict(root=os.path.realpath(cwd),dirs=dirs)
    if deep:
        # Breadth-first so a cap still leaves the upper levels complete.
        queue=[''] ; seen=set(); total=0; complete=True; lazy=[]
        while queue:
            p=queue.pop(0)
            if p in seen: continue
            seen.add(p)
            if p not in dirs:
                if len(dirs)>=MAX_DEEP_DIRS or total>=MAX_DEEP_ENTRIES: complete=False; break
                dirs[p]=list_or_error(cwd,p)
            for e in dirs[p].get('entries',()):
                total+=1
                if not e['directory']: continue
                if e['name'] in HEAVY: lazy.append(e['path'])
                else: queue.append(e['path'])
        result['deep']=dict(complete=complete,dirs=len(dirs),entries=total,lazy=lazy[:200])
    if with_git:
        try: result['git']=git_changes(cwd)
        except Exception as e: result['gitError']=str(e)
    return result
IMAGE={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','gif':'image/gif','webp':'image/webp','bmp':'image/bmp','ico':'image/x-icon','svg':'image/svg+xml'}
MAX_IMAGE=8*1024*1024
def image_ok(ext,raw):
    if ext=='png': return raw.startswith(b'\x89PNG\r\n\x1a\n')
    if ext in ('jpg','jpeg'): return raw.startswith(b'\xff\xd8\xff')
    if ext=='gif': return raw.startswith((b'GIF87a',b'GIF89a'))
    if ext=='webp': return raw[:4]==b'RIFF' and raw[8:12]==b'WEBP'
    if ext=='bmp': return raw.startswith(b'BM')
    if ext=='ico': return raw.startswith(b'\0\0\1\0')
    if ext=='svg': return b'<svg' in raw[:4096].lower()
    return False
def read_image(cwd,relative):
    if not relative or not allowed_path(relative): raise RuntimeError('路径越界或属于凭据 / 模型配置，拒绝访问')
    ext=relative.rsplit('.',1)[-1].lower() if '.' in relative.split('/')[-1] else ''
    if ext not in IMAGE: raise RuntimeError('不是支持预览的图片格式')
    parent,name=os.path.split(relative)
    with workspace_dir(cwd,parent) as directory:
        fd=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=directory)
        try:
            meta=os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or meta.st_nlink!=1: raise RuntimeError('只支持普通文件，不访问链接 / 设备')
            if meta.st_size>MAX_IMAGE: raise RuntimeError('图片超过 8 MiB，不在面板中预览')
            with os.fdopen(os.dup(fd),'rb') as stream: raw=stream.read(MAX_IMAGE+1)
        finally: os.close(fd)
    if len(raw)>MAX_IMAGE: raise RuntimeError('图片超过 8 MiB，不在面板中预览')
    if not image_ok(ext,raw): raise RuntimeError('文件内容与图片扩展名不符，拒绝预览')
    return dict(path=relative,mime=IMAGE[ext],size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),data=base64.b64encode(raw).decode('ascii'))
def private_dir(*parts):
    home=os.path.realpath(os.path.expanduser('~'))
    base=os.path.join(home,'.local','share','ai-hub',*parts)
    os.makedirs(base,mode=0o700,exist_ok=True)
    if os.path.realpath(base)!=base: raise RuntimeError('私有目录含符号链接，操作已取消')
    meta=os.lstat(base)
    if meta.st_uid!=os.getuid(): raise RuntimeError('私有目录属主异常，操作已取消')
    os.chmod(base,0o700)
    return base
def save_file(cwd,relative,expected,raw):
    if len(raw)>MAX_TEXT or b'\0' in raw: raise RuntimeError('只支持 256 KiB 内 UTF-8 文本')
    raw.decode('utf-8')
    with workspace_file(cwd,relative) as (directory,name,meta,old,content):
        if hashlib.sha256(old).hexdigest()!=expected: raise RuntimeError('CONFLICT:文件已被远端修改；保存已取消。请重新读取并合并，不会覆盖 agent 的修改')
        if old==raw: return dict(path=relative,sha256=expected,size=len(raw),backup=None,unchanged=True)
        # Keep private backups outside the project/git tree, including relative
        # path metadata for recovery. Never overwrite another backup.
        base=private_dir('file-backups',arg['id'])
        token=uuid.uuid4().hex
        backup=os.path.join(base,token+'.bak')
        fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream: stream.write(old); stream.flush(); os.fsync(stream.fileno())
        fd=os.open(os.path.join(base,token+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as stream: json.dump(dict(cwd=cwd,path=relative,sha256=expected),stream)
        temporary='.aihub-save-'+token
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
        try:
            with os.fdopen(fd,'wb') as stream:
                stream.write(raw); os.fchmod(stream.fileno(),stat.S_IMODE(meta.st_mode)&0o777); stream.flush(); os.fsync(stream.fileno())
            # Recheck immediately before atomic publication. External programs
            # do not share a lock, so a residual microsecond race is documented.
            with workspace_file(cwd,relative) as (_,__,current,data,___):
                if (current.st_dev,current.st_ino,current.st_mtime_ns)!=(meta.st_dev,meta.st_ino,meta.st_mtime_ns) or data!=old:
                    raise RuntimeError('CONFLICT:保存期间远端文件发生变化；已取消，请重新读取并合并')
            os.replace(temporary,name,src_dir_fd=directory,dst_dir_fd=directory)
        finally:
            try: os.unlink(temporary,dir_fd=directory)
            except FileNotFoundError: pass
        return dict(path=relative,sha256=hashlib.sha256(raw).hexdigest(),size=len(raw),backup=backup)
def visible(root,cwd,name):
    # Git reports paths relative to the repository root regardless of -C.
    # Restrict the workbench to this session's actual project/subdirectory.
    if not allowed_path(name): return None
    relative=os.path.relpath(os.path.join(root,name),cwd)
    return relative if allowed_path(relative) else None
def numstat(cwd,root,real,staged):
    args=['git','--no-pager','-C',cwd,'diff','--numstat','-z','--no-renames','--no-ext-diff','--no-textconv']
    if staged: args.append('--cached')
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    result={}
    if p.returncode: return result
    for row in p.stdout.decode('utf-8','replace').split('\0'):
        cols=row.split('\t',2)
        if len(cols)!=3: continue
        path=visible(root,real,cols[2])
        if path: result[path]=(None if cols[0]=='-' else int(cols[0]),None if cols[1]=='-' else int(cols[1]))
    return result
def git_changes(cwd):
    root=os.path.realpath(repo(cwd)); real=os.path.realpath(cwd)
    p=subprocess.run(['git','--no-pager','-C',cwd,'status','--porcelain=v1','-z','--untracked-files=all'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode: raise RuntimeError(p.stderr.decode('utf-8','replace').strip() or 'git status 失败')
    records=p.stdout.decode('utf-8','replace').split('\0'); changes=[]; index=0; truncated=False
    work=numstat(cwd,root,real,False); cached=numstat(cwd,root,real,True)
    while index<len(records):
        row=records[index]; index+=1
        if len(row)<4: continue
        code,name=row[:2],row[3:]
        original=None
        if 'R' in code or 'C' in code:
            original=records[index] if index<len(records) else None; index+=1
        path=visible(root,real,name)
        if not path or (original and not allowed_path(original)): continue
        if len(changes)>=MAX_CHANGES: truncated=True; break
        changes.append(dict(path=path,status=code,original=original,
            staged=code[0] not in (' ','?','!'),unstaged=code[1]!=' ' or code=='??',
            added=(work.get(path) or (0,0))[0],deleted=(work.get(path) or (0,0))[1],
            stagedAdded=(cached.get(path) or (0,0))[0],stagedDeleted=(cached.get(path) or (0,0))[1]))
    branch=run(['git','-C',cwd,'branch','--show-current'],False)
    head=run(['git','-C',cwd,'rev-parse','--short','HEAD'],False)
    counts=run(['git','-C',cwd,'rev-list','--left-right','--count','@{upstream}...HEAD'],False).split()
    return dict(root=root,cwd=real,branch=branch,head=head,changes=changes,truncated=truncated,
        behind=int(counts[0]) if len(counts)==2 else None,ahead=int(counts[1]) if len(counts)==2 else None)
def git_diff(cwd,relative,staged):
    if not relative or not allowed_path(relative): raise RuntimeError('拒绝读取受保护 diff')
    # Refuse symlink content/diffs as well. Deleted files are allowed, but their
    # existing parent must stay inside the session root without symlinks.
    parent,name=os.path.split(relative)
    try:
        with workspace_dir(cwd,parent) as directory:
            try:
                meta=os.stat(name,dir_fd=directory,follow_symlinks=False)
                if not stat.S_ISREG(meta.st_mode): raise RuntimeError('不展示链接 / 目录 diff')
            except FileNotFoundError: pass
    except FileNotFoundError: pass # whole parent directory deleted
    changes=git_changes(cwd)['changes']
    change=next((c for c in changes if c['path']==relative),None)
    if not change: return dict(path=relative,patch='',staged=staged,note='该文件当前没有变更')
    if change['status']=='??':
        if staged: return dict(path=relative,patch='',staged=True,note='未跟踪文件没有暂存内容')
        try: content=read_file(cwd,relative)['content']
        except RuntimeError as e: return dict(path=relative,patch='',staged=False,note=str(e))
        lines=content.splitlines()
        return dict(path=relative,patch='--- /dev/null\n+++ b/'+relative+'\n@@ -0,0 +1,'+str(len(lines))+' @@\n'+''.join('+'+line+'\n' for line in lines),staged=False,untracked=True)
    args=['git','--no-pager','-C',cwd,'diff','--no-ext-diff','--no-textconv','--no-renames','--no-color']
    if staged: args.append('--cached')
    args+=['--',':(literal)'+relative]
    p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        raw=p.stdout.read(MAX_TEXT+1)
        if len(raw)>MAX_TEXT: p.kill(); raise RuntimeError('diff 超过 256 KiB，请在终端中使用 git diff')
        if p.wait(timeout=10): raise RuntimeError('git diff 失败')
    finally:
        if p.poll() is None: p.kill()
        p.communicate()
    return dict(path=relative,patch=raw.decode('utf-8','replace'),staged=staged)
`
module.exports = { WORKSPACE }
