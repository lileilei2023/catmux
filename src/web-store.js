'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const P = require('./remote-protocol')

// Web mode stores metadata only. No Electron / native SQLite dependency and
// no read or migration of the installed desktop application's database.
class JsonStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Web 数据目录归属不正确')
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Web 数据目录需要 0700 权限；不会自动修改已有目录')
    this.file = path.join(dir, 'remote-sessions.json')
    this.lockFile = path.join(dir, 'remote-sessions.lock')
    this.owner = crypto.randomUUID()
    this.rows = new Map()
    if (fs.existsSync(this.file)) {
      const stateStat = fs.lstatSync(this.file)
      if (stateStat.isSymbolicLink() || stateStat.size > 4 * 1024 * 1024 || (process.getuid && stateStat.uid !== process.getuid())) throw new Error('Web 会话元数据文件无效')
      const records = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(records) || records.length > 1000) throw new Error('Web 会话记录格式无效；保留文件，不会重置')
      for (const s of records) { P.sessionId(s.id); P.hostAlias(s.host); P.remotePath(s.project); this.rows.set(s.id, s) }
    }
    try { this.lock = fs.openSync(this.lockFile, 'wx', 0o600) } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const st = fs.lstatSync(this.lockFile)
      if (st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('Web 数据锁归属不正确')
      const old = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
      if (old.kind !== 'aihub-web-store' || !Number.isInteger(old.pid) || old.pid <= 0) throw new Error('Web 数据锁无效；请手动核查')
      try { process.kill(old.pid, 0); throw new Error('Web 数据目录已由另一个进程使用') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      fs.unlinkSync(this.lockFile) // only a validated, same-owner, stale app lock
      this.lock = fs.openSync(this.lockFile, 'wx', 0o600)
    }
    fs.writeFileSync(this.lock, JSON.stringify({ kind: 'aihub-web-store', pid: process.pid, owner: this.owner }))
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak.${Date.now()}`)
  }
  list() { return [...this.rows.values()].map(s => ({ ...s })) }
  get(id) { const s = this.rows.get(id); return s ? { ...s } : null }
  save() {
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`
    let fd
    try {
      fd = fs.openSync(tmp, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify(this.list(), null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = null
      fs.renameSync(tmp, this.file)
    } finally { if (fd != null) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  }
  put(s) {
    P.sessionId(s.id)
    const previous = this.rows.get(s.id)
    if (!previous && this.rows.size >= 1000) throw new Error('会话数量已达到上限')
    this.rows.set(s.id, { ...s })
    try { this.save() } catch (e) { previous ? this.rows.set(s.id, previous) : this.rows.delete(s.id); throw e }
  }
  remove(id) {
    const previous = this.rows.get(id); this.rows.delete(id)
    try { this.save() } catch (e) { if (previous) this.rows.set(id, previous); throw e }
  }
  close() {
    if (this.lock != null) { fs.closeSync(this.lock); this.lock = null }
    if (fs.existsSync(this.lockFile)) {
      const current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
      if (current.owner === this.owner) fs.unlinkSync(this.lockFile)
    }
  }
}
module.exports = { JsonStore }
