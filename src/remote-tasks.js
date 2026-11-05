'use strict'

// Task lifecycle on the device that owns the repository: start-branch choice,
// end-of-task status, clean-up and push + PR. Runs through the existing SSH
// Python protocol. Safety rules:
// - only ever touches branch aihub/<task id> and worktree
//   ~/.local/share/ai-hub/worktrees/<task id>, both derived from the task id;
// - never forces (no worktree remove --force, no push --force);
// - "merged" means GitHub reports a MERGED pull request (squash-safe), or —
//   without GitHub — git proves the branch's content is already in the target
//   (merging it would change nothing: covers merge, fast-forward and squash);
// - every action re-checks its conditions right before acting.
const TASKS = String.raw`
def sh(args, cwd=None, timeout=60, env_extra=None):
    env=dict(os.environ)
    if env_extra: env.update(env_extra)
    env.update({'GIT_TERMINAL_PROMPT':'0','GH_PROMPT_DISABLED':'1','GH_NO_UPDATE_NOTIFIER':'1','NO_COLOR':'1','GIT_PAGER':'cat'})
    try: p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,env=env)
    except subprocess.TimeoutExpired: return 124,'','操作超时：'+' '.join(args[:3])
    except FileNotFoundError: return 127,'','找不到命令 '+args[0]
    return p.returncode,p.stdout.decode('utf-8','replace').strip(),p.stderr.decode('utf-8','replace').strip()
def volume_of(path):
    parts=os.path.normpath(path).split('/')
    return '/'+parts[1]+'/'+parts[2] if len(parts)>2 and parts[1]=='Volumes' and parts[2] else None
def unmounted(vol, what='主仓库'):
    return RuntimeError('MOUNT:'+what+'所在磁盘 '+vol+' 未挂载。请先在这台设备上挂载它（例如在 Finder 里重新连接外置盘），再进行 Git 操作；agent 与 worktree 里的文件不受影响。')
def mount_guard(path):
    # Main repository on an external disk, or a linked worktree whose .git file
    # points there: give a clear message instead of a cryptic git error.
    vol=volume_of(path)
    if vol and not os.path.ismount(vol): raise unmounted(vol)
    d=os.path.abspath(path)
    while True:
        g=os.path.join(d,'.git')
        if os.path.isfile(g):
            try: line=open(g).read().strip()
            except OSError: return
            if line.startswith('gitdir:'):
                target=line[7:].strip(); tv=volume_of(target)
                if tv and not os.path.ismount(tv): raise unmounted(tv)
            return
        if os.path.isdir(g): return
        parent=os.path.dirname(d)
        if parent==d: return
        d=parent
BRANCH_RE=re.compile(r'^(?!-)(?!.*\.\.)(?!.*//)(?!.*@\{)(?!.*\.lock$)(?!.*/$)(?!.*\.$)[A-Za-z0-9._/+-]{1,200}$')
def valid_ref(name):
    if not isinstance(name,str) or not BRANCH_RE.match(name): raise RuntimeError('分支名无效：'+str(name))
    return name
def list_branches(project):
    root=repo(project)
    code,out,err=sh(['git','-C',root,'for-each-ref','--sort=-committerdate','--format=%(refname)%09%(refname:short)%09%(objectname:short)%09%(committerdate:unix)%09%(subject)','refs/heads','refs/remotes'])
    if code: raise RuntimeError(err or 'git for-each-ref 失败')
    local=[]; remote=[]
    for line in out.splitlines():
        cols=line.split('\t',4)
        if len(cols)<5 or cols[0].endswith('/HEAD'): continue
        item=dict(name=cols[1],sha=cols[2],at=int(cols[3] or 0),subject=cols[4][:120])
        (local if cols[0].startswith('refs/heads/') else remote).append(item)
        if len(local)+len(remote)>=400: break
    return dict(root=root,current=sh(['git','-C',root,'branch','--show-current'])[1],local=local,remote=remote)
def has_ref(root, ref): return sh(['git','-C',root,'rev-parse','--verify','--quiet',ref+'^{commit}'])[0]==0
def resolve_base(root, base):
    # "develop" = the local branch, unless origin/develop is strictly newer
    # (local is an ancestor): then start from origin/develop. No automatic fetch.
    valid_ref(base)
    local,remote='refs/heads/'+base,'refs/remotes/origin/'+base
    if has_ref(root,local):
        if has_ref(root,remote) and sh(['git','-C',root,'rev-parse',local])[1]!=sh(['git','-C',root,'rev-parse',remote])[1] and sh(['git','-C',root,'merge-base','--is-ancestor',local,remote])[0]==0: return remote
        return local
    for ref in ('refs/remotes/'+base,remote):
        if has_ref(root,ref): return ref
    raise RuntimeError('起点分支 '+base+' 不存在（本地与远端跟踪分支都没有）')
def task_paths(arg):
    tid=arg['id']
    if not re.match(r'^[a-f0-9]{32}$',tid): raise RuntimeError('任务 ID 无效')
    if arg.get('tmux') not in (None,'aihub-'+tid): raise RuntimeError('只处理 Catmux 自己创建的任务')
    return os.path.join(os.path.expanduser('~'),'.local','share','ai-hub','worktrees',tid),'aihub/'+tid
def target_ref(root, target):
    for ref in ('refs/remotes/origin/'+target,'refs/heads/'+target):
        if sh(['git','-C',root,'rev-parse','--verify','--quiet',ref])[0]==0: return ref
    return None
def rev_count(root, rng):
    code,out,_=sh(['git','-C',root,'rev-list','--count',rng])
    return int(out) if code==0 and out.isdigit() else None
def origin_info(root):
    # Raw configured URL (not insteadOf-expanded): that is what the user set up.
    code,url,_=sh(['git','-C',root,'config','--get','remote.origin.url'])
    if code or not url: return dict(url='',host='',github=False)
    m=re.match(r'^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)',url)
    host=(m.group(1) if m else '').lower()
    return dict(url=re.sub(r'//[^@/]+@','//',url),host=host,github=host=='github.com' or host.endswith('.github.com'))
def content_merged(root, tref, branch):
    # True when merging the branch into the target would not change the
    # target's tree, i.e. everything the branch did is already there. Works
    # offline and for squash merges. Older git: plain ancestry only.
    # merge-tree writes objects: send them to a throw-away object directory (the
    # real one is a read-only alternate) so a status check never changes the repo.
    common=sh(['git','-C',root,'rev-parse','--path-format=absolute','--git-common-dir'])[1]
    scratch=tempfile.mkdtemp(prefix='aihub-mt-')
    try:
        code,out,_=sh(['git','-C',root,'merge-tree','--write-tree',tref,'refs/heads/'+branch],env_extra={'GIT_OBJECT_DIRECTORY':scratch,'GIT_ALTERNATE_OBJECT_DIRECTORIES':os.path.join(common,'objects')})
    finally: shutil.rmtree(scratch,ignore_errors=True)
    if code in (0,1) and out:
        if code==1: return False # conflicts: not contained
        return out.splitlines()[0].strip()==sh(['git','-C',root,'rev-parse',tref+'^{tree}'])[1]
    return sh(['git','-C',root,'merge-base','--is-ancestor','refs/heads/'+branch,tref])[0]==0
def gh_prs(root, branch):
    if not shutil.which('gh'): return dict(available=False,error='这台设备没有安装 gh（GitHub CLI）',prs=[])
    code,out,err=sh(['gh','pr','list','--head',branch,'--state','all','--limit','20','--json','number,state,url,headRefOid,baseRefName,title,mergedAt'],cwd=root,timeout=40)
    if code: return dict(available=False,error=(err or out or 'gh 调用失败')[:400],prs=[])
    try: prs=json.loads(out or '[]')
    except ValueError: return dict(available=False,error='gh 输出无法解析',prs=[])
    return dict(available=True,error='',prs=prs if isinstance(prs,list) else [])
def task_status(arg, with_gh=True):
    project=arg['project']
    wt,branch=task_paths(arg)
    root=repo(project)
    target=valid_ref(arg.get('target') or 'main')
    st=dict(root=root,worktree=wt,branch=branch,target=target,worktreeExists=os.path.isdir(wt))
    st['branchExists']=sh(['git','-C',root,'rev-parse','--verify','--quiet','refs/heads/'+branch])[0]==0
    dirty=[]
    if st['worktreeExists']:
        mount_guard(wt)
        code,out,err=sh(['git','-C',wt,'status','--porcelain=v1','--untracked-files=all'])
        if code: raise RuntimeError(err or 'git status 失败')
        dirty=[l for l in out.split('\n') if l.strip()]
    st['dirty']=dirty[:60]; st['dirtyCount']=len(dirty)
    tref=target_ref(root,target); st['targetRef']=tref
    st['head']=sh(['git','-C',root,'rev-parse','refs/heads/'+branch])[1] if st['branchExists'] else None
    st['ahead']=rev_count(root,tref+'..refs/heads/'+branch) if tref and st['branchExists'] else None
    up='refs/remotes/origin/'+branch
    st['pushed']=sh(['git','-C',root,'rev-parse','--verify','--quiet',up])[0]==0
    st['unpushed']=(rev_count(root,up+'..refs/heads/'+branch) if st['pushed'] else st['ahead']) if st['branchExists'] else None
    st['commits']=sh(['git','-C',root,'log','--format=%h %s','-n','30',tref+'..refs/heads/'+branch])[1].splitlines() if tref and st['branchExists'] else []
    origin=origin_info(root); st['origin']=origin
    if not origin['url']: gh=dict(available=False,error='没有 origin 远端',prs=[])
    elif not origin['github']: gh=dict(available=False,error='origin 不是 GitHub（'+origin['host']+'），无法用 gh 查 PR',prs=[])
    else: gh=gh_prs(root,branch) if with_gh and st['branchExists'] else dict(available=False,error='',prs=[])
    st['gh']=gh
    merged=next((p for p in gh['prs'] if p.get('state')=='MERGED'),None)
    st['mergedPr']=merged
    st['openPr']=next((p for p in gh['prs'] if p.get('state')=='OPEN'),None)
    after=None
    if merged and st['branchExists'] and merged.get('headRefOid'):
        oid=merged['headRefOid']
        if st['head']==oid: after=0
        elif sh(['git','-C',root,'cat-file','-e',oid+'^{commit}'])[0]==0: after=rev_count(root,oid+'..refs/heads/'+branch)
        else: after=-1
    st['afterMerge']=after
    st['contentMerged']=bool(tref and st['branchExists'] and st['ahead'] and content_merged(root,tref,branch))
    reasons=[]
    if st['dirtyCount']: reasons.append('worktree 里有 '+str(st['dirtyCount'])+' 个未提交 / 未跟踪的改动')
    if st['branchExists']:
        if merged:
            if after and after>0 and not st['contentMerged']: reasons.append('PR #'+str(merged['number'])+' 合并后，分支又有 '+str(after)+' 个新提交')
            elif after==-1 and not st['contentMerged']: reasons.append('本地找不到 PR #'+str(merged['number'])+' 合并时的提交，无法确认没有后续改动（可先 git fetch）')
        elif tref is None: reasons.append('找不到目标分支 '+target+'，无法判断分支是否有自己的提交')
        elif st['ahead'] and not st['contentMerged']:
            if st['openPr']: reasons.append('PR #'+str(st['openPr']['number'])+' 还没有合并（OPEN）')
            elif not gh['available']: reasons.append('分支有 '+str(st['ahead'])+' 个提交，内容还没有进入 '+target+'（git 判断）；也无法用 gh 确认 PR：'+gh['error'])
            else: reasons.append('分支有 '+str(st['ahead'])+' 个提交，但没有找到已合并（MERGED）的 PR，内容也还不在 '+target+' 里')
    st['reasons']=reasons; st['cleanable']=not reasons
    return st
def stop_task_tmux(arg):
    name=arg.get('tmux')
    if name and name=='aihub-'+arg['id'] and subprocess.run(['tmux','has-session','-t',exact(name)],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode==0:
        run(['tmux','kill-session','-t',exact(name)])
        return True
    return False
def task_clean(arg):
    st=task_status(arg)
    if not st['cleanable']: raise RuntimeError('BLOCKED:'+json.dumps(st['reasons'],ensure_ascii=False))
    stopped=stop_task_tmux(arg) # nothing may write into the worktree while it is removed
    removed=deleted=False
    if st['worktreeExists']:
        code,_,err=sh(['git','-C',st['root'],'worktree','remove',st['worktree']])
        if code: raise RuntimeError('git worktree remove 失败（没有强制删除，文件仍在）：'+err)
        removed=True
    if st['branchExists']:
        # Squash merges leave the branch "unmerged" for git; GitHub already said MERGED.
        code,_,err=sh(['git','-C',st['root'],'branch','-D',st['branch']])
        if code: raise RuntimeError('本地分支删除失败：'+err)
        deleted=True
    return dict(stopped=stopped,removedWorktree=removed,deletedBranch=deleted,worktree=st['worktree'],branch=st['branch'],mergedPr=st['mergedPr'])
def task_pr(arg):
    st=task_status(arg)
    branch=st['branch']; target=st['target']
    if not st['branchExists']: raise RuntimeError('本地分支 '+branch+' 不存在')
    if st['dirtyCount'] and not arg.get('allowDirty'): raise RuntimeError('DIRTY:'+json.dumps(st['dirty'],ensure_ascii=False))
    if st['targetRef'] is None: raise RuntimeError('找不到目标分支 '+target+'（本地与 origin 都没有）')
    if not st['ahead']: raise RuntimeError('分支相对 '+target+' 没有新提交，不需要开 PR')
    if not st['origin']['url']: raise RuntimeError('没有 origin 远端，无法推送；可以本地合并到 '+target+' 后用“清理”')
    can_pr=st['origin']['github'] and shutil.which('gh')
    if not can_pr and not arg.get('pushOnly'): raise RuntimeError('NOGH:'+(st['gh']['error'] or '这台设备没有安装 gh（GitHub CLI）'))
    code,_,err=sh(['git','-C',st['root'],'push','-u','origin',branch+':'+branch],timeout=150)
    if code: raise RuntimeError('git push 失败（没有强制推送）：'+err[-800:])
    # Hosting services print "create a merge/pull request" links on push.
    links=re.findall(r'https?://\S+',err)
    if not can_pr:
        result=dict(url=links[0] if links else '',links=links[:5],created=False,pushed=True,pushOnly=True,remote=st['origin']['host'])
        if arg.get('stopAfter'): result['stopped']=stop_task_tmux(arg)
        return result
    if st['openPr']:
        result=dict(url=st['openPr']['url'],number=st['openPr']['number'],created=False,pushed=True)
    else:
        code,out,err=sh(['gh','pr','create','--base',target,'--head',branch,'--title',arg['title'],'--body',arg.get('body') or ''],cwd=st['root'],timeout=90)
        if code: raise RuntimeError('gh pr create 失败：'+(err or out)[-800:])
        result=dict(url=(out.splitlines() or [''])[-1],created=True,pushed=True)
    if arg.get('stopAfter'): result['stopped']=stop_task_tmux(arg)
    return result
`
module.exports = { TASKS }
