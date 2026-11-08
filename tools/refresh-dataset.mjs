/**
 * 刷新分析数据：把最新的行为/问卷数据合并成分析数据集，更新方案，重跑分析并导出。
 *
 * 用法（在任意目录）：
 *   node "D:\dsh-plugins\analysis-run\tools\refresh-dataset.mjs"            # 合并 → 有新数据则更新并重跑
 *   node "...\refresh-dataset.mjs" --dry-run                                 # 只合并、只报告，不改方案、不重跑
 *   node "...\refresh-dataset.mjs" --force                                   # 数据没变也重跑一次分析
 *
 * 行为：
 *   1. 在临时目录复制一份最小研究状态（人口学/分数/排除/缓存），用私有管道跑 --stage all；
 *      源数据（DDT/IDM、D:\yyh-lab）不被修改。
 *   2. 比较新合并数据与当前冻结数据的 sha256；没变就停（除非 --force）。
 *   3. 变了就：复制成新冻结文件 → 备份并更新 plan.json 的 dataPath → 重跑分析 → 导出报告。
 * 输出：一行 JSON 摘要（n、数据集 hash、runId、导出 revision、统计量）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STUDY = 'D:/dsh-research-upgrade/20261030-1103/private/study.json'
const ANALYSIS_DIR = 'D:/yyh-lab/analysis'
const MERGED_DIR = path.join(ANALYSIS_DIR, 'merged')
const CORE = 'D:/dsh-plugins/research-core'
const PLUGIN = 'D:/dsh-plugins/analysis-run'
const flags = new Set(process.argv.slice(2))
const dryRun = flags.has('--dry-run')
const force = flags.has('--force')
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const readJsonOr = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }

function fail(message, detail) {
  console.error(`刷新失败：${message}`)
  if (detail) console.error(String(detail).slice(-2000))
  process.exit(1)
}

const study = readJson(STUDY)
const legacy = study.plugins?.analysisLegacy || {}
const projectRoot = legacy.projectRoot
const rawDir = legacy.rawDir
if (!projectRoot || !rawDir) fail('study.json 里缺少 analysisLegacy.projectRoot / rawDir', JSON.stringify(legacy))

const python = process.env.DSH_REFRESH_PYTHON || legacy.pythonPath
if (!python || !existsSync(python)) fail('找不到私有管道解释器（analysisLegacy.pythonPath）', python)
// 分析运行用通用分析的解释器（DSH 运行时），不要用私有 venv，否则环境锁会漂移。
const analysisPython = study.plugins?.analysis?.pythonPath || process.env.DSH_ANALYSIS_PYTHON || python
const pipeline = path.join(path.dirname(legacy.adapterPath || ''), 'pipeline.py')
if (!existsSync(pipeline)) fail('找不到私有管道 pipeline.py', pipeline)

// 有分析在跑就不动
const runsDir = path.join(ANALYSIS_DIR, 'runs')
if (existsSync(runsDir)) {
  const running = readdirSync(runsDir).filter(name => readJsonOr(path.join(runsDir, name, 'meta.json'), {})?.status === 'running')
  if (running.length) fail('有分析正在运行，稍后再试', running.join(', '))
}

// 1) 临时工作区：只复制管道需要的输入，源目录不改
const work = mkdtempSync(path.join(os.tmpdir(), 'yyh-refresh-'))
const inputs = ['demographics.json', 'scores.csv', 'scores_detail.csv', 'scores-manifest.json', 'state.json', 'schedule.json', 'exclusions.csv', 'ops-adapter-state.json']
for (const name of inputs) {
  const source = path.join('D:/yyh-lab', name)
  if (existsSync(source)) copyFileSync(source, path.join(work, name))
}
for (const dir of ['cache', 'scales']) {
  const source = path.join('D:/yyh-lab', dir)
  if (existsSync(source)) spawnSync('cmd', ['/c', 'xcopy', source.replace(/\//g, '\\'), path.join(work, dir), '/E', '/I', '/Q', '/Y'], { windowsHide: true })
}

const env = { ...process.env, DDT_GATE_EXPLORE: String(legacy.gateExplore ?? 12), DDT_GATE_MAIN: String(legacy.gateMain ?? 12) }
const pipelineResult = spawnSync(python, [pipeline, '--stage', 'all', '--json', '--project-root', projectRoot, '--lab-dir', work.replace(/\\/g, '/'), '--raw-dir', rawDir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
const marker = String(pipelineResult.stdout || '').lastIndexOf('===JSON===')
if (marker < 0) fail('私有管道没有返回结果', (pipelineResult.stderr || pipelineResult.stdout || '').slice(-2000))
const pipelineJson = JSON.parse(pipelineResult.stdout.slice(marker + 10).trim())
if (!pipelineJson.ok) fail('私有管道运行失败', JSON.stringify(pipelineJson.failures || pipelineJson.error || pipelineJson).slice(0, 2000))
const dataset = path.join(pipelineJson.runDir, 'dataset.csv')
if (!existsSync(dataset)) fail('管道没有产出 dataset.csv', pipelineJson.runDir)
const datasetHash = sha(dataset)
const datasetRows = readFileSync(dataset, 'utf8').trim().split(/\r?\n/).length - 1

// 2) 与当前冻结数据比较
const planPath = path.join(ANALYSIS_DIR, 'plan.json')
const plan = readJsonOr(planPath, null)
const currentDataPath = plan?.dataPath ? String(plan.dataPath).replace(/\\/g, '/') : ''
const currentHash = currentDataPath && existsSync(currentDataPath) ? sha(currentDataPath) : null
const changed = datasetHash !== currentHash

if (dryRun) {
  rmSync(work, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, dryRun: true, n: pipelineJson.n, datasetRows, datasetHash: datasetHash.slice(0, 16), changed, currentHash: currentHash ? currentHash.slice(0, 16) : null }, null, 2))
  process.exit(0)
}
if (!changed && !force) {
  rmSync(work, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, changed: false, message: '合并数据与当前分析数据一致，没有新数据；分析未重跑', n: pipelineJson.n, datasetHash: datasetHash.slice(0, 16) }, null, 2))
  process.exit(0)
}

// 3) 冻结新数据集 + 更新方案（旧数据集与旧方案都保留）
mkdirSync(MERGED_DIR, { recursive: true })
const frozen = path.join(MERGED_DIR, `dataset-${datasetHash.slice(0, 12)}.csv`)
if (!existsSync(frozen)) copyFileSync(dataset, frozen)
const backupPlan = path.join(ANALYSIS_DIR, `plan-before-refresh-${new Date().toISOString().slice(0, 10)}.json`)
if (existsSync(planPath)) copyFileSync(planPath, backupPlan)
const nextPlan = { ...(plan || {}), dataPath: frozen.replace(/\\/g, '/') }
writeFileSync(planPath, JSON.stringify(nextPlan, null, 2) + '\n', 'utf8')

// 4) 用真实输出目录重跑分析并导出
const { loadPlugin, makeHost, request, pageHeaders } = await import('file:///' + CORE + '/tests/harness.mjs')
const host = makeHost({ workspaces: [], sessions: {}, cwd: process.cwd() })
const plugin = await loadPlugin(PLUGIN)
plugin.apply(host.ctx, { studyPath: STUDY, pythonPath: analysisPython, labDir: ANALYSIS_DIR })
const handler = host.routes.get('/api/analysis-run')
const post = (action, payload) => request(handler, { method: 'POST', path: '/api/analysis-run', headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders('page-refresh-1') }, body: { action, payload } })
const connected = await post('studyConnect', { studyPath: STUDY })
const token = connected.json?.data?.binding?.token
if (!token) fail('连接研究失败', connected.text)
const run = await post('run', { plan: nextPlan, stage: 'all', binding: token })
if (!run.json?.data?.meta) fail('分析运行失败', run.text)
const meta = run.json.data.meta
const runId = run.json.data.runId
const regression = meta.nodes?.regression?.result
const interaction = regression?.anova?.find(row => /salience/.test(row.term) && /intervention/.test(row.term))
let exported = null
if (flags.has('--export') || true) {
  const result = await post('export', { runId, binding: token })
  exported = result.json?.data?.revision || null
}

rmSync(work, { recursive: true, force: true })
console.log(JSON.stringify({
  ok: true,
  changed,
  n: meta.subjects,
  dataset: { file: path.basename(frozen), hash: datasetHash.slice(0, 16), rows: datasetRows },
  previous: { file: currentDataPath ? path.basename(currentDataPath) : null, hash: currentHash ? currentHash.slice(0, 16) : null },
  runId,
  exportRevision: exported,
  stats: interaction ? { F: interaction.F, p: interaction.p, partialEtaSquared: interaction.partialEtaSquared } : null,
  planBackup: backupPlan,
}, null, 2))
