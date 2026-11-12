import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStudyContext, validateStudyDefinition } from './study-context.mjs'
import { createScheduler } from './scheduler.mjs'
import { hostBinding, bindingStatus } from '@local/research-core/host'
import { openResearchData } from '@local/research-core/data'
import { openAnalysis, AnalysisError as CoreAnalysisError } from '@local/research-core/analysis'
import { buildResults, renderHtmlReport, tableFromGrid, artifactManifest } from '@local/research-core/results'
import { agentProjection, resolvePrivacyPolicy, shareProjection, shareManifest, sanitizeError, scrubText } from '@local/research-core/privacy-projection'
import { pointRangeChart, forestChart, distributionChart, pairedChart, renderPng, renderPdf } from '@local/research-core/charts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOADED_HASHES = Object.fromEntries(['index.js','study-context.mjs','study-selection.mjs'].map(name => [name, createHash('sha256').update(readFileSync(path.join(HERE,name))).digest('hex')]))
const ROUTE = '/api/analysis-run'
const MODULES = [{ id: 'descriptives', label: '描述统计' }, { id: 'sample', label: '样本特征表' }, { id: 'sensitivity', label: '敏感性分析' }, { id: 'correlation', label: '相关分析' }, { id: 'reliability', label: '信度' }, { id: 'ttest', label: 't 检验' }, { id: 'anova', label: '方差分析' }, { id: 'mediation', label: '中介分析' }, { id: 'script', label: '自定义脚本' }, { id: 'regression', label: '组间回归 / ANCOVA' }, { id: 'paired', label: '配对变化' }, { id: 'mixed', label: '被试内线性混合模型' }]
const LOCKS = new Map()
const WRITES = new Map()
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' }); await rename(temporary, file) }
  finally { await rm(temporary, { force: true }).catch(() => {}) }
}
async function serialWrite(key, operation) {
  if (WRITES.has(key) || LOCKS.has(key)) throw new AnalysisError('busy', '当前研究正在运行或保存，请稍后重试')
  WRITES.set(key, true)
  try { return await operation() } finally { WRITES.delete(key) }
}
const hash = text => createHash('sha256').update(text).digest('hex')
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback } }
class AnalysisError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details } }

/* ---------- 07：Agent 工具只拿得到摘要，拿不到逐人记录/路径 ---------- */
const countNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** analysis_status 的 Agent 摘要：状态、计数、显示名；路径与逐人排除明细不进入。 */
function statusAgentSummary(data = {}) {
  const runs = Array.isArray(data.runs) ? data.runs : []
  const exclusions = Array.isArray(data.exclusions) ? data.exclusions : []
  return {
    status: data.busy ? 'busy' : (runs.length ? 'ready' : 'idle'),
    study: { name: data.study ? data.study.name : null },
    counts: { runs: runs.length, exclusions: exclusions.length, autoTicks: countNumber(data.autoTicks) },
    runs: runs.slice(0, 20).map(run => ({
      runId: run && run.runId ? String(run.runId) : null,
      status: run && run.status ? String(run.status) : 'unknown',
      interrupted: Boolean(run && run.interrupted),
      n: run && run.n !== undefined ? countNumber(run.n) : null,
      observations: run && run.observations !== undefined ? countNumber(run.observations) : null,
    })),
    pendingChanges: Boolean(data.pendingChanges),
    backends: data.backends && typeof data.backends === 'object'
      ? Object.fromEntries(Object.entries(data.backends).map(([name, value]) => [name, { ok: Boolean(value && value.ok), missing: Array.isArray(value && value.missing) ? value.missing.length : 0 }]))
      : null,
  }
}

/** analysis_results 的 Agent 摘要：表结构可以按列过滤，逐行数值只在 strict-local 外按白名单处理。 */
function resultsAgentSummary(data = {}) {
  const tables = (Array.isArray(data.tables) ? data.tables : []).map(table => {
    if (!table || typeof table !== 'object') return table
    // results() 里是 CSV 网格（columns 字符串、rows 数组）；投影需要按列 schema 得到对象行。
    const isGrid = Array.isArray(table.rows) && (table.rows.length === 0 || Array.isArray(table.rows[0]))
    return isGrid
      ? tableFromGrid({ key: table.key, columns: table.columns || [], rows: table.rows || [], types: table.types || null, analysisSet: table.analysisSet || null, nodeId: table.nodeId || null, title: table.title || null, labels: table.labels })
      : table
  })
  return {
    runId: data.runId ? String(data.runId) : null,
    status: data.meta && data.meta.status ? String(data.meta.status) : (data.runId ? 'unknown' : 'none'),
    counts: {
      tables: tables.length,
      rows: tables.reduce((sum, table) => sum + (Array.isArray(table && table.rows) ? table.rows.length : 0), 0),
      figures: Array.isArray(data.figures) ? data.figures.length : 0,
      presentations: Array.isArray(data.presentations) ? data.presentations.length : 0,
    },
    tables: tables.map(table => ({
      key: table.key,
      number: table.number,
      title: table.title,
      columns: table.columns,
      rows: table.rows,
      types: table.types || null,
      notes: table.notes || [],
      analysisSet: table.analysisSet || null,
      sourceHash: table.sourceHash || null,
    })),
    figureKeys: (Array.isArray(data.figures) ? data.figures : []).map(figure => figure && (figure.key || figure.name)).filter(Boolean),
    analysisSet: data.meta && data.meta.analysisSet ? data.meta.analysisSet : data.analysisSet,
    integrity: { ok: Boolean(data.integrity && data.integrity.ok), corrupt: Array.isArray(data.integrity && data.integrity.corrupt) ? data.integrity.corrupt.length : 0 },
    study: data.study ? { name: data.study.name } : null,
  }
}

/** analysis_export 的摘要：导出计数与相对产物名；本地目录不进入。 */
function exportAgentSummary(data = {}) {
  return {
    runId: data.runId ? String(data.runId) : null,
    revision: Number.isFinite(Number(data.revision)) ? Number(data.revision) : null,
    status: 'exported',
    counts: {
      artifacts: Array.isArray(data.artifacts) ? data.artifacts.length : 0,
      figures: Array.isArray(data.figures) ? data.figures.length : 0,
      png: countNumber(data.png),
    },
    artifacts: (Array.isArray(data.artifacts) ? data.artifacts : []).map(relative => ({ relativePath: String(relative) })),
    figures: (Array.isArray(data.figures) ? data.figures : []).map(key => String(key)),
    pdf: data.pdf === true,
    office: data.office === true,
  }
}

/** analysis_run 的摘要：只留运行状态、计数与错误（错误由投影再脱敏）。 */
function analysisRunSummary(data = {}) {
  const meta = data && data.meta && typeof data.meta === 'object' ? data.meta : {}
  return {
    status: data.ok === false ? 'failed' : 'ok',
    runId: data.runId ? String(data.runId) : null,
    reused: data.reused === true,
    counts: {
      tables: Array.isArray(meta.tables) ? meta.tables.length : 0,
      subjects: Number.isFinite(Number(meta.subjects)) ? Number(meta.subjects) : 0,
      observations: Number.isFinite(Number(meta.observations)) ? Number(meta.observations) : 0,
      warnings: Array.isArray(meta.warnings) ? meta.warnings.length : 0,
    },
    error: data.error ? String(data.error) : null,
  }
}

export function parseCsv(text) {
  const result = []; let row = [], value = '', quoted = false
  for (const char of String(text).replace(/^\uFEFF/, '')) {
    if (char === '"') { if (quoted === 'escape') { value += '"'; quoted = true } else if (quoted === true) quoted = 'escape'; else if (quoted === false) quoted = true }
    else if (quoted === true) value += char
    else { if (quoted === 'escape') quoted = false; if (char === ',') { row.push(value); value = '' } else if (char === '\n') { row.push(value); result.push(row); row = []; value = '' } else if (char !== '\r') value += char }
  }
  if (value || row.length) { row.push(value); result.push(row) }
  return result.filter(row => row.some(value => value !== ''))
}

/** 插件自带的统计后端目录（vendor/site-packages）；存在就优先于运行时的同名包。 */
const VENDOR_SITE = path.join(HERE, 'vendor', 'site-packages')
const VENDOR_MANIFEST = path.join(HERE, 'vendor', 'manifest.json')
function vendorPresent() { return existsSync(VENDOR_SITE) && existsSync(path.join(VENDOR_SITE, 'scipy')) }
function pythonEnv(cfg) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    ...Object.fromEntries(Object.entries(cfg.adapter?.gateEnvironment || {}).map(([key, name]) => [name, String(key === 'explore' ? cfg.gateExplore ?? 30 : cfg.gateMain ?? 40)])) }
  if (vendorPresent()) env.PYTHONPATH = [VENDOR_SITE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  return env
}

export function python(cfg, script, args, options = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false
    const child = (options.spawn || spawn)(cfg.pythonPath, ['-X', 'utf8', script, ...args], { cwd: path.dirname(script), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pythonEnv(cfg) })
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result) }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs ?? 15 * 60 * 1000)
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) { timedOut = true; child.kill() } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
    child.on('error', error => finish({ ok: false, error: `Python 启动失败：${error.message}` }))
    child.on('close', code => { if(timedOut){finish({ok:false,error:'分析超时且进程已退出；请查看运行记录后重试。'});return} const marker = stdout.lastIndexOf('===JSON==='); try { if (marker < 0) throw new Error(stderr || `Python 退出码 ${code}`); finish(JSON.parse(stdout.slice(marker + 10).trim())) } catch (error) { finish({ ok: false, error: error.message }) } })
  })
}

function safeRun(id) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,79}$/.test(id)) throw new AnalysisError('invalid', '运行编号不合法'); return id }
function configFor(config) {
  const context = loadStudyContext(config, { pluginKey: 'analysis' })
  const cfg = { ...context.plugin, ...config }
  const base = context.baseDir
  for (const key of ['dataPath', 'pythonPath', 'pipelinePath', 'adapterPath', 'labDir', 'rawDir', 'projectRoot']) if (cfg[key]) cfg[key] = path.resolve(base, cfg[key])
  cfg.pythonPath ||= 'python'
  cfg.outputDir = cfg.labDir || path.join(context.dataRoot, 'analysis')
  if (cfg.adapterPath) {
    const manifest = JSON.parse(readFileSync(cfg.adapterPath, 'utf8').replace(/^\uFEFF/, ''))
    if (manifest.schemaVersion !== 1 || typeof manifest.pipelinePath !== 'string') throw new AnalysisError('adapter', 'adapter manifest 需要 schemaVersion:1 和 pipelinePath')
    cfg.pipelinePath = path.resolve(path.dirname(cfg.adapterPath), manifest.pipelinePath)
    cfg.adapter = manifest
  }
  if (cfg.pipelinePath) {
    for (const key of ['projectRoot', 'labDir', 'rawDir']) if (!cfg[key]) throw new AnalysisError('adapter', `私有适配器必须显式配置 ${key}`)
    cfg.outputDir = cfg.labDir
  }
  cfg.outputDir = path.resolve(cfg.outputDir)
  return { cfg, context }
}

export function apply(ctx, config = {}) {
  const VERSION = '0.5.0'
  let selected = configFor(config)
  let autoScheduler = null
  function current() { return selected }
  /** 07：只从 privacy 服务/研究配置/插件配置读，Agent 工具参数不能放宽。 */
  function privacyPolicy() {
    const { cfg, context } = current()
    return resolvePrivacyPolicy({ ctx, config: { ...config, ...cfg }, study: context, pluginKey: 'analysis' })
  }
  function currentPrivacyMode() {
    try { return privacyPolicy().mode } catch { return 'strict-local' }
  }
  function privacyOptions(policy) {
    return { sessionTools: policy.sessionTools, allowedColumns: policy.allowedColumns, maxBytes: policy.maxBytes, attachments: policy.attachments }
  }
  const binding = hostBinding(ctx, {
    plugin: 'analysis-run',
    version: VERSION,
    config,
    hooks: {
      loadStudy: studyPath => configFor({ studyPath, ...(config.pythonPath ? { pythonPath: config.pythonPath } : {}) }).context,
      currentIdentity: () => ({ studyId: selected.context.id, studyPath: selected.context.path, dataRoot: selected.context.dataRoot, revision: selected.context.revision }),
      busy: () => LOCKS.size > 0 || WRITES.size > 0,
      prepareSwitch(studyPath) {
        if (LOCKS.has(selected.cfg.outputDir) || WRITES.has(selected.cfg.outputDir) || LOCKS.size > 0) throw new AnalysisError('busy', '分析正在运行或保存，暂不能切换研究')
        const previous = selected
        const next = configFor({ studyPath, ...(config.pythonPath ? { pythonPath: config.pythonPath } : {}) })
        return { commit() { selected = next }, rollback() { selected = previous } }
      }
    }
  })
  binding.dispatch(ctx)
  async function studyConnect(actor, payload) {
    if (!path.isAbsolute(String(payload.studyPath || ''))) throw new AnalysisError('invalid', '研究定义需要绝对路径')
    const view = binding.connect(actor, { studyPath: payload.studyPath })
    const active = await binding.activate(actor)
    return { binding: active || view, study: current().context.identity }
  }
  async function studySave(actor, payload) {
    const problems = validateStudyDefinition(payload.definition)
    if (problems.length) throw new AnalysisError('invalid', problems.join('；'))
    if (!path.isAbsolute(String(payload.studyPath || ''))) throw new AnalysisError('invalid', '研究定义需要绝对路径')
    if (LOCKS.size > 0 || WRITES.size > 0) throw new AnalysisError('busy', '分析运行时不能保存研究')
    // Explicit user action creates a new definition only; existing files are never overwritten.
    await mkdir(path.dirname(payload.studyPath), { recursive: true })
    await writeFile(payload.studyPath, JSON.stringify(payload.definition, null, 2), { encoding: 'utf8', flag: 'wx' })
    try {
      const view = binding.connect(actor, { studyPath: payload.studyPath })
      const active = await binding.activate(actor)
      return { binding: active || view, study: current().context.identity }
    } catch (error) {
      await rm(payload.studyPath, { force: true }).catch(() => {})
      throw error
    }
  }
  async function exclusions(cfg) { return readJson(path.join(cfg.outputDir, 'exclusions.json'), []) }
  async function planFor(cfg) {
    const stored = await readJson(path.join(cfg.outputDir, 'plan.json'), null)
    return stored || { dataPath: cfg.dataPath || '', idColumn: cfg.idColumn || 'participantId', outcome: cfg.outcome || '', layout: cfg.layout || 'wide', groupColumns: cfg.groupColumns || [], covariates: cfg.covariates || [], pairedColumns: cfg.pairedColumns || [], within: cfg.within || null, analyses: cfg.analyses || ['descriptives'], gate: cfg.gate || { minSubjects: cfg.gateMain ?? 30 } }
  }
  function privateArgs(cfg, stage) { return ['--stage', stage, '--json', '--project-root', cfg.projectRoot, '--lab-dir', cfg.labDir, '--raw-dir', cfg.rawDir] }
  async function privateStatus(cfg) { const out = await python(cfg, cfg.pipelinePath, privateArgs(cfg, 'status')); if (!out.ok) throw new AnalysisError('python', out.error); return out }
  async function runs(cfg, study = null) {
    let entries; try { entries = await readdir(path.join(cfg.outputDir, 'runs'), { withFileTypes: true }) } catch { return [] }
    const list = []
    const studyId = (study || current().context).id
    for (const entry of entries.filter(e => e.isDirectory()).sort((a,b) => b.name.localeCompare(a.name))) {
      const meta = await readJson(path.join(cfg.outputDir, 'runs', entry.name, 'meta.json'), null)
      if (!meta || (meta.study && meta.study.id !== studyId)) continue
      // 被中断的运行：仍是 running，但记录里的进程已经不在了。
      let interrupted = false
      if (meta.status === 'running' && meta.process && meta.process.hostname === os.hostname() && Number.isInteger(Number(meta.process.pid))) {
        try { process.kill(Number(meta.process.pid), 0) } catch { interrupted = true }
      }
      list.push({ runId: entry.name, status: meta.status, interrupted, n: meta.subjects ?? meta.n, observations: meta.observations, startedAt: meta.startedAt, finishedAt: meta.finishedAt, study: meta.study, error: meta.error, fingerprint: meta.fingerprint })
    }
    // stale：被更新后、输入不同的运行（只在读取时推导，不改已完成的运行目录）。
    const newest = list[0]
    const newestFingerprint = newest && newest.fingerprint
    for (const row of list) {
      row.stale = Boolean(newest && row.runId !== newest.runId && row.fingerprint && newestFingerprint && row.fingerprint !== newestFingerprint)
    }
    for (const row of list) delete row.fingerprint
    return list
  }
  async function schema() {
    const { cfg, context } = current()
    return { study: context.identity, mode: cfg.pipelinePath ? 'adapter' : 'generic', modules: MODULES, stages: cfg.pipelinePath ? cfg.adapter?.stages || [{ id: 'all', label: '运行本地分析' }] : [{ id: 'all', label: '运行已选分析' }], plan: cfg.pipelinePath ? null : await planFor(cfg), planRevision: hash(await readFile(path.join(cfg.outputDir, 'plan.json'), 'utf8').catch(() => '')), exclusionsRevision: hash(await readFile(path.join(cfg.outputDir, cfg.pipelinePath ? cfg.adapter?.exclusionsFile || 'exclusions.csv' : 'exclusions.json'), 'utf8').catch(() => '')), adapterName: cfg.adapter?.name || (cfg.pipelinePath ? '本地适配器' : null) }
  }
  async function status(_payload = {}, view = null) {
    const { cfg, context } = current(); const base = await schema(); const history = await runs(cfg)
    if (cfg.pipelinePath) { const legacy = await privateStatus(cfg); return { ...base, busy: LOCKS.get(cfg.outputDir) || null, runs: history, lastRun: history[0] || null, source: { path: cfg.rawDir, files: legacy.rawFileCount, newFiles: legacy.newFileCount }, validity: legacy.validity || {}, exclusions: legacy.exclusions || [], python: { ok: true }, paths: { outputDir: cfg.outputDir } } }
    const plan = await planFor(cfg)
    let source = { path: plan.dataPath, exists: false }
    if (plan.source && plan.source.type === 'core') {
      // core 来源：现算一份汇合，以便显示当前数据版本与"有更新待运行"。
      try {
        const built = openAnalysis({ data: openResearchData({ study: context, instanceId: view && view.instanceId }), study: context, owner: 'analysis-run' }).dataset({ plan })
        source = { kind: 'core', exists: true, hash: built.hash, stats: built.stats, columns: built.columns }
      } catch (error) {
        source = { kind: 'core', exists: false, error: error.message }
      }
    } else {
      try { const bytes = await readFile(plan.dataPath); source = { ...source, exists: true, sha256: hash(bytes), size: bytes.length, columns: parseCsv(bytes.toString('utf8'))[0] || [] } } catch { /* Missing source is a setup state. */ }
    }
    const items = await exclusions(cfg)
    let latest = null
    if (history[0]) latest = await readJson(path.join(cfg.outputDir, 'runs', history[0].runId, 'meta.json'), null)
    // 后端可用性：用最近一次运行记录的环境；没有运行就不知道，返回 null。
    const CORE_BACKENDS = { descriptives: ['numpy', 'pandas'], sample: ['numpy', 'pandas'], sensitivity: ['numpy', 'pandas'], correlation: ['numpy', 'pandas'], reliability: ['numpy', 'pandas'], ttest: ['numpy', 'pandas'], anova: ['numpy', 'pandas', 'statsmodels'], mediation: ['numpy', 'pandas', 'statsmodels'], script: ['numpy', 'pandas'], regression: ['numpy', 'pandas', 'statsmodels'], paired: ['numpy', 'pandas'], mixed: ['statsmodels'] }
    let backends = null
    let backendsSource = vendorPresent() ? 'vendor' : 'runtime'
    let vendor = { present: vendorPresent(), site: VENDOR_SITE, manifest: existsSync(VENDOR_MANIFEST) ? await readJson(VENDOR_MANIFEST, null) : null }
    if (latest) {
      const environment = await readJson(path.join(cfg.outputDir, 'runs', history[0].runId, 'environment.json'), null)
      if (environment) {
        backends = Object.fromEntries(Object.entries(CORE_BACKENDS).map(([module, deps]) => {
          const missing = deps.filter(name => !(environment.packages || {})[name])
          return [module, { ok: missing.length === 0, missing }]
        }))
        const scipyPath = String((environment.packageSources || {}).scipy || '')
        backendsSource = scipyPath.includes(`${path.sep}vendor${path.sep}`) ? 'vendor' : (scipyPath ? 'runtime' : backendsSource)
      }
    }
    const sourceChanged = plan.source && plan.source.type === 'core'
      ? (latest?.dataset?.hash || latest?.source?.sha256) !== source.hash
      : latest?.source?.sha256 !== source.sha256
    // core 来源的 dataPath 是运行时派生的，不算方案变更。
    const normalizePlan = value => { const clone = JSON.parse(JSON.stringify(value || {})); delete clone.dataPath; return JSON.stringify(clone) }
    const pendingChanges = Boolean(latest && (sourceChanged || normalizePlan(latest.plan) !== normalizePlan(plan) || JSON.stringify(latest.excludedIds || []) !== JSON.stringify(items.map(row => row.id).sort())))
    return { ...base, busy: LOCKS.get(cfg.outputDir) || null, queued: PENDING.has(cfg.outputDir), autoError: autoScheduler?.state().error || null, autoTicks: autoScheduler?.state().ticks || 0, backends, backendsSource, vendor, runs: history, lastRun: history[0] || null, source, pendingChanges, exclusions: items, python: { configured: Boolean(cfg.pythonPath) }, paths: { outputDir: cfg.outputDir }, study: context.identity }
  }
  async function results(query = {}) {
    const { cfg, context } = current(); const history = await runs(cfg); const id = String(query.run || query.runId || history[0]?.runId || '')
    if (!id) return { runId: null, meta: null, tables: [], report: null, figures: [], study: context.identity }
    const dir = path.join(cfg.outputDir, 'runs', safeRun(id)); const meta = await readJson(path.join(dir, 'meta.json'), null)
    if (!meta) throw new AnalysisError('not_found', '找不到这次运行')
    if (meta.study && meta.study.id !== context.id) throw new AnalysisError('study', '运行属于另一项研究')
    let allowed = meta.tables || []; let valid = { model: true, report: true }
    if (cfg.pipelinePath) {
      const legacyArchive = !meta.stageStates
      if (legacyArchive) {
        const names = await readdir(path.join(dir,'tables')).catch(()=>[])
        allowed = names.filter(name=>/^[A-Za-z0-9_-]+\.csv$/.test(name)).map(name=>({key:path.basename(name,'.csv'),label:cfg.adapter?.tableLabels?.[path.basename(name,'.csv')]||path.basename(name,'.csv'),path:`tables/${name}`}))
        meta.archive = { legacy: true, verified: false, readOnly: true, text: '历史未验证快照，只读；新分析需要运行全部并创建新记录。' }
        valid = {model:false,report:true}; meta.model = null
      } else {
        const probe = await privateStatus(cfg); valid = probe.validity?.[id] || {}
        allowed = valid.model ? (meta.model?.artifacts || []).filter(file => file.endsWith('.csv')).map(file => ({ key: path.basename(file, '.csv'), label: cfg.adapter?.tableLabels?.[path.basename(file, '.csv')] || path.basename(file, '.csv'), path: `tables/${path.basename(file)}` })) : []
        if (!valid.model) meta.model = null
      }
      meta.validity = valid
    }
    const tables = []
    const corrupt = []
    if (!cfg.pipelinePath) {
      for (const [relative, expected] of Object.entries(meta.artifactHashes || {})) {
        const target = path.resolve(dir, relative)
        if (!target.startsWith(dir + path.sep)) throw new AnalysisError('integrity', '产物路径越界')
        try { if (hash(await readFile(target)) !== expected) corrupt.push(relative) } catch { corrupt.push(relative) }
      }
    }
    for (const table of corrupt.length ? [] : allowed) {
      if (!/^tables\/[A-Za-z0-9_-]+\.csv$/.test(table.path)) continue
      const grid = parseCsv(await readFile(path.join(dir, table.path), 'utf8'))
      tables.push({ key: table.key, label: table.label || table.key, columns: grid[0] || [], rows: grid.slice(1), types: table.types || null, analysisSet: table.analysisSet || null, nodeId: table.nodeId || null, title: table.title || null })
    }
    let report = null; if (valid.report && !corrupt.length) { try { report = await readFile(path.join(dir, 'report.md'), 'utf8') } catch {} }
    let figures = []
    if (cfg.pipelinePath && valid.report) figures = (meta.figures || []).map(file => ({ name: path.basename(file), url: `${ROUTE}?action=figure&run=${encodeURIComponent(id)}&name=${encodeURIComponent(path.basename(file))}` }))
    // 07：已导出的排版版本（只列目录，不改 manifest）。
    let presentations = []
    try {
      const root = path.join(dir, 'presentation')
      const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      for (const entry of entries) {
        const manifest = await readJson(path.join(root, entry.name, 'manifest.json'), null)
        const files = (await readdir(path.join(root, entry.name), { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => path.relative(path.join(root, entry.name), path.join(item.parentPath || item.path, item.name)).replace(/\\/g, '/'))
        presentations.push({ revision: Number(entry.name), createdAt: manifest?.createdAt || null, parent: manifest?.parent || null, sourceHash: manifest?.sourceHash || null, files })
      }
      presentations.sort((left, right) => right.revision - left.revision)
    } catch { presentations = [] }
    return { runId: id, meta, tables, report, figures, presentations, integrity: { ok: !corrupt.length, corrupt }, study: meta.study || context.identity }
  }
  async function savePlan(payload) {
    const { cfg } = current(); if (cfg.pipelinePath) throw new AnalysisError('adapter', '本地适配器方案由其配置管理')
    const plan = payload.plan || payload
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new AnalysisError('invalid', '分析方案需要对象')
    const coreSource = Boolean(plan.source && plan.source.type === 'core')
    if (!coreSource && (!plan.dataPath || !path.isAbsolute(plan.dataPath))) throw new AnalysisError('invalid', '数据路径需要绝对路径（或把 source.type 设为 core 从研究核心汇合）')
    const file = path.join(cfg.outputDir, 'plan.json')
    const previous = await readFile(file, 'utf8').catch(() => '')
    if (payload.revision !== hash(previous)) throw new AnalysisError('conflict', '方案已变更，请刷新后再保存')
    await atomicJson(file, plan)
    return { saved: true, plan, revision: hash(JSON.stringify(plan, null, 2)) }
  }
  const PENDING = new Map()
  /** 同一个输出目录只跑一个分析；期间到来的请求合并成"最新请求"，完成后再补跑一次。 */
  async function requestRun(payload, state, view) {
    const { cfg } = state
    if (LOCKS.has(cfg.outputDir) || WRITES.has(cfg.outputDir)) {
      PENDING.set(cfg.outputDir, { payload, state, view })
      return { queued: true, message: '已有分析在运行：已合并为最新请求，完成后再补跑' }
    }
    return await run(payload, state, view)
  }
  async function run(payload = {}, state = current(), view = null) {
    const { cfg, context } = state; if (LOCKS.has(cfg.outputDir) || WRITES.has(cfg.outputDir)) throw new AnalysisError('busy', '当前研究已有分析在运行')
    LOCKS.set(cfg.outputDir, { stage: payload.stage || 'all', startedAt: new Date().toISOString() })
    try {
      let result
      if (cfg.pipelinePath) {
        const stage = String(payload.stage || 'all'); const stages = cfg.adapter?.stages?.map(row => row.id) || ['all']
        if (stage !== 'all' && !stages.includes(stage)) throw new AnalysisError('stage', '适配器不支持该阶段')
        const args = privateArgs(cfg, stage)
        if (payload.runId && stage !== 'all') {
          const old = await readJson(path.join(cfg.outputDir,'runs',safeRun(payload.runId),'meta.json'),null)
          if (!old?.stageStates) throw new AnalysisError('legacy_archive','历史运行是只读未验证归档，请运行全部创建新记录')
          args.push('--run-id', safeRun(payload.runId))
        }
        result = await python(cfg, cfg.pipelinePath, args)
      } else {
        let plan = payload.plan || await planFor(cfg)
        if (payload.stage && payload.stage !== 'all') { if (!MODULES.some(row => row.id === payload.stage)) throw new AnalysisError('stage', '未知分析模块'); plan.analyses = ['descriptives', payload.stage].filter((id,i,a) => a.indexOf(id) === i) }
        let dataset = null
        if (plan.source && plan.source.type === 'core') {
          // 从已提交代次汇合分析表（不读旧 CSV 镜像），写进输出目录的 datasets/ 并按 hash 复用。
          const built = (() => {
            try {
              return openAnalysis({ data: openResearchData({ study: context, instanceId: view && view.instanceId }), study: context, owner: 'analysis-run' }).dataset({ plan })
            } catch (error) {
              if (error instanceof CoreAnalysisError) throw new AnalysisError(error.code, error.message, error.details)
              throw error
            }
          })()
          const datasetsDir = path.join(cfg.outputDir, 'datasets')
          await mkdir(datasetsDir, { recursive: true })
          const key = built.hash.slice(0, 16)
          const csvPath = path.join(datasetsDir, `${key}.csv`)
          const manifestPath = path.join(datasetsDir, `${key}.manifest.json`)
          const escape = value => { const text = value === null || value === undefined ? '' : String(value); return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text }
          const csv = [built.columns.join(','), ...built.rows.map(row => built.columns.map(column => escape(row[column])).join(','))].join('\n') + '\n'
          await writeFile(csvPath, csv, 'utf8')
          await writeFile(manifestPath, JSON.stringify({ ...built.manifest, hash: built.hash }, null, 2), 'utf8')
          dataset = { type: 'core', key, path: csvPath, manifestPath, hash: built.hash, stats: built.stats }
          plan = { ...plan, dataPath: csvPath }
        }
        const codeDir = await mkdtemp(path.join(os.tmpdir(), 'analysis-code-'))
        try {
          const names = ['engine.py','index.js','client.js','study-context.mjs','study-selection.mjs']
          for (const name of names) {
            const source = path.join(HERE,name), bytes = await readFile(source)
            if (LOADED_HASHES[name] && hash(bytes) !== LOADED_HASHES[name]) throw new AnalysisError('code_changed', '已加载代码与磁盘版本不同，请重新加载插件后运行')
            await copyFile(source,path.join(codeDir,name))
            if (hash(await readFile(path.join(codeDir,name))) !== hash(bytes)) throw new AnalysisError('code_changed', '代码快照期间文件变化，请重试')
          }
          const request = { action: 'run', study: context.identity, plan, outputDir: cfg.outputDir, exclusions: await exclusions(cfg), revisionOf: payload.runId || null, scriptPaths: names.filter(name=>name!=='engine.py').map(name=>path.join(codeDir,name)), force: payload?.force === true || payload?.forceRecompute === true }
          if (dataset) request.dataset = dataset
          result = await python(cfg, path.join(codeDir, 'engine.py'), ['--request-json', JSON.stringify(request)])
        } finally { if (path.dirname(codeDir) !== os.tmpdir() || !path.basename(codeDir).startsWith('analysis-code-')) throw new AnalysisError('path', '临时代码路径校验失败'); await rm(codeDir,{recursive:true,force:true}) }
      }
      if (!result.ok) throw new AnalysisError('run_failed', result.error || result.failures?.[0]?.error || '分析失败', { runId: result.runId })
      return result
    } finally {
      LOCKS.delete(cfg.outputDir)
      const next = PENDING.get(cfg.outputDir)
      if (next) {
        PENDING.delete(cfg.outputDir)
        // 补跑用排队时的研究身份，但数据在真正开始时重新汇合，不会混用旧版本。
        setImmediate(() => { run(next.payload, next.state, next.view).catch(() => {}) })
      }
    }
  }
  async function exclude(payload) {
    const { cfg, context } = current(); const id = String(payload.id || '')
    if (!context.acceptsId(id)) throw new AnalysisError('invalid', '参与者编号不符合研究定义')
    if (!['add','remove'].includes(payload.op)) throw new AnalysisError('invalid', '排除操作需要 add 或 remove')
    const revisionFile = path.join(cfg.outputDir, cfg.pipelinePath ? cfg.adapter?.exclusionsFile || 'exclusions.csv' : 'exclusions.json')
    if (payload.revision !== hash(await readFile(revisionFile, 'utf8').catch(() => ''))) throw new AnalysisError('conflict', '排除名单已变更，请刷新后再保存')
    if (cfg.pipelinePath) {
      const file = path.join(cfg.labDir, cfg.adapter?.exclusionsFile || 'exclusions.csv')
      const keysConfigured = cfg.adapter?.exclusionColumns
      if (!keysConfigured) throw new AnalysisError('adapter', '适配器需要 exclusionColumns')
      const grid = parseCsv(await readFile(file, 'utf8').catch(() => Object.values(keysConfigured).join(',') + '\n')); const header = grid[0]
      const keys = cfg.adapter?.exclusionColumns
      if (!keys || !header.includes(keys.id)) throw new AnalysisError('adapter', '适配器需要有效的 exclusionColumns 映射')
      const rows = grid.slice(1).filter(row => row[header.indexOf(keys.id)] !== id)
      if (payload.op !== 'remove') { if (!String(payload.reason || '').trim()) throw new AnalysisError('invalid', '请填写排除理由'); const record = { [keys.id]: id, [keys.reason]: payload.reason, [keys.at]: new Date().toISOString(), [keys.actor]: 'analysis-run' }; rows.push(header.map(col => record[col] || '')) }
      const csv = [header,...rows].map(row => row.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n')+'\n'
      await mkdir(cfg.labDir,{recursive:true}); await writeFile(file,csv,'utf8'); return { id, pendingChanges: true }
    }
    const items = (await exclusions(cfg)).filter(row => row.id !== id)
    if (payload.op !== 'remove') { if (!String(payload.reason || '').trim()) throw new AnalysisError('invalid', '请填写排除理由'); items.push({ id, reason: String(payload.reason).trim(), at: new Date().toISOString() }) }
    await atomicJson(path.join(cfg.outputDir, 'exclusions.json'), items)
    return { id, pendingChanges: true }
  }
  const queries = { schema, status, results, preview: planPreview }
  const READ_ACTIONS = new Set(['schema', 'status', 'results', 'preview'])

  /** 方案向导的预览：返回列名与各模块可用人数，不写任何文件。 */
  async function planPreview(payload = {}) {
    const { cfg } = current()
    const raw = payload.plan || payload
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AnalysisError('invalid', '分析方案需要对象')
    const plan = JSON.parse(JSON.stringify(raw))
    if (!plan.dataPath) throw new AnalysisError('invalid', '还没有选择数据文件')
    const codeDir = await mkdtemp(path.join(os.tmpdir(), 'analysis-preview-'))
    try {
      await copyFile(path.join(HERE, 'engine.py'), path.join(codeDir, 'engine.py'))
      const request = { action: 'preview', study: current().context.identity, plan }
      const result = await python(cfg, path.join(codeDir, 'engine.py'), ['--request-json', JSON.stringify(request)])
      if (!result.ok) throw new AnalysisError('preview_failed', result.error || '预览失败')
      return result
    } finally {
      if (path.basename(codeDir).startsWith('analysis-preview-')) await rm(codeDir, { recursive: true, force: true })
    }
  }

  function withFigureUrls(data, actor) {
    if (!data || !Array.isArray(data.figures)) return data
    const pageId = actor.kind === 'page' ? actor.pageId : ''
    data.figures = data.figures.map(figure => ({ ...figure, url: figure.url + '&pageId=' + encodeURIComponent(pageId) }))
    return data
  }

  async function action(actor, name, payload = {}) {
    if (name === 'capabilities') {
      await binding.read(actor, () => null)
      return { ...binding.capabilities(actor), study: current().context.identity }
    }
    if (name === 'autoTick') { await autoScheduler.tick(); return { ticked: true } }
    if (name === 'studyConnect') return await studyConnect(actor, payload)
    if (name === 'studySave') return await studySave(actor, payload)
    if (!Object.hasOwn(queries, name) && !['plan', 'run', 'exclude', 'export'].includes(name)) throw new AnalysisError('action', '未知操作')
    const expected = { token: payload.binding || payload.bindingToken, studyId: payload.studyId, studyRevision: payload.studyRevision }
    if (READ_ACTIONS.has(name)) {
      const { binding: view, data } = await binding.read(actor, async (_view) => {
        const value = await queries[name](payload, _view)
        return name === 'results' ? withFigureUrls(value, actor) : value
      })
      return { ...data, binding: view, study: current().context.identity }
    }
    if (name === 'export') {
      const { binding: view, data } = await binding.write(actor, expected, async (_view, state) => { const value = await exportRun(payload); return { ...value, binding: undefined } }, { holdLock: false, capture: () => current() })
      return { ...data, binding: view, study: current().context.identity }
    }
    if (name === 'run') {
      // 分析可能运行十几分钟：切换在锁内完成，运行在锁外，期间由 LOCKS 阻止切走。
    const { binding: view, data } = await binding.write(actor, expected, async (_view, state) => requestRun(payload, state, _view), { holdLock: false, capture: () => current() })
      return { ...data, binding: view, study: current().context.identity }
    }
    const { binding: view, data } = await binding.write(actor, expected, async () => {
      const { cfg } = current()
      if (name === 'plan') return await serialWrite(cfg.outputDir, () => savePlan(payload))
      return await serialWrite(cfg.outputDir, () => exclude(payload))
    })
    return { ...data, binding: view, study: current().context.identity }
  }

  const handler = async (req, res) => {
    const respond = (code, payload) => { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(payload)) }
    try {
      const url = new URL(req.url || ROUTE, 'http://localhost'); const origin = req.headers.origin
      const figure = req.method === 'GET' && url.searchParams.get('action') === 'figure'
      const presentation = req.method === 'GET' && url.searchParams.get('action') === 'presentation'
      if ((req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) || (origin && new URL(origin).host !== req.headers.host) || (!figure && !presentation && req.headers['x-analysis-run'] !== '1')) throw new AnalysisError('forbidden', '拒绝跨站访问')
      if (presentation) {
        const actor = binding.pageActor({ req, pageId: url.searchParams.get('pageId'), workspaceId: url.searchParams.get('workspaceId'), sessionId: url.searchParams.get('sessionId') })
        const { binding: view, data: result } = await binding.read(actor, () => results({ run: url.searchParams.get('run') }))
        void view
        const revision = String(url.searchParams.get('rev') || '')
        const file = String(url.searchParams.get('file') || '')
        if (!/^\d+$/.test(revision) || !/^(report\.(html|pdf)|results\.json|manifest\.json|tables\.(docx|xlsx)|figures\/[\w-]+\.(svg|png))$/.test(file)) throw new AnalysisError('not_found', '导出文件不可用')
        if (!(result.presentations || []).some(item => String(item.revision) === revision && item.files.includes(file))) throw new AnalysisError('not_found', '导出文件不可用')
        const { cfg } = current()
        const target = path.join(cfg.outputDir, 'runs', result.runId, 'presentation', revision, file)
        const media = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png'
          : file.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : file.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json; charset=utf-8'
        res.statusCode = 200
        res.setHeader('content-type', media)
        res.setHeader('cache-control', 'no-store')
        if (file.endsWith('.html')) res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'")
        // 应用内新标签页会被拦截：PDF 直接以下载方式返回，HTML 允许 iframe 预览。
        if (file.endsWith('.pdf')) res.setHeader('content-disposition', 'attachment; filename="report.pdf"')
        res.setHeader('x-content-type-options', 'nosniff')
        res.end(await readFile(target)); return
      }
      if (figure) {
        const actor = binding.pageActor({ req, pageId: url.searchParams.get('pageId'), workspaceId: url.searchParams.get('workspaceId'), sessionId: url.searchParams.get('sessionId') })
        const name = url.searchParams.get('name')
        const { binding: view, data: result } = await binding.read(actor, () => results({ run: url.searchParams.get('run') }))
        void view
        if (!result.figures.some(row => row.name === name) || !/^[\w.-]+\.png$/i.test(name)) throw new AnalysisError('not_found','图片不可用或已过期')
        const { cfg } = current(); res.setHeader('content-type','image/png'); res.end(await readFile(path.join(cfg.outputDir,'runs',result.runId,name))); return
      }
      let name, payload
      if (req.method === 'GET') { name = url.searchParams.get('action') || 'status'; payload = Object.fromEntries(url.searchParams) ; if (!['status','schema','results','capabilities'].includes(name)) throw new AnalysisError('method','此操作需要 POST') }
      else if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024*1024) throw new AnalysisError('invalid','请求体过大') }
        const parsed = JSON.parse(body || '{}'); name = parsed.action; payload = parsed.payload || {}
      } else throw new AnalysisError('method','只接受 GET / POST')
      const actor = binding.pageActor({ req, pageId: payload.pageId, workspaceId: payload.workspaceId, sessionId: payload.sessionId })
      respond(200,{ok:true,data:await action(actor, name, payload)})
    } catch(error) {
      const mapped = bindingStatus(error)
      // 07：错误响应去本地路径/逐人编号，details 与异常栈不返回。
      respond(mapped || (error.code==='not_found'?404:error.code==='forbidden'?403:400),{ok:false,error:sanitizeError(error, { mode: currentPrivacyMode() })})
    }
  }
  /* ---------- 07 导出：结果对象 → 三线表 / 图 / HTML / PDF / manifest ---------- */
  async function exportRun(payload = {}) {
    const { cfg, context } = current()
    if (cfg.pipelinePath) throw new AnalysisError('adapter', '通用导出只支持通用引擎运行；私有适配器有自己的报告流程')
    const data = await results(payload)
    if (!data.runId) throw new AnalysisError('not_found', '还没有可导出的运行')
    if (!data.integrity || !data.integrity.ok) throw new AnalysisError('integrity', '运行产物校验失败，不能导出')
    const runId = safeRun(data.runId)
    const runDir = path.join(cfg.outputDir, 'runs', runId)
    const root = path.join(runDir, 'presentation')
    const previous = existsSync(root) ? (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => Number(entry.name)).sort((a, b) => a - b).pop() : null
    const revision = (previous || 0) + 1
    const outDir = path.join(root, String(revision))
    await mkdir(outDir, { recursive: true })
    const built = buildResults({ run: { runId }, meta: data.meta, tables: data.tables.map(table => tableFromGrid(table)) })
    const figures = []
    const figureFiles = []
    const addFigure = async (key, chart, analysisSetId = null) => {
      if (!chart || chart.ok === false) return
      figureFiles.push({ key, width: chart.width, height: chart.height, analysisSetId })
      built.figures.push({ key, title: chart.title || key, svg: `figures/${key}.svg`, width: chart.width, height: chart.height, analysisSetId })
      await writeFile(path.join(outDir, 'figures', `${key}.svg`), chart.svg)
      const png = renderPng({ svg: chart.svg, outPath: path.join(outDir, 'figures', `${key}.png`), width: chart.width, height: chart.height, dpi: 300 })
      if (png.ok) figures.push({ key, png: `figures/${key}.png`, dpi: png.dpi })
    }
    await mkdir(path.join(outDir, 'figures'), { recursive: true })
    const STAT_COLUMNS = new Set(['subjects', 'n', 'mean', 'sd', 'se', 'median', 'q1', 'q3', 'iqr', 'minimum', 'maximum', 'valueRange', 'ciLow', 'ciHigh', 'missing'])
    const descriptives = built.tables.find(table => table.key === 'descriptives')
    const descriptiveSet = descriptives?.analysisSet || built.analysisSet
    if (descriptives && descriptives.columns.some(column => column.key === 'mean')) {
      // 多因素时用完整的组标签，不只取第一个分组列；计数列不参与标签。
      const labelKeys = descriptives.columns.map(column => column.key).filter(key => !STAT_COLUMNS.has(key))
      const chart = pointRangeChart({
        title: '分组估计与 95% 区间',
        subtitle: `分析集 ${descriptiveSet.subset} · 独立人数 ${descriptiveSet.subjects ?? '—'} · 观测 ${descriptiveSet.observations ?? '—'}`,
        height: 420,
        rows: descriptives.rows.map(row => ({
          label: scrubText(labelKeys.map(key => String(row[key] ?? '')).filter(Boolean).join(' × ') || '整体'),
          estimate: row.mean, low: row.ciLow, high: row.ciHigh, n: row.subjects ?? row.n,
        })),
      })
      await addFigure('group-estimates', chart, descriptiveSet.id)
    }
    // 分布图与配对图只使用引擎发布的分析集行（排除、缺失、变换、成对完整规则与模型一致）。
    const distribution = data.meta?.charts?.distribution
    if (distribution && !distribution.error && Array.isArray(distribution.groups) && distribution.groups.length) {
      await addFigure('distribution', distributionChart({
        title: '分析集观测分布',
        subtitle: `${scrubText(distribution.outcome)} · 分析集 n=${distribution.n} · 每个点=一个观测`,
        groups: distribution.groups.slice(0, 6).map(group => (group && typeof group === 'object' ? { ...group, label: scrubText(group.label) } : group)), height: 460,
      }), distribution.analysisSetId || descriptiveSet.id)
    }
    const coefficientTable = built.tables.find(table => table.key === 'coefficients') || built.tables.find(table => table.key === 'regression' && table.columns.some(column => column.key === 'term') && table.columns.some(column => column.key === 'estimate'))
    if (coefficientTable) {
      await addFigure('model-estimates', forestChart({ title: '模型估计与 95% 区间', height: 360, rows: coefficientTable.rows.map(row => ({ label: scrubText(String(row.term)), estimate: row.estimate, low: row.ciLow, high: row.ciHigh, p: row.p })) }), coefficientTable.analysisSet?.id)
    }
    const contrastTable = built.tables.find(table => table.key === 'contrasts') || built.tables.find(table => table.key === 'contrast')
    if (contrastTable && contrastTable.columns.some(column => column.key === 'estimate')) {
      await addFigure('planned-contrasts', forestChart({ title: '预设对比', height: 340, rows: contrastTable.rows.map(row => ({ label: scrubText(String(row.name ?? row.term ?? '对比')), estimate: row.estimate, low: row.ciLow, high: row.ciHigh, p: row.p })) }), contrastTable.analysisSet?.id)
    }
    const pairedChartData = data.meta?.charts?.paired
    if (pairedChartData && !pairedChartData.error && Array.isArray(pairedChartData.pairs) && pairedChartData.pairs.length) {
      const plan = data.meta?.plan || {}
      const beforeLabel = scrubText(plan.pairedColumns?.[0] || plan.within?.levels?.[0] || '前测')
      const afterLabel = scrubText(plan.pairedColumns?.[1] || plan.within?.levels?.[1] || '后测')
      await addFigure('paired-trajectories', pairedChart({
        title: '配对变化轨迹',
        subtitle: `${beforeLabel} → ${afterLabel} · 分析集 n=${pairedChartData.n} · 每位参与者一条线`,
        pairs: pairedChartData.pairs, beforeLabel, afterLabel, height: 460,
      }), pairedChartData.analysisSetId)
    }
    // 07：分享包从白名单重新构造；HTML/JSON/Office 的标题与表值共用同一份分享视图。
    const policy = privacyPolicy()
    const share = shareProjection(built, { meta: data.meta, mode: policy.mode })
    const figureHtml = share.figures.map((figure, index) => {
      if (!figure.svg) return ''
      // 内联进 HTML 时去掉 SVG 命名空间（HTML5 不需要，也让报告里没有任何 http 引用）。
      const svg = readFileSync(path.join(outDir, figure.svg), 'utf8').replace(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')
      const png = figures.find(item => item.key === figure.key)
      return `<figure class="chart" data-figure="${escapeAttr(figure.key)}">${svg}<figcaption>图 ${index + 1} ${escapeAttr(figure.title || figure.key)}${png ? ` · PNG 300dpi：${escapeAttr(png.png)}` : ''}</figcaption></figure>`
    }).join('\n')
    const html = renderHtmlReport({ meta: share.meta, results: share, today: new Date().toISOString().slice(0, 10) })
      .replace('<h2>表格 <span class="meta">Tables</span></h2>', `${figureHtml}<h2>表格 <span class="meta">Tables</span></h2>`)
    await writeFile(path.join(outDir, 'report.html'), html)
    const pdf = renderPdf({ html, outPath: path.join(outDir, 'report.pdf') })
    await writeFile(path.join(outDir, 'results.json'), JSON.stringify({ ...share, figures: share.figures.map(figure => ({ ...figure, svg: undefined, png: figures.find(item => item.key === figure.key)?.png || null })) }, null, 2))
    // 三线表的 DOCX / XLSX：本地 python-docx / openpyxl 渲染，失败也要写进结果而不是静默跳过。
    let office = { ok: false, reason: '未运行' }
    if (cfg.pythonPath) {
      const output = await python(cfg, path.join(HERE, 'office_export.py'), ['--results', path.join(outDir, 'results.json'), '--out', outDir], { timeoutMs: 120000 })
      office = output && output.ok === true ? { ok: true, docx: output.docx, xlsx: output.xlsx, tables: output.tables } : { ok: false, reason: String(output?.error || '三线表导出失败') }
    }
    const artifacts = []
    const addFile = async (relative, mediaType) => {
      const content = await readFile(path.join(outDir, relative))
      artifacts.push({ mediaType, relativePath: relative, sha256: hash(content) })
    }
    await addFile('report.html', 'text/html')
    for (const figure of share.figures) if (figure.svg) await addFile(figure.svg, 'image/svg+xml')
    for (const figure of figures) await addFile(figure.png, 'image/png')
    await addFile('results.json', 'application/json')
    if (office.ok) {
      await addFile('tables.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      await addFile('tables.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    }
    if (pdf.ok) await addFile('report.pdf', 'application/pdf')
    const manifest = shareManifest(artifactManifest({ results: share, artifacts }))
    manifest.presentationRevision = revision
    manifest.parent = previous ? `presentation/${previous}/manifest.json` : null
    manifest.pdf = pdf.ok ? { relativePath: 'report.pdf' } : { unavailable: pdf.reason }
    manifest.office = office.ok ? { docx: 'tables.docx', xlsx: 'tables.xlsx' } : { unavailable: office.reason }
    // 排版 revision 的可追溯信息：格式 schema、分析集引用、图表分析集与来源模型 hash。
    manifest.formatSchema = 1
    manifest.analysisSet = share.analysisSet
    manifest.figures = share.figures.map(figure => ({ key: figure.key, analysisSetId: figure.analysisSetId || null }))
    manifest.render = { html: 'ok', pdf: pdf.ok ? 'ok' : { unavailable: pdf.reason }, office: office.ok ? 'ok' : { unavailable: office.reason }, svg: share.figures.length, png: figures.length }
    try { manifest.sourceModelHash = hash(await readFile(path.join(runDir, 'model.json'))) } catch { manifest.sourceModelHash = null }
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return { runId, revision, dir: `runs/${runId}/presentation/${revision}`, artifacts: artifacts.map(item => item.relativePath), figures: share.figures.map(figure => figure.key), png: figures.length, pdf: pdf.ok, office: office.ok, manifest, study: context.identity }
  }
  const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

  /* ---------- 去抖自动运行（config.autoRun，默认关闭） ---------- */
  function readInstanceId(dataRoot) {
    try { return JSON.parse(readFileSync(path.join(dataRoot, 'study-instance.json'), 'utf8')).instanceId || null } catch { return null }
  }
  async function readAutoState(cfg) {
    try { return JSON.parse(await readFile(path.join(cfg.outputDir, 'auto-state.json'), 'utf8')) } catch { return {} }
  }
  async function writeAutoState(cfg, value) {
    try { await writeFile(path.join(cfg.outputDir, 'auto-state.json'), JSON.stringify(value, null, 2)) } catch { /* 状态文件只是加速，不阻断运行 */ }
  }
  // 自动调度的纯逻辑都在 scheduler.mjs；这里只把工程依赖注入进去。
  autoScheduler = createScheduler({
    config,
    current,
    run,
    analysis: {
      planFor,
      // 传入 tick 捕获的 context，避免 runs() 内部再读 current()。
      runs: (cfg, studyState) => runs(cfg, studyState && studyState.context),
      latestMeta: (cfg, runId) => readJson(path.join(cfg.outputDir, 'runs', runId, 'meta.json'), null),
      dataset: ({ state: studyState, plan, instanceId }) => openAnalysis({ data: openResearchData({ study: studyState.context, instanceId }), study: studyState.context, owner: 'analysis-run' }).dataset({ plan }),
      instanceId: context => readInstanceId(context.dataRoot),
      // 对内存 LOCKS/WRITES 的检查作为 run 前 guard。
      blocked: studyState => LOCKS.has(studyState.cfg.outputDir) || WRITES.has(studyState.cfg.outputDir),
    },
    readAutoState,
    writeAutoState,
  })
  function startAuto() { return autoScheduler.start() }
  const attach = scope => scope.effect(() => scope.webServer.register({kind:'prefix',path:ROUTE,handler}), 'analysis-run route')
  const web = ctx.get?.('webServer'); if (web) ctx.effect(() => web.register({kind:'prefix',path:ROUTE,handler}), 'analysis-run route'); else ctx.inject(['webServer'],attach)
  const register = scope => {
    const output = { schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:v.text}] }
    const defs = [
      ['analysis_status','查看当前研究、分析方案、输入状态与运行历史。',{},[],async (args,exec)=>{
        try {
          const { data } = await binding.read(binding.agentActor(exec), async view => status({}, view))
          const policy = privacyPolicy()
          return JSON.stringify(agentProjection('analysis_status', statusAgentSummary(data), policy.mode, privacyOptions(policy)), null, 2)
        } catch (error) {
          return JSON.stringify(sanitizeError(error, { mode: currentPrivacyMode() }), null, 2)
        }
      }],
      ['analysis_run','运行通用分析或显式配置的本地适配器，每次通用运行保存独立快照。',{stage:{type:'string'},runId:{type:'string'}},[],async (args,exec)=>{
        try {
          const actor = binding.agentActor(exec)
          const { binding: view, data } = await binding.write(actor, {}, async (_v, state) => requestRun(args || {}, state, _v), { holdLock: false, capture: () => current() })
          void view
          const policy = privacyPolicy()
          return JSON.stringify(agentProjection('analysis_run', analysisRunSummary(data), policy.mode, privacyOptions(policy)), null, 2)
        } catch (error) {
          return JSON.stringify(sanitizeError(error, { mode: currentPrivacyMode() }), null, 2)
        }
      }],
      ['analysis_results','读取指定运行的动态表格、节点状态与报告。',{runId:{type:'string'},table:{type:'string'}},[],async (args,exec)=>{
        try {
          const actor = binding.agentActor(exec)
          const { data } = await binding.read(actor, async () => { const value = await results(args || {}); if (args && args.table) value.tables = value.tables.filter(row => row.key === args.table); return value })
          const policy = privacyPolicy()
          return JSON.stringify(agentProjection('analysis_results', resultsAgentSummary(data), policy.mode, privacyOptions(policy)), null, 2)
        } catch (error) {
          return JSON.stringify(sanitizeError(error, { mode: currentPrivacyMode() }), null, 2)
        }
      }],
      ['analysis_export','把指定运行导出为自包含 HTML/PDF/三线表图片与产物清单（本地渲染，不调云端）。',{runId:{type:'string'}},[],async (args,exec)=>{
        try {
          const actor = binding.agentActor(exec)
          const { data } = await binding.write(actor, {}, async (_v) => exportRun(args || {}), { holdLock: false, capture: () => current() })
          const policy = privacyPolicy()
          return JSON.stringify(agentProjection('analysis_export', exportAgentSummary(data), policy.mode, privacyOptions(policy)), null, 2)
        } catch (error) {
          return JSON.stringify(sanitizeError(error, { mode: currentPrivacyMode() }), null, 2)
        }
      }],
      ['analysis_exclude','按研究编号维护人工排除；新运行应用变更，历史快照不变。',{id:{type:'string'},op:{type:'string',enum:['add','remove']},reason:{type:'string'}},['id','op'],async (args,exec)=>{
        const actor = binding.agentActor(exec)
        const { data: view } = await binding.read(actor, () => schema())
        const { data } = await binding.write(actor, {}, async () => await serialWrite(current().cfg.outputDir, () => exclude({ ...(args || {}), revision: view.exclusionsRevision })))
        return JSON.stringify(data, null, 2)
      }]
    ]
    for (const [name,description,properties,required,execute] of defs) scope.tools.register({name,description,parameters:{type:'object',properties,required,additionalProperties:false},output,execute:async (args, exec)=>({text:await execute(args||{}, exec)})})
  }
  const tools = ctx.get?.('tools'); if (tools) register({tools}); else ctx.inject(['tools'],register)
  startAuto()
  ctx.effect(() => () => { autoScheduler.dispose() }, 'analysis-run auto scheduler')
}
export const name = 'analysis-run'
export const version = '0.5.0'
