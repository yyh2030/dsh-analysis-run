import { createHash } from 'node:crypto'

const sha256 = value => createHash('sha256').update(value).digest('hex')

/**
 * 自动运行的输入指纹：研究身份 + 完整方案 + 数据集 hash。
 * 字段顺序固定（studyId、plan、datasetHash），修改方案或数据都必须产生新键。
 */
export function requestedKey({ studyId = null, plan = null, datasetHash = null } = {}) {
  return sha256(JSON.stringify({ studyId, plan, datasetHash }))
}

/**
 * 去抖自动运行调度器（纯逻辑，不直接读写文件、不直接计时）。
 *
 * 依赖通过参数注入，便于用假时钟测试：
 * - current(): 返回 { cfg, context } 研究状态快照。
 * - run(payload, studyState, view): 执行一次分析；返回 promise。
 * - analysis: { planFor(cfg), runs(cfg, studyState), latestMeta(cfg, runId),
 *   dataset({ state, plan, instanceId }), instanceId(context), blocked(studyState) }。
 * - readAutoState(cfg) / writeAutoState(cfg, value): auto-state.json 读写。
 *
 * 排队回调只使用排队时捕获的 studyState，绝不重新调用 current()，
 * 这样切换到另一研究后不会用错 cfg.outputDir 或 context（A05）。
 */
export function createScheduler({
  config = {},
  current,
  run,
  analysis = {},
  readAutoState = async () => ({}),
  writeAutoState = async () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof current !== 'function') throw new TypeError('createScheduler 需要 current()')
  if (typeof run !== 'function') throw new TypeError('createScheduler 需要 run()')
  if (!analysis || typeof analysis.planFor !== 'function') throw new TypeError('createScheduler 需要 analysis.planFor()')
  if (typeof analysis.runs !== 'function') throw new TypeError('createScheduler 需要 analysis.runs()')
  if (typeof analysis.dataset !== 'function') throw new TypeError('createScheduler 需要 analysis.dataset()')

  const debounceDelay = () => Number(config.debounceMs) || 3000
  const pollDelay = () => Number(config.autoPollMs) || 2000

  let disposed = false
  let started = false
  let interval = null
  let initial = null
  let debounce = null
  let busy = false
  let pausedKey = null
  let lastKey = null
  let lastError = ''
  let ticks = 0
  const disposers = []

  function state() {
    return {
      disposed,
      started,
      busy,
      pending: debounce !== null,
      pausedKey,
      requestedKey: lastKey,
      ticks,
      error: lastError,
      timers: { interval: interval !== null, initial: initial !== null, debounce: debounce !== null },
    }
  }

  function clearDebounce() {
    if (debounce !== null) { clearTimeoutFn(debounce); debounce = null }
  }

  /** 排队时捕获 studyState；回调、成功状态、失败暂停键都基于这次捕获。 */
  function schedule(studyState, key, instanceId) {
    if (disposed) return false
    clearDebounce()
    const captured = studyState
    debounce = setTimeoutFn(() => {
      debounce = null
      if (disposed) return
      Promise.resolve()
        .then(() => run({}, captured, { instanceId }))
        .then(async () => {
          lastError = ''
          pausedKey = null
          const stored = await readAutoState(captured.cfg)
          await writeAutoState(captured.cfg, { ...stored, requestedKey: key, completedAt: new Date().toISOString() })
        })
        .catch(error => {
          lastError = String(error && error.message ? error.message : error)
          // 暂停键用完整指纹：修完方案（键变化）后自动恢复。
          pausedKey = key
        })
    }, debounceDelay())
    if (debounce && typeof debounce.unref === 'function') debounce.unref()
    return true
  }

  async function tick() {
    if (disposed || busy) return state()
    busy = true
    ticks += 1
    try {
      // 本次 tick 只读一次 current()，其余步骤全部用这个快照。
      const studyState = current()
      if (!studyState || !studyState.cfg || !studyState.context) return state()
      const { cfg, context } = studyState
      if (!context.configured) return state()
      if (typeof analysis.blocked === 'function' && analysis.blocked(studyState)) return state()

      const plan = await analysis.planFor(cfg)
      if (!plan || !plan.source || plan.source.type !== 'core') return state()

      const instanceId = typeof analysis.instanceId === 'function' ? await analysis.instanceId(context) : null
      if (!instanceId) return state()

      let built
      try {
        built = await analysis.dataset({ state: studyState, plan, instanceId })
      } catch { return state() }
      const datasetHash = built && built.hash ? built.hash : null

      const key = requestedKey({ studyId: context.identity?.id ?? context.id ?? null, plan, datasetHash })
      lastKey = key

      const stored = await readAutoState(cfg)
      if (stored && stored.requestedKey === key) return state()

      const history = await analysis.runs(cfg, studyState)
      if (!history || !history.length) {
        if (debounce === null && pausedKey !== key) schedule(studyState, key, instanceId)
        return state()
      }

      const latest = typeof analysis.latestMeta === 'function'
        ? await analysis.latestMeta(cfg, history[0].runId, studyState)
        : null
      const latestHash = latest?.dataset?.hash || latest?.source?.sha256
      const samePlan = JSON.stringify(latest?.plan || null) === JSON.stringify(plan || null)
      if (latestHash === datasetHash && samePlan) return state()

      if (debounce === null && pausedKey !== key) schedule(studyState, key, instanceId)
      return state()
    } finally {
      busy = false
    }
  }

  function start() {
    if (disposed || started || !config.autoRun) return false
    started = true
    interval = setIntervalFn(() => { tick().catch(() => {}) }, pollDelay())
    if (interval && typeof interval.unref === 'function') interval.unref()
    disposers.push(() => { if (interval !== null) { clearIntervalFn(interval); interval = null } })

    initial = setTimeoutFn(() => { initial = null; tick().catch(() => {}) }, 50)
    if (initial && typeof initial.unref === 'function') initial.unref()
    disposers.push(() => { if (initial !== null) { clearTimeoutFn(initial); initial = null } })
    disposers.push(clearDebounce)
    return true
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0)) {
      try { disposer() } catch { /* 已清理 */ }
    }
    clearDebounce()
    interval = null
    initial = null
  }

  // 与旧 startAuto() 一致：只有显式 autoRun 才启动轮询与初始 tick。
  if (config.autoRun) start()

  return { tick, start, dispose, state, requestedKey }
}
