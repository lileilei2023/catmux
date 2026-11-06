'use strict'
const { EventEmitter } = require('events')
const P = require('./remote-protocol')
const { PythonPty } = require('./web-pty')

class RemoteConnections extends EventEmitter {
  constructor(service, createPty = (file, args) => new PythonPty(file, args)) {
    super(); this.service = service; this.createPty = createPty; this.links = new Map(); this.shuttingDown = false
  }
  state(id, status, detail = '') { this.emit('event', { type: 'state', id, status, detail }) }
  snapshot(id) { this.service.get(id); const l = this.links.get(id); return { data: l?.tail || '', status: l?.status || 'detached', detail: l?.detail || '' } }
  setState(id, link, status, detail = '') { link.status = status; link.detail = detail; this.state(id, status, detail) }
  disconnect(id) {
    const link = this.links.get(id)
    if (link) {
      link.desired = false; link.generation++; clearTimeout(link.timer); clearTimeout(link.stable)
      try { link.proc?.kill() } catch {}
      link.proc = null; this.setState(id, link, 'detached', '只断开本机；远端 agent 保留')
    } else this.state(id, 'detached', '远端 agent 保留')
  }
  async connect(id) {
    const record = this.service.get(id)
    // This runs only when the user explicitly connects a failed/partial record.
    // Reconcile its existing resources read-only; never retry create.
    if (['failed', 'creating'].includes(record.status)) {
      this.state(id, 'connecting', '只读核对原远端会话，不重建 agent')
      try { await this.service.recover(id) }
      catch (e) { this.state(id, 'blocked', e.message); throw e }
    }
    if (this.links.get(id)?.desired) return true // reloads/tabs reuse one transport
    const tail = this.links.get(id)?.tail || ''
    const previous = this.links.get(id)
    this.disconnect(id)
    const link = { desired: true, generation: 0, attempt: 0, cols: previous?.cols || 100, rows: previous?.rows || 28, proc: null, tail, status: 'connecting' }
    this.links.set(id, link); await this.attach(id, link); return true
  }
  async attach(id, link) {
    if (!link.desired || this.shuttingDown || this.links.get(id) !== link) return
    const generation = ++link.generation
    this.setState(id, link, link.attempt ? 'reconnecting' : 'connecting')
    try {
      const s = this.service.get(id), info = await this.service.inspect(id)
      if (!link.desired || generation !== link.generation) return
      if (!info) { link.desired = false; this.setState(id, link, 'missing', this.service.revivable(s) ? '远端 tmux 会话不存在（设备可能重启过）。点「恢复会话」在原目录重建并接上原对话' : '远端会话不存在，不会重建 agent'); return }
      const spec = P.attachSpec(s, this.service.bins)
      if (!spec.file) throw new Error('本机找不到所选 SSH/tssh 客户端')
      const proc = this.createPty(spec.file, spec.args)
      link.proc = proc
      let handshake = '', confirmed = false, fatal = false
      proc.on('data', data => {
        if (generation !== link.generation) return
        link.tail = (link.tail + data).slice(-128 * 1024)
        handshake = (handshake + data).slice(-2048)
        if (!confirmed && /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|unable to authenticate|ssh:.*Permission denied/i.test(handshake)) fatal = true
        if (!confirmed && handshake.includes(`\x1b]777;AIHUB_READY:${id}\x07`)) {
          confirmed = true
          this.setState(id, link, 'connected', `${s.transport === 'local' ? '本机 tmux 已连接' : (s.transport === 'udp' ? 'tssh UDP' : 'SSH TCP') + ' 远端握手完成'} · 同一 tmux 会话`)
        }
        this.emit('event', { type: 'data', id, data })
      })
      proc.on('error', error => { if (generation === link.generation) { fatal = true; this.setState(id, link, 'blocked', error.message); proc.kill() } })
      proc.on('exit', ({ exitCode }) => {
        if (generation !== link.generation) return
        link.proc = null; clearTimeout(link.stable)
        if (!link.desired || this.shuttingDown) return
        if (!exitCode || fatal) { link.desired = false; this.setState(id, link, fatal ? 'blocked' : 'detached', fatal ? '客户端校验/运行失败，停止自动重试' : '连接正常退出，远端会话保留'); return }
        this.retry(id, link, `连接进程退出 (${exitCode})`)
      })
      proc.resize(link.cols, link.rows)
      this.setState(id, link, 'attached', '本机传输进程已启动，等待远端握手')
      link.stable = setTimeout(() => { if (generation === link.generation && confirmed) link.attempt = 0 }, 15000)
    } catch (error) {
      if (!link.desired || generation !== link.generation) return
      if (error.code === 'network' || /超时|timed out|Connection refused|No route|reset by peer/.test(error.message)) this.retry(id, link, error.message)
      else { link.desired = false; this.setState(id, link, 'blocked', error.message) }
    }
  }
  retry(id, link, detail) {
    if (!link.desired || this.shuttingDown) return
    const delay = P.retryDelay(link.attempt++)
    this.setState(id, link, 'reconnecting', `${detail}；${delay / 1000} 秒后重新附着，不重建 agent`)
    link.timer = setTimeout(() => this.attach(id, link), delay)
  }
  write(id, data) {
    this.service.get(id)
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new Error('终端输入无效或过大')
    const pty = this.links.get(id)?.proc
    if (!pty) throw new Error('请先连接终端')
    pty.write(data); return true
  }
  // A reload replays raw history, which may start mid-escape-sequence. Make the
  // full-screen app (tmux) repaint once: shrink one row, then restore.
  redraw(id) {
    this.service.get(id)
    const link = this.links.get(id)
    if (!link?.proc || link.status !== 'connected') return false
    const { cols, rows } = link
    link.proc.resize(cols, Math.max(2, rows - 1))
    setTimeout(() => { if (link.proc) link.proc.resize(link.cols, link.rows) }, 60)
    return true
  }
  resize(id, cols, rows) {
    this.service.get(id)
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 200) throw new Error('终端尺寸无效')
    const link = this.links.get(id)
    if (link) { link.cols = cols; link.rows = rows; link.proc?.resize(cols, rows) }
    return true
  }
  close() { this.shuttingDown = true; for (const id of this.links.keys()) this.disconnect(id) }
}
module.exports = { RemoteConnections }
