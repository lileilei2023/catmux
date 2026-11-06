'use strict'
// One Catmux window. A second one (Dock click, bookmark, history, a stray tab)
// asks whether a window is already open; if so it hands over and closes itself.
;(() => {
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('catmux-window') : null
  const me = Math.random().toString(36).slice(2)
  let primary = false
  channel?.addEventListener('message', e => {
    const m = e.data || {}
    if (m.type === 'hello' && primary && m.from !== me) { channel.postMessage({ type: 'here', to: m.from }); window.focus() }
  })
  let forced = false
  try { forced = sessionStorage.getItem('catmux-here') === '1' } catch {}
  // Resolves true when this window should run Catmux.
  function claim() {
    if (!channel || forced) { primary = true; return Promise.resolve(true) }
    return new Promise(resolve => {
      const done = result => { channel.removeEventListener('message', reply); clearTimeout(timer); primary = result; resolve(result) }
      const reply = e => { if (e.data?.type === 'here' && e.data.to === me) done(false) }
      channel.addEventListener('message', reply)
      channel.postMessage({ type: 'hello', from: me })
      const timer = setTimeout(() => done(true), 250)
    })
  }
  // This window is the duplicate: close it, or explain if the browser refuses.
  function duplicate() {
    window.close()
    setTimeout(() => {
      if (document.getElementById('single-note')) return
      const box = document.createElement('div'); box.id = 'single-note'; box.className = 'single-note'
      const card = document.createElement('div'); card.className = 'single-card'
      const title = document.createElement('b'); title.textContent = 'Catmux 已在另一个窗口打开'
      const text = document.createElement('p'); text.textContent = '同时开多个窗口会各自连接、互相抢输入。请回到原来的窗口使用，这个可以关掉。'
      const close = document.createElement('button'); close.className = 'primary'; close.textContent = '关闭此窗口'; close.onclick = () => { window.close(); setTimeout(() => { close.textContent = '请按 ⌘W 关闭此窗口' }, 200) }
      const here = document.createElement('button'); here.textContent = '仍在这里打开'
      here.onclick = () => { try { sessionStorage.setItem('catmux-here', '1') } catch {}; location.reload() }
      card.append(title, text, close, here); box.append(card); document.body.append(box)
      document.body.classList.remove('booting'); document.body.dataset.ready = 'duplicate'
    }, 300)
  }
  window.AIHubSingle = { claim, duplicate }
})()
