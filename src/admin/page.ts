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
          <h1>拟人群聊（qflarebot-plugin-social v0.12.0 · 自适应 Agent & 群聊风格学习）</h1>
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
        <h2 style="margin:0">Social Agent 工具中心、模型用量与执行日志</h2>
        <button id="btn-save-tools" class="btn btn-primary">保存工具白名单</button>
      </div>
      <div id="agent-summary" class="muted" style="margin-bottom:10px">正在加载 Agent 状态...</div>
      <div class="grid" id="llm-usage-grid" style="margin-bottom:12px"></div>
      <div class="muted" style="margin-bottom:6px">近 7 天三通道路由性能与误触发统计（Fast / Smart / Full）：</div>
      <table style="margin-bottom:12px">
        <thead>
          <tr>
            <th>通道</th>
            <th>调用次数</th>
            <th>平均延迟</th>
            <th>P95 延迟</th>
            <th>Token 消耗</th>
            <th>工具调用/失败</th>
            <th>误触发</th>
          </tr>
        </thead>
        <tbody id="routing-stats-body"></tbody>
      </table>
      <div class="muted" style="margin-bottom:6px">内置娱乐/查询工具：</div>
      <div id="builtin-tools-box" class="row" style="margin-bottom:12px"></div>
      <div class="muted" style="margin-bottom:6px">外部插件工具白名单（框架 core.tools 自动发现，默认关闭）：</div>
      <div id="external-tools-box" class="row" style="margin-bottom:12px"></div>
      <div class="muted" style="margin-bottom:6px">最近工具执行日志：</div>
      <div id="tool-logs-list" class="muted">暂无工具调用记录。</div>
    </div>

    <div class="card">
      <h2>AI 语音互动（TTS 试听、费用统计与发送日志）</h2>
      <div id="voice-summary" class="muted" style="margin-bottom:10px">正在加载语音配置...</div>
      <div class="grid" id="voice-stats-grid" style="margin-bottom:12px"></div>
      <div class="row" style="margin-bottom:10px">
        <input id="voice-preview-text" type="text" value="哈哈，今晚群里这么热闹，我也来凑个热闹！" style="flex:1" />
        <input id="voice-preview-emotion" type="text" placeholder="情绪（可选，如 happy）" style="width:160px" />
        <button id="btn-voice-preview" class="btn btn-primary">语音试听</button>
      </div>
      <audio id="voice-preview-player" controls style="width:100%;display:none;margin-bottom:12px"></audio>
      <div class="muted" style="margin-bottom:6px">最近语音发送日志（含缓存命中、降级与预估费用）：</div>
      <div id="voice-logs-list" class="muted">暂无语音发送记录。</div>
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

    <div class="card">
      <div class="row between" style="margin-bottom:10px">
        <div>
          <h2 style="margin:0">群聊风格学习中心（V0.12.0）</h2>
          <div id="learn-summary" class="muted" style="margin-top:4px">请输入或选择群 ID 查看本群风格档案、语料与热梗。</div>
        </div>
        <div class="row">
          <select id="learn-group-select" style="min-width:180px">
            <option value="">选择已有群（group_openid）</option>
          </select>
          <input id="learn-group-id" type="text" placeholder="或手动输入群 openid" style="width:180px" />
          <button id="btn-learn-load" class="btn btn-primary">加载本群学习状态</button>
          <button id="btn-learn-auth" class="btn">切换本群学习授权</button>
          <button id="btn-learn-run" class="btn">立即蒸馏候选版本</button>
          <button id="btn-learn-purge" class="btn btn-danger">清除本群学习数据</button>
        </div>
      </div>

      <div class="row" style="margin-bottom:10px">
        <select id="learn-import-format">
          <option value="json">JSON（支持百兆大文件流式分块）</option>
          <option value="jsonl">JSONL</option>
          <option value="txt">TXT（QQ 导出/对话）</option>
          <option value="csv">CSV</option>
        </select>
        <select id="learn-import-limit">
          <option value="2000">最近 2,000 条（推荐，大文件秒级导入）</option>
          <option value="5000">最近 5,000 条</option>
          <option value="10000">最近 10,000 条</option>
          <option value="0">全量流式导入（耗时较长）</option>
        </select>
        <input id="learn-import-file" type="file" accept=".txt,.csv,.json,.jsonl" />
        <button id="btn-learn-import" class="btn btn-primary">脱敏并分块导入语料</button>
        <button id="btn-learn-stop" class="btn" style="display:none">停止导入</button>
      </div>
      <div id="learn-import-status" class="muted" style="margin-bottom:12px"></div>

      <div class="muted" style="margin-bottom:6px">风格档案版本（候选 / 已发布 / 冻结 / 回滚，含防删除复活校验）：</div>
      <div id="learn-profiles" class="muted" style="margin-bottom:12px">暂无风格版本。</div>

      <div class="muted" style="margin-bottom:6px">群内热梗知识库（状态可切换 active / blocked）：</div>
      <div id="learn-memes" class="muted" style="margin-bottom:12px">暂无热梗记录。</div>

      <div class="muted" style="margin-bottom:6px">风格实验室（A–E 同上下文对照，绝不发送到 QQ 群且不污染记忆/语料）：</div>
      <div class="row" style="margin-bottom:8px">
        <input id="lab-context" type="text" placeholder="可选上下文（如：群友A: 今天又加班了）" style="flex:1;min-width:220px" />
        <input id="lab-message" type="text" placeholder="测试发言（如：太离谱了吧这也能加班）" style="flex:1;min-width:220px" />
        <button id="btn-lab-run" class="btn btn-primary">运行 A–E 对比</button>
      </div>
      <div id="lab-results" class="muted">点击「运行 A–E 对比」查看不同风格层级的真实回复、耗时与 Token。</div>
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
      const sel = document.getElementById('learn-group-select')
      if (sel) {
        const prev = document.getElementById('learn-group-id').value.trim()
        sel.textContent = ''
        const defOpt = document.createElement('option')
        defOpt.value = ''
        defOpt.textContent = '选择已有群（group_openid）'
        sel.appendChild(defOpt)
        for (const g of data.groups || []) {
          const opt = document.createElement('option')
          opt.value = g.groupId
          opt.textContent = g.groupId.slice(0, 16) + (g.groupId.length > 16 ? '…' : '')
          if (g.groupId === prev) opt.selected = true
          sel.appendChild(opt)
        }
        if (!prev && data.groups && data.groups.length > 0) {
          sel.value = data.groups[0].groupId
          document.getElementById('learn-group-id').value = data.groups[0].groupId
          loadLearningOverview(data.groups[0].groupId)
        }
      }
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

    async function loadVoiceOverview() {
      const res = await bridge.fetch('/api/voice/overview')
      const data = await res.json()
      if (!data.ok) return
      const c = data.config
      document.getElementById('voice-summary').textContent =
        '状态：' + (c.enableVoice ? '已开启' : '未开启') +
        ' · 供应商：' + c.provider +
        ' · 模型：' + c.model +
        ' · 音色：' + c.voiceId +
        ' · 触发：' + c.triggerMode +
        ' · Key：' + (c.hasApiKey ? '已设置' : '未设置') +
        ' · 失败降级文字：' + (c.fallbackToText ? '开' : '关')

      const vGrid = document.getElementById('voice-stats-grid')
      vGrid.textContent = ''
      const u = data.usage7d || {}
      const vItems = [
        ['7日语音发送', u.totalSent || 0],
        ['缓存命中', u.totalCached || 0],
        ['降级文字', u.totalFallback || 0],
        ['累计字数', u.totalChars || 0],
        ['预估费用(元)', u.totalEstimatedCost || 0],
      ]
      for (const [label, val] of vItems) {
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
        vGrid.appendChild(box)
      }

      const logBox = document.getElementById('voice-logs-list')
      logBox.textContent = ''
      if (!data.logs || !data.logs.length) {
        logBox.textContent = '暂无语音发送记录。'
        return
      }
      for (const item of data.logs.slice(0, 15)) {
        const row = document.createElement('div')
        row.className = 'mem-item'
        const left = document.createElement('div')
        left.textContent =
          '[' + item.status + (item.cached ? '/缓存' : '') + '] ' +
          item.provider + ' / ' + item.voiceId +
          (item.emotion ? ' (' + item.emotion + ')' : '') +
          ' · ' + item.charCount + '字 · ¥' + item.estimatedCost +
          (item.error ? ' · ' + item.error : '')
        const right = document.createElement('div')
        right.className = 'muted'
        right.textContent = fmtTime(item.createdAt)
        row.appendChild(left)
        row.appendChild(right)
        logBox.appendChild(row)
      }
    }

    document.getElementById('btn-voice-preview').onclick = async () => {
      const text = document.getElementById('voice-preview-text').value.trim()
      const emotion = document.getElementById('voice-preview-emotion').value.trim()
      if (!text) return
      bridge.toast('正在合成试听语音...', 'info')
      const res = await bridge.fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, emotion }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '合成失败' }))
        bridge.toast(err.error || '合成失败', 'error')
        return
      }
      const blob = await res.blob()
      const player = document.getElementById('voice-preview-player')
      player.src = URL.createObjectURL(blob)
      player.style.display = 'block'
      player.play().catch(() => undefined)
      bridge.toast('试听语音已就绪', 'success')
    }

    let selectedBuiltins = new Set()
    let selectedExternals = new Set()

    async function loadAgentOverview() {
      const res = await bridge.fetch('/api/agent/overview')
      const data = await res.json()
      if (!data.ok) return
      const c = data.config
      document.getElementById('agent-summary').textContent =
        '路由模式：' + (c.adaptiveEnabled ? c.routingMode : '已关闭自适应') +
        ' · 非@工具：' + (c.allowNonMention ? '开' : '关') +
        ' · 自主升级：' + (c.autoEscalate ? '开' : '关') +
        ' · Top-K：' + c.candidateTopK +
        ' · 预算：' + c.agentBudgetMs + 'ms' +
        ' · core.tools：' + (c.coreToolsAvailable ? '已接入' : '未提供')

      const rBody = document.getElementById('routing-stats-body')
      rBody.textContent = ''
      const routing = data.routing7d || { channels: [], totalEscalations: 0, totalFalseTriggers: 0 }
      for (const ch of routing.channels || []) {
        const tr = document.createElement('tr')
        const cells = [
          ch.channel,
          String(ch.count),
          ch.avgLatencyMs + 'ms',
          ch.p95LatencyMs + 'ms',
          String(ch.totalTokens),
          ch.totalToolCalls + ' / ' + ch.totalToolFailures,
          String(ch.falseTriggers),
        ]
        for (const val of cells) {
          const td = document.createElement('td')
          td.textContent = val
          tr.appendChild(td)
        }
        rBody.appendChild(tr)
      }

      const usageTotals = (data.llmUsage7d || []).reduce(
        (acc, r) => ({
          runs: acc.runs + (r.runs || 0),
          toolCalls: acc.toolCalls + (r.toolCalls || 0),
          inputTokens: acc.inputTokens + (r.inputTokens || 0),
          outputTokens: acc.outputTokens + (r.outputTokens || 0),
        }),
        { runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
      )
      const uGrid = document.getElementById('llm-usage-grid')
      uGrid.textContent = ''
      for (const [label, val] of [
        ['7日模型调用', usageTotals.runs],
        ['7日工具调用', usageTotals.toolCalls],
        ['7日输入 Token', usageTotals.inputTokens],
        ['7日输出 Token', usageTotals.outputTokens],
      ]) {
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
        uGrid.appendChild(box)
      }

      selectedBuiltins = new Set(data.policy.enabledBuiltins || [])
      selectedExternals = new Set(data.policy.enabledExternalTools || [])

      const bBox = document.getElementById('builtin-tools-box')
      bBox.textContent = ''
      for (const t of data.builtinTools || []) {
        const label = document.createElement('label')
        label.className = 'btn'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = selectedBuiltins.has(t.id)
        cb.onchange = () => {
          if (cb.checked) selectedBuiltins.add(t.id)
          else selectedBuiltins.delete(t.id)
        }
        label.appendChild(cb)
        const span = document.createElement('span')
        span.style.marginLeft = '6px'
        span.textContent = t.id + (t.requiresApiKey ? ' (需Key)' : '')
        span.title = t.description
        label.appendChild(span)
        bBox.appendChild(label)
      }

      const eBox = document.getElementById('external-tools-box')
      eBox.textContent = ''
      if (!data.externalCatalog || !data.externalCatalog.length) {
        const empty = document.createElement('span')
        empty.className = 'muted'
        empty.textContent = '当前未发现其他插件公开的 core.tools 工具。'
        eBox.appendChild(empty)
      } else {
        for (const t of data.externalCatalog) {
          const label = document.createElement('label')
          label.className = 'btn'
          const cb = document.createElement('input')
          cb.type = 'checkbox'
          cb.checked = selectedExternals.has(t.id)
          cb.onchange = () => {
            if (cb.checked) selectedExternals.add(t.id)
            else selectedExternals.delete(t.id)
          }
          label.appendChild(cb)
          const span = document.createElement('span')
          span.style.marginLeft = '6px'
          span.textContent = t.id + ' [' + t.sideEffect + ']'
          span.title = t.description
          label.appendChild(span)
          eBox.appendChild(label)
        }
      }

      const tLogs = document.getElementById('tool-logs-list')
      tLogs.textContent = ''
      if (!data.toolLogs || !data.toolLogs.length) {
        tLogs.textContent = '暂无工具调用记录。'
      } else {
        for (const item of data.toolLogs.slice(0, 15)) {
          const row = document.createElement('div')
          row.className = 'mem-item'
          const left = document.createElement('div')
          left.textContent =
            '[' + item.status + '] ' + item.toolId + ' (' + item.source + ') · ' +
            item.latencyMs + 'ms' + (item.error ? ' · ' + item.error : '')
          const right = document.createElement('div')
          right.className = 'muted'
          right.textContent = fmtTime(item.createdAt)
          row.appendChild(left)
          row.appendChild(right)
          tLogs.appendChild(row)
        }
      }
    }

    document.getElementById('btn-save-tools').onclick = async () => {
      const r = await bridge.fetch('/api/agent/policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabledBuiltins: [...selectedBuiltins],
          enabledExternalTools: [...selectedExternals],
        }),
      })
      const out = await r.json()
      bridge.toast(out.ok ? '已保存工具白名单策略' : (out.error || '保存失败'), out.ok ? 'success' : 'error')
    }

    document.getElementById('btn-refresh').onclick = () => { loadOverview(); loadMemes(); loadVoiceOverview(); loadAgentOverview() }
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

    // ---- V0.12.0 群聊风格学习中心与风格实验室 ----
    let currentLearnState = null

    async function loadLearningOverview(groupId) {
      const gid = (groupId || document.getElementById('learn-group-id').value || '').trim()
      if (!gid) return
      document.getElementById('learn-group-id').value = gid
      const r = await bridge.fetch('/api/learning/overview?groupId=' + encodeURIComponent(gid))
      const data = await r.json()
      if (!data.ok) {
        bridge.toast(data.error || '加载失败', 'error')
        return
      }
      currentLearnState = data
      const cs = data.corpusSummary || { total: 0, pending: 0, processed: 0, onlineCount: 0, importCount: 0 }
      document.getElementById('learn-summary').textContent =
        '全局开关：' + (data.globalEnabled ? '开' : '关') +
        ' · 本群授权：' + (data.settings.authorized ? '已授权' : '未授权') +
        ' · 冻结长期风格：' + (data.settings.freezeStable ? '是' : '否') +
        ' · 当前发布版本：' + (data.published ? 'v' + data.published.version : '无') +
        ' · 有效语料：' + cs.total + '（待学习 ' + cs.pending + ' / 在线 ' + cs.onlineCount + ' / 导入 ' + cs.importCount + '）' +
        ' · 活跃样本：' + (data.examples || []).length

      const pBox = document.getElementById('learn-profiles')
      pBox.textContent = ''
      if (!data.profiles || !data.profiles.length) {
        pBox.textContent = '暂无风格版本，请先导入语料或点击「立即蒸馏候选版本」。'
      } else {
        for (const p of data.profiles) {
          const row = document.createElement('div')
          row.className = 'mem-item'
          const info = document.createElement('div')
          info.textContent =
            'v' + p.version + ' [' + p.status + '] · 证据 ' + p.evidenceCount + ' 条 / ' + p.distinctSenders + ' 人 · 置信度 ' + p.confidence +
            (p.stableStyle && p.stableStyle.toneSummary ? ' · ' + p.stableStyle.toneSummary : '')
          const acts = document.createElement('div')
          acts.className = 'row'
          if (p.status !== 'published' && p.status !== 'invalidated') {
            const btnPub = document.createElement('button')
            btnPub.className = 'btn btn-primary'
            btnPub.textContent = p.status === 'archived' ? '回滚到此版本' : '发布'
            btnPub.onclick = async () => {
              const res = await bridge.fetch('/api/learning/profiles/' + encodeURIComponent(p.profileId) + '/publish', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ groupId: gid }),
              })
              const out = await res.json()
              bridge.toast(out.ok ? '已发布版本 v' + p.version : (out.error || '发布失败'), out.ok ? 'success' : 'error')
              loadLearningOverview(gid)
            }
            acts.appendChild(btnPub)
          }
          if (p.status === 'candidate') {
            const btnRej = document.createElement('button')
            btnRej.className = 'btn'
            btnRej.textContent = '拒绝'
            btnRej.onclick = async () => {
              await bridge.fetch('/api/learning/profiles/' + encodeURIComponent(p.profileId) + '/status', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: 'rejected' }),
              })
              loadLearningOverview(gid)
            }
            acts.appendChild(btnRej)
          }
          row.appendChild(info)
          row.appendChild(acts)
          pBox.appendChild(row)
        }
      }

      const mBox = document.getElementById('learn-memes')
      mBox.textContent = ''
      if (!data.memes || !data.memes.length) {
        mBox.textContent = '暂无群内热梗。'
      } else {
        for (const m of data.memes.slice(0, 15)) {
          const row = document.createElement('div')
          row.className = 'mem-item'
          const info = document.createElement('div')
          info.textContent =
            '「' + m.name + '」[' + m.status + '] ' + m.meaning + '（出现 ' + m.occurrenceCount + ' 次 / ' + m.distinctSenderCount + ' 人）'
          const btnToggle = document.createElement('button')
          btnToggle.className = 'btn'
          btnToggle.textContent = m.status === 'active' ? '禁用' : '启用'
          btnToggle.onclick = async () => {
            await bridge.fetch('/api/learning/memes/' + encodeURIComponent(m.memeId), {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ groupId: gid, status: m.status === 'active' ? 'blocked' : 'active' }),
            })
            loadLearningOverview(gid)
          }
          row.appendChild(info)
          row.appendChild(btnToggle)
          mBox.appendChild(row)
        }
      }
    }

    document.getElementById('learn-group-select').onchange = (e) => {
      const val = e.target.value
      if (val) {
        document.getElementById('learn-group-id').value = val
        loadLearningOverview(val)
      }
    }
    document.getElementById('btn-learn-load').onclick = () => loadLearningOverview()
    document.getElementById('btn-learn-auth').onclick = async () => {
      const gid = document.getElementById('learn-group-id').value.trim()
      if (!gid) return bridge.toast('请先填写目标群 ID', 'error')
      const nextAuth = !(currentLearnState && currentLearnState.groupId === gid && currentLearnState.settings.authorized)
      await bridge.fetch('/api/learning/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: gid, authorized: nextAuth }),
      })
      bridge.toast(nextAuth ? '已开启本群学习授权' : '已关闭本群学习授权', 'success')
      loadLearningOverview(gid)
    }
    document.getElementById('btn-learn-run').onclick = async () => {
      const gid = document.getElementById('learn-group-id').value.trim()
      if (!gid) return bridge.toast('请先填写目标群 ID', 'error')
      bridge.toast('正在蒸馏候选风格版本...', 'info')
      const r = await bridge.fetch('/api/learning/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: gid, force: true }),
      })
      const out = await r.json()
      bridge.toast(out.ok ? '已生成候选版本（样本 ' + out.processedCount + ' 条）' : (out.reason || '学习未执行'), out.ok ? 'success' : 'error')
      loadLearningOverview(gid)
    }
    document.getElementById('btn-learn-purge').onclick = async () => {
      const gid = document.getElementById('learn-group-id').value.trim()
      if (!gid) return
      await bridge.fetch('/api/learning/group/' + encodeURIComponent(gid), { method: 'DELETE' })
      bridge.toast('已清空本群全部学习数据并失效缓存', 'success')
      loadLearningOverview(gid)
    }
    let importAbortFlag = false
    document.getElementById('btn-learn-stop').onclick = () => {
      importAbortFlag = true
      bridge.toast('正在停止导入...', 'info')
    }

    function extractSimpleRowFromObj(obj) {
      if (!obj || typeof obj !== 'object') return null
      // 兼容常见 QQ 导出 JSON 结构（含纯字段、nested sender/content 数组等）
      let content = ''
      const rawContent = obj.content ?? obj.text ?? obj.message ?? obj.msg ?? obj.raw_message
      if (typeof rawContent === 'string') {
        content = rawContent
      } else if (Array.isArray(rawContent)) {
        content = rawContent
          .map((seg) => (typeof seg === 'string' ? seg : (seg && (seg.text || seg.content || (seg.data && seg.data.text))) || ''))
          .join(' ')
      } else if (rawContent && typeof rawContent === 'object') {
        content = String(rawContent.text || rawContent.content || '')
      }
      content = content.trim()
      if (!content) return null
      let sender = 'anon'
      if (typeof obj.sender === 'string') sender = obj.sender
      else if (obj.sender && typeof obj.sender === 'object') sender = String(obj.sender.uin || obj.sender.uid || obj.sender.id || obj.sender.nickname || obj.sender.name || 'anon')
      else sender = String(obj.user_id || obj.uid || obj.uin || obj.author || obj.user || obj.nickname || obj.name || 'anon')
      const rawTs = obj.timestamp ?? obj.time ?? obj.date ?? obj.created_at ?? obj.msgTime
      let ts = Date.now()
      if (typeof rawTs === 'number' && Number.isFinite(rawTs)) ts = rawTs > 1e12 ? rawTs : rawTs * 1000
      else if (typeof rawTs === 'string' && rawTs.trim()) {
        const parsed = Date.parse(rawTs.trim().replace(' ', 'T'))
        if (Number.isFinite(parsed)) ts = parsed
      }
      const isBot = Boolean(obj.is_bot || obj.isBot || obj.bot || (obj.sender && obj.sender.bot))
      return {
        sender: sender.slice(0, 48),
        content: content.slice(0, 400),
        timestamp: Math.floor(ts),
        messageId: String(obj.message_id || obj.msg_id || obj.id || '').slice(0, 64),
        isBot,
      }
    }

    // 流式扫描超大 JSON 文本片中的平级消息对象（绝不一次性 JSON.parse 整个 180MB 文件）
    function scanJsonObjectsFromChunk(buf) {
      const rows = []
      let inStr = false
      let esc = false
      let depth = 0
      let startIdx = -1
      let lastConsumed = 0
      for (let i = 0; i < buf.length; i += 1) {
        const ch = buf[i]
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\\\') esc = true
          else if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') { inStr = true; continue }
        if (ch === '{') {
          if (depth === 0) startIdx = i
          depth += 1
        } else if (ch === '}') {
          if (depth > 0) depth -= 1
          if (depth === 0 && startIdx >= 0) {
            const slice = buf.slice(startIdx, i + 1)
            lastConsumed = i + 1
            startIdx = -1
            if (slice.length < 32000) {
              try {
                const parsed = JSON.parse(slice)
                const row = extractSimpleRowFromObj(parsed)
                if (row) rows.push(row)
              } catch {}
            }
          }
        }
      }
      const remainder = startIdx >= 0 ? buf.slice(startIdx) : buf.slice(lastConsumed)
      return { rows, remainder: remainder.length > 65536 ? '' : remainder }
    }

    document.getElementById('btn-learn-import').onclick = async () => {
      const gid = document.getElementById('learn-group-id').value.trim()
      const fileInput = document.getElementById('learn-import-file')
      const fmt = document.getElementById('learn-import-format').value
      const maxRows = Number(document.getElementById('learn-import-limit').value || '2000')
      if (!gid || !fileInput.files || !fileInput.files[0]) {
        return bridge.toast('请先选择目标群并选择语料文件', 'error')
      }
      const file = fileInput.files[0]
      const statusEl = document.getElementById('learn-import-status')
      const btnImport = document.getElementById('btn-learn-import')
      const btnStop = document.getElementById('btn-learn-stop')
      importAbortFlag = false
      btnImport.disabled = true
      btnStop.style.display = 'inline-block'

      try {
        const fileSize = file.size
        // 若选择“最近 N 条”且文件超大（> 10MB），直接从文件尾部切片读取（如最后 12MB），避免浏览器卡死且优先获取近期语料
        const tailBytes = maxRows > 0 ? Math.max(8 * 1024 * 1024, maxRows * 2048) : fileSize
        let offset = maxRows > 0 && fileSize > tailBytes ? fileSize - tailBytes : 0
        const startOffset = offset
        const sliceSize = 1024 * 1024 // 每次只读 1MB，绝不撑爆内存

        let totalAccepted = 0
        let totalSkipped = 0
        let sourceId = ''
        let carry = ''
        let pendingRows = []
        let pendingLines = []

        const flushRows = async () => {
          while (pendingRows.length > 0 && !importAbortFlag) {
            const batch = pendingRows.splice(0, 200)
            const r = await bridge.fetch('/api/learning/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ groupId: gid, format: fmt, label: file.name, sourceId: sourceId || undefined, rows: batch }),
            })
            const out = await r.json()
            if (!out.ok) throw new Error(out.error || '导入失败')
            sourceId = out.sourceId
            totalAccepted += out.acceptedRows || 0
            totalSkipped += out.skippedRows || 0
            if (maxRows > 0 && totalAccepted >= maxRows) {
              importAbortFlag = true
              break
            }
          }
        }

        const flushLines = async () => {
          while (pendingLines.length > 0 && !importAbortFlag) {
            const batchText = pendingLines.splice(0, 200).join('\\n')
            if (!batchText.trim()) continue
            const r = await bridge.fetch('/api/learning/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ groupId: gid, format: fmt, label: file.name, sourceId: sourceId || undefined, rawText: batchText }),
            })
            const out = await r.json()
            if (!out.ok) throw new Error(out.error || '导入失败')
            sourceId = out.sourceId
            totalAccepted += out.acceptedRows || 0
            totalSkipped += out.skippedRows || 0
            if (maxRows > 0 && totalAccepted >= maxRows) {
              importAbortFlag = true
              break
            }
          }
        }

        while (offset < fileSize && !importAbortFlag) {
          const end = Math.min(fileSize, offset + sliceSize)
          const chunkText = await file.slice(offset, end).text()
          offset = end

          if (fmt === 'json') {
            const scanned = scanJsonObjectsFromChunk(carry + chunkText)
            carry = scanned.remainder
            for (const row of scanned.rows) pendingRows.push(row)
            if (pendingRows.length >= 200) await flushRows()
          } else {
            const parts = (carry + chunkText).split(/\\r?\\n/)
            carry = end < fileSize ? (parts.pop() || '') : ''
            if (fmt === 'jsonl') {
              for (const line of parts) {
                const t = line.trim()
                if (!t) continue
                try {
                  const row = extractSimpleRowFromObj(JSON.parse(t))
                  if (row) pendingRows.push(row)
                } catch {}
              }
              if (pendingRows.length >= 200) await flushRows()
            } else {
              for (const line of parts) pendingLines.push(line)
              if (pendingLines.length >= 200) await flushLines()
            }
          }

          const pct = Math.min(100, Math.round(((offset - startOffset) / Math.max(1, fileSize - startOffset)) * 100))
          statusEl.textContent =
            '流式分块导入中（' + pct + '%）… 已入库 ' + totalAccepted + ' 条，过滤/去重 ' + totalSkipped + ' 条'
          await new Promise((resolve) => setTimeout(resolve, 0))
        }

        if (!importAbortFlag) {
          if (pendingRows.length > 0) await flushRows()
          if (pendingLines.length > 0) await flushLines()
        }

        statusEl.textContent =
          (importAbortFlag && maxRows > 0 && totalAccepted >= maxRows ? '已达到导入上限并完成：' : importAbortFlag ? '已手动停止：' : '导入完成：') +
          '入库 ' + totalAccepted + ' 条，过滤/去重 ' + totalSkipped + ' 条（文件 ' + Math.round(fileSize / 1024 / 1024) + 'MB，已自动脱敏与匿名化）'
        bridge.toast('语料导入完成（入库 ' + totalAccepted + ' 条）', 'success')
        loadLearningOverview(gid)
      } catch (err) {
        statusEl.textContent = '导入出错：' + (err && err.message ? err.message : String(err))
        bridge.toast('导入失败：' + (err && err.message ? err.message : String(err)), 'error')
      } finally {
        btnImport.disabled = false
        btnStop.style.display = 'none'
      }
    }
    document.getElementById('btn-lab-run').onclick = async () => {
      const gid = document.getElementById('learn-group-id').value.trim()
      const testContext = document.getElementById('lab-context').value.trim()
      const testMessage = document.getElementById('lab-message').value.trim()
      if (!gid || !testMessage) return bridge.toast('请填写目标群 ID 和测试发言', 'error')
      const box = document.getElementById('lab-results')
      box.textContent = '正在运行 A–E 五模式对照测试（不会发送到 QQ 群）...'
      const r = await bridge.fetch('/api/learning/lab', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: gid, testContext, testMessage }),
      })
      const out = await r.json()
      if (!out.ok) {
        box.textContent = out.error || '运行失败'
        return
      }
      box.textContent = ''
      for (const item of out.results || []) {
        const row = document.createElement('div')
        row.className = 'mem-item'
        const left = document.createElement('div')
        left.textContent =
          item.label + '：' + item.reply +
          '（耗时 ' + item.latencyMs + 'ms / 检索 ' + item.retrievalMs + 'ms / 风格 ' + item.styleTokens + ' tok / 模型 ' + (item.inputTokens + item.outputTokens) + ' tok）'
        const btnGood = document.createElement('button')
        btnGood.className = 'btn'
        btnGood.textContent = '标记优质'
        btnGood.onclick = async () => {
          await bridge.fetch('/api/learning/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              groupId: gid,
              mode: item.mode,
              contextExcerpt: testContext + ' ' + testMessage,
              botReply: item.reply,
              rating: 'good',
              source: 'lab',
            }),
          })
          bridge.toast('已记录优质反馈', 'success')
        }
        row.appendChild(left)
        row.appendChild(btnGood)
        box.appendChild(row)
      }
    }

    await Promise.all([loadOverview(), loadMemes(), loadVoiceOverview(), loadAgentOverview()])
  </script>
</body>
</html>
`
