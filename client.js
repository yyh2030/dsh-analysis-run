/**
 * analysis-run — browser half.
 *
 * 一个面板：上次运行与门禁、单跑阶段、三线表、报告、图、运行历史、排除名单。
 * 数据全部来自 Host 路由；页面自己不读数据目录。
 */
window.__ModuleLoader__.load({
  id: '@local/analysis-run',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/analysis-run'

    async function call(action, payload, query) {
      let url = API + '?action=' + encodeURIComponent(action)
      if (query) {
        const qs = new URLSearchParams(query).toString()
        if (qs) url += '&' + qs
      }
      const init = { headers: { 'x-analysis-run': '1' } }
      if (payload !== undefined) {
        init.method = 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify({ action, payload })
      }
      const res = await fetch(url, init)
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        throw new Error((json.error && json.error.message) || 'HTTP ' + res.status)
      }
      return json.data
    }

    /* ================================================================ *
     * styles
     * ================================================================ */

    const CSS = `
.ar-root{--ar-bg:var(--dsw-alias-bg-base,#fff);--ar-panel:var(--dsw-alias-bg-layer-1,#f7f7f8);--ar-raised:var(--dsw-alias-bg-layer-2,#f1f2f4);--ar-line:var(--dsw-alias-border-l1,rgba(0,0,0,.09));--ar-line2:var(--dsw-alias-border-l2,rgba(0,0,0,.16));--ar-text:var(--dsw-alias-label-primary,#16181d);--ar-text2:var(--dsw-alias-label-secondary,#5b6068);--ar-brand:var(--dsw-alias-brand-primary,#3f5efb);--ar-ok:var(--dsw-alias-state-success-primary,#148a62);--ar-warn:var(--dsw-alias-state-warn-primary,#b7791f);--ar-bad:var(--dsw-alias-state-error-primary,#c0392b);display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ar-bg);color:var(--ar-text);font-size:13px;line-height:1.55;overflow:hidden}
.ar-root *{box-sizing:border-box}
.ar-top{display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;border-bottom:1px solid var(--ar-line);flex:none}
.ar-brand{display:flex;align-items:baseline;gap:8px;min-width:0}
.ar-brand strong{font-size:14px;font-weight:650;white-space:nowrap}
.ar-brand span{font-size:11.5px;color:var(--ar-text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:44ch}
.ar-top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.ar-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid transparent;font-size:12.5px;cursor:pointer;white-space:nowrap;background:transparent;color:var(--ar-text);font-family:inherit}
.ar-btn:disabled{opacity:.55;cursor:default}
.ar-btn-primary{background:var(--ar-brand);color:var(--dsw-alias-bg-base,#fff)}
.ar-btn-ghost{color:var(--ar-text2)}
.ar-btn-ghost:hover:not(:disabled){background:var(--ar-raised);color:var(--ar-text)}
.ar-btn-outline{background:var(--ar-bg);border-color:var(--ar-line2)}
.ar-btn-outline:hover:not(:disabled){background:var(--ar-raised)}
.ar-btn-sm{height:24px;padding:0 9px;font-size:11.5px;border-radius:6px}
.ar-scroll{flex:1;min-height:0;overflow:auto;padding:16px 16px 40px}
.ar-card{border:1px solid var(--ar-line);border-radius:14px;background:var(--ar-panel);padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.ar-head{display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap}
.ar-big{font-size:30px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.ar-big small{font-size:13px;font-weight:500;color:var(--ar-text2);margin-left:4px;letter-spacing:0}
.ar-meta{display:flex;flex-wrap:wrap;gap:14px;color:var(--ar-text2);font-size:12px}
.ar-meta b{color:var(--ar-text);font-weight:600;font-variant-numeric:tabular-nums}
.ar-cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.ar-cell{border:1px solid var(--ar-line);border-radius:10px;background:var(--ar-bg);padding:9px 11px;display:flex;flex-direction:column;gap:4px;min-width:0}
.ar-cell-code{font-weight:650;font-size:12.5px}
.ar-cell-n{font-size:11.5px;color:var(--ar-text2);font-variant-numeric:tabular-nums}
.ar-alert{display:flex;gap:8px;align-items:flex-start;padding:8px 11px;border-radius:9px;font-size:12px;border:1px solid transparent}
.ar-alert-warn{color:var(--ar-warn);background:color-mix(in oklab,var(--ar-warn) 8%,transparent);border-color:color-mix(in oklab,var(--ar-warn) 25%,transparent)}
.ar-alert-bad{color:var(--ar-bad);background:color-mix(in oklab,var(--ar-bad) 8%,transparent);border-color:color-mix(in oklab,var(--ar-bad) 25%,transparent)}
.ar-alert-info{color:var(--ar-text2);background:var(--ar-bg);border-color:var(--ar-line)}
.ar-stages{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px solid var(--ar-line);padding-top:12px}
.ar-stage{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 10px;border-radius:999px;border:1px solid var(--ar-line);background:var(--ar-bg);color:var(--ar-text2);font-size:11.5px;cursor:pointer;font-family:inherit}
.ar-stage:hover:not(:disabled){border-color:var(--ar-line2);color:var(--ar-text);background:var(--ar-raised)}
.ar-stage:disabled{opacity:.55;cursor:default}
.ar-stage.is-done{color:var(--ar-text);border-color:color-mix(in oklab,var(--ar-ok) 35%,var(--ar-line))}
.ar-stage i{font-style:normal;font-size:10.5px;color:var(--ar-ok);font-variant-numeric:tabular-nums}
.ar-tabs{display:flex;align-items:center;gap:6px;margin:16px 0 10px;flex-wrap:wrap}
.ar-tab{height:28px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--ar-text2);font-size:12.5px;cursor:pointer;font-family:inherit}
.ar-tab:hover{background:var(--ar-raised);color:var(--ar-text)}
.ar-tab.is-active{background:var(--ar-raised);border-color:var(--ar-line);color:var(--ar-text);font-weight:600}
.ar-chip{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--ar-line);background:var(--ar-bg);color:var(--ar-text2);font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-family:inherit}
.ar-chip.is-active{color:var(--ar-text);border-color:var(--ar-line2);background:var(--ar-raised);font-weight:600}
.ar-table-wrap{border:1px solid var(--ar-line);border-radius:12px;overflow:auto;background:var(--ar-bg)}
.ar-table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
.ar-table caption{caption-side:top;text-align:left;padding:10px 12px 6px;font-size:12px;color:var(--ar-text2)}
.ar-table th{text-align:left;padding:8px 11px;border-top:1.5px solid var(--ar-text);border-bottom:1px solid var(--ar-text);font-weight:600;font-size:11.5px;white-space:nowrap;background:var(--ar-bg)}
.ar-table td{padding:6px 11px;white-space:nowrap;border-bottom:1px solid var(--ar-line)}
.ar-table tbody tr:last-child td{border-bottom:1.5px solid var(--ar-text)}
.ar-table td.num{text-align:right}
.ar-note{font-size:11.5px;color:var(--ar-text2);margin-top:8px}
.ar-report{white-space:pre-wrap;font-size:12.5px;line-height:1.7;font-family:inherit;border:1px solid var(--ar-line);border-radius:12px;background:var(--ar-bg);padding:14px 16px;max-height:none;overflow:auto;margin:0}
.ar-figs{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.ar-fig{border:1px solid var(--ar-line);border-radius:12px;background:var(--ar-bg);padding:8px;display:flex;flex-direction:column;gap:6px}
.ar-fig img{width:100%;border-radius:8px;display:block}
.ar-fig span{font-size:11px;color:var(--ar-text2);font-family:ui-monospace,Consolas,monospace}
.ar-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ar-form input{height:30px;padding:0 9px;border:1px solid var(--ar-line);border-radius:7px;background:var(--ar-bg);color:var(--ar-text);font-size:12.5px;outline:none;font-family:inherit}
.ar-form input:focus{border-color:var(--ar-line2)}
.ar-form input.ar-id{width:96px;font-family:ui-monospace,Consolas,monospace}
.ar-form input.ar-reason{flex:1;min-width:220px}
.ar-list{display:flex;flex-direction:column;gap:6px}
.ar-row{display:grid;grid-template-columns:76px 74px minmax(0,1fr) auto;gap:12px;align-items:center;border:1px solid var(--ar-line);border-radius:9px;background:var(--ar-bg);padding:8px 11px;font-size:12px;cursor:pointer;font-family:inherit;text-align:left;color:inherit}
.ar-row:hover{background:var(--ar-raised)}
.ar-row-id{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.ar-row-n{font-variant-numeric:tabular-nums;color:var(--ar-text2);font-size:11.5px}
.ar-row-state{margin-left:auto;font-size:11px;color:var(--ar-text2)}
.ar-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;border:1px solid var(--ar-line2);font-size:10.5px;color:var(--ar-text2)}
.ar-tag-ok{color:var(--ar-ok);border-color:color-mix(in oklab,var(--ar-ok) 35%,transparent)}
.ar-tag-bad{color:var(--ar-bad);border-color:color-mix(in oklab,var(--ar-bad) 35%,transparent)}
.ar-empty{border:1px dashed var(--ar-line2);border-radius:14px;padding:34px 20px;text-align:center;color:var(--ar-text2);display:flex;flex-direction:column;align-items:center;gap:8px}
.ar-empty b{color:var(--ar-text);font-weight:600}
.ar-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ar-text);color:var(--ar-bg);padding:8px 14px;border-radius:999px;font-size:12px;z-index:5;box-shadow:0 6px 22px rgba(0,0,0,.18);max-width:70ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar-toast.is-bad{background:var(--ar-bad);color:#fff}
.ar-spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:ar-spin .8s linear infinite;display:inline-block}
@keyframes ar-spin{to{transform:rotate(360deg)}}
.ar-sroot{position:relative;display:flex;flex-direction:column;height:100%;min-height:0}
`

    function insertStyles() {
      const mark = 'analysis-run'
      if (document.querySelector('style[data-plugin-css="' + mark + '"]')) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = mark
      tag.dataset.pluginCss = mark
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ================================================================ *
     * small pieces
     * ================================================================ */

    const STAGE_SHORT = {
      ingest: '摄取',
      derive: '推导',
      merge: '合并',
      model: '模型',
      report: '报告'
    }

    function num(value) {
      return typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value ?? ''))
    }

    function when(text) {
      if (!text) return '—'
      const date = new Date(text)
      if (Number.isNaN(date.getTime())) return String(text)
      const pad = value => String(value).padStart(2, '0')
      return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function gateTag(level) {
      if (level === 'main') return h('span', { className: 'ar-tag ar-tag-ok' }, '主分析门槛已开')
      if (level === 'explore') return h('span', { className: 'ar-tag' }, '探索阶段')
      if (level === 'describe') return h('span', { className: 'ar-tag' }, '只出描述统计')
      return null
    }

    function Table({ table }) {
      const [expanded, setExpanded] = useState(false)
      const rows = expanded ? table.rows : table.rows.slice(0, 40)
      return h('div', { className: 'ar-table-wrap' },
        h('table', { className: 'ar-table' },
          h('caption', null, table.label),
          h('thead', null, h('tr', null, table.columns.map(column => h('th', { key: column }, column)))),
          h('tbody', null, rows.map((row, index) => h('tr', { key: index },
            row.map((cell, columnIndex) => h('td', {
              key: columnIndex,
              className: num(cell) ? 'num' : undefined
            }, cell === '' ? '—' : String(cell))))))
        ),
        table.rows.length > 40
          ? h('div', { className: 'ar-note' },
              h('button', {
                className: 'ar-btn ar-btn-ghost ar-btn-sm',
                onClick: () => setExpanded(value => !value)
              }, expanded ? '只看前 40 行' : `展开全部 ${table.rows.length} 行`))
          : null
      )
    }

    /* ================================================================ *
     * panel
     * ================================================================ */

    function Panel() {
      const [status, setStatus] = useState(null)
      const [results, setResults] = useState(null)
      const [tab, setTab] = useState('tables')
      const [tableKey, setTableKey] = useState('')
      const [activeRun, setActiveRun] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [toastState, setToastState] = useState(null)
      const toastTimer = useRef(null)

      const toast = useCallback((message, tone) => {
        setToastState({ message, tone: tone || 'ok' })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToastState(null), 3800)
      }, [])

      const load = useCallback(async (runId) => {
        setError('')
        try {
          const [nextStatus, nextResults] = await Promise.all([
            call('status'),
            call('results', undefined, runId ? { run: runId } : undefined)
          ])
          setStatus(nextStatus)
          setResults(nextResults)
          if (nextResults.runId) setActiveRun(nextResults.runId)
          setTableKey(current => {
            if (current && nextResults.tables.some(table => table.key === current)) return current
            return nextResults.tables.length ? nextResults.tables[0].key : ''
          })
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [])

      useEffect(() => {
        load()
        return () => clearTimeout(toastTimer.current)
      }, [load])

      const runStage = useCallback(async (stage) => {
        setBusy(stage)
        setError('')
        try {
          const out = await call('run', { stage, runId: stage === 'all' ? '' : activeRun })
          toast(`${stage === 'all' ? '五个阶段' : STAGE_SHORT[stage] || stage}跑完：${out.runId}，n = ${out.n ?? '?'}`, 'ok')
          await load(out.runId)
          if (stage === 'all' || stage === 'model') setTab('tables')
        } catch (err) {
          setError(String(err.message || err))
          toast('分析失败：' + String(err.message || err), 'bad')
        } finally {
          setBusy('')
        }
      }, [activeRun, load, toast])

      const exclude = useCallback(async (op, id, reason) => {
        try {
          await call('exclude', { op, id, reason })
          toast(op === 'remove' ? `已恢复 ${id}` : `已排除 ${id}`, 'ok')
          await load(activeRun)
        } catch (err) {
          toast(String(err.message || err), 'bad')
        }
      }, [activeRun, load, toast])

      const openDir = useCallback(async () => {
        try {
          const out = await call('reveal', { run: activeRun })
          toast('已打开 ' + out.opened)
        } catch (err) {
          toast(String(err.message || err), 'bad')
        }
      }, [activeRun, toast])

      const last = status && status.lastRun
      const meta = (results && results.meta) || null
      const gate = (meta && meta.model && meta.model.gate) || (status && status.lastMeta && status.lastMeta.gate) || null
      const nByCell = (meta && meta.nByCell) || (status && status.lastMeta && status.lastMeta.byCell) || {}
      const doneStages = {}
      if (meta && Array.isArray(meta.results)) {
        for (const item of meta.results) doneStages[item.stage] = item.ms
      }
      const stages = (status && status.stages) || Object.keys(STAGE_SHORT).map(id => ({ id, label: id }))

      return h('div', { className: 'ar-sroot' },
        h('div', { className: 'ar-top' },
          h('div', { className: 'ar-brand' },
            h('strong', null, '分析直通'),
            h('span', null, 'DDT 原始数据 → 无差异点 / AUC / k → 三线表')
          ),
          h('div', { className: 'ar-top-right' },
            busy ? h('span', { className: 'ar-note' }, h('span', { className: 'ar-spin' }), ' ', STAGE_SHORT[busy] || busy, ' 运行中…') : null,
            h('button', { className: 'ar-btn ar-btn-ghost', disabled: Boolean(busy), onClick: () => load(activeRun) }, '刷新'),
            h('button', {
              className: 'ar-btn ar-btn-outline',
              disabled: Boolean(busy),
              onClick: openDir
            }, '打开结果目录'),
            h('button', {
              className: 'ar-btn ar-btn-primary',
              disabled: Boolean(busy),
              onClick: () => runStage('all')
            }, busy === 'all' ? '运行中…' : '跑全部')
          )
        ),
        h('div', { className: 'ar-scroll' },
          error ? h('div', { className: 'ar-alert ar-alert-bad', style: { marginBottom: '12px' } }, error) : null,

          !status
            ? h('div', { className: 'ar-empty' }, h('b', null, '正在读 _lab…'), '第一次打开会读缓存与运行记录。')
            : h('div', { className: 'ar-card' },
                h('div', { className: 'ar-head' },
                  h('div', { className: 'ar-big' }, last ? (last.n ?? '—') : '—', h('small', null, '人进入分析')),
                  h('div', { className: 'ar-meta' },
                    h('span', null, '数据截止 ', h('b', null, (last && last.dataCutoff) || '—')),
                    h('span', null, '上次运行 ', h('b', null, last ? when(last.startedAt) : '还没有')),
                    h('span', null, '耗时 ', h('b', null, last && last.ms ? Math.round(last.ms / 1000) + ' s' : '—')),
                    h('span', null, '原始文件 ', h('b', null, status.rawFileCount ?? 0), ' 个')
                  ),
                  h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
                    gateTag(gate && gate.level),
                    status.newFileCount > 0
                      ? h('span', { className: 'ar-tag ar-tag-ok' }, `新到 ${status.newFileCount} 个文件`)
                      : null
                  )
                ),

                h('div', { className: 'ar-cells' },
                  Object.keys(nByCell).length
                    ? Object.keys(nByCell).sort().map(cell => h('div', { key: cell, className: 'ar-cell' },
                        h('div', { className: 'ar-cell-code' }, cell),
                        h('div', { className: 'ar-cell-n' }, `${nByCell[cell]} 人`)
                      ))
                    : h('div', { className: 'ar-cell' },
                        h('div', { className: 'ar-cell-code' }, '四格人数'),
                        h('div', { className: 'ar-cell-n' }, '跑一次才有'))
                ),

                !status.python.ok
                  ? h('div', { className: 'ar-alert ar-alert-bad' }, 'Python 不可用：', status.python.error)
                  : null,

                meta && meta.failures && meta.failures.length
                  ? h('div', { className: 'ar-alert ar-alert-bad' },
                      '上次运行有阶段失败：' + meta.failures.map(item => `${STAGE_SHORT[item.stage] || item.stage}（${item.error}）`).join('；'))
                  : null,

                meta && meta.warnings && meta.warnings.length
                  ? h('div', { className: 'ar-alert ar-alert-warn' }, '提醒：' + meta.warnings.slice(0, 4).join('；'))
                  : null,

                (meta && meta.changedSinceLast && meta.changedSinceLast.newSubjects && meta.changedSinceLast.newSubjects.length)
                  ? h('div', { className: 'ar-alert ar-alert-info' },
                      '比上一次新增被试：' + meta.changedSinceLast.newSubjects.join('、'))
                  : null,

                status.newFiles.length
                  ? h('div', { className: 'ar-alert ar-alert-info' },
                      `新到 ${status.newFiles.length} 个原始文件还没进缓存：` + status.newFiles.slice(0, 6).join('、') +
                      (status.newFiles.length > 6 ? ' 等' : '') + '。点「跑全部」即可纳入。')
                  : null,

                h('div', { className: 'ar-stages' },
                  h('span', { className: 'ar-note', style: { marginRight: '2px' } }, '单跑阶段：'),
                  stages.map(stage => h('button', {
                    key: stage.id,
                    className: 'ar-stage' + (doneStages[stage.id] ? ' is-done' : ''),
                    disabled: Boolean(busy),
                    title: stage.label,
                    onClick: () => runStage(stage.id)
                  },
                    STAGE_SHORT[stage.id] || stage.id,
                    doneStages[stage.id] ? h('i', null, Math.round(doneStages[stage.id] / 1000 * 10) / 10 + 's') : null
                  ))
                )
              ),

          results && results.runId
            ? h('div', { className: 'ar-tabs' },
                h('button', { className: 'ar-tab' + (tab === 'tables' ? ' is-active' : ''), onClick: () => setTab('tables') },
                  '三线表（' + results.tables.length + '）'),
                h('button', { className: 'ar-tab' + (tab === 'report' ? ' is-active' : ''), onClick: () => setTab('report') }, '报告'),
                h('button', { className: 'ar-tab' + (tab === 'figures' ? ' is-active' : ''), onClick: () => setTab('figures') }, '图'),
                h('button', { className: 'ar-tab' + (tab === 'exclude' ? ' is-active' : ''), onClick: () => setTab('exclude') },
                  '排除名单（' + (status ? status.exclusions.length : 0) + '）'),
                h('span', { className: 'ar-note', style: { marginLeft: 'auto' } },
                  '运行 ', h('b', null, results.runId), ' · n = ', String((results.meta && results.meta.n) ?? '—'))
              )
            : null,

          results && results.runId && tab === 'tables'
            ? h('div', null,
                results.tables.length
                  ? h('div', { className: 'ar-tabs' }, results.tables.map(table => h('button', {
                      key: table.key,
                      className: 'ar-chip' + (table.key === tableKey ? ' is-active' : ''),
                      onClick: () => setTableKey(table.key)
                    }, table.label)))
                  : null,
                results.tables.length
                  ? results.tables
                      .filter(table => table.key === tableKey)
                      .map(table => h(Table, { key: table.key, table }))
                  : h('div', { className: 'ar-empty' }, h('b', null, '这次运行没有表'), '先跑模型阶段。'),
                h('div', { className: 'ar-note' },
                  '三线表同时写成 CSV：', h('code', null, '_lab/runs/' + results.runId + '/tables/'), '。')
              )
            : null,

          results && results.runId && tab === 'report'
            ? (results.report
                ? h('pre', { className: 'ar-report' }, results.report)
                : h('div', { className: 'ar-empty' }, h('b', null, '这次运行还没有报告'), '跑一次 report 阶段（或点「跑全部」）。'))
            : null,

          results && results.runId && tab === 'figures'
            ? (results.figures.length
                ? h('div', { className: 'ar-figs' }, results.figures.map(figure => h('div', { key: figure.name, className: 'ar-fig' },
                    h('img', { src: figure.url, alt: figure.name }),
                    h('span', null, figure.name)
                  )))
                : h('div', { className: 'ar-empty' }, h('b', null, '这次运行没有图'), '画图失败时会在报告里留一条提醒。'))
            : null,

          results && results.runId && tab === 'exclude'
            ? h(Exclusions, {
                items: (status && status.exclusions) || [],
                onAdd: (id, reason) => exclude('add', id, reason),
                onRemove: id => exclude('remove', id),
                disabled: Boolean(busy)
              })
            : null,

          status && status.runs && status.runs.length
            ? h('div', { style: { marginTop: '18px' } },
                h('div', { className: 'ar-note', style: { marginBottom: '8px' } }, '运行历史'),
                h('div', { className: 'ar-list' }, status.runs.map(run => h('button', {
                  key: run.runId,
                  className: 'ar-row',
                  onClick: () => { setActiveRun(run.runId); load(run.runId) }
                },
                  h('span', { className: 'ar-row-id' }, run.runId),
                  h('span', { className: 'ar-row-n' }, 'n = ' + (run.n ?? '—')),
                  h('span', { className: 'ar-row-n' }, run.dataCutoff || ''),
                  h('span', { className: 'ar-row-state' },
                    gateTag(run.gate),
                    run.status === 'failed' ? h('span', { className: 'ar-tag ar-tag-bad' }, '有失败') : null,
                    run.runId === activeRun ? h('span', { className: 'ar-tag' }, '当前') : null
                  )
                )))
              )
            : null,

          h('div', { className: 'ar-note', style: { marginTop: '18px' } },
            '全部结果在 ', h('code', null, status ? status.paths.labDir : '_lab'), ' /runs/<runId>/；',
            '缓存可删，删了会重算。排除名单在 ', h('code', null, 'exclusions.csv'), '，脚本只执行不自动判断。')
        ),
        toastState
          ? h('div', { className: 'ar-toast' + (toastState.tone === 'bad' ? ' is-bad' : '') }, toastState.message)
          : null
      )
    }

    function Exclusions({ items, onAdd, onRemove, disabled }) {
      const [id, setId] = useState('')
      const [reason, setReason] = useState('')
      const submit = event => {
        event.preventDefault()
        if (!/^\d{5}$/.test(id.trim())) return
        if (!reason.trim()) return
        onAdd(id.trim(), reason.trim())
        setId('')
        setReason('')
      }
      return h('div', { className: 'ar-card' },
        h('div', { className: 'ar-note' },
          '排除规则必须人定：这里只执行名单，脚本不会自动排除。改完名单重跑合并（或「跑全部」）才进入结果。'),
        h('form', { className: 'ar-form', onSubmit: submit },
          h('input', {
            className: 'ar-id',
            value: id,
            placeholder: '编号',
            maxLength: 5,
            disabled,
            onChange: event => setId(event.target.value.replace(/\D/g, '').slice(0, 5))
          }),
          h('input', {
            className: 'ar-reason',
            value: reason,
            placeholder: '理由（写进 exclusions.csv）',
            disabled,
            onChange: event => setReason(event.target.value)
          }),
          h('button', {
            className: 'ar-btn ar-btn-outline',
            type: 'submit',
            disabled: disabled || !/^\d{5}$/.test(id.trim()) || !reason.trim()
          }, '加入排除')
        ),
        items.length
          ? h('div', { className: 'ar-list' }, items.map(item => h('div', {
              key: item['编号'],
              className: 'ar-row',
              style: { cursor: 'default' }
            },
              h('span', { className: 'ar-row-id' }, item['编号']),
              h('span', { className: 'ar-row-n' }, item['时间'] || ''),
              h('span', null, item['原因'] || '（没写理由）'),
              h('button', {
                className: 'ar-btn ar-btn-ghost ar-btn-sm',
                disabled,
                onClick: () => onRemove(item['编号'])
              }, '恢复')
            )))
          : h('div', { className: 'ar-empty' }, h('b', null, '名单是空的'), '所有 T0 与 T2 都有数据的人都进入分析。')
      )
    }

    /* ================================================================ *
     * icon + guard + mounting
     * ================================================================ */

    function Icon({ size, active }) {
      return h('svg', {
        width: size || 18,
        height: size || 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
        h('path', { d: 'M3 9h18M3 15h18', opacity: 0.7 }),
        h('path', { d: 'M7 13.2l2.6-3.4 2.4 2 2.8-4' }),
        h('circle', { cx: 7, cy: 13.2, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 14.8, cy: 7.8, r: 0.9, fill: 'currentColor', stroke: 'none' })
      )
    }

    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[analysis-run] panel crashed:', error)
      }
      render() {
        if (this.state.error) {
          const text = String((this.state.error && (this.state.error.stack || this.state.error.message)) || this.state.error)
          return h('div', {
            style: {
              padding: '18px',
              fontFamily: 'ui-monospace,Consolas,monospace',
              fontSize: '12px',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              color: '#b00020',
              overflow: 'auto',
              height: '100%',
              boxSizing: 'border-box'
            }
          }, '分析直通面板渲染失败：\n\n' + text + '\n\n（把这段发给我即可定位）')
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => insertStyles(), 'analysis-run: styles')
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'analysis-run', order: 33, label: '分析直通' },
            props => h(Icon, { size: (props && props.size) || 18, active: Boolean(props && props.active) })
          )
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'analysis-run' }, () => h(Guard, null, h(Panel))))
      }
    }
  }
})
