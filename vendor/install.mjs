/**
 * analysis-run 统计后端的离线安装脚本。
 *
 * 把 vendor/wheels/ 里的 wheel 安装到插件自己的 vendor/site-packages，运行时由插件把
 * 这个目录放进 PYTHONPATH，因此不依赖 DSH 运行时里是否已经 pip 过 scipy/statsmodels。
 *
 * 用法：
 *   node vendor/install.mjs                 # 用默认的 DSH 运行时 Python
 *   node vendor/install.mjs --python <路径> # 指定解释器
 *   node vendor/install.mjs --check         # 只检查环境与已装版本，不安装
 *
 * 换解释器（例如 DSH 把运行时升到 3.13）后：把对应的 cp313 wheel 放进 vendor/wheels/，再运行一次本脚本。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const vendorRoot = here
const wheelsDir = path.join(vendorRoot, 'wheels')
const siteDir = path.join(vendorRoot, 'site-packages')
const manifestPath = path.join(vendorRoot, 'manifest.json')

const PACKAGES = [
  ['scipy', '1.18.1'],
  ['statsmodels', '0.15.0'],
  ['patsy', '1.0.3'],
  ['formulaic', '1.2.2'],
  ['interface-meta', '2.0.1'],
  ['narwhals', '2.28.0'],
  ['wrapt', '2.5.2'],
  ['packaging', '26.3'],
]
// numpy / pandas 不内置：它们由 DSH 运行时提供，重复带入容易出现两份二进制包。
const RUNTIME_PROVIDED = ['numpy', 'pandas']

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}
const checkOnly = process.argv.includes('--check')
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const runtimePython = path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const python = arg('--python') || process.env.DSH_ANALYSIS_PYTHON || runtimePython

function run(args, env = {}) {
  return spawnSync(python, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } })
}

if (!existsSync(python)) {
  console.error(`找不到 Python：${python}\n请用 --python 指定，或设置 DSH_ANALYSIS_PYTHON。`)
  process.exit(2)
}

const probe = run(['-c', 'import sys, platform, sysconfig; print(sys.version.split()[0]); print(platform.machine()); print(sysconfig.get_platform())'])
if (probe.status !== 0) {
  console.error('解释器自检失败：' + String(probe.stderr || '').trim().slice(0, 400))
  process.exit(2)
}
const [version, machine] = probe.stdout.trim().split(/\r?\n/)
const majorMinor = version.split('.').slice(0, 2).join('.')
console.log(`解释器：${python}\n版本：${version} · 平台：${machine} · Python ${majorMinor}`)

if (!existsSync(wheelsDir) || readdirSync(wheelsDir).filter(name => name.endsWith('.whl')).length === 0) {
  console.error(`没有找到离线 wheel：${wheelsDir}`)
  process.exit(2)
}
const wheels = readdirSync(wheelsDir).filter(name => name.endsWith('.whl'))
const nativeWheels = wheels.filter(name => /cp\d+/.test(name))
const tag = `cp${majorMinor.replace('.', '')}`
const mismatch = nativeWheels.filter(name => !name.includes(tag))
if (mismatch.length) {
  console.error(`wheel 与解释器不匹配（需要 ${tag}）：${mismatch.join('、')}\n` +
    `请把与 Python ${majorMinor} / ${machine} 对应的 wheel 放进 vendor/wheels/ 后重试；` +
    `纯 Python 包（patsy/formulaic 等）不受影响。`)
  process.exit(3)
}

const environment = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
if (existsSync(siteDir)) environment.PYTHONPATH = siteDir

const verify = () => {
  const names = PACKAGES.map(([name]) => name)
  const script = [
    'import json, sys, importlib.metadata as md',
    'out = {}',
    'for name in sys.argv[1:]:',
    '    try: out[name] = {"version": md.version(name)}',
    '    except Exception as error: out[name] = {"error": str(error)}',
    'for extra in ("scipy", "statsmodels", "numpy", "pandas"):',
    '    try:',
    '        module = __import__(extra); out[extra] = {"version": getattr(module, "__version__", None), "path": getattr(module, "__file__", None)}',
    '    except Exception as error: out[extra] = {"error": str(error)}',
    'print(json.dumps(out, ensure_ascii=False))',
  ].join('\n')
  const result = run(['-c', script, ...names], environment)
  return result.status === 0 ? JSON.parse(result.stdout.trim().split(/\r?\n/).pop()) : null
}

if (checkOnly) {
  const current = verify()
  console.log(JSON.stringify({ python, version, machine, site: siteDir, installed: current }, null, 2))
  process.exit(current && current.scipy && current.scipy.path && current.scipy.path.startsWith(siteDir) ? 0 : 1)
}

const install = PACKAGES.map(([name, version]) => `${name}==${version}`)
const args = ['-m', 'pip', 'install', '--no-index', '--find-links', wheelsDir, '--target', siteDir,
  '--upgrade', '--no-deps', '--no-warn-script-location', ...install]
mkdirSync(siteDir, { recursive: true })
const installed = run(args, { PYTHONPATH: '' })
if (installed.status !== 0) {
  console.error('安装失败：' + String(installed.stderr || installed.stdout || '').trim().slice(0, 1200))
  process.exit(4)
}

const after = verify()
if (!after || !after.scipy || !after.scipy.path || !String(after.scipy.path).startsWith(siteDir)) {
  console.error('安装后自检失败：vendored 版本没有被加载。结果：' + JSON.stringify(after))
  process.exit(5)
}
const manifest = {
  schemaVersion: 1,
  installedAt: new Date().toISOString(),
  python: { version, majorMinor, machine, executable: python },
  site: siteDir,
  runtimeProvided: RUNTIME_PROVIDED,
  packages: Object.fromEntries(PACKAGES.map(([name]) => [name, after[name] && after[name].version ? after[name].version : null])),
  wheels,
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('已安装到 ' + siteDir)
console.log(JSON.stringify(manifest.packages, null, 2))
console.log('numpy/pandas 由 DSH 运行时提供：' + JSON.stringify({ numpy: after.numpy && after.numpy.version, pandas: after.pandas && after.pandas.version }))
