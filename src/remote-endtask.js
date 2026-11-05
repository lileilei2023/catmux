'use strict'
// "结束任务" dialog: stop only / clean up worktree + branch / push and open a PR.
// The page only displays what the remote reports; every condition is re-checked
// on the device right before acting, so a stale dialog cannot do harm.
;(() => {
  const $ = id => document.getElementById(id)
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el }
  const prefixed = (message, prefix) => message.startsWith(prefix) ? message.slice(prefix.length) : null
  let ctx = null, session = null, status = null, target = '', seq = 0, busy = false

  function open(s, context) {
    ctx = context; session = s; status = null; busy = false
    target = s.prTarget || ''
    $('end-title').textContent = `结束任务 · ${s.name}`
    $('end-dialog').showModal()
    load()
  }
  async function load() {
    const my = ++seq, body = $('end-body')
    body.replaceChildren(node('div', '正在读取任务状态（git / gh）…', 'end-loading'))
    try {
      if (!target) { const d = await ctx.hub.projectSettings(session.host, session.project).catch(() => ({})); target = d.prTarget || 'main' }
      const r = await ctx.hub.taskStatus(session.id, target)
      if (my !== seq) return
      status = r; render()
    } catch (e) {
      if (my !== seq) return
      status = { error: e.message }; render()
    }
  }
  function card(title, text, className = '') {
    const box = node('section', null, 'end-card ' + className)
    box.append(node('h3', title)); if (text) box.append(node('p', text, 'muted'))
    return box
  }
  function stopCard() {
    const box = card('只停止 agent', '结束 tmux 会话；worktree、分支和未提交改动都原样保留。')
    const b = node('button', '只停止', 'mini'); b.disabled = session.status === 'stopped'
    b.onclick = () => run(async () => { if (await ctx.stopSession(session.id) !== false) { close(); ctx.toast('已停止 agent；worktree 与分支保留') } })
    box.append(b); return box
  }
  function render() {
    const body = $('end-body'); body.replaceChildren()
    if (status.error) {
      const mount = prefixed(status.error, 'MOUNT:')
      body.append(node('div', mount || status.error, 'end-banner ' + (mount ? 'warn' : 'error')))
      body.append(stopCard()); return
    }
    if (!status.task) { body.append(node('p', status.reason, 'muted')); body.append(stopCard()); return }
    body.append(summary())
    body.append(stopCard(), cleanCard(), prCard())
  }
  function summary() {
    const s = status, box = node('div', null, 'end-summary')
    const row = (k, v, cls = '') => { const r = node('div', null, 'end-row ' + cls); r.append(node('span', k), v instanceof Node ? v : node('b', v)); box.append(r) }
    row('分支', `${s.branch}${session.base ? `（起点 ${session.base}）` : ''}`)
    const t = node('span', null, 'end-target')
    const input = node('input'); input.value = target; input.spellcheck = false; input.setAttribute('aria-label', 'PR 目标分支')
    input.onchange = () => { const v = input.value.trim(); if (v && v !== target) { target = v; load() } }
    const save = node('button', '设为项目默认', 'link'); save.onclick = () => run(async () => {
      const d = await ctx.hub.projectSettings(session.host, session.project).catch(() => ({}))
      await ctx.hub.setProjectSettings(session.host, session.project, d.base || session.base || '', target); ctx.toast(`已将 ${target} 设为该项目的 PR 目标分支`)
    })
    t.append(input, save); row('PR 目标', t)
    row('worktree', s.worktreeExists ? s.worktree : `${s.worktree}（已不存在）`)
    row('远端', !s.origin?.url ? '没有 origin（纯本地仓库）' : `${s.origin.url}${s.origin.github ? '' : '（非 GitHub）'}`)
    row('提交', s.targetRef == null ? `找不到目标分支 ${s.target}` : `${s.ahead ?? '?'} 个新提交（相对 ${s.targetRef.replace(/^refs\/(remotes\/|heads\/)/, '')}）` + (s.unpushed ? ` · ${s.unpushed} 个未 push` : s.pushed ? ' · 已 push' : ''))
    if (s.commits?.length) { const list = node('ul', null, 'end-list'); for (const c of s.commits.slice(0, 8)) list.append(node('li', c)); if (s.commits.length > 8) list.append(node('li', `…共 ${s.commits.length} 个`)); box.append(list) }
    row('未提交改动', s.dirtyCount ? `${s.dirtyCount} 个` : '无', s.dirtyCount ? 'warn' : 'ok')
    if (s.dirtyCount) { const list = node('ul', null, 'end-list mono'); for (const l of s.dirty.slice(0, 10)) list.append(node('li', l)); if (s.dirtyCount > 10) list.append(node('li', `…共 ${s.dirtyCount} 个`)); box.append(list) }
    const pr = s.mergedPr || s.openPr
    const prText = !s.gh.available && s.gh.error ? `gh 不可用：${s.gh.error}` : pr ? `#${pr.number} ${pr.state === 'MERGED' ? '已合并' : '未合并（OPEN）'} → ${pr.baseRefName}` : '没有 PR'
    if (s.contentMerged) row('合并情况', `分支内容已包含在 ${s.target} 中（git 判断，含 squash / 本地合并）`, 'ok')
    const prRow = node('span'); prRow.append(node('b', prText)); if (pr?.url) { const a = node('a', ' 打开', 'link'); a.href = pr.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; prRow.append(a) }
    row('Pull Request', prRow, s.mergedPr ? 'ok' : '')
    return box
  }
  function cleanCard() {
    const s = status, box = card('清理 worktree 与分支', '先停止 agent，再 git worktree remove（不强制）并删除本地分支 ' + s.branch + '；远端分支保留。')
    if (!s.cleanable) {
      box.classList.add('blocked')
      const list = node('ul', null, 'end-reasons'); for (const r of s.reasons) list.append(node('li', r)); box.append(node('p', '现在不能清理：', 'end-why'), list)
      return box
    }
    box.append(node('p', s.mergedPr ? `PR #${s.mergedPr.number} 已合并（GitHub 显示 MERGED），且之后没有新提交、没有未提交改动。` : s.contentMerged ? `分支的全部改动已在 ${s.target} 里（git 判断），没有未提交改动。` : '分支没有自己的提交，也没有未提交改动。', 'end-ok'))
    const b = node('button', '清理', 'mini danger-btn')
    b.onclick = () => run(async () => {
      const r = await ctx.hub.taskClean(session.id, target, `清理任务「${session.name}」？\n\n将停止 agent，删除 worktree：\n${s.worktree}\n以及本地分支 ${s.branch}。\n远端分支、主仓库其他内容不受影响。`)
      if (r === false) return
      close(); ctx.toast(`已清理：${r.removedWorktree ? 'worktree 已删除' : 'worktree 原本不存在'}，${r.deletedBranch ? '本地分支已删除' : '本地分支原本不存在'}`); ctx.reload()
    })
    box.append(b); return box
  }
  function prCard() {
    const s = status, canPr = !!(s.origin?.github && s.gh.available)
    if (!s.origin?.url) {
      const box = card('推送并开 PR', '这个仓库没有 origin 远端，无法推送或开 PR。')
      box.append(node('p', `可以在终端里把 ${s.branch} 合并到 ${s.target}（普通合并或 squash 都行），然后用上面的“清理”：git 会确认改动已在 ${s.target} 中。`, 'muted'))
      return box
    }
    if (!canPr) return pushOnlyCard()
    const box = card('推送并开 PR', `git push -u origin ${s.branch}，然后 gh pr create --base <目标分支>。不会自动提交，也不会强制推送。`)
    if (s.openPr) box.append(node('p', `已有未合并的 PR #${s.openPr.number}：再次推送会更新它。`, 'muted'))
    const title = node('input'); title.placeholder = 'PR 标题'
    title.value = s.openPr?.title || (s.commits?.length === 1 ? s.commits[0].replace(/^\S+\s/, '') : session.name)
    const body = node('textarea', null, 'end-body-input')
    body.value = `## 改动\n${(s.commits || []).map(c => '- ' + c.replace(/^\S+\s/, '')).join('\n') || '- '}\n\n由 Catmux 任务「${session.name}」创建（分支 ${s.branch}${session.base ? `，起点 ${session.base}` : ''}）。`
    box.append(node('label', 'PR 标题'), title, node('label', 'PR 描述'), body)
    let allow = null
    if (s.dirtyCount) {
      const warn = node('div', null, 'end-banner warn')
      warn.append(node('div', `worktree 里有 ${s.dirtyCount} 个未提交 / 未跟踪的改动，它们不会进入 PR。可以先让 agent 提交，再回来开 PR。`))
      const label = node('label', null, 'checkbox inline'); allow = node('input'); allow.type = 'checkbox'
      label.append(allow, document.createTextNode('我知道，仍然只推送已提交的内容')); warn.append(label); box.append(warn)
    }
    const stopLabel = node('label', null, 'checkbox inline'), stopAfter = node('input'); stopAfter.type = 'checkbox'
    stopLabel.append(stopAfter, document.createTextNode('完成后停止 agent')); box.append(stopLabel)
    const b = node('button', s.openPr ? '推送并更新 PR' : '推送并创建 PR', 'mini primary')
    const problem = s.targetRef == null ? `找不到目标分支 ${s.target}` : !s.ahead ? `相对 ${s.target} 没有新提交` : !s.gh.available ? `gh 不可用：${s.gh.error || '未安装'}` : ''
    if (problem) { b.disabled = true; box.append(node('p', problem, 'end-why')) }
    const update = () => { if (!problem) b.disabled = busy || !title.value.trim() || (allow && !allow.checked) }
    title.oninput = update; if (allow) allow.onchange = update; update()
    const result = node('div', null, 'end-result')
    b.onclick = () => run(async () => {
      try {
        const r = await ctx.hub.taskPr(session.id, { target, title: title.value.trim(), body: body.value, allowDirty: !!allow?.checked, stopAfter: stopAfter.checked })
        result.replaceChildren(node('span', r.created ? 'PR 已创建：' : 'PR 已更新：'))
        const a = node('a', r.url, 'link'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; result.append(a)
        const copy = node('button', '复制链接', 'mini ghost'); copy.onclick = () => ctx.copyText(r.url, ' PR 链接'); result.append(copy)
        ctx.toast(r.created ? `PR 已创建 → ${target}` : 'PR 已更新'); ctx.reload()
      } catch (e) {
        const dirty = prefixed(e.message, 'DIRTY:')
        if (dirty) { ctx.toast('有未提交改动：请确认后再推送'); load(); return }
        throw e
      }
    })
    box.append(b, result); return box
  }
  // Non-GitHub remote (Gitee / GitLab / self-hosted) or no gh: push the branch only;
  // the hosting service usually prints a "create merge request" link, shown here.
  function pushOnlyCard() {
    const s = status, box = card('推送分支', `origin 是 ${s.origin.host || '非 GitHub 远端'}${s.gh.error ? `：${s.gh.error}` : ''}。将执行 git push -u origin ${s.branch}（不强制），PR / MR 请在网页上创建。`)
    let allow = null
    if (s.dirtyCount) {
      const warn = node('div', null, 'end-banner warn'); warn.append(node('div', `worktree 里有 ${s.dirtyCount} 个未提交 / 未跟踪的改动，不会被推送。`))
      const label = node('label', null, 'checkbox inline'); allow = node('input'); allow.type = 'checkbox'
      label.append(allow, document.createTextNode('我知道，仍然只推送已提交的内容')); warn.append(label); box.append(warn)
    }
    const b = node('button', '推送分支', 'mini primary'), result = node('div', null, 'end-result')
    const problem = s.targetRef == null ? `找不到目标分支 ${s.target}` : !s.ahead ? `相对 ${s.target} 没有新提交` : ''
    if (problem) { b.disabled = true; box.append(node('p', problem, 'end-why')) }
    const update = () => { if (!problem) b.disabled = busy || (allow && !allow.checked) }
    if (allow) allow.onchange = update; update()
    b.onclick = () => run(async () => {
      const r = await ctx.hub.taskPr(session.id, { target, title: session.name, body: '', allowDirty: !!allow?.checked, pushOnly: true })
      result.replaceChildren(node('span', `已推送到 ${r.remote || 'origin'}。`))
      for (const link of r.links || []) { const a = node('a', link, 'link'); a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; result.append(a) }
      if (!r.links?.length) result.append(node('span', `请在网页上从 ${s.branch} 向 ${s.target} 创建合并请求。`, 'muted'))
      ctx.toast('分支已推送'); ctx.reload()
    })
    box.append(b, result); return box
  }
  async function run(fn) {
    if (busy) return
    busy = true; document.querySelectorAll('#end-body button').forEach(b => { b.dataset.wasDisabled = b.disabled; b.disabled = true })
    try { await fn() }
    catch (e) {
      const blocked = prefixed(e.message, 'BLOCKED:'), mount = prefixed(e.message, 'MOUNT:')
      if (blocked) { try { ctx.toast('不能清理：' + JSON.parse(blocked).join('；')) } catch { ctx.toast(blocked) } load() }
      else ctx.toast(mount || e.message)
    } finally {
      busy = false
      document.querySelectorAll('#end-body button').forEach(b => { b.disabled = b.dataset.wasDisabled === 'true' })
    }
  }
  function close() { seq++; $('end-dialog').close() }
  document.addEventListener('DOMContentLoaded', () => { $('end-close').onclick = close })
  window.AIHubEndTask = { open, close }
})()
