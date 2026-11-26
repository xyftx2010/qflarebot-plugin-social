/**
 * 插件专属管理页（V0.5.0 多模态社交版，单文件内联 HTML/CSS/JS）。
 *
 * 严格遵循 QFlareBot 插件页面安全规范：
 * - 接入 /tokens.css 与 /bridge.js；
 * - 所有动态数据均使用 textContent / DOM 节点构建，禁止 innerHTML 拼接用户数据；
 * - 不使用 localStorage / cookie（opaque origin sandbox iframe）。
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>拟人群聊管理</title>
  <link rel="stylesheet" href="/tokens.css" />
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
      color: var(--text, #1f2937);
      background: var(--bg, #f8fafc);
    }
    .wrap { max-width: 1020px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .card {
      background: var(--surface, #ffffff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 12px;
      padding: 16px;
    }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .between { justify-content: space-between; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
    .stat-box {
      padding: 10px 12px;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 10px;
      background: var(--surface-alt, #f9fafb);
    }
    .stat-val { font-size: 20px; font-weight: 600; margin-top: 4px; }
    h1 { font-size: 20px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .muted { color: var(--text-muted, #6b7280); font-size: 13px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: var(--surface-alt, #eef2ff);
      color: var(--accent, #3b82f6);
    }
    .badge-off { background: #fee2e2; color: #b91c1c; }
    .btn {
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border, #d1d5db);
      background: var(--surface, #fff);
      color: inherit;
      cursor: pointer;
      font-size: 13px;
    }
    .btn-primary { background: var(--accent, #2563eb); color: #fff; border-color: transparent; }
    .btn-danger { color: #dc2626; border-color: #fecaca; }
    input, select {
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--border, #d1d5db);
      background: var(--surface, #fff);
      color: inherit;
      font-size: 13px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .mem-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border, #e5e7eb);
    }
    .meme-thumb {
      width: 48px;
      height: 48px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid var(--border, #e5e7eb);
      background: #f1f5f9;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="row between">
        <div>
          <h1>拟人群聊（qflarebot-plugin-social v0.5.0）</h1>
          <div id="summary" class="muted">正在加载运行状态...</div>
          <div id="mm-summary" class="muted" style="margin-top:4px"></div>
        </div>
        <div class="row">
          <button id="btn-sync-agent" class="btn">同步默认人格到 Agent</button>
          <button id="btn-refresh" class="btn btn-primary">刷新</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>多模态调用统计（近 7 天合计）</h2>
      <div class="grid" id="stats-grid"></div>
      <div class="muted" style="margin-top:8px">提示：视觉模型别名、图片理解开关与频控、表情包概率、重复冷却和保存天数请在「插件 → 拟人群聊 → 插件配置」中修改，即时生效。</div>
    </div>

    <div class="card">
      <h2>群聊状态与权限诊断</h2>
      <div class="muted" style="margin-bottom:10px">「非@权限」显示该群近期是否收到过普通群消息，用于确认群主是否已开启「获取群内全部消息」。</div>
      <table>
        <thead>
          <tr>
            <th>群 ID</th>
            <th>发言模式</th>
            <th>绑定人格</th>
            <th>非@权限</th>
            <th>上下文</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="groups-body"></tbody>
      </table>
    </div>

    <div class="card" id="memory-card" style="display:none">
      <div class="row between" style="margin-bottom:10px">
        <h2 id="memory-title" style="margin:0">群聊记忆</h2>
        <button id="btn-clear-memories" class="btn btn-danger">清空本群记忆</button>
      </div>
      <div class="row" style="margin-bottom:12px">
        <input id="new-memory-input" type="text" placeholder="添加一条群公共娱乐记忆（自动脱敏敏感信息）" style="flex:1" />
        <button id="btn-add-memory" class="btn btn-primary">添加记忆</button>
      </div>
      <div id="memories-list"></div>
    </div>

    <div class="card">
      <div class="row between" style="margin-bottom:10px">
        <h2 style="margin:0">表情包素材库管理（R2 + D1）</h2>
        <div class="row">
          <select id="meme-scope-filter">
            <option value="all">全部范围</option>
            <option value="group">仅群独立库</option>
            <option value="global">仅全局库</option>
          </select>
          <input id="meme-search-input" type="text" placeholder="按标签/情绪/含义搜索" />
          <button id="btn-search-memes" class="btn btn-primary">查询</button>
        </div>
      </div>
      <div id="memes-list" class="muted">正在加载表情包素材库...</div>
    </div>
  </div>

  <script type="module">
    import { createBridge } from '/bridge.js'
    const bridge = await createBridge()
    bridge.setTitle('拟人群聊')

    let activeGroupId = null

    function fmtTime(ts) {
      if (!ts) return '未观测'
      return new Date(ts).toLocaleString('zh-CN', { hour12: false })
    }

    function renderStats(stats) {
      const grid = document.getElementById('stats-grid')
      grid.textContent = ''
      const totals = (stats || []).reduce(
        (acc, s) => ({
          visionCalls: acc.visionCalls + (s.visionCalls || 0),
          visionCacheHits: acc.visionCacheHits + (s.visionCacheHits || 0),
          visionErrors: acc.visionErrors + (s.visionErrors || 0),
          memeSent: acc.memeSent + (s.memeSent || 0),
          memeCollected: acc.memeCollected + (s.memeCollected || 0),
        }),
        { visionCalls: 0, visionCacheHits: 0, visionErrors: 0, memeSent: 0, memeCollected: 0 },
      )
      const items = [
        ['视觉模型调用', totals.visionCalls],
        ['图片缓存命中', totals.visionCacheHits],
        ['视觉异常降级', totals.visionErrors],
        ['表情包发送', totals.memeSent],
        ['表情包收藏', totals.memeCollected],
      ]
      for (const [label, val] of items) {
        const box = document.createElement('div')
        box.className = 'stat-box'
        const lbl = document.createElement('div')
        lbl.className = 'muted'
        lbl.textContent = label
        const v = document.createElement('div')
        v.className = 'stat-val'
        v.textContent = String(val)
        box.appendChild(lbl)
        box.appendChild(v)
        grid.appendChild(box)
      }
    }

    async function loadOverview() {
      const res = await bridge.fetch('/api/overview')
      const data = await res.json()
      if (!data.ok) {
        bridge.toast(data.error || '加载失败', 'error')
        return
      }
      document.getElementById('summary').textContent =
        '对话模型：' + data.config.modelAlias +
        ' · 视觉模型：' + data.config.visionModelAlias +
        ' · 默认模式：' + data.config.defaultMode +
        ' · @让渡Agent：' + (data.config.yieldAtToAgent ? '开' : '关')
      document.getElementById('mm-summary').textContent =
        '图片理解：' + (data.config.enableVision ? '开（限 ' + data.config.visionRateLimitPerMinute + '次/分）' : '关') +
        ' · 智能表情包：' + (data.config.enableMemeReply ? '开（概率 ' + data.config.memeSendProbability + ' / 重复冷却 ' + data.config.memeRepeatCooldownSeconds + '秒）' : '关') +
        ' · 保存期限：' + data.config.memeTtlDays + ' 天'
      renderStats(data.multimodalStats)
      renderGroups(data.groups, data.personas)
    }

    function renderGroups(groups, personas) {
      const tbody = document.getElementById('groups-body')
      tbody.textContent = ''
      if (!groups.length) {
        const tr = document.createElement('tr')
        const td = document.createElement('td')
        td.colSpan = 6
        td.className = 'muted'
        td.textContent = '暂无群聊记录，在群里发几条消息或执行 /social status 后将出现在这里。'
        tr.appendChild(td)
        tbody.appendChild(tr)
        return
      }
      for (const g of groups) {
        const tr = document.createElement('tr')

        const tdId = document.createElement('td')
        tdId.textContent = g.groupId.slice(0, 14) + (g.groupId.length > 14 ? '…' : '')
        tdId.title = g.groupId
        tr.appendChild(tdId)

        const tdMode = document.createElement('td')
        const selMode = document.createElement('select')
        for (const optVal of ['auto', 'at', 'off']) {
          const opt = document.createElement('option')
          opt.value = optVal
          opt.textContent = optVal
          if (g.mode === optVal) opt.selected = true
          selMode.appendChild(opt)
        }
        tdMode.appendChild(selMode)
        tr.appendChild(tdMode)

        const tdPersona = document.createElement('td')
        const selPersona = document.createElement('select')
        for (const p of personas) {
          const opt = document.createElement('option')
          opt.value = p.id
          opt.textContent = p.name + ' (' + p.id + ')'
          if (g.personaId === p.id) opt.selected = true
          selPersona.appendChild(opt)
        }
        tdPersona.appendChild(selPersona)
        tr.appendChild(tdPersona)

        const tdPerm = document.createElement('td')
        tdPerm.textContent = g.lastNonAtSeenAt ? '已收到 (' + fmtTime(g.lastNonAtSeenAt) + ')' : '未观测到非@消息'
        tr.appendChild(tdPerm)

        const tdCtx = document.createElement('td')
        tdCtx.textContent = String(g.contextCount) + ' 条'
        tr.appendChild(tdCtx)

        const tdAct = document.createElement('td')
        const btnSave = document.createElement('button')
        btnSave.className = 'btn'
        btnSave.textContent = '保存'
        btnSave.onclick = async () => {
          const r = await bridge.fetch('/api/groups/' + encodeURIComponent(g.groupId), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: selMode.value, personaId: selPersona.value }),
          })
          const out = await r.json()
          bridge.toast(out.ok ? '已保存群设置' : (out.error || '保存失败'), out.ok ? 'success' : 'error')
        }

        const btnMem = document.createElement('button')
        btnMem.className = 'btn'
        btnMem.style.marginLeft = '6px'
        btnMem.textContent = '记忆'
        btnMem.onclick = () => loadMemories(g.groupId)

        tdAct.appendChild(btnSave)
        tdAct.appendChild(btnMem)
        tr.appendChild(tdAct)
        tbody.appendChild(tr)
      }
    }

    async function loadMemories(groupId) {
      activeGroupId = groupId
      document.getElementById('memory-card').style.display = 'block'
      document.getElementById('memory-title').textContent = '群聊记忆：' + groupId
      const res = await bridge.fetch('/api/groups/' + encodeURIComponent(groupId) + '/memories')
      const data = await res.json()
      const list = document.getElementById('memories-list')
      list.textContent = ''
      if (!data.ok || !data.memories.length) {
        const empty = document.createElement('div')
        empty.className = 'muted'
        empty.textContent = '当前群暂无活跃记忆。'
        list.appendChild(empty)
        return
      }
      for (const m of data.memories) {
        const row = document.createElement('div')
        row.className = 'mem-item'
        const left = document.createElement('div')
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = m.scope === 'member' ? ('成员:' + (m.userName || '群友')) : '群公共'
        const txt = document.createElement('span')
        txt.style.marginLeft = '8px'
        txt.textContent = m.content
        const meta = document.createElement('div')
        meta.className = 'muted'
        meta.textContent = '过期时间：' + fmtTime(m.expiresAt)
        left.appendChild(badge)
        left.appendChild(txt)
        left.appendChild(meta)

        const del = document.createElement('button')
        del.className = 'btn btn-danger'
        del.textContent = '删除'
        del.onclick = async () => {
          await bridge.fetch('/api/groups/' + encodeURIComponent(groupId) + '/memories/' + encodeURIComponent(m.id), {
            method: 'DELETE',
          })
          bridge.toast('已删除记忆', 'success')
          loadMemories(groupId)
        }
        row.appendChild(left)
        row.appendChild(del)
        list.appendChild(row)
      }
    }

    async function loadMemes() {
      const scope = document.getElementById('meme-scope-filter').value
      const q = document.getElementById('meme-search-input').value.trim()
      const qs = new URLSearchParams({ scope, q })
      const res = await bridge.fetch('/api/memes?' + qs.toString())
      const data = await res.json()
      const box = document.getElementById('memes-list')
      box.textContent = ''
      if (!data.ok || !data.memes.length) {
        const empty = document.createElement('div')
        empty.className = 'muted'
        empty.textContent = '暂无匹配的表情包。群友可在群内发送或引用图片后输入 /收藏表情 进行授权收藏。'
        box.appendChild(empty)
        return
      }
      for (const m of data.memes) {
        const row = document.createElement('div')
        row.className = 'mem-item'

        const left = document.createElement('div')
        left.className = 'row'

        const img = document.createElement('img')
        img.className = 'meme-thumb'
        img.alt = m.meaning
        img.src = '/p/social/meme/' + encodeURIComponent(m.id)
        left.appendChild(img)

        const info = document.createElement('div')
        const top = document.createElement('div')
        const scopeBadge = document.createElement('span')
        scopeBadge.className = 'badge'
        scopeBadge.textContent = m.scope === 'global' ? '全局' : ('群:' + (m.groupId || '').slice(0, 8))
        top.appendChild(scopeBadge)

        if (!m.enabled) {
          const disBadge = document.createElement('span')
          disBadge.className = 'badge badge-off'
          disBadge.style.marginLeft = '6px'
          disBadge.textContent = '已禁用'
          top.appendChild(disBadge)
        }

        const title = document.createElement('span')
        title.style.marginLeft = '8px'
        title.textContent = m.meaning + '（情绪:' + (m.mood || '无') + ' / 分类:' + m.category + '）'
        top.appendChild(title)

        const sub = document.createElement('div')
        sub.className = 'muted'
        sub.textContent =
          '标签：' + (m.tags.length ? m.tags.join('、') : '无') +
          ' · 使用 ' + m.useCount + ' 次 · 过期：' + fmtTime(m.expiresAt)
        info.appendChild(top)
        info.appendChild(sub)
        left.appendChild(info)

        const actions = document.createElement('div')
        actions.className = 'row'

        const toggleBtn = document.createElement('button')
        toggleBtn.className = 'btn'
        toggleBtn.textContent = m.enabled ? '禁用' : '启用'
        toggleBtn.onclick = async () => {
          await bridge.fetch('/api/memes/' + encodeURIComponent(m.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !m.enabled }),
          })
          bridge.toast(m.enabled ? '已禁用表情包' : '已启用表情包', 'success')
          loadMemes()
        }

        const delBtn = document.createElement('button')
        delBtn.className = 'btn btn-danger'
        delBtn.textContent = '删除'
        delBtn.onclick = async () => {
          await bridge.fetch('/api/memes/' + encodeURIComponent(m.id), { method: 'DELETE' })
          bridge.toast('已删除表情包及 R2 原图', 'success')
          loadMemes()
        }

        actions.appendChild(toggleBtn)
        actions.appendChild(delBtn)
        row.appendChild(left)
        row.appendChild(actions)
        box.appendChild(row)
      }
    }

    document.getElementById('btn-refresh').onclick = () => { loadOverview(); loadMemes() }
    document.getElementById('btn-search-memes').onclick = loadMemes
    document.getElementById('meme-scope-filter').onchange = loadMemes
    document.getElementById('btn-sync-agent').onclick = async () => {
      const r = await bridge.fetch('/api/sync-agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const out = await r.json()
      bridge.toast(out.ok ? '已同步人格基调到 Agent' : (out.reason || '同步失败'), out.ok ? 'success' : 'error')
    }
    document.getElementById('btn-add-memory').onclick = async () => {
      if (!activeGroupId) return
      const input = document.getElementById('new-memory-input')
      const content = input.value.trim()
      if (!content) return
      const r = await bridge.fetch('/api/groups/' + encodeURIComponent(activeGroupId) + '/memories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const out = await r.json()
      if (out.ok) {
        input.value = ''
        bridge.toast('已添加记忆', 'success')
        loadMemories(activeGroupId)
      } else {
        bridge.toast(out.error || '添加失败', 'error')
      }
    }
    document.getElementById('btn-clear-memories').onclick = async () => {
      if (!activeGroupId) return
      await bridge.fetch('/api/groups/' + encodeURIComponent(activeGroupId) + '/memories', { method: 'DELETE' })
      bridge.toast('已清空本群记忆', 'success')
      loadMemories(activeGroupId)
    }

    await Promise.all([loadOverview(), loadMemes()])
  </script>
</body>
</html>
`
