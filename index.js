/**
 * analysis-run — Host half.
 *
 * 一条 HTTP 路由服务面板「分析」页；四个工具把同一份状态与结果交给 agent。
 * 原始数据只读：本插件只写 `_lab/cache`、`_lab/runs` 与 `_lab/exclusions.csv`。
 *
 * 数据契约（见 README）：原始 CSV 与量表答案是原始数据；cache 与 runs 都是缓存，
 * 删掉可以重建，但 runs/<runId>/meta.json 是唯一说明「哪版数据对哪版结果」的记录。
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = '/api/analysis-run'
const HEADER = 'x-analysis-run'
const MAX_BODY = 1024 * 1024
const RUN_TIMEOUT_MS = 15 * 60 * 1000
const STAGES = ['ingest', 'derive', 'merge', 'model', 'report']
const STAGE_LABEL = {
  ingest: '摄取（原始 CSV → 逐试次长表）',
  derive: '推导（无差异点 → AUC / k）',
  merge: '合并（AUC + 量表分 + 人口学 + 排除）',
  model: '模型（描述统计 / 主分析）',
  report: '报告（三线表、图、md）'
}

const DEFAULT_PROJECT = 'C:/Users/16787/OneDrive/Desktop/yyh硕士论文'
const DEFAULT_PYTHON = '04_预实验数据与分析/.analysis_venv/Scripts/python.exe'

class RouteError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/* ------------------------------------------------------------------ *
 * io helpers
 * ------------------------------------------------------------------ */

function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new RouteError('too_large', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new RouteError('invalid', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  try {
    return new URL(origin).host === String(req.headers.host || '')
  } catch {
    return false
  }
}

function isId(value) {
  return /^\d{5}$/.test(String(value || '').trim())
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readJson(target, fallback) {
  try {
    return JSON.parse(await readFile(target, 'utf8'))
  } catch {
    return fallback
  }
}

function resolveConfig(config) {
  const root = path.resolve(String((config && config.projectRoot) || DEFAULT_PROJECT).replace(/\\/g, '/'))
  const pythonCandidate = String((config && config.pythonPath) || '').replace(/\\/g, '/')
  const pythonPath = pythonCandidate || path.join(root, DEFAULT_PYTHON).replace(/\\/g, '/')
  return {
    projectRoot: root,
    labDir: path.resolve(String((config && config.labDir) || 'D:/yyh-lab').replace(/\\/g, '/')),
    rawDir: path.resolve(String((config && config.rawDir) || path.join(root, '正式实验数据', 'DDT')).replace(/\\/g, '/')),
    pythonPath,
    pythonFromConfig: Boolean(pythonCandidate),
    gateExplore: Number((config && config.gateExplore) || 30),
    gateMain: Number((config && config.gateMain) || 40)
  }
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter(items => items.length && !(items.length === 1 && items[0] === ''))
}

function gridToTable(grid) {
  if (!grid.length) return { columns: [], rows: [] }
  const [header, ...body] = grid
  return {
    columns: header,
    rows: body.map(items => header.map((_column, index) => items[index] ?? ''))
  }
}

async function readTable(target) {
  try {
    return gridToTable(parseCsv(await readFile(target, 'utf8')))
  } catch {
    return null
  }
}

const TABLE_LABEL = {
  table1_descriptives: '表 1 描述统计',
  table2_availability: '表 2 数据可用性',
  table3_qc: '表 3 质控',
  table4_change: '表 4 T2 − T0 变化',
  table5_ancova_auc: '表 5 主分析 ANCOVA',
  table6_simple_effects: '表 6 简单效应',
  table7_adjusted_means: '表 7 调整均值',
  table8_ancova_lnk: '表 8 敏感性 ln(k)',
  table9_missing: '表 9 缺失与完成',
  table10_completion: '表 10 完成率与超时',
  table11_distribution: '表 11 分布特征',
  table12_reliability: '表 12 FTPS 信度',
  table13_balance: '表 13 基线平衡',
  table14_nonsystematic: '表 14 非系统折扣',
  table15_prepilot: '表 15 预实验 DTA',
  table16_stai_change: '表 16 STAI-S 变化',
  table17_ftps_lmm: '表 17 FTPS 混合模型',
  table18_mediation: '表 18 中介分析',
  table19_trait_anxiety: '表 19 特质焦虑',
  table20_sensitivity: '表 20 ITT/PP 敏感性'
}

/* ------------------------------------------------------------------ *
 * python
 * ------------------------------------------------------------------ */

function runPython(cfg, args, timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cfg.pythonPath, ['-X', 'utf8', path.join(HERE, 'pipeline.py'), ...args], {
        cwd: HERE,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          DDT_GATE_EXPLORE: String(cfg.gateExplore),
          DDT_GATE_MAIN: String(cfg.gateMain)
        }
      })
    } catch (error) {
      resolve({ ok: false, error: `无法启动 python：${error && error.message ? error.message : error}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `分析超时（${Math.round(timeoutMs / 1000)}s），已中止` })
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => finish({ ok: false, error: `python 启动失败：${error && error.message ? error.message : error}` }))
    child.on('close', code => {
      const marker = stdout.lastIndexOf('===JSON===')
      if (marker === -1) {
        finish({
          ok: false,
          error: (stderr || stdout || `python 退出码 ${code}`).trim().slice(0, 800)
        })
        return
      }
      const tail = stdout.slice(marker + '===JSON==='.length).trim()
      try {
        finish(JSON.parse(tail))
      } catch {
        finish({ ok: false, error: '分析输出不是合法 JSON：' + tail.slice(0, 300) })
      }
    })
  })
}

async function pythonReady(cfg) {
  if (!(await exists(cfg.pythonPath))) {
    return {
      ok: false,
      error: `找不到 python：${cfg.pythonPath}。在插件配置里把 pythonPath 指向装了 pandas / statsmodels 的解释器。`
    }
  }
  const probe = await runPython(cfg, ['--stage', 'status', '--json'], 60000)
  if (!probe.ok) return { ok: false, error: probe.error }
  return { ok: true, python: cfg.pythonPath, payload: probe }
}

/* ------------------------------------------------------------------ *
 * plugin
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const runsDir = path.join(cfg.labDir, 'runs')
  const cacheDir = path.join(cfg.labDir, 'cache')
  const exclusionsPath = path.join(cfg.labDir, 'exclusions.csv')

  let busy = null
  let lock = null

  /* ---------------------------- reads ---------------------------- */

  async function listRuns(limit = 20) {
    let names = []
    try {
      names = (await readdir(runsDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .reverse()
    } catch {
      return []
    }
    const runs = []
    for (const name of names.slice(0, limit)) {
      const meta = await readJson(path.join(runsDir, name, 'meta.json'), null)
      if (!meta) continue
      runs.push({
        runId: meta.runId || name,
        startedAt: meta.startedAt,
        finishedAt: meta.finishedAt,
        status: meta.status,
        stages: meta.stages,
        n: meta.n,
        dataCutoff: meta.dataCutoff,
        gate: meta.model && meta.model.gate ? meta.model.gate.level : null,
        changed: meta.changedSinceLast || null,
        ms: meta.ms
      })
    }
    return runs
  }

  async function readExclusions() {
    try {
      const grid = parseCsv(await readFile(exclusionsPath, 'utf8'))
      if (!grid.length) return []
      const { columns, rows } = gridToTable(grid)
      if (!columns.includes('编号')) return []
      return rows.map(items => {
        const record = {}
        columns.forEach((column, index) => {
          record[column] = items[index]
        })
        return record
      })
    } catch {
      return []
    }
  }

  async function writeExclusions(items) {
    await mkdir(cfg.labDir, { recursive: true })
    const header = '编号,原因,时间,操作'
    const lines = items.map(item => [item['编号'], item['原因'], item['时间'], item['操作']]
      .map(value => {
        const text = String(value ?? '')
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
      }).join(','))
    await writeFile(exclusionsPath, '\ufeff' + [header, ...lines].join('\r\n') + '\r\n', 'utf8')
  }

  async function statusPayload() {
    const probe = await runPython(cfg, ['--stage', 'status', '--json'], 120000)
    const runs = await listRuns()
    const last = runs[0] || null
    const lastMeta = last ? await readJson(path.join(runsDir, last.runId, 'meta.json'), null) : null
    return {
      lastRun: last,
      lastMeta: lastMeta
        ? {
            n: lastMeta.n,
            changed: lastMeta.changedSinceLast,
            warnings: lastMeta.warnings || [],
            failures: lastMeta.failures || [],
            qc: lastMeta.qc || null,
            gate: lastMeta.model && lastMeta.model.gate ? lastMeta.model.gate : null,
            byCell: lastMeta.nByCell || null
          }
        : null,
      runs,
      newFiles: probe.ok !== false ? probe.newFiles || [] : [],
      newFileCount: probe.ok !== false ? probe.newFileCount || 0 : 0,
      rawFileCount: probe.ok !== false ? probe.rawFileCount || 0 : 0,
      cache: probe.ok !== false ? probe.cache : { trials: false, auc: false },
      exclusions: await readExclusions(),
      stages: STAGES.map(stage => ({ id: stage, label: STAGE_LABEL[stage] })),
      paths: { labDir: cfg.labDir, rawDir: cfg.rawDir, runsDir, python: cfg.pythonPath },
      python: { ok: probe.ok !== false, error: probe.ok === false ? probe.error : null },
      pipelineVersion: probe.ok !== false ? probe.pipelineVersion : null,
      tables: Object.entries(TABLE_LABEL).map(([id, label]) => ({ id, label })),
      busy
    }
  }

  async function resultsPayload(runId) {
    const runs = await listRuns(40)
    const target = runId || (runs[0] && runs[0].runId)
    if (!target) return { runId: null, runs, tables: [], report: null, figures: [], meta: null }
    const runDir = path.join(runsDir, target)
    const meta = await readJson(path.join(runDir, 'meta.json'), null)
    if (!meta) throw new RouteError('not_found', `没有这次运行：${target}`)
    const tables = []
    for (const [key, label] of Object.entries(TABLE_LABEL)) {
      const table = await readTable(path.join(runDir, 'tables', `${key}.csv`))
      if (table) tables.push({ key, label, ...table })
    }
    let report = null
    try {
      report = await readFile(path.join(runDir, 'report.md'), 'utf8')
    } catch {
      report = null
    }
    let figures = []
    try {
      figures = (await readdir(runDir))
        .filter(name => /\.png$/i.test(name))
        .map(name => ({ name, url: `${ROUTE}?action=figure&run=${encodeURIComponent(target)}&name=${encodeURIComponent(name)}` }))
    } catch {
      figures = []
    }
    return { runId: target, runs, meta, tables, report, figures }
  }

  async function runStage(stage, requestedRun) {
    if (lock) throw new RouteError('busy', '已经有一次分析在跑，等它结束再点')
    const ok = await pythonReady(cfg)
    if (!ok.ok) throw new RouteError('python', ok.error)
    lock = { stage, startedAt: new Date().toISOString() }
    busy = { stage, startedAt: lock.startedAt }
    try {
      const args = ['--stage', stage, '--json', '--project-root', cfg.projectRoot, '--lab-dir', cfg.labDir,
        '--raw-dir', cfg.rawDir]
      if (stage !== 'all') {
        // 单跑一个阶段：并进那一次运行（面板给的那次，否则最近一次），保留数据集与表格
        let runId = /^[\w-]{6,40}$/.test(String(requestedRun || '')) ? String(requestedRun) : ''
        if (!runId) {
          const latest = await listRuns(1)
          runId = latest.length ? latest[0].runId : ''
        }
        if (runId) args.push('--run-id', runId)
      }
      const payload = await runPython(cfg, args)
      if (!payload.ok) {
        throw new RouteError('run_failed', payload.error || (payload.failures && payload.failures[0] && payload.failures[0].error) || '分析失败')
      }
      return payload
    } finally {
      lock = null
      busy = null
    }
  }

  async function figureFile(runId, name) {
    if (!/^[\w.-]+\.png$/i.test(String(name || ''))) throw new RouteError('invalid', '文件名不合法')
    if (!/^[\w-]{6,40}$/.test(String(runId || ''))) throw new RouteError('invalid', 'runId 不合法')
    const target = path.join(runsDir, runId, name)
    if (!(await exists(target))) throw new RouteError('not_found', '没有这张图')
    return target
  }

  /* ---------------------------- actions ---------------------------- */

  const actions = {
    async status() {
      return statusPayload()
    },
    async results(query) {
      return resultsPayload(String((query && query.run) || ''))
    },
    async run(payload) {
      const stage = String((payload && payload.stage) || 'all')
      if (stage !== 'all' && !STAGES.includes(stage)) throw new RouteError('invalid', `未知阶段：${stage}`)
      const result = await runStage(stage, payload && payload.runId)
      return {
        runId: result.runId,
        runDir: result.runDir,
        stages: result.stages,
        n: result.n,
        gate: result.gate,
        report: result.report,
        tables: result.tables,
        changed: result.changed,
        failures: result.failures,
        summaryText: result.summaryText,
        ms: result.ms
      }
    },
    async exclude(payload) {
      const op = String((payload && payload.op) || 'add')
      const id = String((payload && payload.id) || '').trim()
      if (!isId(id)) throw new RouteError('invalid', '被试编号应为 5 位数字')
      const items = await readExclusions()
      const rest = items.filter(item => String(item['编号'] || '').trim() !== id)
      if (op === 'remove') {
        await writeExclusions(rest)
        return { id, removed: true, items: await readExclusions() }
      }
      const reason = String((payload && payload.reason) || '').trim()
      if (!reason) throw new RouteError('invalid', '排除必须写理由：排除规则由人定，脚本只执行')
      rest.push({ 编号: id, 原因: reason, 时间: new Date().toISOString().slice(0, 10), 操作: '面板' })
      await writeExclusions(rest)
      return { id, reason, items: await readExclusions() }
    },
    async reveal(payload) {
      const runId = String((payload && payload.run) || '')
      const dir = /^[\w-]{6,40}$/.test(runId) ? path.join(runsDir, runId) : cfg.labDir
      await mkdir(dir, { recursive: true }).catch(() => {})
      const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
      child.unref()
      return { opened: dir }
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || ROUTE, 'http://localhost')
    // <img> 带不了自定义头：图片只读、同源，按 sameOrigin 单独放行
    const isFigure = req.method === 'GET' && url.searchParams.get('action') === 'figure'
    if (!sameOrigin(req) || (!isFigure && req.headers[HEADER] !== '1')) {
      send(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝跨站访问分析接口' } })
      return
    }
    try {
      if (req.method === 'GET') {
        const action = url.searchParams.get('action') || 'status'
        if (action === 'figure') {
          const target = await figureFile(url.searchParams.get('run'), url.searchParams.get('name'))
          const body = await readFile(target)
          res.statusCode = 200
          res.setHeader('content-type', 'image/png')
          res.setHeader('content-length', String(body.length))
          res.setHeader('cache-control', 'no-cache')
          res.end(body)
          return
        }
        const run = actions[action]
        if (!run) throw new RouteError('unknown_action', '未知操作：' + action)
        const data = await run(Object.fromEntries(url.searchParams.entries()))
        send(res, 200, { ok: true, data })
        return
      }
      if (req.method !== 'POST') throw new RouteError('method', '只接受 GET 与 POST')
      const body = await readBody(req)
      const action = String(body.action || url.searchParams.get('action') || '')
      const run = actions[action]
      if (!run) throw new RouteError('unknown_action', '未知操作：' + action)
      const data = await run(body.payload || body || {})
      send(res, 200, { ok: true, data })
    } catch (error) {
      const status = error instanceof RouteError ? (error.code === 'not_found' ? 404 : 400) : 500
      if (status >= 500) console.error('[analysis-run]', error)
      send(res, status, {
        ok: false,
        error: {
          code: error && error.code ? error.code : 'error',
          message: String(error && error.message ? error.message : error)
        }
      })
    }
  }

  const webServer = ctx.get ? ctx.get('webServer') : undefined
  if (webServer) {
    ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'analysis-run: http route')
  } else {
    ctx.inject(['webServer'], scope => {
      scope.effect(
        () => scope.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
        'analysis-run: http route'
      )
    })
  }

  /* ---------------------------- tools ---------------------------- */

  const textOutput = {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  }

  function gateLine(gate) {
    if (!gate) return '门禁：还没跑过模型阶段。'
    return `门禁：${gate.text || gate.level}`
  }

  const registerTools = scope => {
    try {
      if (!scope.tools || typeof scope.tools.register !== 'function') return

      scope.tools.register({
        name: 'analysis_status',
        description: '查看 DDT 分析直通的状态：上次运行（runId、n、数据截止、门禁）、新到的原始文件、缓存与排除名单。只读，不改数据。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput,
        async execute() {
          const status = await statusPayload()
          const last = status.lastRun
          const lines = []
          if (!last) {
            lines.push('还没有运行过分析。点了「全部」或调用 analysis_run 才会生成第一次结果。')
          } else {
            lines.push(`上次运行：${last.runId}（${last.startedAt || ''}${last.ms ? '，' + Math.round(last.ms / 1000) + ' s' : ''}）`)
            lines.push(`n = ${last.n ?? '?'}，数据截止 ${last.dataCutoff || '?'}；阶段：${(last.stages || []).join(' → ')}`)
            lines.push(gateLine(status.lastMeta && status.lastMeta.gate))
            const changed = (status.lastMeta && status.lastMeta.changed) || last.changed
            if (changed && changed.newSubjects && changed.newSubjects.length) {
              lines.push(`比上次新增被试：${changed.newSubjects.join('、')}`)
            }
            if (changed && changed.interactionP) {
              const p = changed.interactionP
              lines.push(`关键检验 p：${p.before} → ${p.now}`)
            }
            const qc = status.lastMeta && status.lastMeta.qc
            if (qc) {
              lines.push(`质控：${qc.n_trials} 试次 / ${qc.n_points} 个无差异点；异常格 ${qc.bad_cells}，缺失 IP ${qc.missing_ip}，k 在边界 ${qc.k_at_bound}；超时 ${qc.timeout_trials} 试次`)
            }
          }
          lines.push(`原始文件 ${status.rawFileCount} 个，新到 ${status.newFileCount} 个${status.newFileCount ? '（' + status.newFiles.slice(0, 6).join('、') + (status.newFiles.length > 6 ? ' 等' : '') + '）' : ''}。`)
          lines.push(`缓存：${status.cache.trials ? '有' : '无'}逐试次长表 / ${status.cache.auc ? '有' : '无'} AUC 宽表。排除名单 ${status.exclusions.length} 人。`)
          if (!status.python.ok) lines.push(`python 不可用：${status.python.error}`)
          return { text: lines.join('\n') }
        }
      })

      scope.tools.register({
        name: 'analysis_run',
        description: '跑 DDT 分析直通管线。stage=all 依次跑五个阶段；也可以单跑 ingest / derive / merge / model / report。完成后返回 runId、n、门禁结论与结果位置。结果写在 _lab/runs/<runId>/。',
        parameters: {
          type: 'object',
          properties: {
            stage: {
              type: 'string',
              enum: ['all', 'ingest', 'derive', 'merge', 'model', 'report'],
              description: 'all=五阶段全跑；单阶段只重算那一步（缓存键不够时会提示先跑前一步）'
            }
          },
          additionalProperties: false
        },
        output: textOutput,
        async execute(args) {
          const stage = String((args && args.stage) || 'all')
          if (stage !== 'all' && !STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`)
          const result = await runStage(stage)
          const lines = [result.summaryText, '', `结果目录：${result.runDir}`]
          if (result.tables && result.tables.length) lines.push(`三线表：${result.tables.length} 张（tables/）`)
          if (result.report) lines.push(`报告：${result.report}`)
          return { text: lines.join('\n') }
        }
      })

      scope.tools.register({
        name: 'analysis_results',
        description: '读某次分析的三线表与结论。不传 runId 时读最近一次。返回描述统计、质控、主分析（若门禁已开）等表格的文本。',
        parameters: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: '运行编号（形如 20261029-012138）；不填则用最近一次' },
            table: { type: 'string', description: '只看某张表，如 table1_descriptives；不填则给全部' }
          },
          additionalProperties: false
        },
        output: textOutput,
        async execute(args) {
          const payload = await resultsPayload(String((args && args.runId) || '').trim())
          if (!payload.runId) return { text: '还没有任何分析结果：先调用 analysis_run。' }
          const only = String((args && args.table) || '').trim()
          const lines = [`运行 ${payload.runId}：n = ${payload.meta && payload.meta.n}，数据截止 ${payload.meta && payload.meta.dataCutoff}`]
          const gate = payload.meta && payload.meta.model && payload.meta.model.gate
          if (gate) lines.push(gateLine(gate))
          for (const table of payload.tables) {
            if (only && table.key !== only) continue
            lines.push('', `## ${table.label}`)
            lines.push('| ' + table.columns.join(' | ') + ' |')
            lines.push('|' + table.columns.map(() => '---').join('|') + '|')
            for (const row of table.rows.slice(0, 40)) lines.push('| ' + row.join(' | ') + ' |')
            if (table.rows.length > 40) lines.push(`（还有 ${table.rows.length - 40} 行，见 ${path.join(cfg.labDir, 'runs', payload.runId, 'tables', table.key + '.csv')}）`)
          }
          if (!only && payload.report) {
            const summary = payload.report.split('\n').filter(line => line.startsWith('- ') || line.startsWith('## ')).slice(0, 12)
            lines.push('', '## 报告要点', ...summary)
          }
          if (payload.meta && payload.meta.changedSinceLast && payload.meta.changedSinceLast.newSubjects) {
            lines.push('', `比上次新增：${payload.meta.changedSinceLast.newSubjects.join('、') || '无'}`)
          }
          return { text: lines.join('\n') }
        }
      })

      scope.tools.register({
        name: 'analysis_exclude',
        description: '维护排除名单 _lab/exclusions.csv。排除规则必须人定：add 必须给理由；remove 把该编号移出名单。改完名单后要重跑合并（analysis_run stage=merge 或 all）才会进入结果。',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'remove'], description: 'add=加入排除；remove=恢复' },
            id: { type: 'string', description: '被试编号（5 位数字）' },
            reason: { type: 'string', description: '排除理由（add 必填），写进 _lab/exclusions.csv' }
          },
          required: ['op', 'id'],
          additionalProperties: false
        },
        output: textOutput,
        async execute(args) {
          const op = String((args && args.op) || 'add')
          const id = String((args && args.id) || '').trim()
          if (!isId(id)) throw new Error('被试编号应为 5 位数字')
          if (op === 'remove') {
            const items = (await readExclusions()).filter(item => String(item['编号'] || '').trim() !== id)
            await writeExclusions(items)
            return { text: `已把 ${id} 移出排除名单；当前排除 ${items.length} 人。重跑合并后生效。` }
          }
          const reason = String((args && args.reason) || '').trim()
          if (!reason) throw new Error('排除必须写理由：排除规则由人定，脚本只执行')
          const items = (await readExclusions()).filter(item => String(item['编号'] || '').trim() !== id)
          items.push({ 编号: id, 原因: reason, 时间: new Date().toISOString().slice(0, 10), 操作: '工具' })
          await writeExclusions(items)
          return { text: `已排除 ${id}（${reason}）；当前排除 ${items.length} 人。重跑合并后生效。` }
        }
      })
    } catch (error) {
      console.error('[analysis-run] 工具注册失败：', error)
    }
  }

  const tools = ctx.get ? ctx.get('tools') : undefined
  if (tools) registerTools({ tools })
  else ctx.inject(['tools'], registerTools)
}

export const name = 'analysis-run'
