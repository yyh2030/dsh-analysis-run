"""Generic CSV analysis. Every run uses immutable local input and code snapshots."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import uuid
import re as _re

# 测试、预览和生产必须使用同一统计后端：直接调用 engine.py 时也把插件自带的
# vendor/site-packages 前置到 sys.path（插件运行时会通过 PYTHONPATH 再做一次）。
_VENDOR_SITE = Path(__file__).resolve().parent / 'vendor' / 'site-packages'
if _VENDOR_SITE.is_dir() and str(_VENDOR_SITE) not in sys.path:
    sys.path.insert(0, str(_VENDOR_SITE))

VERSION = 'analysis-engine/2.5.0'
MODULES = ('descriptives', 'sample', 'sensitivity', 'correlation', 'reliability', 'ttest', 'anova', 'mediation', 'regression', 'paired', 'mixed', 'script')
# 每个模块需要的本地依赖；缺后端时显示"环境待准备"，不能悄悄换成别的检验。
BACKENDS = {'descriptives': ('numpy', 'pandas'), 'sample': ('numpy', 'pandas'), 'sensitivity': ('numpy', 'pandas'), 'correlation': ('numpy', 'pandas'), 'reliability': ('numpy', 'pandas'), 'ttest': ('numpy', 'pandas'), 'anova': ('numpy', 'pandas', 'statsmodels'), 'mediation': ('numpy', 'pandas', 'statsmodels'), 'script': ('numpy', 'pandas'), 'regression': ('numpy', 'pandas', 'statsmodels'),
            'paired': ('numpy', 'pandas'), 'mixed': ('statsmodels',)}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def clean(value):
    import numpy as np
    if isinstance(value, dict): return {str(k):clean(v) for k,v in value.items()}
    if isinstance(value, (list,tuple)): return [clean(v) for v in value]
    if isinstance(value, np.generic): value=value.item()
    if isinstance(value, float) and not np.isfinite(value): return None
    return value


def now(): return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def validate(plan):
    if not isinstance(plan, dict): raise ValueError('plan must be an object')
    for key in ('dataPath','idColumn','outcome'):
        if not isinstance(plan.get(key),str) or not plan[key].strip(): raise ValueError(f'{key} is required')
    if not Path(plan['dataPath']).is_absolute(): raise ValueError('dataPath must be absolute')
    for key in ('groupColumns','covariates','analyses','pairedColumns'):
        if key in plan and (not isinstance(plan[key],list) or not all(isinstance(v,str) and v for v in plan[key])):
            raise ValueError(f'{key} must be a list of nonempty strings')
        if len(plan.get(key,[])) != len(set(plan.get(key,[]))): raise ValueError(f'{key} has duplicate values')
    if set(plan.get('analyses',[]))-set(MODULES): raise ValueError('unsupported analysis module')
    if plan.get('layout','wide') not in ('wide','long'): raise ValueError('layout must be wide or long')
    within=plan.get('within')
    if within is not None:
        if not isinstance(within,dict) or not isinstance(within.get('column'),str) or not within['column']:
            raise ValueError('within.column is required')
        levels=within.get('levels',[])
        if not isinstance(levels,list) or not all(isinstance(v,str) and v for v in levels) or len(levels)!=len(set(levels)):
            raise ValueError('within.levels must contain unique strings')
    minimum=plan.get('gate',{}).get('minSubjects',30)
    if isinstance(minimum,bool) or not isinstance(minimum,int) or minimum<2: raise ValueError('gate.minSubjects must be an integer >= 2')
    roles=[plan['idColumn'],plan['outcome']]+plan.get('groupColumns',[])+plan.get('covariates',[])
    if plan.get('within'): roles += [plan['within']['column']]
    if len(roles)!=len(set(roles)): raise ValueError('idColumn, outcome, groups, covariates and within must have distinct column roles')
    if plan.get('pairedColumns') and (len(plan['pairedColumns'])!=2 or plan['idColumn'] in plan['pairedColumns']):
        raise ValueError('pairedColumns must contain two distinct measurements, excluding idColumn')
    # 未支持的建模选项要显式报错，不能悄悄拟合近似模型。
    if plan.get('distribution') not in (None,'gaussian','normal'):
        raise ValueError('未支持：本引擎只支持正态(gaussian)分布，不能悄悄换成近似模型')
    if 'interactions' in plan:
        specs=plan['interactions']
        if not isinstance(specs,list): raise ValueError('interactions must be a list of [a, b] pairs')
        groups=set(plan.get('groupColumns',[]))
        for spec in specs:
            if not isinstance(spec,(list,tuple)) or len(spec)!=2 or any(not isinstance(item,str) or not item for item in spec) or spec[0]==spec[1]:
                raise ValueError('each interaction must be two distinct group column names')
            for name in spec:
                if name not in groups: raise ValueError(f'interaction member {name} must be a groupColumn (categorical)')
    if str(plan.get('sumsOfSquares','II')).upper() not in ('I','II','III'):
        raise ValueError('sumsOfSquares only supports I, II or III')
    if 'contrasts' in plan:
        specs=plan['contrasts']
        if not isinstance(specs,list): raise ValueError('contrasts must be a list')
        groups=set(plan.get('groupColumns',[]))
        for spec in specs:
            if not isinstance(spec,dict) or spec.get('column') not in groups:
                raise ValueError('each contrast needs a groupColumn as column')
            levels=spec.get('levels')
            if not isinstance(levels,list) or len(levels)!=2 or any(not isinstance(level,str) or not level for level in levels) or levels[0]==levels[1]:
                raise ValueError('contrast.levels must be two distinct strings')
    if plan.get('randomSlopes'):
        raise ValueError('未支持：随机斜率尚未实现，只有声明过的随机截距可用')
    if 'reml' in plan and not isinstance(plan['reml'],bool):
        raise ValueError('reml must be true or false')
    if 'frequencies' in plan:
        specs=plan['frequencies']
        if not isinstance(specs,list): raise ValueError('frequencies must be a list')
        for spec in specs:
            if isinstance(spec,str) and spec: continue
            if isinstance(spec,dict) and isinstance(spec.get('column'),str) and spec['column']: continue
            raise ValueError('frequencies entries must be column names or {column} objects')
    if 'script' in plan:
        spec=plan['script']
        if not isinstance(spec,dict): raise ValueError('script must be an object')
        code=spec.get('code'); file_=spec.get('file')
        if not (isinstance(code,str) and code.strip()) and not (isinstance(file_,str) and file_.strip()):
            raise ValueError('script needs code or file')
        if isinstance(code,str) and len(code)>50000: raise ValueError('script.code is too long (limit 50000 characters)')
    if 'transforms' in plan:
        specs=plan['transforms']
        if not isinstance(specs,list): raise ValueError('transforms must be a list')
        for spec in specs:
            if not isinstance(spec,dict) or not isinstance(spec.get('op'),str) or not isinstance(spec.get('column'),str):
                raise ValueError('transforms entries require op and column')
    if 'correlation' in plan:
        spec=plan['correlation']
        if not isinstance(spec,dict): raise ValueError('correlation must be an object')
        columns=spec.get('columns')
        if not isinstance(columns,list) or len(columns)<2 or any(not isinstance(c,str) or not c for c in columns):
            raise ValueError('correlation.columns must be at least two column names')
        if spec.get('method','pearson') not in ('pearson','spearman'):
            raise ValueError('correlation.method only supports pearson or spearman')
        if spec.get('correct','none') not in ('none','bh'):
            raise ValueError('correlation.correct only supports none or bh')
        partial=spec.get('partial') or []
        if not isinstance(partial,list) or any(not isinstance(c,str) for c in partial):
            raise ValueError('correlation.partial must be a list of column names')
    if 'reliability' in plan:
        specs=plan['reliability']
        if not isinstance(specs,list) or not specs: raise ValueError('reliability must be a non-empty list')
        for spec in specs:
            if not isinstance(spec,dict) or not isinstance(spec.get('items'),list) or len(spec['items'])<2:
                raise ValueError('each reliability entry needs at least two items')
            if any(not isinstance(c,str) or not c for c in spec['items']): raise ValueError('reliability items must be column names')
            reverse=spec.get('reverse') or []
            if not isinstance(reverse,list) or any(not isinstance(c,str) for c in reverse): raise ValueError('reliability.reverse must be a list')
            declared=spec.get('range')
            if declared is not None:
                if not isinstance(declared,list) or len(declared)!=2 or not all(isinstance(value,(int,float)) and not isinstance(value,bool) for value in declared):
                    raise ValueError('reliability.range must be [min,max] numbers')
                if declared[0] >= declared[1]: raise ValueError('reliability.range min must be < max')
    if 'ttest' in plan:
        spec=plan['ttest']
        if not isinstance(spec,dict): raise ValueError('ttest must be an object')
        if spec.get('kind','independent') not in ('independent','one-sample'):
            raise ValueError('ttest.kind only supports independent or one-sample')
        if spec.get('kind','independent')=='independent' and not isinstance(spec.get('group'),str):
            raise ValueError('independent ttest needs ttest.group')
        if spec.get('kind','independent')=='one-sample' and not isinstance(spec.get('mu'),(int,float)):
            raise ValueError('one-sample ttest needs a numeric ttest.mu')
    if 'anova' in plan:
        spec=plan['anova']
        if not isinstance(spec,dict): raise ValueError('anova must be an object')
        factors=spec.get('factors')
        if not isinstance(factors,list) or not factors or any(not isinstance(f,str) or not f for f in factors):
            raise ValueError('anova.factors must be a non-empty list of column names')
        if len(factors)>2: raise ValueError('anova supports one or two factors')
        if spec.get('sumsOfSquares') not in (None,'I','II','III'):
            raise ValueError('anova.sumsOfSquares only supports I, II or III')
    if 'mediation' in plan:
        spec=plan['mediation']
        if not isinstance(spec,dict): raise ValueError('mediation must be an object')
        for key in ('x','m','y'):
            if not isinstance(spec.get(key),str) or not spec[key]: raise ValueError(f'mediation needs {key}')
        if not isinstance(spec.get('bootstrap',1000),int) or spec.get('bootstrap',1000)<100:
            raise ValueError('mediation.bootstrap must be an integer >= 100')
        if spec.get('seed') is not None and not isinstance(spec['seed'],int):
            raise ValueError('mediation.seed must be an integer')
    if 'sampleColumns' in plan:
        specs=plan['sampleColumns']
        if not isinstance(specs,list) or not specs: raise ValueError('sampleColumns must be a non-empty list')
        for spec in specs:
            if not isinstance(spec,dict) or not isinstance(spec.get('column'),str) or not spec['column']:
                raise ValueError('each sampleColumns entry needs a column string')
            if spec.get('kind','numeric') not in ('numeric','categorical'):
                raise ValueError('sampleColumns.kind only supports numeric or categorical')
    return plan


def load_csv(path):
    import csv
    import pandas as pd
    with open(path, encoding='utf-8-sig', newline='') as handle:
        header=next(csv.reader(handle),[])
    if not header or len(header)!=len(set(header)) or any(not value.strip() for value in header):
        raise ValueError('CSV requires unique nonempty column headers')
    return pd.read_csv(path, encoding='utf-8-sig', dtype=str, keep_default_na=False)


TRANSFORMS = ('recode', 'missing', 'center', 'zscore', 'log')


def apply_transforms(data, specs):
    """允许列表内的确定性预处理；不执行任意表达式。返回 (data, 操作记录)。"""
    import numpy as np
    import pandas as pd
    ops = []
    for spec in specs or []:
        if not isinstance(spec, dict):
            raise ValueError('transforms entries must be objects')
        op = spec.get('op')
        column = spec.get('column')
        if op not in TRANSFORMS:
            raise ValueError(f'未支持：预处理操作 {op}')
        if not isinstance(column, str) or column not in data.columns:
            raise ValueError(f'transform {op}: unknown column {column}')
        target = spec.get('name') or column
        if op == 'recode':
            mapping = spec.get('map') or {}
            if not isinstance(mapping, dict):
                raise ValueError('recode.map must be an object')
            before = data[column].astype(str)
            data[target] = data[column].map(lambda value: mapping.get(str(value), value))
            changed = int((data[target].astype(str) != before).sum())
        elif op == 'missing':
            values = [str(value) for value in (spec.get('values') or [])]
            before = int(data[column].notna().sum())
            data.loc[data[column].astype(str).isin(values), column] = np.nan
            changed = int(before - data[column].notna().sum())
        else:
            numeric = pd.to_numeric(data[column].replace('', np.nan), errors='coerce')
            bad = numeric.isna() & data[column].ne('')
            if bad.any():
                raise ValueError(f'transform {op}: nonnumeric values in {column}')
            if op == 'log':
                if (numeric.dropna() <= 0).any():
                    raise ValueError('transform log: values must be positive')
                data[target] = np.log(numeric)
            elif op == 'center':
                data[target] = numeric - numeric.mean()
            else:
                spread = numeric.std(ddof=1)
                data[target] = (numeric - numeric.mean()) / spread if spread else numeric - numeric.mean()
            changed = int(numeric.notna().sum())
        ops.append({'op': op, 'column': column, 'name': target, 'changed': changed})
    return data, ops


def read_data(path, plan):
    import numpy as np
    import pandas as pd
    data = load_csv(path)
    data, transform_ops = apply_transforms(data, plan.get('transforms'))
    idcol=plan['idColumn']; outcome=plan['outcome']
    expected=[idcol,outcome]+plan.get('groupColumns',[])+plan.get('covariates',[])+plan.get('pairedColumns',[])
    within=plan.get('within') or {}
    if plan.get('layout','wide')=='long': expected += [within.get('column','')]
    missing=[c for c in expected if c not in data.columns]
    if missing: raise ValueError('missing columns: '+', '.join(missing))
    ids=data[idcol]
    if ids.str.strip().eq('').any(): raise ValueError('participant IDs must be nonempty strings')
    if ids.ne(ids.str.strip()).any(): raise ValueError('participant IDs contain surrounding whitespace; correct source explicitly')
    keys=[idcol]+([within['column']] if plan.get('layout','wide')=='long' else [])
    duplicates=data.loc[data.duplicated(keys,keep=False),keys]
    if len(duplicates): raise ValueError('expected unique '+','.join(keys)+'; duplicate keys: '+duplicates.to_json(orient='records',force_ascii=False))
    if plan.get('layout','wide')=='long':
        if data[within['column']].str.strip().eq('').any(): raise ValueError('within values must be nonempty')
        levels=within.get('levels') or sorted(data[within['column']].unique())
        unknown=set(data[within['column']])-set(levels)
        if unknown: raise ValueError('unknown within levels: '+', '.join(sorted(unknown)))
        for col in plan.get('groupColumns',[]):
            if data.groupby(idcol)[col].nunique().gt(1).any(): raise ValueError(f'between-subject group {col} changes within participant')
    for col in set([outcome]+plan.get('covariates',[])+plan.get('pairedColumns',[])):
        original=data[col]
        number=pd.to_numeric(original.replace('',np.nan),errors='coerce')
        bad=original.ne('') & (number.isna() | ~np.isfinite(number))
        if bad.any(): raise ValueError(f'{col}: nonnumeric or infinite values at rows '+','.join(str(i+2) for i in bad[bad].index))
        data[col]=number
    for col in plan.get('groupColumns',[]): data[col]=data[col].replace('',np.nan)
    return data, transform_ops


def module_columns(plan, module):
    """每个模块实际需要的列，全部来自方案声明而不是"数据里有什么"。

    返回 (required, numeric, categorical)。缺列在 prepare_frame 里直接失败，
    不会过滤掉不存在的列再假装检查通过。
    """
    idcol = plan['idColumn']; outcome = plan['outcome']
    groups = list(plan.get('groupColumns') or [])
    covariates = list(plan.get('covariates') or [])
    if module == 'descriptives':
        return [idcol, outcome] + groups, [outcome], groups
    if module == 'sample':
        specs = plan.get('sampleColumns') or []
        required = _unique([idcol] + [spec['column'] for spec in specs if spec.get('column')] + groups)
        numeric = _unique([spec['column'] for spec in specs if spec.get('column') and spec.get('kind', 'numeric') == 'numeric'])
        categorical = _unique([spec['column'] for spec in specs if spec.get('column') and spec.get('kind') == 'categorical'] + groups)
        return required, numeric, categorical
    if module == 'sensitivity':
        return [idcol, outcome] + groups, [outcome], groups
    if module == 'correlation':
        spec = plan.get('correlation') or {}
        cols = list(spec.get('columns') or []); partial = list(spec.get('partial') or []); by = list(spec.get('by') or [])
        return [idcol] + cols + partial + by, cols + partial, by
    if module == 'reliability':
        items = [item for spec in (plan.get('reliability') or []) for item in (spec.get('items') or [])]
        return [idcol] + items, items, []
    if module == 'ttest':
        spec = plan.get('ttest') or {}; measured = spec.get('outcome') or outcome
        required = [idcol, measured]
        categorical = []
        if spec.get('kind', 'independent') == 'independent' and spec.get('group'):
            required.append(spec['group']); categorical.append(spec['group'])
        return required, [measured], categorical
    if module == 'anova':
        spec = plan.get('anova') or {}; measured = spec.get('outcome') or outcome; factors = list(spec.get('factors') or [])
        return [idcol, measured] + factors, [measured], factors
    if module == 'mediation':
        spec = plan.get('mediation') or {}
        cols = [spec.get('x'), spec.get('m'), spec.get('y')] + list(spec.get('covariates') or [])
        cols = [column for column in cols if column]
        return [idcol] + cols, cols, []
    if module == 'regression':
        return [idcol, outcome] + groups + covariates, [outcome] + covariates, groups
    if module == 'paired':
        if plan.get('layout', 'wide') == 'long':
            within = plan.get('within') or {}
            column = within.get('column', '')
            return [idcol, column, outcome], [outcome], [column]
        cols = list(plan.get('pairedColumns') or [])
        return [idcol] + cols, cols, []
    if module == 'mixed':
        within = plan.get('within') or {}; column = within.get('column', '')
        return [idcol, column, outcome] + groups + covariates, [outcome] + covariates, [column] + groups
    return [idcol], [], []


BLANK_TOKENS = {'', 'na', 'n/a', 'nan', 'none', 'null', '.', 'missing'}


def _unique(values):
    seen = set(); out = []
    for value in values:
        if value in seen: continue
        seen.add(value); out.append(value)
    return out


def _coerce_numeric(frame, columns, module):
    import numpy as np
    import pandas as pd
    for column in columns:
        raw = frame[column]
        text = raw.astype('object').map(lambda value: '' if value is None else str(value).strip().lower())
        blank = raw.isna() | text.isin(BLANK_TOKENS)
        number = pd.to_numeric(raw.where(~blank), errors='coerce')
        invalid = ~blank & number.isna()
        if invalid.any():
            examples = [str(raw[index])[:24] for index in list(raw[invalid].index)[:3]]
            raise ValueError(f'{module}: 列 {column} 含无法解析为数值的内容（行 {",".join(str(i + 2) for i in invalid[invalid].index[:3])}）：{examples}')
        if np.isinf(number).any():
            raise ValueError(f'{module}: 列 {column} 含无穷值')
        frame[column] = number
    return frame


def prepare_frame(data, plan, module):
    """按模块声明的列准备 frame：缺列直接失败，空白统一为缺失，非法数值/无穷报错。

    预览、门槛与执行共用这一层，保证"人数"与"实际进入模型的观测"是同一批行。
    """
    required, numeric, categorical = module_columns(plan, module)
    missing = [column for column in required if column not in data.columns]
    if missing:
        raise ValueError(f'{module}: 数据缺少列 {", ".join(missing)}')
    frame = data.copy()
    if module != 'script':
        _coerce_numeric(frame, numeric, module)
    return frame, {'module': module, 'required': required, 'numeric': numeric, 'categorical': categorical}


def environment():
    packages={}
    for name in ('numpy','pandas','scipy','statsmodels','patsy'):
        try: packages[name]=importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError: packages[name]=None
    blas=None
    try:
        import numpy as np
        config=np.show_config(mode='dicts')
        dependencies=config.get('Build Dependencies',{}) or {}
        blas=(dependencies.get('blas',{}) or {}).get('name')
        lapack=(dependencies.get('lapack',{}) or {}).get('name')
        blas={'blas':blas,'lapack':lapack}
    except Exception:
        blas=None
    sources={}
    for name in ('numpy','pandas','scipy','statsmodels'):
        try:
            spec=importlib.util.find_spec(name)
            sources[name]=str(spec.origin) if spec else None
        except Exception:
            sources[name]=None
    return {'python':sys.version,'pythonMajorMinor':'.'.join(platform.python_version().split('.')[:2]),
            'implementation':platform.python_implementation(),'executable':sys.executable,
            'platform':platform.platform(),'machine':platform.machine(),'processor':platform.processor(),
            'packages':packages,'blas':blas,'packageSources':sources,'sysPath':[str(item) for item in sys.path[:8]]}


def lock_signature(env):
    """环境锁只固定影响数值结果的要素：Python 主次版本、实现、关键包版本、BLAS 名称。"""
    return {'pythonMajorMinor':env.get('pythonMajorMinor'),'implementation':env.get('implementation'),
            'packages':{k:v for k,v in (env.get('packages') or {}).items() if v},
            'blas':env.get('blas')}


def check_lock(env, lock):
    """返回与锁不一致的条目；空列表表示可复现。"""
    current=lock_signature(env)
    problems=[]
    if lock.get('pythonMajorMinor') and lock['pythonMajorMinor']!=current['pythonMajorMinor']:
        problems.append(f"python {lock['pythonMajorMinor']} -> {current['pythonMajorMinor']}")
    if lock.get('implementation') and lock['implementation']!=current['implementation']:
        problems.append(f"implementation {lock['implementation']} -> {current['implementation']}")
    for name,version in (lock.get('packages') or {}).items():
        if current['packages'].get(name)!=version:
            problems.append(f"{name} {version} -> {current['packages'].get(name)}")
    old_blas=(lock.get('blas') or {}).get('blas') if isinstance(lock.get('blas'),dict) else lock.get('blas')
    new_blas=(current.get('blas') or {}).get('blas') if isinstance(current.get('blas'),dict) else current.get('blas')
    if old_blas and old_blas!=new_blas:
        problems.append(f"blas {old_blas} -> {new_blas}")
    return problems


def _betacf(a, b, x):
    """Continued fraction for the incomplete beta function (Numerical Recipes)."""
    tiny = 1e-30
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    return h


def _betainc(a, b, x):
    """Regularized incomplete beta I_x(a,b)，用于在不依赖 scipy 的情况下算 t 分位数。"""
    import math
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    log_front = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1.0 - x)
    front = math.exp(log_front)
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def t_critical(df, level=0.95):
    """双侧 Student-t 临界值（本机没有 scipy 时也不退回 1.96 的正态近似）。"""
    if df <= 0:
        return None
    target = 1.0 - (1.0 - level) / 2.0
    low, high = 0.0, 200.0
    for _ in range(200):
        mid = (low + high) / 2.0
        # P(|T| <= t) = 1 - I_{df/(df+t^2)}(df/2, 1/2)
        tail = 0.5 * _betainc(df / 2.0, 0.5, df / (df + mid * mid))
        probability = 1.0 - tail
        if probability < target:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def describe(data, plan):
    import numpy as np
    groups=list(plan.get('groupColumns',[]))
    if plan.get('layout','wide')=='long': groups += [(plan.get('within') or {})['column']]
    chunks=data.groupby(groups,dropna=False,sort=True) if groups else [((),data)]
    rows=[]
    for key,frame in chunks:
        values=frame[plan['outcome']].dropna()
        if not isinstance(key,tuple): key=(key,)
        row={col:value for col,value in zip(groups,key)}
        valid=len(values)
        sd=values.std(ddof=1) if valid>=2 else None
        se=(sd/np.sqrt(valid)) if (sd is not None and valid>=2) else None
        if se is not None and valid>=2:
            critical=t_critical(valid-1,0.95)
            ci_low=float(values.mean()-critical*se); ci_high=float(values.mean()+critical*se)
        else:
            critical=None; ci_low=None; ci_high=None
        q1=float(values.quantile(0.25)) if valid else None
        q3=float(values.quantile(0.75)) if valid else None
        row.update(subjects=int(frame[plan['idColumn']].nunique()),observations=len(frame),validObservations=valid,
                   missing=int(frame[plan['outcome']].isna().sum()),mean=values.mean() if valid else None,sd=sd,se=se,
                   ciLevel=0.95,ciCritical=critical,ciLow=ci_low,ciHigh=ci_high,
                   median=values.median() if valid else None,q1=q1,q3=q3,iqr=(q3-q1) if (q1 is not None and q3 is not None) else None,
                   minimum=values.min() if valid else None,maximum=values.max() if valid else None,
                   valueRange=(float(values.max()-values.min()) if valid else None))
        rows.append(row)
    return clean(rows)


def frequencies(data, plan):
    """类别频数：每个分组×列×取值的计数与分母（分母=该组该列非缺失的独立参与者数）。"""
    import pandas as pd
    groups=list(plan.get('groupColumns',[]))
    if plan.get('layout','wide')=='long': groups += [(plan.get('within') or {})['column']]
    rows=[]
    for spec in plan.get('frequencies',[]):
        column=spec['column'] if isinstance(spec,dict) else str(spec)
        if column not in data.columns: raise ValueError(f'frequencies column missing: {column}')
        chunks=data.groupby(groups,dropna=False,sort=True) if groups else [((),data)]
        for key,frame in chunks:
            if not isinstance(key,tuple): key=(key,)
            series=frame[column]
            usable=frame[series.notna() & (series.astype(str)!='')]
            denominator=int(usable[plan['idColumn']].nunique())
            counts=usable.groupby(column,dropna=False)[plan['idColumn']].nunique().sort_index()
            for value,count in counts.items():
                row={col:item for col,item in zip(groups,key)}
                row.update(column=column,value=str(value),count=int(count),denominator=denominator,
                           percent=(round(float(count)/denominator*100,4) if denominator else None),
                           missing=denominator-int(count))
                rows.append(row)
    return clean(rows)



def model_frame(data, plan, extra=()):
    cols=list(dict.fromkeys([plan['idColumn'],plan['outcome']]+plan.get('groupColumns',[])+plan.get('covariates',[])+list(extra)))
    frame=data.loc[:,cols].dropna(subset=cols).copy()
    # Internal names prevent arbitrary CSV headers from becoming executable formula fragments.
    rename={plan['outcome']:'_outcome',plan['idColumn']:'_subject'}
    rename.update({col:f'_group{i}' for i,col in enumerate(plan.get('groupColumns',[]))})
    rename.update({col:f'_cov{i}' for i,col in enumerate(plan.get('covariates',[]))})
    within=plan.get('within') or {}
    if within.get('column'): rename[within['column']]='_within'
    frame=frame.rename(columns=rename)
    terms=[f'C(_group{i})' for i in range(len(plan.get('groupColumns',[])))]+[f'_cov{i}' for i in range(len(plan.get('covariates',[])))]
    group_index={column:f'_group{i}' for i,column in enumerate(plan.get('groupColumns',[]))}
    for pair in plan.get('interactions',[]) or []:
        left,right=group_index[pair[0]],group_index[pair[1]]
        terms.append(f'C({left}):C({right})')
    return frame,terms


def coefficients(model):
    ci=model.conf_int()
    return clean([{'term':term,'estimate':float(model.params[term]),'se':float(model.bse[term]),
                   'ciLow':float(ci.loc[term,0]),'ciHigh':float(ci.loc[term,1]),'p':float(model.pvalues[term])}
                  for term in model.params.index])


def regression(data,plan):
    import numpy as np
    import statsmodels.api as sm
    import statsmodels.formula.api as smf
    if plan.get('layout','wide')!='wide': raise ValueError('regression requires independent wide rows; choose mixed for repeated observations')
    frame,terms=model_frame(data,plan)
    if not terms: raise ValueError('regression needs groupColumns, covariates or interactions')
    formula='_outcome ~ '+' + '.join(terms)
    model=smf.ols(formula,data=frame).fit()
    if model.df_resid<=0 or np.linalg.matrix_rank(model.model.exog)<model.model.exog.shape[1]:
        raise ValueError('regression design is rank deficient or has no residual degrees of freedom')
    typ={'I':1,'II':2,'III':3}.get(str(plan.get('sumsOfSquares','II')).upper(),2)
    anova=sm.stats.anova_lm(model,typ=typ)
    residual=float(anova.loc['Residual','sum_sq']) if 'Residual' in anova.index else None
    # 展示时把内部列名换回研究里的列名，避免表格里出现 _group0。
    display={'[T.':'[T.'}
    renamed={}
    for i,column in enumerate(plan.get('groupColumns',[])): renamed[f'C(_group{i})']=f'C({column})'
    for i,column in enumerate(plan.get('covariates',[])): renamed[f'_cov{i}']=column
    def show(term):
        text=str(term)
        for internal,original in renamed.items(): text=text.replace(internal,original)
        text=_re.sub(r'C\(([^)]+)\)\[T\.([^\]]+)\]', r'\1 = \2', text)
        text=_re.sub(r'C\(([^)]+)\)', r'\1', text)
        return text.replace('_outcome',plan['outcome']).replace(':', ' × ')
    rows=[]
    for term,row in anova.iterrows():
        if str(term)=='Residual': continue
        ss=float(row['sum_sq'])
        rows.append({'term':show(term),'df':float(row['df']),'sumSq':ss,'F':float(row['F']),
                     'p':float(row['PR(>F)']) if row['PR(>F)'] is not None else None,
                     'partialEtaSquared':(ss/(ss+residual) if residual and (ss+residual)>0 else None)})
    group_index={column:f'_group{i}' for i,column in enumerate(plan.get('groupColumns',[]))}
    contrasts=[]
    for spec in plan.get('contrasts',[]) or []:
        column=spec['column']; reference,other=spec['levels']
        internal=group_index[column]
        original=f'C({internal})'
        if original not in formula: raise ValueError(f'contrast column {column} is not a categorical term in the model')
        replaced=f'C({internal}, Treatment(reference={reference!r}))'
        model2=smf.ols(formula.replace(original,replaced),data=frame).fit()
        name=None
        for key in model2.params.index:
            if 'reference=' in key and f'[T.{other}]' in key and internal in key:
                name=key; break
        if name is None: raise ValueError(f'contrast {reference} -> {other}: level not found in {column}')
        interval=model2.conf_int()
        contrasts.append({'name':spec.get('name') or f'{column}: {other} - {reference}','column':column,
                          'from':reference,'to':other,'estimate':float(model2.params[name]),'se':float(model2.bse[name]),
                          't':float(model2.tvalues[name]),'p':float(model2.pvalues[name]),
                          'ciLow':float(interval.loc[name,0]),'ciHigh':float(interval.loc[name,1])})
    return {'subjects':frame._subject.nunique(),'observations':int(model.nobs),'subjectIds':sorted(frame._subject.unique()),
            'formula':show(formula),'sumsOfSquares':typ,'n':int(model.nobs),
            'dfModel':float(model.df_model),'dfResidual':float(model.df_resid),
            'rSquared':float(model.rsquared),'adjRSquared':float(model.rsquared_adj),
            'rank':int(np.linalg.matrix_rank(model.model.exog)),'designColumns':int(model.model.exog.shape[1]),
            'conditionNumber':float(np.linalg.cond(model.model.exog)),
            'coefficients':[{'term':show(row['term']),**{key:value for key,value in row.items() if key!='term'}} for row in coefficients(model)],
            'anova':rows,'contrasts':contrasts}


def paired(data,plan):
    import numpy as np
    from scipy import stats
    idcol=plan['idColumn']
    if plan.get('layout','wide')=='long':
        within=plan.get('within') or {}; levels=within.get('levels',[])
        if len(levels)!=2: raise ValueError('paired long analysis needs exactly two declared within.levels')
        wide=data.pivot(index=idcol,columns=within['column'],values=plan['outcome']).reindex(columns=levels)
        labels=levels
    else:
        labels=plan.get('pairedColumns',[])
        if len(labels)!=2: raise ValueError('paired wide analysis needs pairedColumns [before,after]')
        wide=data.set_index(idcol)[labels]
    full=wide.dropna(); delta=full[labels[1]]-full[labels[0]]
    if len(delta)<2 or delta.std(ddof=1)<=0: raise ValueError('paired differences need at least two cases and nonzero variance')
    test=stats.ttest_rel(full[labels[1]],full[labels[0]])
    half=stats.t.ppf(.975,len(delta)-1)*stats.sem(delta)
    return clean({'subjects':len(full),'observations':len(full)*2,'subjectIds':sorted(full.index),
                  'before':labels[0],'after':labels[1],'estimate':delta.mean(),'ciLow':delta.mean()-half,'ciHigh':delta.mean()+half,
                  't':float(test.statistic),'df':len(delta)-1,'p':float(test.pvalue)})


def mixed(data,plan):
    import numpy as np
    import pandas as pd
    import statsmodels.formula.api as smf
    if plan.get('layout')!='long': raise ValueError('mixed requires long CSV and within.column')
    within=plan.get('within') or {}; col=within['column']
    frame,terms=model_frame(data,plan,[col])
    levels=within.get('levels') or sorted(data[col].unique())
    if len(levels)<2: raise ValueError('mixed needs at least two within levels')
    frame['_within']=pd.Categorical(frame['_within'],categories=levels,ordered=True)
    repeated=frame.groupby('_subject').size()
    if repeated.gt(1).sum()<2: raise ValueError('mixed needs repeated observations from at least two participants')
    formula='_outcome ~ C(_within)'+(' + '+' + '.join(terms) if terms else '')
    reml=bool(plan.get('reml',False))
    model=smf.mixedlm(formula,frame,groups=frame['_subject']).fit(reml=reml,method='lbfgs')
    if not model.converged: raise ValueError('mixed model did not converge')
    if not np.isfinite(model.params).all(): raise ValueError('mixed model returned nonfinite coefficients')
    # 方差成分与诊断：随机截距方差接近 0 说明奇异拟合，要明确提示而不是当作正常结果。
    group_var=float(model.cov_re.iloc[0,0]) if hasattr(model,'cov_re') else None
    residual_var=float(model.scale) if hasattr(model,'scale') else None
    tolerance=1e-8
    singular=bool(group_var is not None and group_var<=tolerance)
    icc=(group_var/(group_var+residual_var) if group_var is not None and residual_var and (group_var+residual_var)>0 else None)
    return clean({'subjects':int(frame._subject.nunique()),'observations':int(len(frame)),
                  'subjectIds':sorted(frame._subject.unique()),
                  'formula':formula,'method':('REML' if reml else 'ML')+' random intercept','reml':reml,
                  'converged':bool(model.converged),'singular':singular,
                  'varianceComponents':{'groupVariance':group_var,'residualVariance':residual_var,'icc':icc},
                  'groups':int(frame._subject.nunique()),'groupSizes':{'min':int(repeated.min()),'max':int(repeated.max())},
                  'dfResidual':float(getattr(model,'df_resid',float('nan'))),
                  'coefficients':coefficients(model)})


def sample_table(data, plan):
    """样本特征表（Table 1）：先按 participantId 去重成一人一行，再算人数/均值/SD/百分比。

    同一编号在不同行里同一列出现不同值（如年龄 20 与 30）时明确拒绝，不静默取第一行；
    分类变量的百分比以该 scope 下非缺失人数为分母，缺失单独计数。
    """
    import numpy as np
    import pandas as pd
    specs = plan.get('sampleColumns') or []
    if not specs: raise ValueError('sample table needs sampleColumns')
    idcol = plan['idColumn']
    groups = plan.get('groupColumns') or []
    columns = [spec['column'] for spec in specs]
    frame = data[_unique([idcol] + columns + groups)]

    people = {}
    for _, row in frame.iterrows():
        pid = str(row[idcol]).strip()
        if not pid: continue
        person = people.setdefault(pid, {'values': {}, 'groups': {}, 'conflicts': set()})
        for column in columns:
            value = row[column]
            if value is None or value is pd.NA or (isinstance(value, float) and np.isnan(value)):
                continue
            text = str(value).strip()
            if not text:
                continue
            if column in person['values'] and str(person['values'][column]) != text:
                person['conflicts'].add(column)
            else:
                person['values'][column] = value
        for group in groups:
            value = row[group]
            text = '' if value is None or (isinstance(value, float) and np.isnan(value)) else str(value).strip()
            if not text: continue
            if group in person['groups'] and str(person['groups'][group]) != text:
                person['conflicts'].add(group)
            else:
                person['groups'][group] = value

    conflicted = {pid: sorted(person['conflicts']) for pid, person in people.items() if person['conflicts']}
    if conflicted:
        example = next(iter(conflicted.items()))
        raise ValueError(f'样本特征表：同一编号的特征值不一致（如 {example[0]} 的 {",".join(example[1])}），需要先确认取哪个访视或修正来源')

    per_person = pd.DataFrame([
        {'_id': pid, **person['values'], **{group: person['groups'].get(group) for group in groups}}
        for pid, person in people.items()
    ])
    group = groups[0] if groups else None
    rows = []
    for spec in specs:
        column = spec['column']; kind = spec.get('kind', 'numeric'); label = spec.get('label') or column
        scopes = [('整体', per_person)]
        if group:
            for level in sorted(str(item) for item in per_person[group].dropna().unique()):
                scopes.append((f'{group}={level}', per_person[per_person[group].astype(str) == level]))
        for scope_name, scope_frame in scopes:
            raw = scope_frame[column] if column in scope_frame.columns else pd.Series(dtype=object)
            denominator_people = int(len(scope_frame))
            if kind == 'numeric':
                values = pd.to_numeric(raw, errors='coerce')
                valid = values.dropna()
                rows.append({'variable': column, 'label': label, 'scope': scope_name, 'kind': '数值', 'level': None,
                             'n': int(valid.size),
                             'mean': float(valid.mean()) if valid.size else None,
                             'sd': float(valid.std(ddof=1)) if valid.size > 1 else None,
                             'median': float(valid.median()) if valid.size else None,
                             'count': None, 'percent': None,
                             'missing': int(denominator_people - valid.size)})
            elif kind == 'categorical':
                series = raw.astype('object').map(lambda value: '' if value is None else str(value).strip()).replace('', np.nan)
                counts = series.dropna().value_counts()
                denominator = int(series.notna().sum())
                missing = int(denominator_people - denominator)
                for level in sorted(str(item) for item in counts.index):
                    count = int(counts[level])
                    rows.append({'variable': column, 'label': label, 'scope': scope_name, 'kind': '分类', 'level': level,
                                 'n': denominator, 'mean': None, 'sd': None, 'median': None,
                                 'count': count, 'percent': round(100.0 * count / denominator, 1) if denominator else None,
                                 'missing': missing})
            else:
                raise ValueError(f'sample column {column}: kind must be numeric or categorical')
    return rows


def sensitivity_table(data,plan):
    """缺失处理敏感性：比较"全部观测"与"完整病例"两个分析集下的分组均值。
    规则是事先声明的（完整 = outcome/分组/协变量都不缺失），不做事后挑选。"""
    import numpy as np
    import pandas as pd
    outcome=plan['outcome']; groups=plan.get('groupColumns') or []
    columns=[outcome]+groups+plan.get('covariates',[])
    missing=[column for column in columns if column not in data.columns]
    if missing: raise ValueError('sensitivity columns not found: '+', '.join(missing))
    complete=data.dropna(subset=columns)
    group=groups[0] if groups else None
    scopes=[('整体', data, complete)]
    if group:
        for level in sorted(str(item) for item in data[group].dropna().unique()):
            scopes.append((f'{group}={level}', data[data[group].astype(str)==level], complete[complete[group].astype(str)==level]))
    rows=[]
    for name, all_arm, complete_arm in scopes:
        all_values=pd.to_numeric(all_arm[outcome].replace('',np.nan),errors='coerce').dropna()
        complete_values=pd.to_numeric(complete_arm[outcome].replace('',np.nan),errors='coerce').dropna()
        all_mean=float(all_values.mean()) if all_values.size else None
        complete_mean=float(complete_values.mean()) if complete_values.size else None
        rows.append({'scope':name,
                     'nAll':int(all_values.size),'meanAll':all_mean,
                     'sdAll':float(all_values.std(ddof=1)) if all_values.size>1 else None,
                     'nComplete':int(complete_values.size),'meanComplete':complete_mean,
                     'sdComplete':float(complete_values.std(ddof=1)) if complete_values.size>1 else None,
                     'deltaMean':(complete_mean-all_mean) if (complete_mean is not None and all_mean is not None) else None,
                     'dropped':int(len(all_arm)-len(complete_arm))})
    return rows


def _t_two_sided(t, df):
    import math
    if not math.isfinite(t) or df<=0: return None
    return _betainc(df/2.0, 0.5, df/(df+t*t))


def _f_upper(f, d1, d2):
    import math
    if not math.isfinite(f) or f<=0 or d1<=0 or d2<=0: return None
    return _betainc(d2/2.0, d1/2.0, d2/(d2+d1*f))


def _pearson(x, y):
    import numpy as np
    n=len(x)
    if n<3: return None
    xa=np.asarray(x,dtype=float); ya=np.asarray(y,dtype=float)
    if xa.std(ddof=1)==0 or ya.std(ddof=1)==0: return None
    r=float(np.corrcoef(xa,ya)[0,1])
    t=None if abs(r)>=1 else r*((n-2)/(1-r*r))**0.5
    return {'n':n,'r':r,'t':t,'df':n-2,'p':_t_two_sided(t,n-2) if t is not None else None}


def _fisher_ci(r, n, level=0.95):
    import math
    if n<=3 or abs(r)>=1: return (None,None)
    z=math.atanh(r); se=1.0/math.sqrt(n-3)
    critical=t_critical(n-3, level) or 1.959963984540054
    return (math.tanh(z-critical*se), math.tanh(z+critical*se))


def _bh(rows, key='p'):
    """Benjamini–Hochberg：按 p 排序后逐步放大 q 值，返回同顺序的校正 p。"""
    indexed=[(i,row[key]) for i,row in enumerate(rows) if row.get(key) is not None]
    if not indexed: return
    indexed.sort(key=lambda item: item[1])
    total=len(indexed); previous=1.0
    adjusted={}
    for rank,(index,p) in enumerate(reversed(indexed),start=1):
        q=min(previous, p*total/(total-rank+1))
        previous=q
        adjusted[index]=min(1.0,q)
    for index,value in adjusted.items(): rows[index][key+'_adjusted']=value


def _fisher_ci_with_df(r, n, df, level=0.95):
    import math
    if n <= 3 or abs(r) >= 1 or df <= 1: return (None, None)
    z = math.atanh(r); se = 1.0 / math.sqrt(n - 3)
    critical = t_critical(df, level) or 1.959963984540054
    return (math.tanh(z - critical * se), math.tanh(z + critical * se))


def _partial_stats(frame, x, y, controls):
    """偏相关：用安全内部矩阵做残差化，自由度按控制设计秩扣除。

    列名不进入公式，因此空格、中文、符号列名都安全；控制变量共线时按设计秩计算，
    秩满时等价于普通偏相关，秩亏时 df 相应减少而不是假装满秩。
    """
    import numpy as np
    xv = frame[x].to_numpy(dtype=float); yv = frame[y].to_numpy(dtype=float)
    controls_matrix = frame[controls].to_numpy(dtype=float)
    design = np.column_stack([np.ones(len(frame)), controls_matrix]) if controls_matrix.size else np.ones((len(frame), 1))
    rank = int(np.linalg.matrix_rank(design))
    rx = xv - design @ np.linalg.lstsq(design, xv, rcond=None)[0]
    ry = yv - design @ np.linalg.lstsq(design, yv, rcond=None)[0]
    stats = _pearson(rx, ry)
    if not stats: return None
    df = stats['n'] - 2 - max(0, rank - 1)
    if df <= 0: return {'n': stats['n'], 'r': stats['r'], 't': None, 'df': df, 'p': None}
    r = stats['r']
    t = None if abs(r) >= 1 else r * (df / max(1e-12, 1 - r * r)) ** 0.5
    return {'n': stats['n'], 'r': r, 't': t, 'df': df, 'p': _t_two_sided(t, df) if t is not None else None}


def correlation(data, plan):
    import numpy as np
    import pandas as pd
    spec=plan['correlation']
    columns=spec['columns']; method=spec.get('method','pearson'); partial=spec.get('partial') or []
    by=spec.get('by') or []
    gate=int((plan.get('gate') or {}).get('minSubjects',30))
    frame=data[[plan['idColumn']]+columns+partial+by].dropna()
    scopes=[('整体', frame)]
    if by:
        for key, group in frame.groupby(by, dropna=True):
            label=key if isinstance(key,str) else '|'.join(str(item) for item in (key if isinstance(key,tuple) else [key]))
            scopes.append((str(label), group))
    rows=[]; skipped=[]
    for scope, frame_scope in scopes:
        # 每个 scope 独立判门槛：整体 40 人不能给一个只有 4 个观测的分组放行。
        if len(frame_scope) < gate:
            skipped.append({'scope': scope, 'eligible': int(len(frame_scope))})
            continue
        values = frame_scope.copy()
        if method == 'spearman':
            # Spearman 的受支持定义：先把所有参与变量（含控制变量）转成秩，再残差化。
            for column in columns + partial:
                values[column] = values[column].rank()
        for i in range(len(columns)):
            for j in range(i+1,len(columns)):
                x=columns[i]; y=columns[j]
                if partial:
                    stats=_partial_stats(values, x, y, partial)
                    if not stats: continue
                    low, high=_fisher_ci_with_df(stats['r'], stats['n'], stats['df'])
                else:
                    stats=_pearson(values[x], values[y])
                    if not stats: continue
                    low, high=_fisher_ci(stats['r'], stats['n'])
                rows.append({'scope':scope,'x':x,'y':y,'method':method,'partial':','.join(partial) or None,
                             'n':stats['n'],'r':stats['r'],'ciLow':low,'ciHigh':high,'t':stats['t'],'df':stats['df'],'p':stats['p']})
    if spec.get('correct')=='bh': _bh(rows)
    return {'rows': rows, 'skipped': skipped}


def reliability(data, plan):
    import numpy as np
    import pandas as pd
    rows=[]
    for spec in plan['reliability']:
        items=spec['items']; reverse=spec.get('reverse') or []
        frame=data[items].apply(pd.to_numeric, errors='coerce')
        declared=spec.get('range')
        if declared:
            low, high = float(declared[0]), float(declared[1])
            endpoint_source='declared'
        else:
            low, high = float(frame.min().min()), float(frame.max().max())
            endpoint_source='observed'
        for column in reverse:
            if column in frame.columns:
                # 反向题按量尺端点翻转（1—5 → 6−x）；样本端点只在方案未声明量尺时兜底。
                frame[column]=low + high - frame[column]
        frame=frame.dropna()
        n=len(frame); k=len(items)
        name=spec.get('name') or '+'.join(items)
        if n<3 or k<2:
            rows.append({'name':name,'n':n,'k':k,'alpha':None,'missing':int(len(data)-n),'reverseSource':endpoint_source})
            continue
        total=frame.sum(axis=1)
        if float(total.var(ddof=1))<=0:
            rows.append({'name':name,'n':n,'k':k,'alpha':None,'missing':int(len(data)-n),'reverseSource':endpoint_source})
            continue
        alpha=k/(k-1)*(1-float(frame.var(ddof=1).sum())/float(total.var(ddof=1)))
        # 题总相关采用 corrected item-total（该题与"其余题目之和"的相关），不再包含自身。
        item_total=[float(np.corrcoef(frame[item], total-frame[item])[0,1]) for item in items]
        inter=[float(np.corrcoef(frame[a], frame[b])[0,1]) for i,a in enumerate(items) for b in items[i+1:]]
        rows.append({'name':name,'n':n,'k':k,'alpha':alpha,
                     'itemTotalMin':min(item_total),'itemTotalMax':max(item_total),
                     'meanInterItem':float(np.mean(inter)) if inter else None,
                     'missing':int(len(data)-n),'reverseSource':endpoint_source,
                     'itemTotalType':'corrected'})
    return rows


def ttest(data, plan):
    import numpy as np
    import pandas as pd
    spec=plan['ttest']; kind=spec.get('kind','independent'); outcome=spec.get('outcome') or plan['outcome']
    rows=[]
    values=pd.to_numeric(data[outcome], errors='coerce')
    if kind=='one-sample':
        sample=values.dropna(); n=len(sample); mu=float(spec['mu'])
        if n<3: raise ValueError('one-sample ttest needs at least three observations')
        mean=float(sample.mean()); sd=float(sample.std(ddof=1)); se=sd/np.sqrt(n)
        if sd == 0:
            raise ValueError(f'单样本 t 检验不可估计：样本零方差（n={n}，全部观测相同）')
        t=(mean-mu)/se
        critical=t_critical(n-1) or 1.959963984540054
        rows.append({'kind':'单样本','comparison':f'{outcome} vs {mu}','n':n,'mean1':mean,'mean2':mu,'meanDiff':mean-mu,
                     'se':se,'t':t,'df':n-1,'p':_t_two_sided(t,n-1),'ciLow':(mean-mu)-critical*se,'ciHigh':(mean-mu)+critical*se,
                     'cohenD':(mean-mu)/sd if sd>0 else None})
    else:
        group=spec['group']
        levels=[str(item) for item in data[group].dropna().unique()]
        if len(levels)!=2: raise ValueError(f'ttest.group 需要恰好两个水平，当前 {len(levels)} 个')
        left=pd.to_numeric(data.loc[data[group].astype(str)==levels[0], outcome], errors='coerce').dropna()
        right=pd.to_numeric(data.loc[data[group].astype(str)==levels[1], outcome], errors='coerce').dropna()
        if len(left)<2 or len(right)<2: raise ValueError('每组至少需要两个有效观测')
        n1,n2=len(left),len(right)
        m1,m2=float(left.mean()),float(right.mean()); sd1,sd2=float(left.std(ddof=1)),float(right.std(ddof=1))
        se=np.sqrt(sd1**2/n1+sd2**2/n2)
        if se == 0:
            raise ValueError('独立样本 t 检验不可估计：两组合并标准误为 0（每组方差均为 0）')
        t=(m1-m2)/se
        df=(sd1**2/n1+sd2**2/n2)**2/((sd1**2/n1)**2/(n1-1)+(sd2**2/n2)**2/(n2-1)) if se>0 else None
        pooled=np.sqrt(((n1-1)*sd1**2+(n2-1)*sd2**2)/(n1+n2-2)) if n1+n2>2 else None
        critical=t_critical(df) if df else None
        rows.append({'kind':'独立样本（Welch）','comparison':f'{levels[0]} vs {levels[1]}','n':n1+n2,'mean1':m1,'mean2':m2,
                     'meanDiff':m1-m2,'se':se,'t':t,'df':df,'p':_t_two_sided(t,df) if t is not None and df else None,
                     'ciLow':(m1-m2)-critical*se if critical else None,'ciHigh':(m1-m2)+critical*se if critical else None,
                     'cohenD':(m1-m2)/pooled if pooled and pooled>0 else None})
    return rows


def anova(data, plan):
    import numpy as np
    import pandas as pd
    import statsmodels.api as sm
    import statsmodels.formula.api as smf
    spec=plan['anova']; factors=spec['factors']; outcome=spec.get('outcome') or plan['outcome']
    frame=data[[outcome]+factors].dropna().copy()
    frame[outcome]=pd.to_numeric(frame[outcome], errors='coerce')
    frame=frame.dropna()
    if len(frame)<4: raise ValueError('anova needs at least four complete rows')
    formula=f'_y ~ '+' + '.join(f'C({factor})' for factor in factors)
    if len(factors)==2: formula+=f' + C({factors[0]}):C({factors[1]})'
    model=smf.ols(formula, data=frame.rename(columns={outcome:'_y'})).fit()
    typ={'I':1,'II':2,'III':3}.get(str(spec.get('sumsOfSquares','II')).upper(),2)
    table=sm.stats.anova_lm(model, typ=typ)
    residual=float(table.loc['Residual','sum_sq']) if 'Residual' in table.index else None
    rows=[]
    for term,row in table.iterrows():
        if str(term)=='Residual': continue
        ss=float(row['sum_sq'])
        rows.append({'term':str(term),'df':float(row['df']),'sumSq':ss,'F':float(row['F']),
                     'p':float(row['PR(>F)']) if row['PR(>F)'] is not None else None,
                     'partialEtaSquared':(ss/(ss+residual) if residual and (ss+residual)>0 else None),
                     'n':int(model.nobs)})
    return rows


def mediation(data, plan):
    import numpy as np
    import pandas as pd
    import statsmodels.formula.api as smf
    spec=plan['mediation']; x=spec['x']; m=spec['m']; y=spec['y']
    covariates=spec.get('covariates') or []
    bootstrap=int(spec.get('bootstrap',1000)); seed=spec.get('seed')
    frame=data[[x,m,y]+covariates].dropna().copy()
    for column in [x,m,y]+covariates:
        frame[column]=pd.to_numeric(frame[column], errors='coerce')
    frame=frame.dropna()
    n=len(frame)
    if n<10: raise ValueError('mediation needs at least ten complete rows')
    controls=(' + '+' + '.join(covariates)) if covariates else ''
    a_model=smf.ols(f'_m ~ {x}'+controls, data=frame.rename(columns={m:'_m'})).fit()
    b_model=smf.ols(f'_y ~ {m} + {x}'+controls, data=frame.rename(columns={y:'_y'})).fit()
    total_model=smf.ols(f'_y ~ {x}'+controls, data=frame.rename(columns={y:'_y'})).fit()
    a=float(a_model.params[x]); b=float(b_model.params[m]); c_prime=float(b_model.params[x]); total=float(total_model.params[x])
    indirect=a*b
    rng=np.random.default_rng(seed)
    estimates=[]
    for _ in range(bootstrap):
        sample=frame.sample(n=n, replace=True, random_state=int(rng.integers(0,2**31-1)))
        try:
            a_fit=smf.ols(f'_m ~ {x}'+controls, data=sample.rename(columns={m:'_m'})).fit()
            b_fit=smf.ols(f'_y ~ {m} + {x}'+controls, data=sample.rename(columns={y:'_y'})).fit()
            estimates.append(float(a_fit.params[x])*float(b_fit.params[m]))
        except Exception:
            continue
    low=float(np.percentile(estimates,2.5)) if estimates else None
    high=float(np.percentile(estimates,97.5)) if estimates else None
    rows=[
        {'effect':'a（X→M）','estimate':a,'se':float(a_model.bse[x]),'ciLow':None,'ciHigh':None,'p':float(a_model.pvalues[x]),'n':n},
        {'effect':'b（M→Y）','estimate':b,'se':float(b_model.bse[m]),'ciLow':None,'ciHigh':None,'p':float(b_model.pvalues[m]),'n':n},
        {'effect':'c′（X→Y，控制 M）','estimate':c_prime,'se':float(b_model.bse[x]),'ciLow':None,'ciHigh':None,'p':float(b_model.pvalues[x]),'n':n},
        {'effect':'间接效应 a×b','estimate':indirect,'se':float(np.std(estimates,ddof=1)) if len(estimates)>1 else None,'ciLow':low,'ciHigh':high,'p':None,'n':n},
        {'effect':'总效应 c','estimate':total,'se':float(total_model.bse[x]),'ciLow':None,'ciHigh':None,'p':float(total_model.pvalues[x]),'n':n},
        {'effect':'中介比例 |a×b/c|','estimate':abs(indirect/total) if total else None,'se':None,'ciLow':None,'ciHigh':None,'p':None,'n':n},
    ]
    return rows


SCRIPT_RUNNER = r'''
import sys
from pathlib import Path
import pandas as pd

data_path = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
code_path = Path(sys.argv[3])
out_dir.mkdir(parents=True, exist_ok=True)
header = pd.read_csv(data_path, nrows=0)
dtype = {'subjectid': str} if 'subjectid' in header.columns else None
data = pd.read_csv(data_path, dtype=dtype)


def save(name, frame):
    target = out_dir / (str(name).strip().replace(' ', '_') + '.csv')
    frame.to_csv(target, index=False)
    return target


source = code_path.read_text(encoding='utf-8')
namespace = {'data': data, 'save': save, 'pd': pd, 'Path': Path, 'out_dir': out_dir, '__name__': '__main__'}
exec(compile(source, 'user-script', 'exec'), namespace)
analyze = namespace.get('analyze')
if callable(analyze):
    result = analyze(data, out_dir)
    if result is not None:
        try:
            result.to_csv(out_dir / 'result.csv', index=False)
        except Exception:
            pass
'''


def run_script(data, plan):
    """运行用户脚本：脚本拿到 data（DataFrame）与 save(name, frame)，产出的 CSV 成为报告表格。"""
    import re
    import shutil
    import subprocess
    import sys as _sys
    import tempfile
    import pandas as pd
    spec = plan['script']
    work = Path(tempfile.mkdtemp(prefix='analysis-script-'))
    try:
        data_path = work / 'data.csv'
        data.to_csv(data_path, index=False)
        code = str(spec.get('code') or '')
        if not code:
            file_path = Path(str(spec.get('file') or ''))
            if not file_path.is_file():
                raise ValueError(f'脚本文件不存在：{file_path}')
            code = file_path.read_text(encoding='utf-8')
        code_path = work / 'user.py'
        code_path.write_text(code, encoding='utf-8')
        runner = work / 'runner.py'
        runner.write_text(SCRIPT_RUNNER, encoding='utf-8')
        tables_dir = work / 'tables'
        tables_dir.mkdir()
        try:
            result = subprocess.run([_sys.executable, '-X', 'utf8', str(runner), str(data_path), str(tables_dir), str(code_path)],
                                    capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            raise ValueError('脚本运行超过 180 秒，已中止')
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or '未知错误').strip()
            raise ValueError('脚本执行失败：' + detail[-800:])
        files = sorted(tables_dir.glob('*.csv'))
        if not files:
            raise ValueError('脚本没有产出任何表：请在脚本里调用 save("名称", 数据框)')
        tables = []
        for index, file in enumerate(files):
            frame = pd.read_csv(file)
            key = 'script' if index == 0 else 'script_' + re.sub(r'[^A-Za-z0-9]+', '_', file.stem).strip('_').lower()
            rows = [{str(name): (value.item() if hasattr(value, 'item') else value) for name, value in record.items()}
                    for record in frame.to_dict('records')]
            tables.append({'key': key, 'label': file.stem, 'rows': rows})
        return {'tables': tables, 'stdout': (result.stdout or '').strip()[-1000:]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def eligible_ids(data, plan, module):
    """模块实际可用的独立参与者编号（已按该模块声明列做完整观测过滤）。

    预览、门槛和执行都用它，避免"整体 40 人放行、实际只有 4 个观测"。
    """
    idcol = plan['idColumn']
    columns = {column: data[column] for column in data.columns}
    def ids(frame):
        return sorted({str(value) for value in frame[idcol].dropna()})
    if module in ('sample', 'sensitivity', 'descriptives', 'script'):
        return ids(data)
    if module == 'correlation':
        spec = plan['correlation']
        use = [column for column in spec['columns'] + (spec.get('partial') or []) if column in columns]
        frame = data.dropna(subset=use) if use else data
        if spec.get('by'):
            frame = frame.dropna(subset=[column for column in spec['by'] if column in columns])
        return ids(frame)
    if module == 'reliability':
        items = [item for spec in plan['reliability'] for item in spec['items'] if item in columns]
        return ids(data.dropna(subset=items))
    if module == 'ttest':
        spec = plan['ttest']
        use = [spec.get('outcome') or plan['outcome']]
        if spec.get('kind', 'independent') == 'independent':
            use.append(spec['group'])
        return ids(data.dropna(subset=[column for column in use if column in columns]))
    if module == 'anova':
        spec = plan['anova']
        use = [spec.get('outcome') or plan['outcome']] + spec['factors']
        return ids(data.dropna(subset=[column for column in use if column in columns]))
    if module == 'mediation':
        spec = plan['mediation']
        use = [spec['x'], spec['m'], spec['y']] + (spec.get('covariates') or [])
        return ids(data.dropna(subset=[column for column in use if column in columns]))
    if module == 'paired':
        if plan.get('layout', 'wide') == 'wide':
            return ids(data.dropna(subset=plan.get('pairedColumns', [])))
        within = plan.get('within') or {}
        levels = within.get('levels', [])
        if len(levels) == 2:
            subset = data[data[within['column']].isin(levels)].dropna(subset=[plan['outcome']])
            counts = subset.groupby(idcol)[within['column']].nunique()
            return sorted({str(value) for value in counts[counts.eq(2)].index})
        return []
    if module == 'mixed':
        within = plan.get('within') or {}
        use = [plan['outcome'], within.get('column', '')] + (plan.get('groupColumns') or []) + (plan.get('covariates') or [])
        return ids(data.dropna(subset=[column for column in use if column in columns]))
    cols = [plan['outcome']] + (plan.get('groupColumns') or []) + (plan.get('covariates') or [])
    return ids(data.dropna(subset=[column for column in cols if column in columns]))


def eligible_subjects(data, plan, module):
    return len(eligible_ids(data, plan, module))


def table_frame(rows):
    import pandas as pd
    return pd.DataFrame(rows)


def render(meta,tables):
    lines=[f"# {meta['study']['name']} — analysis",'',f"Run: {meta['runId']}",f"Status: {meta['status']}",
           f"Independent participants: {meta.get('subjects',0)}; observations: {meta.get('observations',0)}",'',
           f"Gate: at least {meta['plan'].get('gate',{}).get('minSubjects',30)} complete eligible participants for each inferential module.",'']
    for module,node in meta['nodes'].items():
        lines += [f"## {module}",'',f"Status: {node['status']}. {node.get('reason','')}",'']
        value=node.get('result') or {}
        if value:
            lines += [f"Participants: {value.get('subjects','—')}; observations: {value.get('observations','—')}",'']
            if 'estimate' in value: lines += [f"Estimate: {value['estimate']:.8g}; 95% CI [{value['ciLow']:.8g}, {value['ciHigh']:.8g}]; p = {value['p']:.8g}",'']
    for table in tables:
        lines += [f"## {table['label']}",'','| '+' | '.join(table['columns'])+' |','|'+'|'.join('---' for _ in table['columns'])+'|']
        for row in table['rows']:
            lines += ['| '+' | '.join('' if value is None else (f'{value:.8g}' if isinstance(value,float) else str(value).replace('|','\\|').replace('\n',' ')) for value in row)+' |']
        lines += ['']
    return '\n'.join(lines)


CACHE_REQUIRED_ARTIFACTS = ('input.csv', 'plan.json', 'study.json', 'exclusions.json', 'environment.json', 'model.json', 'report.md')


def cache_artifacts_ok(entry, meta):
    """完整缓存校验：必需文件齐全、artifactHashes 全部命中且没越出 runDir。

    旧 run 没有 artifactHashes 时不再当作可信缓存（转新 run），避免只凭 meta 状态复用
    一个输入/模型/报告可能已损坏的历史运行。
    """
    hashes = meta.get('artifactHashes')
    if not isinstance(hashes, dict) or not hashes: return False
    if not (entry / 'input.csv').is_file(): return False
    if sha(entry / 'input.csv') != str(meta.get('source', {}).get('sha256') or ''): return False
    root = entry.resolve()
    for relative, expected in hashes.items():
        target = entry / relative
        try:
            resolved = target.resolve()
        except Exception:
            return False
        if resolved != root and root not in resolved.parents: return False  # 路径穿越/越界 symlink
        if not target.is_file(): return False
        if sha(target) != str(expected): return False
    for name in CACHE_REQUIRED_ARTIFACTS:
        if name not in hashes: return False
    for table in meta.get('tables', []) or []:
        relative = table.get('path')
        if not relative: continue
        if relative not in hashes: return False
        if table.get('sha256') and hashes.get(relative) != table['sha256']: return False
    return True


def find_cached_run(runs, fingerprint):
    """同输入 + 同方案 + 同代码 + 同环境的历史运行可直接复用，不重复计算。"""
    if not runs.is_dir():
        return None
    for entry in sorted(runs.iterdir(), key=lambda item: item.name, reverse=True):
        if not entry.is_dir():
            continue
        meta_path = entry / 'meta.json'
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if meta.get('fingerprint') == fingerprint and meta.get('status') in ('ok', 'partial'):
            # 产物缺失/损坏的旧 run 不复用，也不改写它；本次直接新建 run。
            if cache_artifacts_ok(entry, meta): return meta
            continue
    return None


def run(request):
    import warnings
    import pandas as pd
    plan=validate(request['plan']); root=Path(request['outputDir'])
    if not root.is_absolute(): raise ValueError('outputDir must be absolute')
    source=Path(plan['dataPath'])
    if not source.is_file(): raise ValueError('dataPath does not exist')
    exclusions=request.get('exclusions',[])
    env=environment()
    code_hashes={Path(__file__).name: sha(Path(__file__).resolve())}
    script_code={}
    script_plan=plan.get('script')
    if isinstance(script_plan,dict) and script_plan.get('file'):
        script_path=Path(str(script_plan['file']))
        if not script_path.is_absolute(): raise ValueError('script.file must be absolute')
        if not script_path.is_file(): raise ValueError('script.file not found')
        text=script_path.read_text(encoding='utf-8')
        script_plan={**script_plan,'code':text,'file':None,'sourceName':script_path.name}
        plan['script']=script_plan
        script_code[script_path.name]=text
        code_hashes['script:'+script_path.name]=hashlib.sha256(text.encode()).hexdigest()
    for raw in request.get('scriptPaths',[]):
        path=Path(raw)
        if not path.is_file(): raise ValueError(f'code snapshot missing: {path.name}')
        if path.name in code_hashes: raise ValueError('code snapshot basename conflict')
        code_hashes[path.name]=sha(path)
    fingerprint=canonical({'source':sha(source),'plan':plan,'study':request['study'],'exclusions':exclusions,
                           'code':code_hashes,'script':{name:hashlib.sha256(text.encode()).hexdigest() for name,text in script_code.items()},
                           'engine':VERSION,'environment':canonical(lock_signature(env)),
                           'dataset':(request.get('dataset') or {}).get('hash')})
    runs=root/'runs'; runs.mkdir(parents=True,exist_ok=True)
    # 环境锁先于缓存检查：锁漂移时必须失败，不能拿旧缓存顶替。
    policy=str(request.get('environmentPolicy') or 'check')
    lock_file=root/'environment.lock.json'
    lock_state='matched'
    if policy!='record' and lock_file.is_file():
        lock=json.loads(lock_file.read_text(encoding='utf-8'))
        problems=check_lock(env,lock)
        if problems:
            raise ValueError('分析环境与锁不一致：'+'；'.join(problems)+'（确认后可用 environmentPolicy=record 重建锁）')
    elif policy=='record' or not lock_file.is_file():
        lock_state='created'
    if not (request.get('force') or request.get('forceRecompute')):
        cached=find_cached_run(runs,fingerprint)
        if cached:
            if lock_state=='created':
                save(lock_file,{**lock_signature(env),'createdAt':now(),'engineVersion':VERSION})
            return {'ok':True,'reused':True,'runId':cached.get('runId'),'runDir':str(runs/str(cached.get('runId'))),
                    'meta':cached,'summaryText':f"{cached.get('runId')}: reused (same input/plan/code/environment); "
                                               f"{cached.get('subjects',0)} participants, {cached.get('observations',0)} observations"}
    run_id=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:10]
    run_dir=runs/run_id; run_dir.mkdir() # Never reuse or mutate a completed run.
    meta={'schemaVersion':1,'engineVersion':VERSION,'runId':run_id,'study':request['study'],'plan':plan,
          'startedAt':now(),'finishedAt':None,'status':'running','nodes':{},'tables':[],'warnings':[],
          'source':{'path':str(source),'sha256':sha(source)},'revisionOf':request.get('revisionOf'),
          'fingerprint':fingerprint,'dataset':request.get('dataset'),
          'process':{'pid':os.getpid(),'hostname':platform.node()}}
    try:
        shutil.copyfile(source,run_dir/'input.csv')
        if sha(run_dir/'input.csv')!=meta['source']['sha256']: raise ValueError('input changed while snapshotting')
        save(run_dir/'plan.json',plan); save(run_dir/'study.json',request['study'])
        save(run_dir/'exclusions.json',exclusions)
        save(run_dir/'environment.json',env)
        meta['environmentHash']=canonical(lock_signature(env))
        if lock_state!='matched':
            save(lock_file,{**lock_signature(env),'createdAt':now(),'engineVersion':VERSION})
        meta['environmentLock']={'state':lock_state,'path':str(lock_file)}
        if request.get('seeds'): meta['seeds']=request['seeds']
        code_dir=run_dir/'code'; code_dir.mkdir()
        code_sources=[Path(__file__).resolve()]+[Path(path) for path in request.get('scriptPaths',[])]
        copied_hashes={}
        for path in code_sources:
            if not path.is_file(): raise ValueError(f'code snapshot missing: {path.name}')
            if path.name in copied_hashes: raise ValueError('code snapshot basename conflict')
            shutil.copyfile(path,code_dir/path.name); copied_hashes[path.name]=sha(code_dir/path.name)
        for name,text in script_code.items():
            target=code_dir/name
            if target.name in copied_hashes: raise ValueError('code snapshot basename conflict')
            target.write_text(text,encoding='utf-8'); copied_hashes['script:'+name]=hashlib.sha256(text.encode()).hexdigest()
        # 代码在快照期间被改过就重算 fingerprint，不复用旧缓存。
        if canonical(copied_hashes)!=canonical(code_hashes):
            code_hashes=copied_hashes
            meta['fingerprint']=canonical({'source':meta['source']['sha256'],'plan':plan,'study':request['study'],
                                           'exclusions':exclusions,'code':code_hashes,'engine':VERSION,
                                           'environment':canonical(lock_signature(env))})
        meta['codeHashes']=code_hashes
        save(run_dir/'meta.json',meta)
        try:
            data, transform_ops = read_data(run_dir/'input.csv',plan)
        except Exception as error:
            meta['nodes']['prepare']={'status':'failed','dependsOn':[],'reason':str(error)}
            for module in MODULES:
                meta['nodes'][module]={'status':'cancelled','dependsOn':['prepare'],'reason':'上游准备失败'}
            raise
        meta['nodes']['prepare']={'status':'executed','dependsOn':[],'reason':'',
                                   'result':{'transforms':transform_ops,'rows':len(data)}}
        excluded={row['id'] for row in exclusions}
        data=data[~data[plan['idColumn']].isin(excluded)].copy()
        meta.update(subjects=int(data[plan['idColumn']].nunique()),observations=len(data),excludedIds=sorted(excluded))
        (run_dir/'tables').mkdir()
        tables=[]
        def put(key,label,rows,analysis_set=None):
            rows=clean(rows)
            if not rows: return
            frame=pd.DataFrame(rows)
            relative=f'tables/{key}.csv'; frame.to_csv(run_dir/relative,index=False,encoding='utf-8-sig')
            types={column: ('number' if any(isinstance(row.get(column),(int,float)) and not isinstance(row.get(column),bool) for row in rows) else 'string') for column in frame.columns}
            tables.append({'key':key,'label':label,'columns':list(frame.columns),'rows':frame.astype(object).where(frame.notna(),None).values.tolist(),'path':relative,'sha256':sha(run_dir/relative),'types':types,'analysisSet':analysis_set})
        minimum=plan.get('gate',{}).get('minSubjects',30)
        functions={'descriptives':describe,'sample':sample_table,'sensitivity':sensitivity_table,'correlation':correlation,'reliability':reliability,'ttest':ttest,'anova':anova,'mediation':mediation,'script':run_script,'regression':regression,'paired':paired,'mixed':mixed}
        chosen=plan.get('analyses') or ['descriptives']
        for module in MODULES:
            if module not in chosen:
                meta['nodes'][module]={'status':'not_run','dependsOn':['prepare'],'reason':'not selected in plan'}; continue
            missing_backend=[name for name in BACKENDS.get(module,()) if not (env.get('packages') or {}).get(name)]
            if missing_backend:
                meta['nodes'][module]={'status':'not_run','dependsOn':['prepare'],'reason':'环境待准备：缺少 '+', '.join(missing_backend)}
                continue
            try:
                frame, schema = prepare_frame(data, plan, module)
                ids = eligible_ids(frame, plan, module)
                eligible=len(ids)
                if module not in ('descriptives', 'sample', 'sensitivity', 'script') and eligible<minimum:
                    meta['nodes'][module]={'status':'not_run','dependsOn':['prepare'],'reason':f'{eligible} eligible participants < gate {minimum}','eligibleSubjects':eligible}
                    continue
                aset = {'id': canonical({'module': module, 'ids': ids, 'columns': schema['required']})[:16], 'subset': plan.get('subset') or 'enrolled', 'subjects': eligible, 'n': eligible, 'observations': int(len(frame)), 'columns': schema['required'], 'ruleVersion': VERSION}
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter('always')
                    value=clean(functions[module](frame,plan))
                meta['warnings'] += [f'{module}: {warning.message}' for warning in caught]
                if module=='descriptives':
                    put('descriptives','Descriptive statistics',value,aset)
                    if plan.get('frequencies'):
                        put('frequencies','Frequency tables',frequencies(frame,plan),aset)
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':{'subjects':meta['subjects'],'observations':meta['observations']}}
                elif module=='sample':
                    put('sample','Sample characteristics',value,aset)
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':{'subjects':meta['subjects'],'rows':len(value)}}
                elif module=='sensitivity':
                    put('sensitivity','Sensitivity: complete cases',value,aset)
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':{'rows':len(value)}}
                elif module=='correlation' and isinstance(value,dict) and isinstance(value.get('rows'),list):
                    put('correlation','Correlation',value['rows'],aset)
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':{'rows':len(value['rows']),'skippedScopes':value.get('skipped') or []}}
                elif module=='script' and isinstance(value,dict) and isinstance(value.get('tables'),list):
                    for table in value['tables']:
                        put(table['key'], table.get('label') or table['key'], table['rows'],aset)
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':{'tables':len(value['tables']),'stdout':str(value.get('stdout') or '')[:400]}}
                elif isinstance(value,list):
                    put(module,module,value,aset)
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':{'rows':len(value)}}
                else:
                    meta['nodes'][module]={'status':'executed','dependsOn':['prepare'],'reason':'','result':value}
                    if module=='regression' and value.get('coefficients'):
                        put('regression','Regression / ANCOVA',value['coefficients'],aset)
                        if value.get('anova'): put('anova','ANOVA / omnibus tests',value['anova'],aset)
                        if value.get('contrasts'): put('contrasts','Planned contrasts',value['contrasts'],aset)
                    elif value.get('coefficients'): put(module,module,value['coefficients'],aset)
                    else: put(module,module,[{k:v for k,v in value.items() if k!='subjectIds'}],aset)
                node = meta['nodes'].get(module)
                if isinstance(node, dict) and node.get('status') == 'executed':
                    base = node.get('result') if isinstance(node.get('result'), dict) else {}
                    node['result'] = {**base, 'analysisSet': aset}
            except Exception as error:
                meta['nodes'][module]={'status':'failed','dependsOn':['prepare'],'reason':str(error)}
        charts={}
        import numpy as np
        try:
            if 'descriptives' in chosen:
                frame, schema = prepare_frame(data, plan, 'descriptives')
                ids = set(eligible_ids(frame, plan, 'descriptives'))
                subset = frame[frame[plan['idColumn']].astype(str).isin(ids)]
                groups = plan.get('groupColumns') or []
                outcome = plan['outcome']
                grouped = {}
                for _, row in subset.iterrows():
                    value = row[outcome]
                    if value is None or (isinstance(value, float) and not np.isfinite(value)):
                        continue
                    label = ' × '.join(str(row[group]) for group in groups) if groups else '整体'
                    grouped.setdefault(label, []).append(float(value))
                node = meta['nodes'].get('descriptives') or {}
                set_info = (node.get('result') or {}).get('analysisSet') or {}
                plotted = sum(len(values) for values in grouped.values())
                charts['distribution'] = {'outcome': outcome, 'analysisSetId': set_info.get('id'), 'n': int(plotted),
                                          'groups': [{'label': label, 'values': values} for label, values in grouped.items()]}
        except Exception as error:
            charts['distribution'] = {'error': str(error)}
        try:
            if 'paired' in chosen:
                frame, schema = prepare_frame(data, plan, 'paired')
                pairs = []
                if plan.get('layout', 'wide') == 'wide' and len(plan.get('pairedColumns') or []) == 2:
                    before, after = plan['pairedColumns']
                    subset = frame.dropna(subset=[before, after])
                    pairs = [{'id': str(row[plan['idColumn']]), 'before': float(row[before]), 'after': float(row[after])} for _, row in subset.iterrows()]
                elif plan.get('layout') == 'long' and len((plan.get('within') or {}).get('levels') or []) == 2:
                    within = plan['within']; levels = within['levels']; outcome = plan['outcome']
                    pivot = frame[frame[within['column']].isin(levels)].pivot_table(index=plan['idColumn'], columns=within['column'], values=outcome, aggfunc='first')
                    subset = pivot.dropna(subset=levels)
                    pairs = [{'id': str(index), 'before': float(row[levels[0]]), 'after': float(row[levels[1]])} for index, row in subset.iterrows()]
                node = meta['nodes'].get('paired') or {}
                set_info = (node.get('result') or {}).get('analysisSet') or {}
                charts['paired'] = {'pairs': pairs, 'analysisSetId': set_info.get('id'), 'n': len(pairs)}
        except Exception as error:
            charts['paired'] = {'error': str(error)}
        meta['charts'] = charts
        meta['status']='partial' if any(v['status']=='failed' for v in meta['nodes'].values()) else 'ok'
        meta['tables']=[{k:v for k,v in table.items() if k not in ('columns','rows')} for table in tables]
        meta['finishedAt']=now()
        save(run_dir/'model.json',clean(meta['nodes']))
        (run_dir/'report.md').write_text(render(meta,tables),encoding='utf-8')
        meta['artifactHashes']={str(path.relative_to(run_dir)).replace('\\','/'):sha(path) for path in run_dir.rglob('*') if path.is_file() and path.name!='meta.json'}
        save(run_dir/'meta.json',clean(meta))
        return {'ok':True,'runId':run_id,'runDir':str(run_dir),'meta':clean(meta),'summaryText':f"{run_id}: {meta['status']}; {meta['subjects']} participants, {meta['observations']} observations"}
    except Exception as error:
        meta.update(status='failed',finishedAt=now(),error=str(error))
        save(run_dir/'meta.json',clean(meta))
        return {'ok':False,'runId':run_id,'runDir':str(run_dir),'error':str(error),'meta':clean(meta)}


def preview(request):
    """不落盘的分析预览：给方案向导返回列名、可用的人数与模块。"""
    plan=validate(request['plan'])
    source=Path(plan['dataPath'])
    if not source.is_file(): raise ValueError('dataPath does not exist')
    data,_ops=read_data(str(source),plan)
    modules={}
    for module in plan.get('analyses',[]):
        entry={'backends':BACKENDS.get(module,())}
        try:
            frame, schema = prepare_frame(data, plan, module)
            entry['eligible']=len(eligible_ids(frame, plan, module))
            entry['columns']=schema['required']
        except Exception as error:
            entry['eligible']=None
            entry['error']=str(error)
        modules[module]=entry
    return {'ok':True,'columns':[str(column) for column in data.columns],'rows':int(len(data)),'modules':modules}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--request-json',required=True)
    args=parser.parse_args()
    try:
        request=json.loads(args.request_json)
        if request.get('action')=='probe': result={'ok':True,'version':VERSION,'environment':environment()}
        elif request.get('action')=='preview': result=preview(request)
        else: result=run(request)
    except Exception as error: result={'ok':False,'error':str(error)}
    print('===JSON===')
    print(json.dumps(clean(result),ensure_ascii=False,allow_nan=False))
    return 0 if result['ok'] else 1

if __name__=='__main__': sys.exit(main())
