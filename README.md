# DLSSG GUI — 帧生成注入管理器

给 **RTX 20/30 系（SM86 / SM75）** 显卡补上 NVIDIA DLSS 帧生成的图形化工具。

上游开源项目 [`sdli1995/dlssg_for_sm86`](https://github.com/sdli1995/dlssg_for_sm86) 用「代理 DLL + ini」的方式把 Ampere 优化的
DLSS-G 运行库塞进游戏进程，但它只有命令行/手工复制的用法。这个项目把它包装成一个 Windows 桌面软件：
**选游戏 → 选运行库与代理 → 一键注入 → 一键还原**，配置、备份、日志、扫描全在界面里。

> ⚠️ 注入 DLL 与作弊器行为特征一致。**绝不要在带反作弊的网游里使用**（PUBG、Valorant、带 EAC/BattlEye 的游戏等），会封号。
> 只用于单机 3A。

![界面截图](docs/screenshot.png)

---

## 它到底做了什么

上游 0.3.0（代理模式）的部署动作只有两步：

1. 把一个代理 DLL（`version.dll`，或 `alternatives\` 里的 `winmm.dll` / `dbghelp.dll` / `dinput8.dll` / `dxgi.dll` / `d3d12.dll`）
   放进游戏的**渲染 EXE 目录**；
2. 同目录放一份 `dlssg_sm86.ini`。

代理 DLL 内嵌了未修改的原厂 DLSS-G 运行库与 SM86 后端，只拦截 `nvngx_dlssg.dll` 的加载，其余导出全部转发给
`C:\Windows\System32\` 里的同名真实 DLL。同一目录**只能启用一个代理**。

本软件把上面这套动作自动化，并且：

- 覆盖任何文件前**先备份**，并记录每个文件是「新建」还是「覆盖」；
- 记录注入文件的 SHA-256，改动过就能发现；
- 还原时按记录把文件删掉 / 还原成备份，可选清理日志目录；
- 注入前检查游戏是否在运行、目录里是否已有别的代理。

## 功能

| 模块 | 说明 |
| --- | --- |
| 游戏扫描 | 自动读 Steam（`libraryfolders.vdf` + `appmanifest_*.acf`）、Epic（`.item` 清单）、GOG（注册表），也支持手动选目录 |
| DLSS-G 探测 | 按目录里的 `nvngx_dlssg.dll` / `nvngx_dlss.dll` 判定「能不能开帧生成」，并给出候选渲染 EXE 目录 |
| 运行库管理 | 从 GitHub 一键下载（310.9 支持 6X / 310.1 最高 4X）、导入 ZIP（GitHub 的 Download ZIP 里含多个版本会一起导入）、导入文件夹、或直接指定单个 DLL |
| 每游戏配置 | 独立保存运行库、代理名、倍率上限、渲染预设、日志等级、Runtime 键，以及任意自定义键 |
| 一键注入 / 还原 | 预检查（阻塞项 / 提示）→ 写入 → 状态识别；还原支持「强制」与「保留日志」 |
| 文件与备份 | 每个游戏按时间分目录备份，可回滚；保留份数可配置 |
| 日志查看 | 直接读游戏目录 `dlssg_sm86\logs\*.jsonl`，汇总代理重定向 / 路由是否激活 / 错误行 |
| 环境检测 | 读 `nvidia-smi` 拿显卡与驱动，判断 SM86 / SM75 / 40-50 系，给出驱动过旧的提醒 |

## 快速开始（开发）

```powershell
npm install          # 安装依赖（会下载 Electron 二进制）
npm run dev          # 开发模式启动，改代码热更新
npm run typecheck    # 类型检查
npm test             # 核心逻辑单元测试（ini、导入、注入、还原）
```

## 自检脚本

`tools/` 下有几个只读/可选的自检脚本，用来验证关键链路：

```powershell
# 真实环境跑一遍 Steam/Epic/GOG 扫描 + DLSS-G 能力探测（只读）
node --import ./test/loader.mjs tools/check-scan.mts

# 验证「从 GitHub 下载运行库」整条链路：会真的下载约 110MB 到数据目录后校验并清理
$env:DLSSG_GUI_DATA_DIR="$PWD\.check-download"; node --import ./test/loader.mjs tools/check-download.mts

# 检查 IPC 频道在 shared / preload / 主进程三处是否一致
node tools/check-ipc.mjs

# 重新生成图标
node tools/make-icon.mjs
```

界面自检：设置 `DLSSG_GUI_SCREENSHOT=<png 路径>` 启动程序，加载完成 3 秒后会自动截图并退出，
用来确认打包产物能正常渲染。

## 打包成安装包 / 便携版

```powershell
npm run pack:win     # 先构建，再产出 NSIS 安装包 + 便携版到 release\
```

产物：

- `release\DLSSG-GUI-0.1.0-x64.exe` — 安装包（可选择安装目录，开始菜单/桌面快捷方式）
- `release\DLSSG-GUI-0.1.0-portable.exe` — 便携版，双击即用

图标由 `node tools/make-icon.mjs` 生成（纯 Node 实现，无第三方依赖）。

> 国内网络提示：Electron 二进制与 `electron-builder` 的额外组件在 `github.com` / `objects.githubusercontent.com` 上，
> 慢的话在 `.npmrc` 里保留 `electron_mirror`、`electron_builder_binaries_mirror` 指向 npmmirror 镜像。
> 受限环境下（例如没有 `%LOCALAPPDATA%` 写权限）可设 `electron_config_cache` 指向可写目录。

## 数据目录

默认 `%APPDATA%\dlssg-gui`（Electron userData），里面有：

```
packages\   导入/下载的运行库包（每个包一个目录，含 dlssg-gui-package.json）
backups\    <游戏 id>\<时间戳>\ 注入前的原始文件
logs\       本软件自己的日志
games.json  游戏条目与注入记录
packages.json
settings.json
```

- 便携模式：在 exe 旁放一个 `portable.txt`，数据改放 `exe 同级的 data\`。
- 也可以用环境变量 `DLSSG_GUI_DATA_DIR` 指定。

## 验证情况（本机实测）

- `npm run typecheck` 通过；`npm test` 12 项全通过（ini 往返、文件夹/ZIP 导入、注入→状态→改配置→拒绝还原→强制还原全流程）。
- 真实环境扫描：读到 5 个 Steam 库、24 个游戏，0.5s 完成，正确识别出 5 个带 `nvngx_dlssg.dll` 的游戏
  （Call of Duty HQ / Death Stranding 2 / No Man's Sky / PRAGMATA / The Witcher 3 DX12）与 3 个只有超分的游戏。
- 「从 GitHub 下载」实测：310.9 与 310.1 两个变体的 URL 全部 200，310.9 完整下载 6 个代理（约 110MB）→ 导入 → 哈希校验通过。
- 打包产物已在 `release\`；打包版与开发版都能正常启动并渲染界面（截图自检无控制台报错）。

## 目录结构

```
src/
  main/            主进程：文件操作、扫描、注入、日志、IPC
    inject.ts      注入/还原引擎（备份清单、哈希校验、进程检查）
    library.ts     运行库导入（文件夹 / ZIP / GitHub 下载 / 单个 DLL）
    scan.ts        Steam / Epic / GOG 扫描与 DLSS-G 探测
    logs.ts        游戏侧 jsonl 日志读取与汇总
    ipc.ts         IPC 注册
  preload/         contextBridge 暴露 window.api
  renderer/        React 界面（概览 / 游戏 / 详情 / 运行库 / 设置）
  shared/          主进程与界面共用的类型、ini schema、IPC 契约
test/              核心逻辑测试（原生 TS 运行，不经过打包器）
tools/             图标生成、扫描自检、下载自检、IPC 一致性检查
docs/              截图与给测试机的使用说明
```

## dlssg_sm86.ini 配置项

界面里暴露的是上游 0.3.0 出厂文件里的键（高级键可自行添加）：

| 段 | 键 | 取值 | 说明 |
| --- | --- | --- | --- |
| `[General]` | `Enabled` | 0/1 | 1 启用帧生成（用内嵌运行库）；0 关掉，游戏自带 DLSS-G 原样加载 |
| `[FrameGeneration]` | `Optimized` | 0/1 | 1 用最优内核（推荐，输出与原厂逐位一致） |
| `[FrameGeneration]` | `MaxGeneratedFrames` | 1-5 | 上限：5 = 最高 6X，3 = 最高 4X；实际倍率由游戏请求并钳到运行库上限 |
| `[Compatibility]` | `Preset` | Auto/A/B | 仅 310.9 版有效；UI 重组，多数游戏下 B 等于没开 |
| `[Logging]` | `Level` | 0-3 | 0 关闭，1 仅错误，2 配置与能力，3 内核与求值轨迹 |
| `[Logging]` | `Directory` | 路径 | 默认 `dlssg_sm86\logs`，相对 ini 所在目录 |
| `[Runtime]` | `Mode` | Bundled | 常规用法保持 Bundled |
| `[Runtime]` | `CacheDirectory` | 路径 | 留空 = `%LOCALAPPDATA%\DlssgSm86\bundles` |

帧生成没生效时的排查顺序：`dlssg_sm86\logs\loader_*.jsonl` 里应有 `runtime_redirect`（代理已生效）→
`backend_*.jsonl` 里应有 `install` 且 `route active=true`（路由已激活）。缺失通常是驱动/运行库不匹配，会回退原厂路径。
把 `Level` 调到 2 或 3 再跑一次游戏。

## 已知限制

- **只支持 Windows x64 + D3D12**，游戏必须原生支持 DLSS 帧生成。
- 上游对 **RTX 30 系（SM86）** 是主要目标；**RTX 20 系（SM75）** 属于实验性路由，兼容性不保证。
- 6X（Dynamic MFG）能否用取决于游戏自带插件的版本，只有 4X 插件的游戏无法被抬到 6X。
- 装在 `Program Files` 下的游戏写入可能需要管理员权限；本软件会给出写入失败的提示，可以右键「以管理员身份运行」。
- 本软件不修改游戏本体、不联网上传任何数据；「从 GitHub 下载」只请求上游仓库的 raw 文件。

## 许可与致谢

- 本软件源码：**GPL-3.0-only**，见 [`LICENSE`](LICENSE)。
- 本仓库**不含**任何 NVIDIA 运行库文件；第三方材料归属见 [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt)。
- 运行库来自 [`sdli1995/dlssg_for_sm86`](https://github.com/sdli1995/dlssg_for_sm86)（GPLv3）；其内嵌的 `nvngx_dlssg.dll`、
  模型与内核资源版权归 NVIDIA 及上游第三方，**不随本仓库分发**，需要用户自行下载或导入。
- RTX 20 系（SM75）内核族来源：Coldwood1026 的适配工作（见上游 `THIRD_PARTY_NOTICES.txt`）。

