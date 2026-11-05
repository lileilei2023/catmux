'use strict'
const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const { StringDecoder } = require('string_decoder')
const path = require('path')
const { binary, environment } = require('./remote-service')

class PythonPty extends EventEmitter {
  constructor(file, args) {
    super()
    const python = binary('python3')
    if (!python) throw new Error('本机需要 Python 3（仅标准库，无需 Xcode/Electron）')
    this.decoder = new StringDecoder('utf8')
    this.exited = false
    this.child = spawn(python, [path.join(__dirname, 'pty-helper.py'), file, ...args], { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    let pending = '', diagnostic = ''
    this.child.stdout.on('data', chunk => {
      pending += chunk.toString()
      if (pending.length > 1024 * 1024) { this.emit('error', new Error('PTY 事件过大')); this.kill(); return }
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1)
        try {
          const event = JSON.parse(line)
          if (event.type === 'data') this.emit('data', this.decoder.write(Buffer.from(event.data, 'base64')))
          else if (event.type === 'exit') this.exit(event.code)
          else if (event.type === 'error') this.emit('error', new Error(event.error))
        } catch (error) { this.emit('error', error); this.kill() }
      }
    })
    this.child.stderr.on('data', c => { diagnostic = (diagnostic + c.toString()).slice(-2000) })
    this.child.on('error', e => { this.emit('error', e); this.exit(-1) })
    this.child.on('close', code => { if (!this.exited && diagnostic) this.emit('error', new Error(diagnostic)); this.exit(code ?? -1) })
    this.child.stdin.on('error', () => {})
  }
  exit(code) { if (this.exited) return; this.exited = true; const last = this.decoder.end(); if (last) this.emit('data', last); this.emit('exit', { exitCode: code }) }
  send(event) { if (this.exited) throw new Error('终端已断开'); this.child.stdin.write(JSON.stringify(event) + '\n') }
  write(data) { this.send({ type: 'write', data: Buffer.from(data).toString('base64') }) }
  resize(cols, rows) { this.send({ type: 'resize', cols, rows }) }
  kill() { if (!this.exited) { try { this.send({ type: 'close' }); this.child.stdin.end() } catch {} } }
}
module.exports = { PythonPty }
