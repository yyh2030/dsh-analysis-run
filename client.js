/* @dsh-generated: client-identity prelude begin */
;(function (global) {
  if (global.__DSH_RESEARCH_CLIENT_IDENTITY__) return

const DSH_RESEARCH_CLIENT_IDENTITY = (function () {
  const IDENTITY_VERSION = '2026-11-10-u02'
  /** 共享键：同一标签里四个插件都读它，保证 pageId 一致。 */
  const PAGE_KEY = 'dsh:research:page:v3'
  /** 每个插件自己的键：键名含插件前一等公民前缀，便于诊断与单独清理。 */
  const PAGE_KEY_PREFIX = 'dsh:research:page:v3:plugin'
  const WORKSPACE_KEY = 'dsh:research:workspace:v3'
  const REVISION_KEY = 'dsh:research:page-revision:v3'
  const TAB_CHANNEL = 'dsh-research-tab-v3'
  const GLOBAL_KEY = '__DSH_RESEARCH_CLIENT_IDENTITY__'
  const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
  const PROBE_TIMEOUT_MS = 60
  /** 同一 realm（一个标签页）里所有插件共用的随机标签指纹，用来区分同标签兄弟与克隆标签。 */
  const tabNonce = randomToken()

  function randomToken(length) {
    const bytes = new Uint8Array(Math.ceil((length || 24) / 2))
    const cryptoSource = typeof globalThis !== 'undefined' ? globalThis.crypto : null
    if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') cryptoSource.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }

  function randomPageId() { return randomToken(24) }

  function isPageId(value) { return typeof value === 'string' && PAGE_ID_RE.test(value) }

  function pluginPageKey(plugin) {
    const name = String(plugin || 'unknown').trim() || 'unknown'
    return PAGE_KEY_PREFIX + ':' + name
  }

  function safeSegment(value) {
    const text = String(value === null || value === undefined ? '' : value).trim()
    if (!text) return 'none'
    return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'none'
  }

  /** 数据集标识：优先 dataRoot，其次研究定义路径，最后 studyId；只用于草稿键隔离。 */
  function datasetKey(binding) {
    if (!binding || typeof binding !== 'object') return 'none'
    return safeSegment(binding.dataRoot || binding.studyPath || binding.dataset || binding.studyId || 'none')
  }

  function instanceKey(binding) {
    return safeSegment(binding && (binding.instanceId || binding.studyId) || 'none')
  }

  /** study-ops 写到 scale-desk 的焦点提示：同一研究实例 + 同一数据集才复用。 */
  function focusKey(binding) {
    return 'dsh:research:focus:v2:' + instanceKey(binding) + ':' + datasetKey(binding)
  }

  /** analysis-run 方案草稿：实例 + 数据集（dataPath），不能只按 studyId 存。 */
  function planDraftKey(binding, dataPath, studyId) {
    return 'analysis-plan:v2:' + instanceKey(binding) + ':' + safeSegment(studyId || (binding && binding.studyId)) + ':' + safeSegment(dataPath || datasetKey(binding))
  }

  /** demographic-coder 数据集草稿：实例 + 数据集名。 */
  function datasetDraftKey(prefix, binding, dataset) {
    return String(prefix || 'dc:dataset:v3') + ':' + instanceKey(binding) + ':' + safeSegment(dataset || datasetKey(binding))
  }

  /**
   * 从 Client Slot/Service 契约读取当前标签所属工作区。
   * 只读 uiWorkspace 的当前会话与工作区成员关系；拿不到就返回 null，绝不猜 cwd。
   */
  function workspaceFromContext(ctx) {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      const ui = ctx.get('uiWorkspace')
      if (!ui) return null
      const selection = ui.selection && typeof ui.selection.getSnapshot === 'function' ? ui.selection.getSnapshot() : null
      const sessionId = selection && selection.sessionId
      const snapshot = ui.workspaces && ui.workspaces.list && typeof ui.workspaces.list.getSnapshot === 'function' ? ui.workspaces.list.getSnapshot() : null
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      let workspace = null
      if (sessionId) workspace = items.find(item => item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) || null
      if (!workspace && selection && selection.workspaceId) workspace = items.find(item => item && item.workspaceId === selection.workspaceId) || null
      if (!workspace) return null
      return { id: workspace.workspaceId || '', path: workspace.path || '' }
    } catch { return null }
  }

  function safeStorage(global) {
    try { return global && global.sessionStorage ? global.sessionStorage : null } catch { return null }
  }

  function createClientIdentity(options) {
    const settings = options || {}
    const global = settings.global || (typeof globalThis !== 'undefined' ? globalThis : null)
    const plugin = String(settings.plugin || 'unknown')
    const storage = settings.storage !== undefined ? settings.storage : safeStorage(global)
    // 只从页面 window（或显式注入）取 BroadcastChannel；Node 测试进程的全局实现
    // 不能被误当成浏览器标签能力，否则测试/宿主进程会被常驻通道挂住。
    const broadcastFactory = settings.BroadcastChannel || (global && global.BroadcastChannel) || null
    const workspaceProvider = settings.workspaceProvider || null
    const random = typeof settings.random === 'function' ? settings.random : randomPageId
    const tabId = settings.tabId || tabNonce
    const pageKey = pluginPageKey(plugin)
    let pageId = ''
    let workspace = null
    let revision = 0
    let binding = null
    let readyPromise = null
    let channel = null

    function read(key) {
      try { return storage && typeof storage.getItem === 'function' ? String(storage.getItem(key) || '') : '' } catch { return '' }
    }
    function write(key, value) {
      try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, String(value)); return true } catch { return false }
    }
    function remove(key) { try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(key) } catch { /* ignore */ } }

    function workspaceStorageKey(id) { return WORKSPACE_KEY + ':' + id }
    function revisionStorageKey(id) { return REVISION_KEY + ':' + id }

    function readWorkspace() {
      const raw = read(workspaceStorageKey(pageId))
      if (!raw) return null
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' ? { id: String(value.id || ''), path: String(value.path || '') } : null
      } catch { return null }
    }
    function readRevision() {
      const value = Number(read(revisionStorageKey(pageId)))
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
    function persistWorkspace() {
      if (!pageId) return
      if (workspace) write(workspaceStorageKey(pageId), JSON.stringify(workspace))
      else remove(workspaceStorageKey(pageId))
      write(revisionStorageKey(pageId), String(revision))
    }

    function normalizeWorkspace(value) {
      if (!value) return null
      if (typeof value === 'string') return { id: value.trim(), path: '' }
      const id = String(value.id || value.workspaceId || '').trim()
      const path = typeof value.path === 'string' ? value.path.trim() : ''
      if (!id && !path) return null
      return { id, path }
    }

    function installChannel() {
      if (channel || !broadcastFactory) return
      try {
        channel = new broadcastFactory(TAB_CHANNEL)
        if (typeof channel.addEventListener === 'function') {
          channel.addEventListener('message', event => {
            const message = event && event.data ? event.data : event
            if (!message || message.type !== 'identity-probe' || !message.nonce) return
            // 同一标签的四个兄弟共用一个 tab 指纹，不能互相判成克隆；只回答其他标签的探测。
            if (message.tab === tabId) return
            if (message.pageId !== pageId) return
            try { channel.postMessage({ type: 'identity-alive', pageId, nonce: message.nonce }) } catch { /* ignore */ }
          })
        }
      } catch { channel = null }
    }

    /** 克隆标签会复制 sessionStorage；用 BroadcastChannel 问一下这个 pageId 是否已在别的标签活着。 */
    async function contested(id) {
      if (!broadcastFactory) return false
      let probe = null
      try { probe = new broadcastFactory(TAB_CHANNEL) } catch { return false }
      return await new Promise(resolve => {
        let settled = false
        const nonce = random()
        const finish = value => {
          if (settled) return
          settled = true
          try { if (probe && typeof probe.close === 'function') probe.close() } catch { /* ignore */ }
          resolve(value)
        }
        if (typeof probe.addEventListener === 'function') {
          probe.addEventListener('message', event => {
            const message = event && event.data ? event.data : event
            if (message && message.type === 'identity-alive' && message.pageId === id && message.nonce === nonce) finish(true)
          })
        }
        try { probe.postMessage({ type: 'identity-probe', pageId: id, nonce, tab: tabId }) } catch { finish(false); return }
        setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
      })
    }

    function ready() {
      if (readyPromise) return readyPromise
      readyPromise = (async () => {
        const storedPlugin = read(pageKey)
        const storedShared = read(PAGE_KEY)
        // 共享键优先：四个插件以它为唯一事实；插件键只做诊断/清理辅助。
        let candidate = isPageId(storedShared) ? storedShared : (isPageId(storedPlugin) ? storedPlugin : '')
        // 同标签的兄弟插件已经通过共享内存确认过这个身份，不必再互探。
        if (candidate && candidate !== memoryPageId() && await contested(candidate)) candidate = ''
        if (!candidate) {
          candidate = isPageId(memoryPageId()) ? memoryPageId() : random()
          // 进程内唯一 ID：同一标签的四个插件通过共享内存拿到同一个值，克隆/无 storage 时也彼此不同。
          setMemoryPageId(candidate)
          write(pageKey, candidate)
          write(PAGE_KEY, candidate)
        } else {
          setMemoryPageId(candidate)
          if (storedPlugin !== candidate) write(pageKey, candidate)
          if (storedShared !== candidate) write(PAGE_KEY, candidate)
        }
        pageId = candidate
        if (!workspace) workspace = readWorkspace()
        revision = Math.max(revision, readRevision())
        installChannel()
        return pageId
      })()
      return readyPromise
    }

    // 进程内单例挂在全局 API 上：四个插件 bundle 共用同一个 API 实例时通过它对齐。
    function memoryPageId() {
      try { return global && global.__DSH_RESEARCH_PAGE_MEMORY__ ? String(global.__DSH_RESEARCH_PAGE_MEMORY__) : '' } catch { return '' }
    }
    function setMemoryPageId(value) {
      try { if (global) global.__DSH_RESEARCH_PAGE_MEMORY__ = value } catch { /* ignore */ }
    }

    /** 同标签任一插件 newPage 后，其他插件下次请求前要采纳新的共享 pageId。 */
    function syncPageFromGlobal() {
      const sharedMemory = memoryPageId()
      if (!isPageId(sharedMemory) || sharedMemory === pageId) return
      pageId = sharedMemory
      workspace = readWorkspace()
      revision = readRevision()
      binding = null
    }

    function ensure() {
      syncPageFromGlobal()
      if (!pageId) {
        // 同步路径也不能覆盖已持久化的身份；只有确实没有候选时才生成。
        const storedShared = read(PAGE_KEY)
        const storedPlugin = read(pageKey)
        const stored = isPageId(storedShared) ? storedShared : (isPageId(storedPlugin) ? storedPlugin : '')
        pageId = stored || (isPageId(memoryPageId()) ? memoryPageId() : random())
        setMemoryPageId(pageId)
        if (!stored) write(PAGE_KEY, pageId)
        if (storedPlugin !== pageId) write(pageKey, pageId)
        if (!workspace) workspace = readWorkspace()
        revision = Math.max(revision, readRevision())
      }
      return pageId
    }

    function syncWorkspace(ctx) {
      if (typeof workspaceProvider !== 'function' || !pageId) return workspace
      let next = null
      try { next = workspaceProvider(ctx) } catch { next = null }
      return setWorkspace(next)
    }

    function setWorkspace(next) {
      const normalized = normalizeWorkspace(next)
      if (!normalized) return workspace
      if (workspace && workspace.id === normalized.id && workspace.path === normalized.path) return workspace
      if (workspace) {
        // 同标签切换工作区：绑定代次递增，旧令牌作废。
        revision += 1
        binding = null
      }
      workspace = normalized
      persistWorkspace()
      return workspace
    }

    function newPage() {
      const next = random()
      pageId = next
      setMemoryPageId(next)
      revision = 0
      binding = null
      write(pageKey, next)
      write(PAGE_KEY, next)
      persistWorkspace()
      installChannel()
      return next
    }

    function prepare(ctx) {
      syncPageFromGlobal()
      ensure()
      if (typeof workspaceProvider === 'function') syncWorkspace(ctx)
      return begin()
    }

    function begin() {
      ensure()
      return {
        pageId,
        workspaceId: workspace ? workspace.id : '',
        workspacePath: workspace ? workspace.path : '',
        bindingRevision: revision,
        studyId: binding ? binding.studyId || '' : '',
        instanceId: binding ? binding.instanceId || '' : '',
        token: binding ? binding.token || '' : '',
      }
    }

    function headers() {
      ensure()
      const result = { 'x-dsh-page': pageId }
      if (workspace && workspace.id) result['x-dsh-workspace'] = workspace.id
      return result
    }

    function body() {
      ensure()
      const result = { pageId, bindingRevision: revision }
      if (workspace && workspace.id) result.workspaceId = workspace.id
      // 写入令牌必须随请求体发送：连接/读取响应会 remember() 令牌，但只有 body 带上它，
      // 服务端 assertWrite 才会认为这是当前页面的绑定（否则页面永远 binding_required）。
      if (binding && binding.token) result.binding = binding.token
      return result
    }

    function capture() { return begin() }

    function remember(nextBinding) {
      if (!nextBinding || typeof nextBinding !== 'object' || !nextBinding.token) return binding
      binding = {
        token: String(nextBinding.token),
        studyId: nextBinding.studyId || (nextBinding.study && nextBinding.study.id) || '',
        instanceId: nextBinding.instanceId || (nextBinding.study && nextBinding.study.instanceId) || '',
        studyRevision: nextBinding.studyRevision || (nextBinding.study && nextBinding.study.revision) || '',
        bindingRevision: Number(nextBinding.bindingRevision) || 0,
        workspaceId: nextBinding.workspaceId || '',
      }
      return binding
    }

    function staleError(message, details) {
      const error = new Error(message)
      error.code = 'stale_response'
      error.details = details
      return error
    }

    /**
     * 响应回来后核对本次 capture：页面、工作区代次或研究身份变了就拒绝，
     * 由调用方丢弃这次结果，不能覆盖新页面状态。
     */
    function assertResponse(snapshot, responseBinding, options) {
      if (!snapshot) return true
      if (snapshot.pageId !== pageId) throw staleError('页面身份已变化，忽略过时响应', { pageId, expected: snapshot.pageId })
      if (snapshot.bindingRevision !== revision) throw staleError('页面绑定已切换，忽略过时响应', { bindingRevision: revision, expected: snapshot.bindingRevision })
      const workspaceId = workspace ? workspace.id : ''
      if ((snapshot.workspaceId || '') !== workspaceId) throw staleError('页面工作区已切换，忽略过时响应', { workspaceId, expected: snapshot.workspaceId })
      if (responseBinding && typeof responseBinding === 'object') {
        const allowRebind = options && options.allowRebind === true
        const responseStudy = responseBinding.studyId || (responseBinding.study && responseBinding.study.id) || ''
        const responseInstance = responseBinding.instanceId || (responseBinding.study && responseBinding.study.instanceId) || ''
        const responseWorkspace = responseBinding.workspaceId || ''
        if (responseWorkspace && workspaceId && responseWorkspace !== workspaceId) {
          throw staleError('响应来自其他工作区，已丢弃', { workspaceId, responseWorkspace })
        }
        if (!allowRebind) {
          if (snapshot.studyId && responseStudy && snapshot.studyId !== responseStudy) {
            throw staleError('响应属于其他研究，已丢弃', { studyId: responseStudy, expected: snapshot.studyId })
          }
          if (snapshot.instanceId && responseInstance && snapshot.instanceId !== responseInstance) {
            throw staleError('响应属于其他研究实例，已丢弃', { instanceId: responseInstance, expected: snapshot.instanceId })
          }
        }
      }
      return true
    }

    function accept(snapshot, responseBinding, options) {
      assertResponse(snapshot, responseBinding, options)
      return remember(responseBinding)
    }

    // 首次创建就落盘：隐私模式下也会落到本标签的进程内单例。
    void ready().catch(() => {})

    return {
      version: IDENTITY_VERSION,
      plugin,
      ready,
      ensure,
      pageId() { return ensure() },
      newPage,
      prepare,
      begin,
      syncWorkspace,
      setWorkspace,
      workspace() { return workspace ? { ...workspace } : null },
      revision() { return revision },
      headers,
      body,
      capture,
      remember,
      binding() { return binding ? { ...binding } : null },
      assertResponse,
      accept,
      focusKey() { return focusKey(binding) },
      planDraftKey(dataPath) { return planDraftKey(binding, dataPath, binding && binding.studyId) },
      datasetDraftKey(prefix, dataset) { return datasetDraftKey(prefix, binding, dataset) },
      staleError,
    }
  }

  return {
    IDENTITY_VERSION,
    PAGE_KEY,
    PAGE_KEY_PREFIX,
    WORKSPACE_KEY,
    REVISION_KEY,
    TAB_CHANNEL,
    GLOBAL_KEY,
    randomPageId,
    isPageId,
    pluginPageKey,
    safeSegment,
    datasetKey,
    instanceKey,
    focusKey,
    planDraftKey,
    datasetDraftKey,
    workspaceFromContext,
    createClientIdentity,
  }
})()
  global.__DSH_RESEARCH_CLIENT_IDENTITY__ = DSH_RESEARCH_CLIENT_IDENTITY
})(typeof window !== 'undefined' ? window : globalThis)
/* @dsh-generated: client-identity prelude end */








/* @dsh-generated: study-picker prelude begin */
;(function (global) {
  if (global.__DSH_RESEARCH_PICKER__) return

function createStudyPicker(options) {
  const route = options.route
  const headers = options.headers || (() => ({}))
  const pickDirectory = options.pickDirectory || null
  const onChanged = options.onChanged || (() => {})
  const plugin = options.plugin || 'research'
  let root = null
  let panel = null
  let choices = null
  let note = ''
  let busy = false
  let advanced = false
  let creating = false
  let targetDir = ''
  let chooseDir = null

  async function api(action, payload, method = 'POST') {
    const url = method === 'GET' ? `${route}?action=${encodeURIComponent(action)}` : route
    const response = await fetch(url, {
      method,
      headers: { ...headers(), 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ action, payload: payload || {} }) : undefined,
    })
    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok || !data || data.ok === false) {
      const message = data && data.error && (data.error.message || data.error.note) ? (data.error.message || data.error.note) : `请求失败（${response.status}）`
      throw new Error(message)
    }
    return data.data
  }

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'style') { if (node.style) for (const [name, style] of Object.entries(value)) node.style[name] = style }
      else if (key === 'onClick') node.addEventListener('click', value)
      else if (key === 'className') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'value') node.value = value
      else if (key === 'placeholder') node.placeholder = value
      else node.setAttribute(key, value)
    }
    for (const child of children) if (child != null) node.append(child)
    return node
  }

  const buttonStyle = {
    height: '30px', padding: '0 10px', border: '1px solid #cdc7b7', borderRadius: '5px',
    background: '#fffefb', color: '#24221f', cursor: 'pointer', font: 'inherit', fontSize: '13px',
  }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderBottom: '1px solid #eceade', cursor: 'pointer', width: '100%', background: 'transparent', border: 'none', textAlign: 'left', font: 'inherit' }

  function stateLabel(row) {
    if (row.state === 'ok') return '已存在'
    if (row.state === 'missing') return '需重新定位'
    if (row.state === 'invalid') return '配置损坏'
    return '未知'
  }

  function render() {
    if (!panel) return
    panel.textContent = ''
    const recent = (choices && choices.recent) || []
    const scope = (choices && choices.scope) || {}
    const binding = (choices && choices.binding) || {}
    const head = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
      el('strong', { text: '打开研究' }),
      el('button', { style: buttonStyle, text: '关闭', onClick: close }),
    )
    const scopeBox = el('div', { style: { background: '#f2f0e9', borderRadius: '6px', padding: '8px 10px', fontSize: '12.5px', color: '#5b564d', lineHeight: '1.7' } },
      el('div', { text: `当前页面：${binding.studyId || '未绑定'}` }),
      el('div', { text: `当前工作区：${scope.workspace ? (scope.workspace.path || scope.workspace.id || '已识别') : '未识别'}` }),
      el('div', { text: `当前会话：${scope.kind === 'agent' ? (scope.session || '已识别') : '页面切换不改变 Agent 研究'}` }),
    )
    const list = el('div', { style: { maxHeight: '230px', overflow: 'auto', border: '1px solid #eceade', borderRadius: '6px', marginTop: '10px' } })
    if (!recent.length) list.append(el('div', { style: { padding: '12px', color: '#726c62' }, text: '暂无最近研究。选择研究文件夹或新建研究。' }))
    for (const row of recent) {
      const item = el('button', { style: { ...rowStyle, opacity: row.state === 'missing' ? '0.65' : '1' }, onClick: () => select(row) },
        el('span', { style: { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: `${row.name || row.studyId || row.studyPath}` }),
        el('span', { style: { color: '#726c62', fontSize: '12px' }, text: row.current ? '当前' : stateLabel(row) }),
      )
      if (row.current) item.style.background = '#f4e5dd'
      list.append(item)
    }
    const actions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      el('button', { style: buttonStyle, text: '选择研究文件夹…', onClick: chooseFolder }),
      el('button', { style: buttonStyle, text: '新建研究…', onClick: () => { creating = true; advanced = false; render() } }),
      el('button', { style: buttonStyle, text: '高级', onClick: () => { advanced = !advanced; creating = false; render() } }),
    )
    const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, head, scopeBox, list, actions)
    if (creating) body.append(createForm())
    if (advanced) body.append(advancedForm())
    if (note) body.append(el('div', { style: { color: '#9b3a2c', fontSize: '12.5px' }, text: note }))
    panel.append(body)
  }

  function createForm() {
    const name = el('input', { placeholder: '研究名称', value: '', style: { height: '30px', padding: '0 8px', border: '1px solid #cdc7b7', borderRadius: '5px', font: 'inherit' } })
    const dirText = el('span', { style: { color: '#5b564d', fontSize: '12.5px', wordBreak: 'break-all' }, text: targetDir || '尚未选择父目录' })
    const choose = el('button', { style: buttonStyle, text: '选择父目录…', onClick: async () => {
      const dir = await chooseFolderPath()
      if (!dir) return
      targetDir = dir; render()
    } })
    const create = el('button', { style: { ...buttonStyle, background: '#a55a3c', color: '#fdfbf7', borderColor: '#a55a3c' }, text: '创建并连接', onClick: async () => {
      if (busy) return
      const title = String(name.value || '').trim()
      if (!title) { note = '请填写研究名称'; render(); return }
      if (!targetDir) { note = '请选择父目录'; render(); return }
      busy = true; note = ''
      try {
        const payload = { studyPath: joinPath(targetDir, 'study.json'), name: title }
        await api('studyCreate', payload)
        await finishSwitch()
      } catch (error) { note = error.message; busy = false; render() }
    } })
    return el('div', { style: { border: '1px solid #eceade', borderRadius: '6px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
      el('strong', { text: '新建研究' }), name, dirText, el('div', { style: { display: 'flex', gap: '8px' } }, choose, create))
  }

  function advancedForm() {
    const input = el('input', { placeholder: 'study.json 的绝对路径', style: { flex: '1 1 auto', height: '30px', padding: '0 8px', border: '1px solid #cdc7b7', borderRadius: '5px', font: 'inherit' } })
    const connect = el('button', { style: buttonStyle, text: '连接', onClick: async () => {
      if (busy) return
      if (!input.value.trim()) { note = '请填写研究定义路径'; render(); return }
      busy = true; note = ''
      try { await api('studyConnect', { studyPath: input.value.trim() }); await finishSwitch() }
      catch (error) { note = error.message; busy = false; render() }
    } })
    return el('div', { style: { border: '1px solid #eceade', borderRadius: '6px', padding: '10px', display: 'flex', gap: '8px' } }, input, connect)
  }

  function joinPath(dir, name) {
    const clean = String(dir).replace(/[\\/]+$/, '')
    return `${clean}/${name}`
  }

  async function chooseFolderPath() {
    if (!pickDirectory) { note = '当前宿主未提供目录选择，请使用高级路径'; render(); return null }
    try { return await pickDirectory() } catch (error) { note = error.message || '目录选择已取消'; render(); return null }
  }

  async function chooseFolder() {
    const dir = await chooseFolderPath()
    if (!dir) return
    busy = true; note = ''
    try {
      const found = await api('studyDiscover', { dir })
      const configs = (found && found.configs) || []
      if (!configs.length) {
        targetDir = dir; creating = true; advanced = false
        note = '此文件夹没有研究配置，可以新建研究。'
      } else if (configs.length === 1) {
        await api('studyConnect', { studyPath: configs[0].studyPath })
        await finishSwitch()
        return
      } else {
        choices = null
        showConfigs(configs)
        busy = false
        return
      }
    } catch (error) { note = error.message }
    busy = false
    render()
  }

  function showConfigs(configs, relocateId = null) {
    if (!panel) return
    panel.textContent = ''
    panel.append(
      el('strong', { text: relocateId ? '选择重新定位后的研究配置' : '此文件夹有多个研究配置，请选择' }),
      el('div', { style: { margin: '10px 0', border: '1px solid #eceade', borderRadius: '6px' } },
        ...configs.map(row => el('button', { style: rowStyle, onClick: async () => {
          if (!row.valid) { note = '这个配置无效：' + (row.problems || []).join('；'); render(); return }
          try {
            if (relocateId) await api('studyRelocate', { instanceId: relocateId, studyPath: row.studyPath })
            else await api('studyConnect', { studyPath: row.studyPath })
            await finishSwitch()
          } catch (error) { note = error.message; busy = false; render() }
        } },
          el('span', { style: { flex: '1 1 auto' }, text: `${row.name || row.studyId || row.relativePath}` }),
          el('span', { style: { color: row.valid ? '#3f6b4f' : '#9b3a2c', fontSize: '12px' }, text: row.valid ? row.relativePath : '无效' }),
        ))
      ),
      el('button', { style: buttonStyle, text: '返回', onClick: () => { choices = null; refresh(); render() } }),
    )
  }

  async function select(row) {
    if (row.state === 'missing') {
      if (!row.instanceId) { note = '该研究没有实例记录，请选择文件夹或高级路径连接'; advanced = true; render(); return }
      const dir = await chooseFolderPath()
      if (!dir) return
      busy = true; note = ''
      try {
        const found = await api('studyDiscover', { dir })
        const configs = (found && found.configs) || []
        if (!configs.length) { note = '此文件夹没有研究配置'; busy = false; render(); return }
        if (configs.length > 1) { showConfigs(configs, row.instanceId); return }
        await api('studyRelocate', { instanceId: row.instanceId, studyPath: configs[0].studyPath })
        await finishSwitch()
      } catch (error) { note = error.message; busy = false; render() }
      return
    }
    if (!row.studyPath) return
    busy = true; note = ''
    try { await api('studyConnect', { studyPath: row.studyPath }); await finishSwitch() }
    catch (error) { note = error.message; busy = false; render() }
  }

  async function finishSwitch() {
    busy = false
    let name = ''
    try { choices = await api('studyChoices'); const current = (choices.recent || []).find(row => row.current); name = (current && (current.name || current.studyId)) || '' } catch { /* 名称稍后刷新 */ }
    close()
    updateButton()
    showToast(name)
    onChanged()
  }

  function showToast(name) {
    const toast = el('div', {
      style: {
        position: 'fixed', right: '24px', bottom: '28px', zIndex: '2147483100', maxWidth: '420px',
        background: '#24221f', color: '#fdfbf7', borderRadius: '8px', padding: '10px 12px',
        display: 'flex', alignItems: 'center', gap: '10px', font: '13px Cambria, serif',
        boxShadow: '0 10px 26px rgba(0,0,0,.25)',
      },
    },
      el('span', { style: { flex: '1 1 auto' }, text: name ? `已切换到：${name}` : '已切换研究' }),
      el('button', { style: { ...buttonStyle, height: '26px', background: '#fdfbf7' }, text: '刷新面板', onClick: () => { try { window.location.reload() } catch { /* 无窗口 */ } } }),
      el('button', { style: { ...buttonStyle, height: '26px', background: 'transparent', color: '#fdfbf7', borderColor: '#5b564d' }, text: '稍后', onClick: () => toast.remove() }),
    )
    document.body.append(toast)
    setTimeout(() => { try { toast.remove() } catch { /* 已移除 */ } }, 12000)
  }

  async function refresh() {
    try { choices = await api('studyChoices') } catch (error) { choices = null; note = error.message }
    updateButton()
    if (panel) render()
  }

  function updateButton() {
    if (!root) return
    const current = choices && choices.binding && choices.binding.studyId
    const nameRow = choices && choices.recent && choices.recent.find(row => row.current)
    root.textContent = `研究：${(nameRow && (nameRow.name || nameRow.studyId)) || current || '未绑定'} ▾`
  }

  function close() {
    if (panel) { panel.remove(); panel = null }
  }

  function open() {
    if (panel) { close(); return }
    panel = el('div', {
      style: {
        position: 'fixed', top: '70px', right: '24px', width: '540px', maxWidth: 'calc(100vw - 48px)',
        maxHeight: 'calc(100vh - 120px)', overflow: 'auto', zIndex: '2147483000', background: '#fbfaf6',
        border: '1px solid #cdc7b7', borderRadius: '10px', padding: '14px', boxShadow: '0 18px 50px rgba(0,0,0,.22)',
        fontFamily: 'Cambria, "Noto Serif SC", serif', color: '#24221f', fontSize: '14px',
      },
    })
    document.body.append(panel)
    refresh()
  }

  function install() {
    if (root) return root
    if (!document.body || typeof document.body.appendChild !== 'function' || !document.createElement) return null
    root = el('button', {
      style: {
        position: 'fixed', top: '18px', right: '26px', zIndex: '2147482000',
        height: '30px', padding: '0 12px', border: '1px solid #cdc7b7', borderRadius: '999px',
        background: '#fffefb', color: '#24221f', cursor: 'pointer', font: 'inherit', fontSize: '13px',
        boxShadow: '0 2px 10px rgba(0,0,0,.08)',
      },
      text: '研究：加载中…',
      title: `${plugin} 当前研究`,
    })
    root.addEventListener('click', open)
    document.body.append(root)
    refresh()
    return root
  }

  return { install, open, close, refresh, get state() { return choices } }
}

const DSH_RESEARCH_PICKER = { createStudyPicker }
  global.__DSH_RESEARCH_PICKER__ = DSH_RESEARCH_PICKER
})(typeof window !== 'undefined' ? window : globalThis)
/* @dsh-generated: study-picker prelude end */




window.__ModuleLoader__.load({
  id: '@local/analysis-run',
  factory(require) {
    const React = require('react'), h = React.createElement
    const { useState, useEffect, useRef } = React
    const API = '/api/analysis-run'
    /* 页面身份：共享逻辑在 research-core/client-identity.mjs。 */
    const identityApi = window.__DSH_RESEARCH_CLIENT_IDENTITY__
    if (!identityApi) throw new Error('页面身份模块未加载，请刷新页面')
    let hostCtx = null
    const identity = identityApi.createClientIdentity({
      plugin: 'analysis-run',
      storage: (() => { try { return sessionStorage } catch { return null } })(),
      global: (typeof window !== 'undefined' ? window : globalThis),
      workspaceProvider: ctx => identityApi.workspaceFromContext(ctx),
    })
    function newPage() { identity.newPage(); activeBinding = null; return identity.pageId() }
    let activeBinding = null
    const sourceLabel = { page: '页面连接', session: '会话连接', workspace: '工作区记录', project: '工作区项目配置', legacy: '旧配置来源', candidate: '候选研究', empty: '空研究', explicit: '已连接' }
    async function requestTicket() {
      await identity.ready()
      const snapshot = identity.prepare(hostCtx)
      return { snapshot, headers: identity.headers(), body: identity.body() }
    }
    async function call(action, payload, run) {
      const ticket = await requestTicket()
      const init = { headers: { 'x-analysis-run': '1', ...ticket.headers } }
      if (payload !== undefined) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify({ action, payload: { ...payload, ...ticket.body } }) }
      const response = await fetch(`${API}?action=${action}${run ? '&run=' + encodeURIComponent(run) : ''}`, init)
      const result = await response.json()
      if (!result.ok) { const error = new Error(result.error?.message || '请求失败'); error.details = result.error?.details; error.code = result.error?.code; throw error }
      identity.accept(ticket.snapshot, result.data && result.data.binding, { allowRebind: action === 'studyConnect' || action === 'studySave' })
      if (result.data && result.data.binding && result.data.binding.token) activeBinding = result.data.binding.token
      return result.data
    }
    const CSS = `
.ar-app{
  --ar-bg:#f5f4ef;--ar-sunk:#eeede6;--ar-panel:#fbfaf6;--ar-raised:#fffefb;--ar-alt:#f2f0e9;
  --ar-line:#e3dfd4;--ar-line-soft:#eceade;--ar-line-strong:#cdc7b7;
  --ar-ink:#24221f;--ar-ink-2:#5b564d;--ar-ink-3:#726c62;
  --ar-accent:#c46e4f;--ar-accent-deep:#a55a3c;--ar-accent-darker:#8b4526;--ar-accent-soft:#f4e5dd;--ar-on-accent:#fdfbf7;
  --ar-ok:#3f6b4f;--ar-ok-soft:#e4ebe1;--ar-warn:#7d5810;--ar-warn-soft:#f3ead3;--ar-bad:#9b3a2c;--ar-bad-soft:#f4dfd9;--ar-info:#3f5a70;--ar-info-soft:#e2e8ec;
  height:100%;overflow:auto;padding:20px 22px 44px;box-sizing:border-box;background:var(--ar-bg);color:var(--ar-ink);
  font-family:Cambria,"Noto Serif SC","Source Han Serif SC","Songti SC",STSong,SimSun,serif;font-size:15px;line-height:1.62;letter-spacing:0;font-variant-numeric:tabular-nums;
}
.ar-app *{box-sizing:border-box}
.ar-app ::selection{background:var(--ar-accent-soft);color:var(--ar-ink)}
.ar-app button,.ar-app input,.ar-app select,.ar-app textarea{font-family:inherit;color:inherit}
.ar-shell{max-width:1280px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.ar-pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}
.ar-headtext{flex:1 1 320px;min-width:0}
.ar-pagehead h1{margin:0;font-size:21px;line-height:1.24;font-weight:600;letter-spacing:0}
.ar-subtitle{margin:5px 0 0;font-size:13.5px;color:var(--ar-ink-3)}
.ar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ar-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 13px;border:1px solid transparent;border-radius:5px;background:transparent;font-size:14.5px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease}
.ar-btn-quiet{background:var(--ar-raised);border-color:var(--ar-line-strong);color:var(--ar-ink)}
.ar-btn-quiet:hover:not(:disabled){background:var(--ar-alt);border-color:var(--ar-ink-3)}
.ar-btn-primary{background:var(--ar-accent-deep);border-color:var(--ar-accent-deep);color:var(--ar-on-accent)}
.ar-btn-primary:hover:not(:disabled){background:var(--ar-accent-darker);border-color:var(--ar-accent-darker)}
.ar-btn-ghost{color:var(--ar-ink-2);border-color:transparent}
.ar-btn-ghost:hover:not(:disabled){background:var(--ar-alt);color:var(--ar-ink)}
.ar-btn:disabled{background:var(--ar-alt);border-color:var(--ar-line);color:var(--ar-ink-3);cursor:not-allowed}
.ar-app button:focus-visible,.ar-app input:focus-visible,.ar-app select:focus-visible,.ar-app summary:focus-visible{outline:2px solid var(--ar-accent-deep);outline-offset:2px}
.ar-spine{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:9px 14px;border:1px solid var(--ar-line);border-radius:7px;background:var(--ar-panel);font-size:12.5px;color:var(--ar-ink-2)}
.ar-spine b{font-size:14.5px;font-weight:600;color:var(--ar-ink)}
.ar-spine .ar-spine-right{margin-left:auto;display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap}
.ar-tag{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid transparent;border-radius:4px;font-size:12.5px;line-height:1.2;white-space:nowrap}
.ar-tag-ok{color:var(--ar-ok);background:var(--ar-ok-soft);border-color:#cad8c8}
.ar-tag-warn{color:var(--ar-warn);background:var(--ar-warn-soft);border-color:#e1d2ab}
.ar-tag-bad{color:var(--ar-bad);background:var(--ar-bad-soft);border-color:#e0c1b7}
.ar-tag-info{color:var(--ar-info);background:var(--ar-info-soft);border-color:#cbd6dd}
.ar-tag-plain{color:var(--ar-ink-2);background:var(--ar-alt);border-color:var(--ar-line)}
.ar-viewtabs{display:flex;align-items:flex-end;gap:22px;border-bottom:1px solid var(--ar-line);margin-top:2px}
.ar-viewtab{border:0;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:9px 2px 10px;color:var(--ar-ink-3);font-size:15px;line-height:1.3;white-space:nowrap;cursor:pointer}
.ar-viewtab:hover{color:var(--ar-ink)}
.ar-viewtab[aria-selected="true"]{color:var(--ar-ink);font-weight:600;border-bottom-color:var(--ar-accent-deep)}
.ar-card{border:1px solid var(--ar-line);border-radius:7px;background:var(--ar-panel);padding:16px 18px 18px;min-width:0}
.ar-card-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.ar-card-head h2{margin:0;font-size:17px;line-height:1.3;font-weight:600}
.ar-note{margin:0;font-size:13.5px;line-height:1.6;color:var(--ar-ink-3)}
.ar-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px}
.ar-kv{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border:1px solid var(--ar-line-soft);border-radius:5px;background:var(--ar-raised);min-width:0}
.ar-kv span{font-size:12px;color:var(--ar-ink-3)}
.ar-kv b{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar-runhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ar-runid{font-size:13px;letter-spacing:.012em;color:var(--ar-ink-2);background:var(--ar-alt);border:1px solid var(--ar-line);border-radius:4px;padding:1px 8px;overflow-wrap:anywhere}
.ar-stages{display:flex;flex-wrap:wrap;gap:0;border:1px solid var(--ar-line);border-radius:7px;overflow:hidden;background:var(--ar-panel);margin-top:12px}
.ar-stage{flex:1 1 160px;padding:10px 13px;border-right:1px solid var(--ar-line-soft);min-width:0}
.ar-stage:last-child{border-right:0}
.ar-stage[data-s="failed"]{background:var(--ar-bad-soft)}
.ar-stage[data-s="skipped"]{background:var(--ar-sunk)}
.ar-stage-name{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600}
.ar-stage-meta{margin-top:2px;font-size:12px;color:var(--ar-ink-3);overflow-wrap:anywhere}
.ar-resulttabs{display:flex;align-items:flex-end;gap:18px;border-bottom:1px solid var(--ar-line);margin:14px 0 0}
.ar-resulttab{border:0;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 2px 9px;color:var(--ar-ink-3);font-size:14px;cursor:pointer}
.ar-resulttab:hover{color:var(--ar-ink)}
.ar-resulttab[aria-pressed="true"]{color:var(--ar-ink);font-weight:600;border-bottom-color:var(--ar-accent-deep)}
.ar-work{display:grid;grid-template-columns:210px minmax(0,1fr);gap:20px;align-items:start;margin-top:14px}
.ar-nav{display:flex;flex-direction:column;gap:4px;border:1px solid var(--ar-line);border-radius:7px;background:var(--ar-panel);padding:8px}
.ar-nav-title{font-size:12px;color:var(--ar-ink-3);padding:2px 6px 6px}
.ar-nav button{border:0;background:transparent;text-align:left;padding:7px 9px;border-radius:4px;color:var(--ar-ink-2);font-size:13.5px;cursor:pointer;line-height:1.45}
.ar-nav button:hover{background:var(--ar-alt);color:var(--ar-ink)}
.ar-nav button[aria-pressed="true"]{background:var(--ar-accent-soft);color:var(--ar-accent-darker);font-weight:600}
.ar-content{min-width:0}
.ar-table-scroll{overflow:auto;max-height:62vh;border:1px solid var(--ar-line);border-radius:5px;background:var(--ar-raised)}
.ar-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px}
.ar-table caption{text-align:left;padding:10px 12px;font-size:13.5px;font-weight:600;color:var(--ar-ink-2);border-bottom:1px solid var(--ar-line);background:var(--ar-alt)}
.ar-table caption small{display:block;margin-top:1px;font-size:11px;font-weight:400;color:var(--ar-ink-3);letter-spacing:.01em}
.ar-table th{position:sticky;top:0;z-index:1;background:var(--ar-alt);text-align:left;padding:8px 10px;border-bottom:1px solid var(--ar-line-strong);font-size:12.5px;font-weight:600;color:var(--ar-ink-2);white-space:nowrap}
.ar-table th small{display:block;margin-top:1px;font-size:10.5px;font-weight:400;color:var(--ar-ink-3);letter-spacing:.01em}
.ar-table td{padding:7px 10px;border-bottom:1px solid var(--ar-line-soft);white-space:nowrap;font-variant-numeric:tabular-nums}
.ar-table th.num,.ar-table td.num{text-align:right}
.ar-table tbody tr:hover td{background:var(--ar-alt)}
.ar-nav button small{display:block;margin-top:1px;font-size:10.5px;font-weight:400;color:var(--ar-ink-3);letter-spacing:.01em}
.ar-figgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.ar-fig{margin:0;border:1px solid var(--ar-line);border-radius:7px;background:var(--ar-raised);padding:10px}
.ar-fig.wide{grid-column:1/-1}
.ar-fig img{display:block;max-width:100%;height:auto}
.ar-fig figcaption{margin-top:7px;font-size:12.5px;color:var(--ar-ink-3)}
.ar-chart{overflow:auto}
.ar-chart svg{display:block;width:100%;min-width:540px;max-width:820px;height:auto;margin:0 auto;font-family:inherit}
.ar-exportbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 16px;border-bottom:1px solid var(--ar-line);background:var(--ar-raised)}
.ar-versions{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;width:100%;font-size:12.5px;color:var(--ar-ink-3)}
.ar-versionrow{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--ar-line);border-radius:999px}
.ar-versionrow b{font-weight:600;color:var(--ar-ink-1)}
.ar-linkbtn{border:0;background:none;padding:0;color:var(--ar-accent,#1b6ca8);cursor:pointer;font:inherit;text-decoration:underline}
.ar-linkbtn:hover{text-decoration:none}
.ar-preview{margin:10px 0 4px;border:1px solid var(--ar-line);border-radius:7px;overflow:hidden;background:var(--ar-raised)}
.ar-preview-head{display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid var(--ar-line);font-size:12.5px;color:var(--ar-ink-3)}
.ar-preview-head b{color:var(--ar-ink-1)}
.ar-preview-frame{display:block;width:100%;height:70vh;border:0;background:#fff}
.ar-reportdoc{max-width:78ch;padding:20px 24px;border:1px solid var(--ar-line);border-radius:7px;background:var(--ar-raised);font-size:14px;line-height:1.78;overflow-wrap:anywhere}
.ar-reportdoc h2{margin:0 0 12px;font-size:19px;line-height:1.3;font-weight:600}
.ar-reportdoc h3{margin:20px 0 8px;font-size:16px;line-height:1.35;font-weight:600;border-bottom:1px solid var(--ar-line-soft);padding-bottom:5px}
.ar-reportdoc h4{margin:14px 0 6px;font-size:14.5px;font-weight:600}
.ar-reportdoc p{margin:8px 0;max-width:none;color:var(--ar-ink-2)}
.ar-reportdoc ul{margin:8px 0;padding-left:22px;color:var(--ar-ink-2)}
.ar-reportdoc li{margin:3px 0}
.ar-reportdoc strong{color:var(--ar-ink);font-weight:600}
.ar-reportdoc code{font-family:inherit;font-size:12.5px;background:var(--ar-alt);border:1px solid var(--ar-line-soft);border-radius:3px;padding:0 4px}
.ar-report-table{overflow:auto;margin:10px 0 14px;border:1px solid var(--ar-line);border-radius:5px}
.ar-report-table table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;font-variant-numeric:tabular-nums}
.ar-report-table th{background:var(--ar-alt);text-align:left;padding:7px 9px;border-bottom:1px solid var(--ar-line-strong);font-weight:600;color:var(--ar-ink-2);white-space:nowrap}
.ar-report-table th small{display:block;margin-top:1px;font-size:10px;font-weight:400;color:var(--ar-ink-3)}
.ar-report-table td{padding:6px 9px;border-bottom:1px solid var(--ar-line-soft);white-space:nowrap}
.ar-empty{border:1px dashed var(--ar-line-strong);border-radius:7px;background:var(--ar-panel);padding:32px 20px;text-align:center;color:var(--ar-ink-3);display:flex;flex-direction:column;align-items:center;gap:8px}
.ar-empty strong{font-size:15px;font-weight:600;color:var(--ar-ink)}
.ar-empty span{font-size:13.5px;max-width:56ch;line-height:1.7}
.ar-status{padding:9px 12px;border:1px solid var(--ar-line);border-radius:5px;background:var(--ar-panel);font-size:13.5px;line-height:1.6;color:var(--ar-ink-2)}
.ar-error{color:var(--ar-bad);background:var(--ar-bad-soft);border-color:#e0c1b7}
.ar-warn{color:var(--ar-warn);background:var(--ar-warn-soft);border-color:#e1d2ab}
.ar-plan-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;margin-top:8px}
.ar-plan-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px;font-size:13.5px;padding:4px 0;border-top:1px solid var(--ar-line-soft)}
.ar-plan-row:first-child{border-top:0}
.ar-plan-row span{color:var(--ar-ink-3)}
.ar-plan-row b{font-weight:500;color:var(--ar-ink);overflow-wrap:anywhere}
.ar-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px;margin-top:12px}
.ar-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:13px;color:var(--ar-ink-2)}
.ar-field.wide{grid-column:1/-1}
.ar-field input,.ar-field select{height:34px;padding:0 9px;border:1px solid var(--ar-line-strong);border-radius:5px;background:var(--ar-raised);color:var(--ar-ink);font-size:14px;outline:none;min-width:0}
.ar-field input:focus,.ar-field select:focus{border-color:var(--ar-accent-deep);outline:2px solid var(--ar-accent-deep);outline-offset:1px}
.ar-hint{font-size:12px;line-height:1.55;color:var(--ar-ink-3)}
.ar-checks{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0 4px}
.ar-checks label{display:flex;align-items:center;gap:6px;font-size:13.5px;color:var(--ar-ink-2)}
.ar-wizard{display:flex;flex-direction:column;gap:4px}
.ar-types{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:12px 0 4px}
.ar-type{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:10px 12px;border:1px solid var(--ar-line-strong);border-radius:8px;background:var(--ar-raised);cursor:pointer;text-align:left;font:inherit;color:var(--ar-ink-1)}
.ar-type:hover{border-color:var(--ar-accent-deep)}
.ar-type b{font-size:13.5px;font-weight:600}
.ar-type span{font-size:12px;color:var(--ar-ink-3)}
.ar-type-on{border-color:var(--ar-accent-deep);box-shadow:0 0 0 2px var(--ar-accent-ring,rgba(27,108,168,.18))}
.ar-colsel{height:32px;padding:0 8px;border:1px solid var(--ar-line-strong);border-radius:5px;background:var(--ar-raised);color:var(--ar-ink-1);font:inherit;font-size:13px}
.ar-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.55;padding:8px 10px;border:1px solid var(--ar-line-strong);border-radius:6px;background:var(--ar-raised);color:var(--ar-ink-1);resize:vertical;width:100%;box-sizing:border-box}
.ar-colchips{display:flex;flex-wrap:wrap;gap:6px;max-height:132px;overflow:auto;padding:2px 0}
.ar-chip{border:1px solid var(--ar-line-strong);background:var(--ar-raised);border-radius:14px;padding:3px 10px;font:inherit;font-size:12px;color:var(--ar-ink-2);cursor:pointer}
.ar-chip:hover{border-color:var(--ar-accent-deep)}
.ar-chip-on{background:var(--ar-accent-deep);border-color:var(--ar-accent-deep);color:#fff}
.ar-preview-plan{margin:14px 0 4px;padding:10px 12px;border:1px dashed var(--ar-line-strong);border-radius:7px;background:var(--ar-sunken,rgba(0,0,0,.02));font-size:13px;color:var(--ar-ink-2);display:flex;flex-direction:column;gap:3px}
.ar-preview-plan b{color:var(--ar-ink-1)}
.ar-checks input{width:15px;height:15px;accent-color:var(--ar-accent-deep);margin:0}
.ar-form-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.ar-details{margin-top:10px;border-top:1px solid var(--ar-line-soft);padding-top:10px}
.ar-details summary{cursor:pointer;font-size:13.5px;color:var(--ar-ink-2);outline:none}
.ar-details summary:hover{color:var(--ar-ink)}
.ar-exclude{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-top:10px}
.ar-exclude label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--ar-ink-2)}
.ar-exclude input{height:32px;padding:0 8px;border:1px solid var(--ar-line-strong);border-radius:5px;background:var(--ar-raised);font-size:13.5px;outline:none}
.ar-list{list-style:none;margin:8px 0 0;padding:0}
.ar-list li{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:5px 0;border-top:1px solid var(--ar-line-soft);font-size:13px}
.ar-runs{display:flex;flex-direction:column;gap:8px}
.ar-runrow{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--ar-line);border-radius:5px;background:var(--ar-raised);text-align:left;cursor:pointer;font-family:inherit}
.ar-runrow:hover{border-color:var(--ar-line-strong);background:var(--ar-alt)}
.ar-runrow[aria-current="true"]{border-color:var(--ar-accent-deep);background:var(--ar-accent-soft)}
.ar-runrow .ar-runid{background:transparent;border:0;padding:0;font-size:13.5px}
.ar-runrow small{font-size:12px;color:var(--ar-ink-3)}
@media (max-width:1100px){
.ar-meta{grid-template-columns:repeat(2,minmax(0,1fr))}
.ar-work{grid-template-columns:minmax(0,1fr)}
.ar-nav{flex-direction:row;flex-wrap:wrap;border:0;background:transparent;padding:0}
.ar-nav-title{display:none}
.ar-nav button{border:1px solid var(--ar-line);background:var(--ar-raised)}
}
@media (max-width:820px){
.ar-pagehead{gap:12px}
.ar-fields{grid-template-columns:minmax(0,1fr)}
.ar-plan-summary{grid-template-columns:minmax(0,1fr)}
.ar-card{padding:14px 15px 16px}
.ar-runrow{grid-template-columns:minmax(0,1fr) auto;row-gap:4px}
.ar-runrow small{grid-column:1/-1}
}
@media (max-width:700px){
.ar-app{padding:16px 14px 36px}
.ar-pagehead h1{font-size:20px}
.ar-actions{width:100%}
.ar-actions .ar-btn{flex:1 1 auto}
.ar-spine .ar-spine-right{margin-left:0;width:100%;padding-top:6px;border-top:1px solid var(--ar-line-soft)}
.ar-viewtabs{gap:16px;overflow-x:auto}
.ar-stage{flex-basis:100%;border-right:0;border-bottom:1px solid var(--ar-line-soft)}
.ar-stage:last-child{border-bottom:0}
.ar-meta{grid-template-columns:repeat(2,minmax(0,1fr))}
.ar-exclude{flex-direction:column;align-items:stretch}
.ar-exclude input{width:100%}
}
@media (max-width:430px){
.ar-app{font-size:15px;padding:12px 10px 30px}
.ar-btn{height:40px;font-size:15px}
.ar-field input,.ar-field select,.ar-exclude input{height:40px;font-size:16px}
.ar-meta{grid-template-columns:1fr 1fr}
}
`
    const moduleLabels = { descriptives: '描述统计', sample: '样本特征表', sensitivity: '敏感性分析', correlation: '相关分析', reliability: '信度', ttest: 't 检验', anova: '方差分析', mediation: '中介分析', regression: '组间回归 / ANCOVA', paired: '配对变化', mixed: '被试内线性混合模型' }
    const nodeLabels = { executed: '已完成', not_run: '未执行', failed: '失败', skipped: '跳过', running: '运行中' }
    const runLabels = { ok: '完成', partial: '部分完成', failed: '失败', running: '运行中' }
    const tagOf = status => status === 'ok' ? 'ok' : status === 'partial' ? 'warn' : status === 'failed' ? 'bad' : 'info'
    const fmtDate = value => { try { return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return String(value || '') } }
    const list = text => text.split(',').map(value => value.trim()).filter(Boolean)
    /** 保存/运行/预览前清理：空的 script 配置不应让引擎报"需要 code 或 file"。 */
    const sanitizePlan = value => {
      const copy = JSON.parse(JSON.stringify(value || {}))
      const hasScript = copy.script && (String(copy.script.code || '').trim() || String(copy.script.file || '').trim())
      if (!hasScript) delete copy.script
      if (Array.isArray(copy.analyses)) copy.analyses = copy.analyses.filter(id => id !== 'script' || Boolean(hasScript))
      return copy
    }
    const fmtCell = (value, numeric = false) => {
      if (value === '' || value == null) return '—'
      if (numeric && Number.isFinite(Number(value))) {
        const raw = String(value)
        if (!raw.includes('.')) return raw
        return Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (Number.isInteger(value)) return String(value)
        return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
      }
      return String(value)
    }
    const columnMap = { group: '组别', subjects: '人数', observations: '观测', validObservations: '有效观测', missing: '缺失', mean: '均值', sd: '标准差', median: '中位数', minimum: '最小值', maximum: '最大值', estimate: '估计值', std_error: '标准误', statistic: '统计量', p_value: 'p 值', ci_low: 'CI 下限', ci_high: 'CI 上限' }
    const columnInfo = name => { const key = String(name); const zh = columnMap[key]; return { zh: zh || key, en: key, bilingual: Boolean(zh && zh !== key) } }
    const tableTitle = name => ({ 'Descriptive statistics': '描述统计' }[name] || name)
    const stageReason = reason => !reason ? '' : reason === 'not selected in plan' ? '方案未选择' : reason.replace(/No module named '([^']+)'/, '缺少 $1 模块')
    const inlineText = text => {
      const parts = []
      const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
      let last = 0, match, key = 0
      while ((match = re.exec(String(text)))) {
        if (match.index > last) parts.push(String(text).slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) parts.push(h('strong', { key: 'b' + key++ }, token.slice(2, -2)))
        else parts.push(h('code', { key: 'c' + key++ }, token.slice(1, -1)))
        last = match.index + token.length
      }
      if (last < String(text).length) parts.push(String(text).slice(last))
      return parts.length ? parts : String(text)
    }
    const reportStatus = { ok: '完成', partial: '部分完成', failed: '失败', executed: '已执行', not_run: '未执行' }
    const translateReportLine = line => {
      let s = String(line)
      s = s.replace(/^Run:\s*/, '运行：')
      s = s.replace(/^Status:\s*(ok|partial|failed|executed|not_run)\.?/, (m, status) => '状态：' + (reportStatus[status] || status))
      s = s.replace(/^Independent participants:\s*(\d+);\s*observations:\s*(\d+).*$/, '独立参与者：$1；观测：$2')
      s = s.replace(/^Participants:\s*(\d+);\s*observations:\s*(\d+).*$/, '参与者：$1；观测：$2')
      s = s.replace(/^Gate:\s*at least (\d+) complete eligible participants for each inferential module\.?$/, '门禁：每个推断模块至少 $1 名完整合格参与者。')
      s = s.replace(/^## (descriptives|regression|paired|mixed)\s*$/, (m, name) => '## ' + (moduleLabels[name] || name))
      s = s.replace(/^## Descriptive statistics\s*$/, '## 描述统计')
      s = s.replace(/^# (.*) — analysis$/, '# $1 — 分析报告')
      s = s.replace(/not selected in plan/g, '方案未选择')
      s = s.replace(/No module named '([^']+)'/g, '缺少 $1 模块')
      return s
    }
    function renderReport(text) {
      const lines = String(text || '').split(/\r?\n/)
      const out = []
      let i = 0, key = 0
      while (i < lines.length) {
        const line = translateReportLine(lines[i])
        if (!line.trim()) { i++; continue }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading) {
          const level = Math.min(4, Math.max(2, heading[1].length + 1))
          out.push(h('h' + level, { key: 'h' + key++ }, inlineText(heading[2])))
          i++; continue
        }
        if (/^\s*\|/.test(line)) {
          const rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) {
            const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
            if (!cells.every(cell => /^:?-{3,}:?$/.test(cell))) rows.push(cells)
            i++
          }
          if (rows.length) {
            const head = rows.shift()
            out.push(h('div', { key: 't' + key++, className: 'ar-report-table' },
              h('table', null,
                h('thead', null, h('tr', null, head.map((cell, j) => { const info = columnInfo(cell); return h('th', { key: j }, info.bilingual ? h(React.Fragment, null, h('span', null, info.zh), h('small', null, info.en)) : cell) }))),
                h('tbody', null, rows.map((row, ri) => h('tr', { key: ri }, row.map((cell, ci) => h('td', { key: ci }, inlineText(cell)))))))))
          }
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
          out.push(h('ul', { key: 'u' + key++ }, items.map((item, j) => h('li', { key: j }, inlineText(item)))))
          continue
        }
        out.push(h('p', { key: 'p' + key++ }, inlineText(line)))
        i++
      }
      return out.length ? out : h('p', null, '报告为空。')
    }
    function descriptiveChart(table) {
      if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null
      const lower = table.columns.map(column => String(column).toLowerCase())
      const groupIndex = lower.findIndex(name => ['group', '组别'].includes(name))
      const meanIndex = lower.findIndex(name => ['mean', '均值'].includes(name))
      const sdIndex = lower.findIndex(name => ['sd', '标准差', 'std'].includes(name))
      const nIndex = lower.findIndex(name => ['subjects', 'n', '人数', 'observations'].includes(name))
      if (groupIndex < 0 || meanIndex < 0) return null
      const rows = table.rows.map(row => {
        const mean = Number(row[meanIndex])
        const sd = sdIndex >= 0 ? Number(row[sdIndex]) : null
        const n = nIndex >= 0 ? Number(row[nIndex]) : null
        const se = Number.isFinite(sd) && Number.isFinite(n) && n > 0 ? sd / Math.sqrt(n) : null
        return { label: String(row[groupIndex] ?? '—'), mean, sd, n, lo: se == null ? mean : mean - 1.96 * se, hi: se == null ? mean : mean + 1.96 * se }
      }).filter(row => Number.isFinite(row.mean))
      if (!rows.length) return null
      const w = 760, hgt = 330, pad = { l: 56, r: 24, t: 28, b: 58 }
      const iw = w - pad.l - pad.r, ih = hgt - pad.t - pad.b
      let min = Math.min(...rows.map(row => row.lo)), max = Math.max(...rows.map(row => row.hi))
      if (!(max > min)) { min -= 1; max += 1 }
      const padY = (max - min) * 0.12
      min -= padY; max += padY
      const y = value => pad.t + ih - (value - min) / (max - min) * ih
      const ticks = Array.from({ length: 6 }, (_, i) => min + (max - min) * i / 5)
      const band = iw / rows.length, bw = Math.min(64, band * 0.48)
      const out = [
        h('line', { key: 'axis', x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + ih, stroke: '#cdc7b7' })
      ]
      ticks.forEach((tick, i) => {
        const yy = y(tick)
        out.push(h('line', { key: 'g' + i, x1: pad.l, x2: pad.l + iw, y1: yy, y2: yy, stroke: '#eceade', strokeWidth: 1 }))
        out.push(h('text', { key: 'gt' + i, x: pad.l - 9, y: yy + 4, textAnchor: 'end', fontSize: 10.5, fill: '#726c62' }, tick.toFixed(1)))
      })
      rows.forEach((row, i) => {
        const cx = pad.l + band * (i + 0.5)
        const top = Math.min(y(row.mean), y(row.lo)), bottom = Math.max(y(row.mean), y(row.hi))
        out.push(h('rect', { key: 'bar' + i, x: cx - bw / 2, y: y(row.mean), width: bw, height: Math.max(1, y(min) - y(row.mean)), fill: '#efd8cc', stroke: '#c46e4f', strokeWidth: 1.2, rx: 2 }))
        if (Number.isFinite(row.lo) && Number.isFinite(row.hi) && row.lo !== row.hi) {
          out.push(h('line', { key: 'ci' + i, x1: cx, x2: cx, y1: y(row.lo), y2: y(row.hi), stroke: '#8b4526', strokeWidth: 1.6 }))
          out.push(h('line', { key: 'cl' + i, x1: cx - 7, x2: cx + 7, y1: y(row.lo), y2: y(row.lo), stroke: '#8b4526', strokeWidth: 1.6 }))
          out.push(h('line', { key: 'ch' + i, x1: cx - 7, x2: cx + 7, y1: y(row.hi), y2: y(row.hi), stroke: '#8b4526', strokeWidth: 1.6 }))
        }
        out.push(h('circle', { key: 'dot' + i, cx, cy: y(row.mean), r: 3.6, fill: '#8b4526' }))
        const labelY = Math.max(pad.t + 11, y(row.hi) - 8)
        out.push(h('text', { key: 'val' + i, x: cx, y: labelY, textAnchor: 'middle', fontSize: 11, fontWeight: 600, fill: '#24221f' }, row.mean.toFixed(2)))
        out.push(h('text', { key: 'x' + i, x: cx, y: pad.t + ih + 20, textAnchor: 'middle', fontSize: 11.5, fill: '#5b564d' }, row.label))
      })
      out.push(h('line', { key: 'base', x1: pad.l, x2: pad.l + iw, y1: pad.t + ih, y2: pad.t + ih, stroke: '#cdc7b7' }))
      out.push(h('text', { key: 'xlab', x: pad.l + iw, y: hgt - 10, textAnchor: 'end', fontSize: 10.5, fill: '#726c62' }, '组别'))
      return h('svg', { viewBox: '0 0 ' + w + ' ' + hgt, role: 'img', 'aria-label': '各组均值与 95% 置信区间' }, out)
    }
    function Table({ table }) {
      const [limit, setLimit] = useState(50)
      const numeric = table.columns.map((_, j) => {
        const values = table.rows.slice(0, 40).map(row => row[j]).filter(value => value !== '' && value != null)
        return values.length > 0 && values.every(value => typeof value === 'number' || (String(value).trim() !== '' && Number.isFinite(Number(value))))
      })
      return h('div', { className: 'ar-table-scroll' },
        h('table', { className: 'ar-table' },
          h('caption', null, h('span', null, tableTitle(table.label)), tableTitle(table.label) !== table.label ? h('small', null, table.label) : null),
          h('thead', null, h('tr', null, table.columns.map((col, i) => { const info = columnInfo(col); return h('th', { key: i, scope: 'col', className: numeric[i] ? 'num' : '' }, info.bilingual ? h(React.Fragment, null, h('span', null, info.zh), h('small', null, info.en)) : info.en) }))),
          h('tbody', null, table.rows.slice(0, limit).map((row, i) => h('tr', { key: i }, row.map((value, j) => h('td', { key: j, className: numeric[j] ? 'num' : '' }, fmtCell(value, numeric[j]))))))),
        table.rows.length > limit ? h('button', { className: 'ar-btn ar-btn-quiet', style: { marginTop: 10 }, onClick: () => setLimit(v => v + 100) }, '继续显示（共 ' + table.rows.length + ' 行）') : null)
    }
    function Panel() {
      const [status, setStatus] = useState(null), [result, setResult] = useState(null), [plan, setPlan] = useState(null), [runId, setRunId] = useState(''), [tab, setTab] = useState('tables'), [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [id, setId] = useState(''), [reason, setReason] = useState(''), [studyPath, setStudyPath] = useState('')
      const [view, setView] = useState('results'), [editing, setEditing] = useState(false)
      const [preview, setPreview] = useState(null)
      const [advanced, setAdvanced] = useState(false), [planInfo, setPlanInfo] = useState(null)
      const sequence = useRef(0), dirty = useRef(false), studyKey = useRef('')
      async function load(selected = '', initial = false) {
        const serial = ++sequence.current
        try {
          const next = await call('status')
          if (serial !== sequence.current) return
          const nextKey = `${next.binding?.instanceId || next.study.instanceId || next.study.id}|${next.study.id}|${next.study.dataRoot}|${next.plan?.dataPath || ''}|${next.study.revision}`
          const changedStudy = studyKey.current !== nextKey
          setStatus(next); setError('')
          if (changedStudy) { dirty.current = false; studyKey.current = nextKey; setPlan(null); setRunId(''); setResult(null); setKey(''); setNotice(''); setEditing(false) }
          if ((changedStudy || !dirty.current) && next.plan) {
            const draftKey = identityApi.planDraftKey(next.binding || {}, next.plan.dataPath, next.study.id)
            let saved = null; try { saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null') } catch { }
            // 草稿只覆盖同一数据文件；数据源变了就丢弃草稿，避免旧草稿盖掉已更新的方案。
            if (saved && next.plan && saved.dataPath && next.plan.dataPath && saved.dataPath !== next.plan.dataPath) saved = null
            setPlan((initial || changedStudy) && saved ? saved : next.plan)
          }
          let nextResult
          const target = changedStudy ? '' : selected
          try { nextResult = await call('results', undefined, target) }
          catch (error) { if (error.code !== 'not_found' || !target) throw error; nextResult = await call('results') }
          if (serial !== sequence.current) return
          const resultStudy = nextResult.study
          if (resultStudy && `${resultStudy.id}|${resultStudy.dataRoot}|${resultStudy.revision}` !== nextKey) { setResult(null); setRunId(''); setKey(''); return load('', true) }
          setResult(nextResult); setRunId(nextResult.runId || '')
          setKey(current => nextResult.tables.some(table => table.key === current) ? current : nextResult.tables[0]?.key || '')
          return true
        } catch (error) { if (serial === sequence.current) { setError(error.message); setResult(null); setRunId(''); setKey('') } return false }
      }
      useEffect(() => { load('', true) }, [])
      useEffect(() => {
        if (!editing || !plan || !plan.dataPath) { setPlanInfo(null); return }
        let alive = true
        const timer = setTimeout(async () => {
          try { const info = await call('preview', { plan: sanitizePlan(plan) }); if (alive) setPlanInfo(info) } catch { if (alive) setPlanInfo(null) }
        }, 400)
        return () => { alive = false; clearTimeout(timer) }
      }, [editing, plan])
      useEffect(() => { if (!status?.busy) return; const timer = setInterval(() => load(runId), 2500); return () => clearInterval(timer) }, [status?.busy, runId])
      function change(name, value) {
        const next = { ...plan, [name]: value }; setPlan(next); dirty.current = true
        try { sessionStorage.setItem(identity.planDraftKey(next.dataPath), JSON.stringify(next)) } catch { }
      }
      async function act(action, payload) {
        setBusy(true); setError(''); setNotice('')
        try {
          const safe = payload && payload.plan ? { ...payload, plan: sanitizePlan(payload.plan) } : payload
          const out = await call(action, { ...safe, ...(action === 'plan' ? { revision: status.planRevision } : {}), ...(action === 'exclude' ? { revision: status.exclusionsRevision } : {}) })
          if (action === 'studyConnect' || action === 'studySave') { setRunId(''); setResult(null); setKey(''); dirty.current = false; await load('', true); setNotice('研究已连接。') }
          else {
            if (action === 'plan') { dirty.current = false; setNotice('方案已保存。'); setEditing(false) }
            else if (action === 'run') { setNotice('运行已完成：' + out.runId); setView('results') }
            else { setNotice('排除名单已保存；下一次运行应用变更。') }
            await load(out.runId || runId)
          }
          return true
        } catch (error) { setError(error.message); if (error.details?.runId) await load(error.details.runId); return false }
        finally { setBusy(false) }
      }
      const blocked = busy || Boolean(status?.busy), meta = result?.meta
      const modules = new Map((status?.modules || []).map(module => [module.id, module.label]))
      const moduleName = id => modules.get(id) || moduleLabels[id] || id
      // 模块是否已具备必填配置：不满足就灰掉，避免"选了却失败"。
      const moduleReady = id => {
        if (id === 'paired') return plan?.layout === 'long' ? (plan.within?.levels || []).length === 2 : (plan.pairedColumns || []).length === 2
        if (id === 'mixed') return plan?.layout === 'long' && Boolean(plan.within?.column)
        if (id === 'regression') return (plan?.groupColumns || []).length > 0 || (plan?.covariates || []).length > 0 || (plan?.interactions || []).length > 0
        if (id === 'correlation') return (plan?.correlation?.columns || []).length >= 2
        if (id === 'reliability') return (plan?.reliability || []).some(spec => (spec.items || []).length >= 2)
        if (id === 'ttest') return plan?.ttest?.kind === 'one-sample' ? Number.isFinite(plan?.ttest?.mu) : Boolean(plan?.ttest?.group)
        if (id === 'anova') return (plan?.anova?.factors || []).length >= 1
        if (id === 'mediation') return Boolean(plan?.mediation?.x && plan?.mediation?.m && plan?.mediation?.y)
        return true
      }
      const moduleHint = { regression: '需要分组列或协变量', paired: '需要两个配对列或两个时点水平', mixed: '需要长表与时点列', correlation: '需要至少两个相关变量', reliability: '需要条目组', ttest: '需要分组列或比较值', anova: '需要因素列', mediation: '需要 X/M/Y 三列' }
      const reliabilityText = specs => (specs || []).map(spec => `${spec.name ? spec.name + '=' : ''}${(spec.items || []).join(',')}`).join('\n')
      const reliabilityFromText = text => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const index = line.indexOf('=')
        return index < 0 ? { items: list(line) } : { name: line.slice(0, index).trim(), items: list(line.slice(index + 1)) }
      })
      const nodes = meta?.nodes || meta?.model?.nodes || {}
      const header = h('header', { className: 'ar-pagehead' },
        h('div', { className: 'ar-headtext' }, h('h1', null, '分析直通'), h('p', { className: 'ar-subtitle' }, (status?.study.name || '正在加载研究…') + (status?.mode === 'adapter' ? ' · 专用分析' : ' · 通用分析') + (status?.binding ? ' · ' + (sourceLabel[status.binding.source] || status.binding.source) + (status.binding.instanceId ? ' / 实例 ' + String(status.binding.instanceId).slice(0, 12) : '') : ''))),
        h('div', { className: 'ar-actions' },
          h('button', { className: 'ar-btn ar-btn-quiet', disabled: busy, onClick: () => load(runId) }, '刷新'),
          h('button', { className: 'ar-btn ar-btn-primary', disabled: blocked || !status || (status.mode === 'generic' && !plan?.dataPath), onClick: () => act('run', { stage: 'all', ...(status.mode === 'generic' ? { plan } : {}) }) }, blocked ? '分析进行中…' : '运行分析')))
      if (!status) return h('main', { className: 'ar-app' }, h('div', { className: 'ar-shell' }, header, error ? h('div', { className: 'ar-status ar-error', role: 'alert' }, error) : null, h('div', { className: 'ar-empty', role: 'status' }, h('strong', null, '正在加载分析方案…'), h('span', null, '读取研究、方案与运行记录后，这里会显示结果、方案和运行历史。'))))
      const run = Array.isArray(status.runs) ? status.runs.find(r => r.runId === runId) : null
      const plans = plan ? [
        ['数据文件', plan.dataPath || '未配置'],
        ['编号 / 结局', (plan.idColumn || '—') + ' / ' + (plan.outcome || '—')],
        ['组别列', (plan.groupColumns || []).join('、') || '无'],
        ['协变量', (plan.covariates || []).join('、') || '无'],
        ['数据布局', plan.layout === 'long' ? '长表：参与者 × 时点' : '宽表：每位参与者一行'],
        ['分析模块', (plan.analyses || []).map(moduleName).join('、') || '未选择'],
        ['推断门禁', '≥ ' + (plan.gate?.minSubjects ?? 30) + ' 人']
      ] : []
      const summary = h('div', { className: 'ar-plan-summary' }, plans.map(([name, value]) => h('div', { key: name, className: 'ar-plan-row' }, h('span', null, name), h('b', null, value))))
      const field = ([name, label, hint]) => h('label', { key: name, className: 'ar-field' + (name === 'dataPath' ? ' wide' : '') }, label, h('input', { value: plan[name] || '', disabled: blocked, onChange: event => change(name, event.target.value), required: true }), h('span', { className: 'ar-hint' }, hint))
      const buildAdvanced = () => h('form', { className: 'ar-plan', onSubmit: async event => { event.preventDefault(); if (await act('plan', { plan })) setEditing(false) } },
        h('div', { className: 'ar-fields' },
          [['dataPath', 'CSV 数据文件', '绝对路径；输入文件保持只读'], ['idColumn', '参与者编号列', '任意非空字符串，组别由独立列指定'], ['outcome', '结局列', '需要数值；空值按模块完整被试处理']].map(field),
          h('label', { className: 'ar-field' }, '数据布局', h('select', { value: plan.layout, onChange: event => change('layout', event.target.value), disabled: blocked }, h('option', { value: 'wide' }, '宽表：每位参与者一行'), h('option', { value: 'long' }, '长表：每位参与者 × 时点一行'))),
          [['groupColumns', '组别列（逗号分隔）'], ['covariates', '数值协变量（逗号分隔）'], ['pairedColumns', '宽表配对列（前测,后测）']].map(([name, label]) => h('label', { key: name, className: 'ar-field' }, label, h('input', { value: (plan[name] || []).join(', '), disabled: blocked, onChange: event => change(name, list(event.target.value)) }))),
          plan.layout === 'long' ? h('label', { className: 'ar-field' }, '时点列', h('input', { value: plan.within?.column || '', disabled: blocked, onChange: event => change('within', { ...plan.within, column: event.target.value }) })) : null,
          plan.layout === 'long' ? h('label', { className: 'ar-field' }, '时点顺序（逗号分隔）', h('input', { value: (plan.within?.levels || []).join(', '), disabled: blocked, onChange: event => change('within', { ...plan.within, levels: list(event.target.value) }) })) : null,
          h('label', { className: 'ar-field' }, '推断分析最低独立人数', h('input', { type: 'number', min: 2, step: 1, value: plan.gate?.minSubjects ?? 30, disabled: blocked, onChange: event => change('gate', { minSubjects: Number(event.target.value) }) }))),
        h('details', { className: 'ar-details' }, h('summary', null, '扩展分析配置（相关 / 信度 / t 检验 / 方差分析 / 中介）'),
          h('div', { className: 'ar-fields' },
            h('label', { className: 'ar-field wide' }, '相关变量（逗号分隔，至少两个）', h('input', { value: (plan.correlation?.columns || []).join(', '), disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, columns: list(event.target.value) }) })),
            h('label', { className: 'ar-field' }, '相关方法', h('select', { value: plan.correlation?.method || 'pearson', disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, method: event.target.value }) }, h('option', { value: 'pearson' }, 'Pearson'), h('option', { value: 'spearman' }, 'Spearman'))),
            h('label', { className: 'ar-field' }, '多重比较校正', h('select', { value: plan.correlation?.correct || 'none', disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, correct: event.target.value }) }, h('option', { value: 'none' }, '不校正'), h('option', { value: 'bh' }, 'Benjamini–Hochberg'))),
            h('label', { className: 'ar-field' }, '偏相关控制变量（逗号分隔）', h('input', { value: (plan.correlation?.partial || []).join(', '), disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, partial: list(event.target.value) }) })),
            h('label', { className: 'ar-field' }, '相关分组列（逗号分隔）', h('input', { value: (plan.correlation?.by || []).join(', '), disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, by: list(event.target.value) }) })),
            h('label', { className: 'ar-field wide' }, '信度条目组（每行：名称=列1,列2）', h('textarea', { rows: 2, value: reliabilityText(plan.reliability), disabled: blocked, onChange: event => change('reliability', reliabilityFromText(event.target.value)) })),
            h('label', { className: 'ar-field' }, 't 检验类型', h('select', { value: plan.ttest?.kind || 'independent', disabled: blocked, onChange: event => change('ttest', { ...plan.ttest, kind: event.target.value }) }, h('option', { value: 'independent' }, '独立样本（Welch）'), h('option', { value: 'one-sample' }, '单样本'))),
            h('label', { className: 'ar-field' }, 't 检验分组列', h('input', { value: plan.ttest?.group || '', disabled: blocked, onChange: event => change('ttest', { ...plan.ttest, group: event.target.value }) })),
            h('label', { className: 'ar-field' }, '单样本比较值', h('input', { type: 'number', value: plan.ttest?.mu ?? '', disabled: blocked, onChange: event => change('ttest', { ...plan.ttest, mu: Number(event.target.value) }) })),
            h('label', { className: 'ar-field' }, '方差分析因素（逗号分隔，1–2 个）', h('input', { value: (plan.anova?.factors || []).join(', '), disabled: blocked, onChange: event => change('anova', { ...plan.anova, factors: list(event.target.value) }) })),
            h('label', { className: 'ar-field' }, '方差分析平方和', h('select', { value: plan.anova?.sumsOfSquares || 'II', disabled: blocked, onChange: event => change('anova', { ...plan.anova, sumsOfSquares: event.target.value }) }, ['I', 'II', 'III'].map(type => h('option', { key: type, value: type }, type + ' 型')))),
            h('label', { className: 'ar-field' }, '中介 X 列', h('input', { value: plan.mediation?.x || '', disabled: blocked, onChange: event => change('mediation', { ...plan.mediation, x: event.target.value }) })),
            h('label', { className: 'ar-field' }, '中介 M 列', h('input', { value: plan.mediation?.m || '', disabled: blocked, onChange: event => change('mediation', { ...plan.mediation, m: event.target.value }) })),
            h('label', { className: 'ar-field' }, '中介 Y 列', h('input', { value: plan.mediation?.y || '', disabled: blocked, onChange: event => change('mediation', { ...plan.mediation, y: event.target.value }) })),
            h('label', { className: 'ar-field' }, 'Bootstrap 次数', h('input', { type: 'number', min: 100, step: 100, value: plan.mediation?.bootstrap ?? 1000, disabled: blocked, onChange: event => change('mediation', { ...plan.mediation, bootstrap: Number(event.target.value) }) })))),
          h('p', { className: 'ar-hint' }, '扩展分析的变量都来自数据文件里的列名；不填就不会启用对应模块。'),
        h('div', { className: 'ar-checks' }, (status.modules || []).map(module => {
          const ready = moduleReady(module.id)
          return h('label', { key: module.id, title: ready ? '' : (moduleHint[module.id] || '') },
            h('input', {
              type: 'checkbox', checked: (plan.analyses || []).includes(module.id), disabled: blocked || !ready,
              onChange: event => change('analyses', event.target.checked ? [...(plan.analyses || []), module.id] : (plan.analyses || []).filter(id => id !== module.id)),
            }),
            module.label,
            ready ? null : h('small', { className: 'ar-note' }, ' · ' + (moduleHint[module.id] || '需要先补配置')))
        })),
        h('p', { className: 'ar-hint' }, '灰掉的模块是当前方案还缺必填项（配对需要两个配对列或两个时点水平；混合模型需要长表与时点列；回归需要分组列或协变量）。补齐后即可勾选。'),
        h('div', { className: 'ar-form-actions' }, h('button', { className: 'ar-btn ar-btn-primary', disabled: blocked || !plan.dataPath }, '保存方案'), h('button', { type: 'button', className: 'ar-btn ar-btn-ghost', onClick: () => setAdvanced(false) }, '返回向导'), h('button', { type: 'button', className: 'ar-btn ar-btn-ghost', onClick: () => setEditing(false) }, '收起')))
      // ---- 分析向导：类型卡片 → 变量下拉 → 公式/人数预览 ----
      const buildWizard = () => {
      const columns = planInfo?.columns || status?.source?.columns || []
      const colSelect = (value, onPick, placeholder) => h('select', { className: 'ar-colsel', value: value || '', disabled: blocked, onChange: event => onPick(event.target.value) },
        h('option', { value: '' }, placeholder || '选择列'), columns.map(column => h('option', { key: column, value: column }, column)))
      const colMulti = (values, onPick, max = 99) => h('div', { className: 'ar-colchips' }, columns.length ? columns.map(column => {
        const on = (values || []).includes(column)
        return h('button', { key: column, type: 'button', className: 'ar-chip' + (on ? ' ar-chip-on' : ''), disabled: blocked, 'aria-pressed': on, onClick: () => onPick(on ? (values || []).filter(item => item !== column) : [...(values || []), column].slice(0, max)) }, column)
      }) : h('span', { className: 'ar-hint' }, '先选数据文件，列名会自动出现'))
      const types = [
        ['descriptives', '描述与样本', '数据分布、样本构成', ['descriptives', 'sample', 'sensitivity']],
        ['correlation', '相关', '两个变量是否相关', ['correlation']],
        ['reliability', '信度', '量表内部一致性', ['reliability']],
        ['ttest', 't 检验', '两组均值差异', ['ttest']],
        ['anova', '方差分析', '多组差异或交互', ['anova']],
        ['regression', '回归 / ANCOVA', '预测与控制协变量', ['regression']],
        ['mediation', '中介', 'X 通过 M 影响 Y', ['mediation']],
        ['paired', '配对变化', '同一批人前后变化', ['paired']],
        ['mixed', '混合模型', '多时点重复测量', ['mixed']],
        ['script', '自定义脚本', '用 Python 处理数据', ['script']]
      ]
      const guessType = () => {
        const selected = new Set(plan?.analyses || [])
        if (selected.has('script')) return 'script'
        if (selected.has('correlation')) return 'correlation'
        if (selected.has('reliability')) return 'reliability'
        if (selected.has('ttest')) return 'ttest'
        if (selected.has('anova')) return 'anova'
        if (selected.has('mediation')) return 'mediation'
        if (selected.has('paired')) return 'paired'
        if (selected.has('mixed')) return 'mixed'
        if (selected.has('regression')) return 'regression'
        return 'descriptives'
      }
      const activeType = guessType()
      const pickType = type => change('analyses', type[3])
      const outcomeField = h('label', { key: 'outcome', className: 'ar-field' }, '结局（因变量）', colSelect(plan.outcome, value => change('outcome', value)))
      const fieldBlocks = {
        descriptives: [h('p', { key: 'note', className: 'ar-hint' }, '输出描述统计、样本特征表与敏感性分析；不需要额外选择。')],
        correlation: [
          h('label', { key: 'columns', className: 'ar-field wide' }, '相关变量（至少两个）', colMulti(plan.correlation?.columns, value => change('correlation', { ...plan.correlation, columns: value }), 12)),
          h('label', { key: 'method', className: 'ar-field' }, '方法', h('select', { value: plan.correlation?.method || 'pearson', disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, method: event.target.value }) }, h('option', { value: 'pearson' }, 'Pearson'), h('option', { value: 'spearman' }, 'Spearman'))),
          h('label', { key: 'correct', className: 'ar-field' }, '多重比较', h('select', { value: plan.correlation?.correct || 'none', disabled: blocked, onChange: event => change('correlation', { ...plan.correlation, correct: event.target.value }) }, h('option', { value: 'none' }, '不校正'), h('option', { value: 'bh' }, 'Benjamini–Hochberg'))),
          h('label', { key: 'partial', className: 'ar-field wide' }, '控制变量（选填）', colMulti(plan.correlation?.partial, value => change('correlation', { ...plan.correlation, partial: value }), 4))
        ],
        reliability: [h('label', { key: 'items', className: 'ar-field wide' }, '题目列（至少两个）', colMulti((plan.reliability?.[0]?.items) || [], value => change('reliability', [{ ...(plan.reliability?.[0] || {}), items: value }]), 20))],
        ttest: [
          h('label', { key: 'kind', className: 'ar-field' }, '类型', h('select', { value: plan.ttest?.kind || 'independent', disabled: blocked, onChange: event => change('ttest', { ...plan.ttest, kind: event.target.value }) }, h('option', { value: 'independent' }, '独立样本（Welch）'), h('option', { value: 'one-sample' }, '单样本'))),
          outcomeField,
          plan.ttest?.kind === 'one-sample' ? h('label', { key: 'mu', className: 'ar-field' }, '比较值', h('input', { type: 'number', value: plan.ttest?.mu ?? '', disabled: blocked, onChange: event => change('ttest', { ...plan.ttest, mu: Number(event.target.value) }) })) : h('label', { key: 'group', className: 'ar-field' }, '分组列（两个水平）', colSelect(plan.ttest?.group, value => change('ttest', { ...plan.ttest, group: value })))
        ],
        anova: [
          outcomeField,
          h('label', { key: 'factors', className: 'ar-field wide' }, '因素（1–2 个）', colMulti(plan.anova?.factors, value => change('anova', { ...plan.anova, factors: value }), 2)),
          h('label', { key: 'ss', className: 'ar-field' }, '平方和类型', h('select', { value: plan.anova?.sumsOfSquares || 'II', disabled: blocked, onChange: event => change('anova', { ...plan.anova, sumsOfSquares: event.target.value }) }, ['I', 'II', 'III'].map(type => h('option', { key: type, value: type }, type + ' 型'))))
        ],
        regression: [
          outcomeField,
          h('label', { key: 'groups', className: 'ar-field wide' }, '分组列（选填，可多选）', colMulti(plan.groupColumns, value => change('groupColumns', value), 4)),
          h('label', { key: 'covariates', className: 'ar-field wide' }, '协变量（选填）', colMulti(plan.covariates, value => change('covariates', value), 8))
        ],
        mediation: [
          h('label', { key: 'x', className: 'ar-field' }, '自变量 X', colSelect(plan.mediation?.x, value => change('mediation', { ...plan.mediation, x: value }))),
          h('label', { key: 'm', className: 'ar-field' }, '中介 M', colSelect(plan.mediation?.m, value => change('mediation', { ...plan.mediation, m: value }))),
          h('label', { key: 'y', className: 'ar-field' }, '因变量 Y', colSelect(plan.mediation?.y, value => change('mediation', { ...plan.mediation, y: value })))
        ],
        paired: [
          h('label', { key: 'before', className: 'ar-field' }, '前测列', colSelect((plan.pairedColumns || [])[0], value => change('pairedColumns', [value, (plan.pairedColumns || [])[1] || '']))),
          h('label', { key: 'after', className: 'ar-field' }, '后测列', colSelect((plan.pairedColumns || [])[1], value => change('pairedColumns', [(plan.pairedColumns || [])[0] || '', value])))
        ],
        mixed: [
          h('label', { key: 'within', className: 'ar-field' }, '时点列', colSelect(plan.within?.column, value => change('within', { ...plan.within, column: value }))),
          h('label', { key: 'levels', className: 'ar-field wide' }, '时点顺序（逗号分隔）', h('input', { value: (plan.within?.levels || []).join(', '), disabled: blocked, onChange: event => change('within', { ...plan.within, levels: list(event.target.value) }) }))
        ],
        script: [
          h('label', { key: 'code', className: 'ar-field wide' }, 'Python 脚本（data 是数据框，save(name, frame) 产出表格）', h('textarea', { rows: 8, className: 'ar-code', value: plan.script?.code || '', disabled: blocked, placeholder: "means = data.groupby('g', as_index=False)['y'].mean()\nsave('group_means', means)", onChange: event => change('script', { ...plan.script, code: event.target.value, file: '' }) })),
          h('label', { key: 'file', className: 'ar-field wide' }, '或从脚本文件运行（绝对路径；填了代码就忽略它）', h('input', { value: plan.script?.file || '', disabled: blocked || Boolean(plan.script?.code), onChange: event => change('script', { ...plan.script, file: event.target.value }) }))
        ]
      }[activeType] || []
      const formulaText = (() => {
        const groups = plan.groupColumns || []
        const covariates = plan.covariates || []
        if (activeType === 'regression') return `${plan.outcome || '?'} ~ ${[...groups, ...covariates].join(' + ') || '（未选列）'}` + ((plan.interactions || []).length ? ' + 交互项' : '')
        if (activeType === 'anova') return `${plan.outcome || '?'} ~ ${(plan.anova?.factors || []).join(' × ') || '（未选因素）'}`
        if (activeType === 'ttest') return `${plan.outcome || '?'} by ${plan.ttest?.group || '（未选分组）'}`
        if (activeType === 'correlation') return (plan.correlation?.columns || []).join(' × ') || '（未选变量）'
        if (activeType === 'mediation') return `${plan.mediation?.x || 'X'} → ${plan.mediation?.m || 'M'} → ${plan.mediation?.y || 'Y'}`
        if (activeType === 'reliability') return `Cronbach α：${((plan.reliability?.[0]?.items) || []).join(', ') || '（未选题目）'}`
        if (activeType === 'paired') return `${(plan.pairedColumns || [])[0] || '前测'} → ${(plan.pairedColumns || [])[1] || '后测'}`
        if (activeType === 'mixed') return `${plan.outcome || '?'} ~ ${plan.within?.column || '时点'} + 组别 + 协变量`
        if (activeType === 'script') return 'Python 脚本 → save("名称", 数据框) 的表格'
        return '描述统计 + 样本特征表 + 敏感性分析'
      })()
      const firstModule = (plan.analyses || [])[0]
      const eligible = planInfo?.modules?.[firstModule]?.eligible
      const outputNote = { descriptives: '3 张表', correlation: '1 张表', reliability: '1 张表', ttest: '1 张表', anova: '1 张表', regression: '2 张表 + 2 张图', mediation: '1 张表 + 1 张图', paired: '1 张表 + 1 张图', mixed: '1 张表', script: '脚本 save 的每张表' }[activeType] || '—'
      const wizardForm = h('div', { className: 'ar-wizard' },
        h('div', { className: 'ar-card-head' }, h('h3', null, '做一次分析'), h('span', { className: 'ar-note' }, '选类型 → 选变量 → 看预览 → 运行')),
        h('div', { className: 'ar-types' }, types.map(type => h('button', { key: type[0], type: 'button', className: 'ar-type' + (activeType === type[0] ? ' ar-type-on' : ''), disabled: blocked, 'aria-pressed': activeType === type[0], onClick: () => pickType(type) },
          h('b', null, type[1]), h('span', null, type[2])))),
        h('div', { className: 'ar-fields' }, fieldBlocks),
        h('div', { className: 'ar-preview-plan' },
          h('b', null, '预览'),
          h('div', null, '公式：' + formulaText),
          h('div', null, '数据：' + (planInfo ? `${planInfo.rows} 行 · ${columns.length} 列` : '读取中…（若长时间不变，检查数据文件是否存在）')),
          h('div', null, '分析集：' + (eligible === undefined ? '—' : eligible === null ? '无法预估（缺列）' : eligible + ' 人')),
          h('div', { className: 'ar-hint' }, '预计输出：' + outputNote)),
        h('div', { className: 'ar-form-actions' },
          h('button', { type: 'button', className: 'ar-btn ar-btn-primary', disabled: blocked || !plan.dataPath, onClick: async () => { if (await act('plan', { plan })) await act('run', { stage: 'all', plan }) } }, '保存并运行'),
          h('button', { type: 'button', className: 'ar-btn ar-btn-quiet', disabled: blocked || !plan.dataPath, onClick: async () => { await act('plan', { plan }) } }, '只保存'),
          h('button', { type: 'button', className: 'ar-btn ar-btn-ghost', onClick: () => setAdvanced(true) }, '高级编辑'),
          h('button', { type: 'button', className: 'ar-btn ar-btn-ghost', onClick: () => setEditing(false) }, '收起')))
      return wizardForm
      }
      const planForm = plan ? (advanced ? buildAdvanced() : buildWizard()) : null
      const connect = h('details', { className: 'ar-details' }, h('summary', null, '连接研究定义'),
        h('form', { className: 'ar-exclude', onSubmit: event => { event.preventDefault(); newPage(); act('studyConnect', { studyPath }) } },
          h('label', { className: 'reason' }, '研究 JSON 绝对路径', h('input', { value: studyPath, required: true, disabled: blocked, onChange: event => setStudyPath(event.target.value) })),
          h('button', { className: 'ar-btn ar-btn-quiet', disabled: blocked || !studyPath.trim() }, '连接研究')),
        h('p', { className: 'ar-hint' }, '连接只改变当前页面：其他页面与会话保留各自的研究绑定。'))
      const exclusions = h('details', { className: 'ar-details' }, h('summary', null, '人工排除（' + status.exclusions.length + '）'),
        h('p', { className: 'ar-hint' }, '记录排除理由。新运行应用变更，历史结果仍对应原快照。'),
        h('form', { className: 'ar-exclude', onSubmit: async event => { event.preventDefault(); if (await act('exclude', { op: 'add', id, reason })) { setId(''); setReason('') } } },
          h('label', null, '参与者编号', h('input', { value: id, disabled: blocked, required: true, onChange: event => setId(event.target.value) })),
          h('label', { className: 'reason' }, '排除理由', h('input', { value: reason, disabled: blocked, required: true, onChange: event => setReason(event.target.value) })),
          h('button', { className: 'ar-btn ar-btn-quiet', disabled: blocked || !id.trim() || !reason.trim() }, '加入排除')),
        h('ul', { className: 'ar-list' }, status.exclusions.map((row, index) => h('li', { key: row.id || row['编号'] || index }, h('span', null, `${row.id || row['编号']}：${row.reason || row['原因'] || ''}`), h('button', { className: 'ar-btn ar-btn-ghost', disabled: blocked, onClick: () => act('exclude', { op: 'remove', id: row.id || row['编号'] }) }, '恢复')))))
      const planView = h('section', { className: 'ar-card' },
        h('div', { className: 'ar-card-head' }, h('h2', null, '分析方案'), h('span', { className: 'ar-note' }, status.mode === 'adapter' ? '由私有适配器提供' : '数据映射与分析模块')),
        status.mode === 'adapter' ? h('div', { className: 'ar-actions' }, (status.stages || []).map(stage => h('button', { key: stage.id, className: 'ar-btn ar-btn-quiet', disabled: blocked, onClick: () => act('run', { stage: stage.id, runId }) }, stage.label))) : null,
        status.mode === 'generic' && plan ? (editing ? planForm : h(React.Fragment, null, summary, h('div', { className: 'ar-form-actions' }, h('button', { className: 'ar-btn ar-btn-quiet', disabled: blocked, onClick: () => setEditing(true) }, '编辑方案'), h('span', { className: 'ar-hint' }, '修改后保存，下一次运行使用新方案；历史结果不变。')))) : h('p', { className: 'ar-note' }, '当前研究没有通用分析方案。'),
        connect, exclusions)
      const runs = Array.isArray(status.runs) ? status.runs : []
      const runsView = h('section', { className: 'ar-card' }, h('div', { className: 'ar-card-head' }, h('h2', null, '运行记录'), h('span', { className: 'ar-note' }, '每次运行保留独立输入、方案与结果快照')),
        runs.length ? h('div', { className: 'ar-runs' }, runs.map(item => h('button', { key: item.runId, className: 'ar-runrow', 'aria-current': item.runId === runId, onClick: async () => { await load(item.runId); setView('results') } },
          h('span', null, h('span', { className: 'ar-runid' }, item.runId), h('small', null, ' · ' + fmtDate(item.startedAt))),
          h('span', { className: 'ar-tag ar-tag-' + tagOf(item.status) }, runLabels[item.status] || item.status),
          h('span', { className: 'ar-note' }, (item.n ?? '—') + ' 人'),
          h('span', { className: 'ar-note' }, (item.observations ?? '—') + ' 行')))) : h('div', { className: 'ar-empty' }, h('strong', null, '还没有运行记录'), h('span', null, '保存方案并运行后，每次分析的独立快照会出现在这里。')))
      const resultHead = meta ? h('section', { className: 'ar-card' },
        h('div', { className: 'ar-runhead' }, h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 600 } }, '当前运行'), h('span', { className: 'ar-runid' }, result.runId), h('span', { className: 'ar-tag ar-tag-' + tagOf(meta.status) }, runLabels[meta.status] || meta.status), meta.archive ? h('span', { className: 'ar-tag ar-tag-warn' }, '历史快照') : null),
        h('div', { className: 'ar-meta' },
          h('div', { className: 'ar-kv' }, h('span', null, '分析纳入'), h('b', null, (meta.subjects ?? meta.n ?? '—') + ' 人')),
          h('div', { className: 'ar-kv' }, h('span', null, '观测行数'), h('b', null, (meta.observations ?? '—') + ' 行')),
          h('div', { className: 'ar-kv' }, h('span', null, '完成时间'), h('b', null, fmtDate(meta.finishedAt || meta.startedAt))),
          h('div', { className: 'ar-kv' }, h('span', null, '排除人数'), h('b', null, ((meta.excludedIds || []).length) + ' 人'))),
        meta.archive ? h('p', { className: 'ar-hint', style: { marginTop: 10 } }, meta.archive.text) : null,
        h('div', { className: 'ar-stages' }, Object.entries(nodes).map(([name, node]) => h('div', { key: name, className: 'ar-stage', 'data-s': node.status },
          h('div', { className: 'ar-stage-name' }, moduleName(name), h('span', { className: 'ar-tag ar-tag-' + (node.status === 'executed' ? 'ok' : node.status === 'failed' ? 'bad' : 'plain') }, nodeLabels[node.status] || node.status)),
          h('div', { className: 'ar-stage-meta' }, stageReason(node.reason) || (node.status === 'executed' ? '已执行' : '未选择或未执行')))))) : null
      const resultTabs = h('div', { className: 'ar-resulttabs' }, [['tables', '表格'], ['figures', '图表'], ['report', '排版报告']].map(([name, label]) => h('button', { key: name, className: 'ar-resulttab', 'aria-pressed': tab === name, onClick: () => setTab(name) }, label + (name === 'tables' ? ' ' + ((result?.tables || []).length) : ''))))
      const builtChart = (result?.tables || []).map(table => descriptiveChart(table)).find(Boolean)
      const resultBody = result?.runId ? (result.integrity?.ok === false ? h('div', { className: 'ar-status ar-error', role: 'alert' }, '运行产物校验失败，表和报告已隐藏。请创建新运行。') : h(React.Fragment, null,
        resultTabs,
        tab === 'tables' ? ((result.tables || []).length ? h('div', { className: 'ar-work' },
          h('aside', { className: 'ar-nav', 'aria-label': '结果表' }, h('div', { className: 'ar-nav-title' }, '结果表'), result.tables.map(table => h('button', { key: table.key, 'aria-pressed': key === table.key, onClick: () => setKey(table.key) }, h('span', null, tableTitle(table.label)), tableTitle(table.label) !== table.label ? h('small', null, table.label) : null))),
          h('div', { className: 'ar-content' }, result.tables.filter(table => table.key === key).map(table => h(Table, { key: table.key, table })))) : h('div', { className: 'ar-empty' }, h('strong', null, '本次没有可展示的表格'), h('span', null, '查看阶段状态或创建新运行。'))) : null,
        tab === 'figures' ? ((builtChart || (result.figures || []).length) ? h('div', { className: 'ar-figgrid' },
          builtChart ? h('figure', { className: 'ar-fig wide' }, h('div', { className: 'ar-chart' }, builtChart), h('figcaption', null, '各组合均值与 95% 置信区间 · 由结果表生成；误差线需要标准差与人数（SD/√n）')) : null,
          (result.figures || []).map(figure => h('figure', { key: figure.name, className: 'ar-fig' }, h('img', { src: figure.url, alt: figure.name }), h('figcaption', null, figure.name)))) : h('div', { className: 'ar-empty' }, h('strong', null, '当前分析模块没有生成图'), h('span', null, '运行包含绘图模块的分析后，图会出现在这里。'))) : null,
        tab === 'report' ? (result.report ? h('div', { className: 'ar-reportdoc' }, renderReport(result.report)) : h('div', { className: 'ar-empty' }, h('strong', null, '本次报告不可用'), h('span', null, '查看阶段状态后重新运行。'))) : null)) : h('div', { className: 'ar-empty' }, h('strong', null, '还没有分析结果'), h('span', null, '先在“分析方案”里确认数据映射和模块，再运行分析。'), h('div', { className: 'ar-actions' }, h('button', { className: 'ar-btn ar-btn-quiet', onClick: () => setView('plan') }, '去分析方案'), h('button', { className: 'ar-btn ar-btn-primary', disabled: blocked, onClick: () => act('run', { stage: 'all', ...(status.mode === 'generic' ? { plan } : {}) }) }, '运行分析')))
      const presentations = Array.isArray(result?.presentations) ? result.presentations : []
      const presentationUrl = (revision, file) => `${API}?action=presentation&run=${encodeURIComponent(result.runId)}&rev=${encodeURIComponent(revision)}&file=${encodeURIComponent(file)}&pageId=${encodeURIComponent(identity.pageId())}`
      // 新标签页在应用内被拦截，改用：报告在面板内预览、PDF/Word/Excel 直接下载。
      const downloadLink = (revision, file, label) => h('a', {
        className: 'ar-linkbtn', href: presentationUrl(revision, file), download: file.split('/').pop(),
      }, label)
      const versionRow = item => h('span', { key: item.revision, className: 'ar-versionrow' },
        h('b', null, 'v' + item.revision),
        h('small', null, item.createdAt ? fmtDate(item.createdAt) : '—'),
        h('small', { title: item.sourceHash || '' }, item.sourceHash ? '数据 ' + String(item.sourceHash).slice(0, 8) : '数据 —'),
        item.sourceHash && result.meta?.dataset?.hash && item.sourceHash !== result.meta.dataset.hash ? h('span', { className: 'ar-tag ar-tag-warn' }, '旧数据') : null,
        item.files.includes('report.html') ? h('button', {
          className: 'ar-linkbtn',
          'aria-pressed': preview?.revision === item.revision,
          onClick: () => setPreview(current => current && current.revision === item.revision ? null : { revision: item.revision }),
        }, preview?.revision === item.revision ? '收起报告' : '报告') : null,
        item.files.includes('report.pdf') ? downloadLink(item.revision, 'report.pdf', 'PDF') : null,
        item.files.includes('tables.docx') ? downloadLink(item.revision, 'tables.docx', 'Word') : null,
        item.files.includes('tables.xlsx') ? downloadLink(item.revision, 'tables.xlsx', 'Excel') : null,
        item.files.includes('report.html') ? h('a', {
          className: 'ar-linkbtn', href: presentationUrl(item.revision, 'report.html'), download: `report-v${item.revision}.html`,
        }, '下载 HTML') : null)
      const previewBlock = preview ? h('div', { className: 'ar-preview' },
        h('div', { className: 'ar-preview-head' },
          h('b', null, '报告预览 · v' + preview.revision),
          h('a', { className: 'ar-linkbtn', href: presentationUrl(preview.revision, 'report.html'), download: `report-v${preview.revision}.html` }, '下载'),
          h('button', { className: 'ar-linkbtn', onClick: () => setPreview(null) }, '关闭')),
        h('iframe', { className: 'ar-preview-frame', src: presentationUrl(preview.revision, 'report.html'), title: '报告预览' })) : null
      const versionsBlock = presentations.length
        ? h('div', { className: 'ar-versions' }, h('span', { className: 'ar-note' }, '历史版本'), presentations.slice(0, 6).map(versionRow))
        : null
      const exportBar = result?.runId
        ? h('div', { className: 'ar-exportbar' },
          h('button', { className: 'ar-btn ar-btn-primary', disabled: blocked, onClick: async () => {
            try { const out = await call('export', { runId: result.runId }); setNotice('已导出第 ' + out.revision + ' 版：HTML / PDF / Word / Excel / 图（' + (out.artifacts || []).length + ' 个文件）'); await load(result.runId) }
            catch (error) { setNotice('导出失败：' + (error.message || error)) }
          } }, '导出报告'),
          h('span', { className: 'ar-note' }, '本地渲染排版版本，不调用云端；旧版本保留可重开'),
          versionsBlock)
        : null
      const resultView = h('section', { className: 'ar-card' }, resultHead, exportBar, previewBlock, resultBody)
      const tabs = h('div', { className: 'ar-viewtabs', role: 'tablist', 'aria-label': '分析直通页面' }, [['results', '结果'], ['plan', '分析方案'], ['runs', '运行记录']].map(([name, label]) => h('button', { key: name, role: 'tab', 'aria-selected': view === name, className: 'ar-viewtab', onClick: () => setView(name) }, label)))
      return h('main', { className: 'ar-app' }, h('div', { className: 'ar-shell' },
        header,
        error ? h('div', { className: 'ar-status ar-error', role: 'alert' }, error, ' ', h('button', { className: 'ar-btn ar-btn-ghost', disabled: blocked, onClick: () => load(runId) }, '重新加载')) : null,
        notice ? h('div', { className: 'ar-status', role: 'status' }, notice) : null,
        status.pendingChanges ? h('div', { className: 'ar-status ar-warn' }, '输入、方案或排除名单已有变更。新运行会保存新快照；当前显示的历史结果保持其原始分析集。') : null,
        h('div', { className: 'ar-spine' }, h('b', null, status.study.name), h('span', null, status.study.id), h('span', null, status.mode === 'adapter' ? (status.adapterName || '专用适配器') : '通用分析'), h('div', { className: 'ar-spine-right' }, h('span', null, status.source.exists ? '数据已找到' : '数据未配置或不可读'), h('span', { className: 'ar-tag ar-tag-' + (status.busy ? 'info' : 'plain') }, status.busy ? '分析进行中' : '当前空闲'))),
        tabs,
        view === 'results' ? resultView : view === 'plan' ? planView : runsView))
    }
    function Icon() { return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }), h('path', { d: 'M3 9h18M9 9v12M13 16l2-3 3 2' })) }
    class Guard extends React.Component { constructor(p) { super(p); this.state = { error: null } } static getDerivedStateFromError(error) { return { error } } render() { return this.state.error ? h('div', { role: 'alert', style: { padding: 20, fontFamily: 'Cambria,"Noto Serif SC",serif', color: '#9b3a2c', background: '#f4dfd9' } }, '分析面板加载失败，请刷新后重试。 ', String(this.state.error.message)) : this.props.children } }
    return { inject: ['slots'], identity, apply(ctx) { hostCtx = ctx; ctx.effect(() => { const tag = document.createElement('style'); tag.textContent = CSS; document.head.appendChild(tag); return () => tag.remove() }, 'analysis-run styles'); try { const ui = ctx.get && ctx.get('uiWorkspace'); window.__DSH_RESEARCH_PICKER__ && window.__DSH_RESEARCH_PICKER__.createStudyPicker({ plugin: 'analysis-run', route: '/api/analysis-run', headers: () => headers(), pickDirectory: ui && typeof ui.pickDirectory === 'function' ? () => ui.pickDirectory() : null }).install() } catch (error) { console.warn('[analysis-run] study picker not installed', error) } ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'analysis-run', order: 33, label: '分析直通' }, () => h(Icon))); ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'analysis-run' }, () => h(Guard, null, h(Panel)))) } }
  }
})
