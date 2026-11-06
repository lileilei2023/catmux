'use strict'

const crypto = require('crypto')
const TOOLS = ['codex', 'claude', 'gemini', 'shell']
// "This Mac" as a device: same protocol and tmux model, executed locally
// instead of over SSH. Reserved alias; an ssh-config Host with this name is hidden.
const LOCAL = 'local'
// Capabilities of xterm.js announced to tmux for our client (no extkeys / margins:
// xterm.js does not implement CSI-u extended keys or left/right margins).
const TERMINAL_FEATURES = '256,RGB,sync,bpaste,focus,title,ccolour,cstyle,strikethrough,usstyle,clipboard'
const SAFE_SSH = ['-a', '-x', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  '-o', 'RemoteCommand=none']

// Permission presets per official CLI, verified against the versions on the
// Mini (codex-cli 0.163.0-alpha, Claude Code 2.1.308). Flags change between
// releases, so presets are data and anything else goes through "extra args".
const LAUNCH_PRESETS = {
  codex: [
    { key: 'default', label: '默认（按 CLI 自身配置询问）', args: [] },
    { key: 'auto', label: '自动编辑（工作区沙箱，必要时询问）', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
    { key: 'full', label: '完全权限（跳过所有确认，无沙箱）', args: ['--dangerously-bypass-approvals-and-sandbox'], danger: true }
  ],
  claude: [
    { key: 'default', label: '默认（按 CLI 自身配置询问）', args: [] },
    { key: 'auto', label: '自动接受编辑（acceptEdits）', args: ['--permission-mode', 'acceptEdits'] },
    { key: 'full', label: '完全权限（跳过所有权限检查）', args: ['--dangerously-skip-permissions'], danger: true }
  ],
  gemini: [{ key: 'default', label: '默认', args: [] }],
  shell: [{ key: 'default', label: '默认', args: [] }]
}
// What the user asked for: Codex and Claude start with full permission unless
// changed in the create dialog (and saved as that tool's default).
const LAUNCH_DEFAULTS = { codex: { preset: 'full', extra: [] }, claude: { preset: 'full', extra: [] }, gemini: { preset: 'default', extra: [] }, shell: { preset: 'default', extra: [] } }
function launchArgs(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 40) throw new Error('启动参数最多 40 个')
  for (const a of value) if (typeof a !== 'string' || !a || a.length > 1024 || /[\x00-\x1f\x7f]/.test(a)) throw new Error('启动参数无效（不能为空或含换行 / 控制字符）')
  return [...value]
}
function launchFor(tool, preset = 'default', extra = []) {
  const list = LAUNCH_PRESETS[tool]
  if (!list) throw new Error('工具无效')
  const p = list.find(x => x.key === preset)
  if (!p) throw new Error('权限模式无效')
  const more = launchArgs(extra)
  if (tool === 'shell' && more.length) throw new Error('远程 Shell 不接受启动参数')
  return { preset: p.key, extra: more, args: [...p.args, ...more], danger: !!p.danger || more.some(a => /^--(dangerously|yolo)/.test(a)) }
}
function commandLine(tool, args = []) { return [tool, ...args].map(a => /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : quote(a)).join(' ') }
function text(value, label, max = 1024) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}无效`)
  return value
}
function hostAlias(value) {
  text(value, 'SSH 别名', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error('请选择 ~/.ssh/config 中的主机别名')
  return value
}
function remotePath(value) {
  text(value, '远程路径', 4096)
  if (!value.startsWith('/')) throw new Error('远程项目必须使用绝对路径')
  // "/a/b/." and "/a/b/" are the same directory; keep one canonical spelling.
  return value.length > 1 ? value.replace(/(\/\.)+$/, '').replace(/\/+$/, '') || '/' : value
}
function workspacePath(value, allowRoot = false) {
  if (value === '' && allowRoot) return value
  text(value, '项目相对路径', 4096)
  if (value.startsWith('/') || value.split('/').some(p => ['', '.', '..'].includes(p))) throw new Error('路径必须在当前项目内')
  for (const p of value.split('/')) {
    if (/^(\.git|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.local|\.codex|\.claude|\.gemini|\.npmrc|\.netrc|auth\.json|settings\.json|config\.toml)$/i.test(p) || /^(\.env|id_rsa|id_ed25519|id_ecdsa|id_dsa)/i.test(p) || /credential|secret|token|password/i.test(p) || /\.(pem|key|env|p12|pfx)$/i.test(p)) throw new Error('凭据 / 模型配置路径不允许访问')
  }
  return value
}
// Git branch names accepted for start / PR target (subset of git check-ref-format).
function branchName(value, label = '分支名') {
  if (typeof value !== 'string' || !/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)(?!.*\.$)[A-Za-z0-9._\/+-]{1,200}$/.test(value)) throw new Error(`${label}无效`)
  return value
}
function sessionId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('会话 ID 无效')
  return value
}
function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'` }
function loginCommand(script) {
  // The script travels once, as $0 of the outer sh (not once per branch).
  const dispatch = 'if [ "$(uname -s)" = Darwin ]; then exec zsh -lc "$0"; else exec bash -lc "$0"; fi'
  // tsshd executes argv, not shell operators. The outer sh is required.
  return `sh -c ${quote(dispatch)} ${quote(script)}`
}
function newSession(opts) {
  const tool = opts.tool || 'codex'
  if (!TOOLS.includes(tool)) throw new Error('仅支持官方 Codex / Claude / Gemini 或远程 shell')
  const mode = opts.mode || 'direct'
  if (mode === 'squad') throw new Error('Claude Squad 模式已移除：请直接新建会话（Catmux 自带独立 worktree 与多会话管理）')
  if (mode !== 'direct') throw new Error('会话模式无效')
  const transport = opts.host === LOCAL ? 'local' : opts.transport || 'udp'
  if (!['udp', 'ssh', 'local'].includes(transport) || (transport === 'local') !== (opts.host === LOCAL)) throw new Error('传输模式无效')
  const id = crypto.randomUUID().replace(/-/g, '')
  const launch = launchFor(tool, opts.preset || (tool === 'shell' ? 'default' : LAUNCH_DEFAULTS[tool].preset), opts.extra || [])
  return { id, name: text(opts.name || tool, '名称', 100), host: hostAlias(opts.host), launch,
    project: remotePath(opts.project), cwd: remotePath(opts.project), tool, mode, transport,
    worktree: mode === 'direct' && tool !== 'shell' && !!opts.worktree,
    group: typeof opts.group === 'string' ? opts.group.trim().slice(0, 100) : '',
    tmux: mode === 'direct' ? `aihub-${id}` : null, owned: true,
    // Claude's conversation id, chosen up front so it can be resumed after a reboot.
    ...(tool === 'claude' ? { agentSession: crypto.randomUUID() } : {}),
    createdAt: Date.now(), status: 'creating' }
}
function attachSpec(session, bins) {
  hostAlias(session.host)
  sessionId(session.id)
  const ready = `printf '\\033]777;AIHUB_READY:${session.id}\\007'; `
  if (session.mode === 'squad' || !session.tmux) throw new Error('Claude Squad 模式已移除；这条旧记录可以从列表移除')
  text(session.tmux, 'tmux 名称', 200)
  // Tell tmux what the browser terminal (xterm.js) supports: 'sync' makes tmux
  // wrap each redraw in synchronized-output markers (no half-drawn frames),
  // RGB keeps 24-bit colour. `tmux -T` (client option, tmux >= 3.2); older ones attach plainly.
  const target = quote('=' + session.tmux)
  const script = ready + `case "$(tmux -V 2>/dev/null)" in "tmux 1."*|"tmux 2."*|"tmux 3.0"*|"tmux 3.1"*) exec tmux attach-session -t ${target};; *) exec tmux -T ${TERMINAL_FEATURES} attach-session -t ${target};; esac`
  if (session.host === LOCAL) return { file: '/bin/sh', args: ['-c', loginCommand(script)] }
  const udp = session.transport === 'udp'
  return { file: udp ? bins.tssh : bins.ssh,
    args: [...SAFE_SSH, ...(udp ? ['--udp'] : []), '-t', session.host, loginCommand(script)] }
}
function attachmentRef(tool, file) {
  remotePath(file)
  // A path reference only: no Enter and no tool-specific permission/model flags.
  return tool === 'claude' ? `@${quote(file)} ` : `${quote(file)} `
}
function retryDelay(attempt) { return Math.min(45000, 2000 * 2 ** Math.min(6, attempt)) }
function attachmentName(name) {
  const base = String(name || 'screenshot.png').split(/[\\/]/).pop()
  if (/^(\.env.*|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa|dsa)(\..*)?|auth\.json|credentials.*|secrets.*|settings\.json|config\.toml)$/i.test(base) || /\.(pem|key|env)$/i.test(base)) throw new Error('不允许上传私钥、登录凭据或模型配置文件，请选择截图 / 项目文件')
  return base
}

// How long tssh may keep failing to reconnect before Catmux replaces it.
const TSSH_TAKEOVER_MS = 25000
module.exports = { TSSH_TAKEOVER_MS, branchName, LOCAL, TERMINAL_FEATURES, LAUNCH_PRESETS, LAUNCH_DEFAULTS, launchArgs, launchFor, commandLine, TOOLS, SAFE_SSH, text, hostAlias, remotePath, workspacePath, sessionId, quote, loginCommand, newSession, attachSpec, attachmentRef, retryDelay, attachmentName }
