# analysis-run 自带的统计后端（vendor）

插件把统计后端装在自己的目录里，不依赖 DSH 运行时是否 pip 过 scipy/statsmodels。

## 目录

```
vendor/
  wheels/              离线 wheel（约 47 MB，随插件保存）
  site-packages/       安装结果（约 192 MB，由 install.mjs 生成，可随时重建）
  manifest.json        解释器信息 + 已装版本 + 来源 wheel
  install.mjs          安装 / 检查脚本
```

运行时插件把 `vendor/site-packages` 放进 `PYTHONPATH`（优先于运行时的 site-packages），所以：
- scipy / statsmodels / patsy / formulaic / interface_meta / narwhals / wrapt / packaging 来自本目录；
- **numpy / pandas 仍由 DSH 运行时提供**（不重复内置，避免两份二进制包冲突）。

## 安装 / 检查

```powershell
node D:\dsh-plugins\analysis-run\vendor\install.mjs           # 装到 vendor/site-packages
node D:\dsh-plugins\analysis-run\vendor\install.mjs --check   # 只看当前解释器和已装版本
node D:\dsh-plugins\analysis-run\vendor\install.mjs --python <其它解释器路径>
```

脚本会先核对解释器版本与 wheel 的 ABI 标签（当前是 `cp312` / `win_amd64`），不匹配就明确报错，
不会装出一半可用一半不可用的环境。装完会自检"vendored 版本确实被加载"，并写 `manifest.json`。

## 换解释器（例如 DSH 把运行时升到 3.13）

1. 把对应的 `cp313` wheel 追加到 `vendor/wheels/`（scipy、statsmodels、wrapt 需要原生 wheel；其余是纯 Python）；
2. 运行 `node vendor/install.mjs`；
3. `vendor/site-packages` 可整个删除重建，不影响任何研究数据。

`node vendor/install.mjs --check` 的退出码：0 = vendored 生效，1 = 没生效，2/3/4/5 = 解释器、ABI、安装或自检失败。

## 许可

scipy、statsmodels、numpy、pandas 均为 BSD 许可，允许随插件再分发；如果要把插件公开发布，
保留各 wheel 内的 LICENSE 文件即可。
