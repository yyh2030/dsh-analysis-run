/**
 * HTTP 冒烟测试：起一个真的 http server，把插件的 handler 挂上去，验证
 * status / results / run / exclude / figure 五条路径与鉴权头。
 *
 * 跑法（插件目录）：
 *   node tests/http-smoke.mjs
 * 会真的跑一次 all（缓存热时一两秒），并在 _lab/exclusions.csv 里加一条再删掉。
 */

import http from 'node:http'
import { apply } from '../index.js'

const PROJECT_ROOT = process.env.DDT_PROJECT_ROOT || 'C:/Users/16787/OneDrive/Desktop/yyh硕士论文'
const LAB_DIR = process.env.DDT_LAB_DIR || 'D:/yyh-lab'
const PYTHON = process.env.DDT_PYTHON
  || 'C:/Users/16787/OneDrive/Desktop/yyh硕士论文/04_预实验数据与分析/.analysis_venv/Scripts/python.exe'

let handler = null
const ctx = {
  get(key) {
    if (key === 'webServer') return { register: () => () => {} }
    if (key === 'tools') return null
    return undefined
  },
  effect(fn) {
    fn()
    return () => {}
  },
  inject() {}
}

// 用一个假的 webServer 捕获 handler
const captured = {}
ctx.get = key => (key === 'webServer' ? { register: route => { captured.route = route; return () => {} } } : undefined)
apply(ctx, { projectRoot: PROJECT_ROOT, labDir: LAB_DIR, pythonPath: PYTHON })
handler = captured.route.handler

const server = http.createServer((req, res) => handler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const HEADERS = { 'x-analysis-run': '1' }

async function request(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: { ...HEADERS, origin: base, ...(options.headers || {}) }
  })
  const type = res.headers.get('content-type') || ''
  const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
  return { status: res.status, body, type }
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  console.error(`  FAIL ${name}${detail ? '：' + detail : ''}`)
  process.exitCode = 1
}

console.log('HTTP 冒烟测试')
const status = await request('/api/analysis-run?action=status')
check('status 200', status.status === 200, String(status.status))
check('status 载入最近运行', Boolean(status.body.data.lastRun), JSON.stringify(status.body).slice(0, 200))
check('status 有阶段与路径', status.body.data.stages.length === 5 && Boolean(status.body.data.paths.labDir))

const results = await request('/api/analysis-run?action=results')
check('results 200', results.status === 200)
check('results 有三线表', results.body.data.tables.length > 0, JSON.stringify(results.body.data.tables.length))
check('results 的 CSV 表头无 BOM', !String(results.body.data.tables[0].columns[0]).startsWith('\uFEFF'))

const run = await request('/api/analysis-run?action=run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'run', payload: { stage: 'all' } })
})
check('run 200', run.status === 200, JSON.stringify(run.body).slice(0, 300))
check('run 有 n', typeof run.body.data.n === 'number', JSON.stringify(run.body.data))

const denied = await fetch(base + '/api/analysis-run?action=status', { headers: { origin: 'http://evil.example' } })
check('跨站被拒', denied.status === 403)

const noHeader = await fetch(base + '/api/analysis-run?action=status')
check('缺少自定义头被拒', noHeader.status === 403)

const exclude = await request('/api/analysis-run?action=exclude', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'exclude', payload: { op: 'add', id: '99999', reason: '冒烟测试' } })
})
check('exclude add 200', exclude.status === 200, JSON.stringify(exclude.body).slice(0, 200))
check('exclude 写进名单', (exclude.body.data.items || []).some(item => item['编号'] === '99999'))

const restore = await request('/api/analysis-run?action=exclude', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'exclude', payload: { op: 'remove', id: '99999' } })
})
check('exclude remove 200', restore.status === 200)
check('exclude 恢复后名单干净', !(restore.body.data.items || []).some(item => item['编号'] === '99999'))

const missing = await request('/api/analysis-run?action=exclude', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'exclude', payload: { op: 'add', id: '99999' } })
})
check('add 缺理由被拒', missing.status === 400)

const figures = run.body.data ? await request(`/api/analysis-run?action=results&run=${run.body.data.runId}`) : null
const figureName = figures && figures.body.data.figures.length ? figures.body.data.figures[0].name : null
if (figureName) {
  const figure = await request(`/api/analysis-run?action=figure&run=${run.body.data.runId}&name=${encodeURIComponent(figureName)}`)
  check('figure 是 PNG', figure.status === 200 && figure.type.includes('image/png') && figure.body.length > 1000)
} else {
  check('figure 存在', false, '这次运行没有图')
}

const traversal = await request(`/api/analysis-run?action=figure&run=${run.body.data.runId}&name=..%2F..%2Fmeta.json`)
check('路径穿越被拒', traversal.status === 400)

server.close()
console.log(process.exitCode ? '有失败' : '全部通过')
