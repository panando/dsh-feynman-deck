# dsh-feynman-deck

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](package.json)

把 [Companion-Inc/feynman](https://github.com/Companion-Inc/feynman) 这套科研工作流接进 DeepSeek Harness（以下简称 DSH），做成一个可选模式。

不重写研究流程，装上就能一句话发起文献综述、论文复现这类长任务。

## 目录

- [特色亮点](#特色亮点)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用示例](#使用示例)
- [主要功能说明](#主要功能说明)
- [配置说明](#配置说明)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [贡献方式](#贡献方式)
- [License](#license)
- [致谢](#致谢)

## 特色亮点

1. **不重写研究流程。** feynman 内部的研究编排原样保留，它的子代理、PDF 解析、文献检索都照旧；本插件只把命令行包了一层。
2. **官方标准模式的能力一个不少。** 本模式照抄官方 `standard` 的全部插件行，只在末尾追加一行本插件，所以换模式不会丢掉任何原有工具。
3. **研究记录与日常使用分开。** 插件给 feynman 单独准备一个主目录，它与你自己 `~/.feynman` 里的历史互不干扰，出问题时分得清是谁写的。
4. **能脱离 DSH 单独排错。** `scripts/run.mjs` 在命令行上跑同一套逻辑，用来把「feynman 本身跑不跑得通」和「插件装得对不对」分开判断。
5. **产物清单自动收集。** 每次跑完自动比对前后文件，列出本次新增和改动的文件，研究报告通常就在其中。

## 安装

### 第一步：装 feynman 本体

```bash
npm install -g @companion-ai/feynman
```

### 第二步：让 feynman 有一个能用的模型

先交互式跑一次 feynman，或者直接确认 `~/.feynman/agent/models.json` 里已经有可用模型。本插件第一次运行时会把它复制到自己的隔离主目录。

### 第三步：装本插件自己的依赖

```bash
cd projects/dsh-feynman-deck && npm install
```

本插件依赖 `@deepseek-ai/schemastery`，DSH 用它校验插件的配置项。这一步不能省。

为什么非装在本目录不可：DSH 把插件包以**软链**的形式挂进 profile 的 `node_modules`，Node 解析依赖时会顺着软链指向的**真实路径**往上找目录。于是 profile 自己的 `node_modules` 帮不上忙，插件自己的依赖只能放在插件目录下。

例外是 `@deepseek-ai/dsh-tools`：它是 DSH 挂载的条目名，加载器会拦截这个包名并指向安装目录里的副本，所以它不需要装在本目录。

### 第四步：装进 profile

在 DSH 里用 `plugin_manager` 工具：

```
action=install_bundle, target=<本目录绝对路径>
```

## 快速开始

1. 新开一个会话。
2. 在模式选择里选「Feynman-Deck」。
3. 确认工具列表里有 `feynman_research`。
4. 直接说需求，例如「用 deepresearch 研究一下 2023 年以后蛋白质结构预测的新方法」。

## 使用示例

### 让模型调用工具

模型看到你的需求后，会发起这样一次调用：

```
feynman_research({
  workflow: "deepresearch",
  input: "2023 年以后关于小样本条件下的蛋白质结构预测有哪些新方法",
  cwd: "/绝对路径/到/你的研究目录",
})
```

`workflow` 和 `cwd` 是必填项。跑完返回的关键内容有：`ok`（是否正常跑完）、`exitCode`、`timedOut`、`artifacts`（本次新增或改动的文件，相对 `cwd` 的路径）、`stdout`（feynman 自己的研究输出）。

### 不经过 DSH 手工验证

```bash
cd projects/dsh-feynman-deck
node scripts/run.mjs --workflow log --cwd /tmp/feynman-try
```

这条命令做的事和插件内部完全一样，用来把「feynman 本身能不能跑」和「DSH 插件装得对不对」这两件事分开判断。

## 主要功能说明

选上「Feynman-Deck」之后，会话拥有与官方 `standard` 模式完全一样的全部能力，只是额外多了一个工具 `feynman_research`。

这个工具被调用时，DSH 会去执行外部命令 `feynman`，把一件研究工作交给它跑，再把报告和产物文件清单还回来。

`workflow` 参数只能取下面这 11 个值之一：

| workflow | 做什么 | 要不要 `input` |
| --- | --- | --- |
| `deepresearch` | 围绕一个题目做深度检索，产出带引用的一页纸报告 | 要，写题目 |
| `lit` | 给定论文或主题做文献综述 | 要 |
| `compare` | 比较若干篇论文的方法与结论 | 要，写清比较哪几篇 |
| `draft` | 把已有材料写成论文草稿 | 要 |
| `recipe` | 把论文的方法写成可执行的训练或实验步骤 | 要 |
| `replicate` | 复现一篇论文的结果 | 要 |
| `audit` | 审查一份研究产物的严谨性 | 要 |
| `autoresearch` | 自动跑一轮从选题到结论的研究 | 要 |
| `review` | 评审一份手稿或研究方案 | 要 |
| `summarize` | 把长文按窗口切分后分层摘要 | 要，给出文件或文本 |
| `log` | 读取历史会话记录，产出结构化笔记 | 不要 |

### `input` 怎么写

Feynman 是另一个代理，它**看不到本次对话**，只拿到你写的那一段 `input`。所以要写清楚背景、限定条件和期望的产出形式，不要写「上面那篇论文」这种指代不明的说法。

- 反例：`"帮我研究一下这个"`
- 正例：`"研究 diffusion 模型在蛋白质侧链构象预测上的进展，重点看 2023 年以后的论文，输出一页纸，带引用"`

### `cwd` 为什么必填

`cwd` 是 Feynman 的工作目录，它的笔记、报告、下载的论文都落在这里。这个目录对模型有意义，对 DSH 主进程没有意义，所以必须显式指定。建议用绝对路径，并给每次研究单独开一个目录，这样产物清单一眼就能看清。

### 关于两个设计上的选择

**为什么要一个独立的 feynman 主目录。** feynman 默认用 `~/.feynman`。如果插件直接用它，插件跑出来的会话记录会和用户手工使用 feynman 的记录混在一起，出问题也分不清是谁写的。所以插件把 feynman 的家搬到 DSH 自己的目录下，两者互不干扰。

**为什么不直接执行 `feynman` 这个命令。** feynman 命令的头部写着 `#!/usr/bin/env node`，而从访达启动的 DSH 主进程，`PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 node。所以插件自己按顺序找 feynman 和 node，找到之后用 node 显式跑 feynman 的 js 入口。

## 配置说明

宿主可以在 `cordis.patch.yml` 里覆盖下面这些字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `feynmanHome` | `~/.dsh/profiles/<profile>/feynman-home` | feynman 主目录的基准目录；真正的家在它的 `.feynman` 子目录里 |
| `feynmanBin` | 自动搜索 | 手工指定 feynman 命令的绝对路径 |
| `model` | `cpa/deepseek-v4.1-flash` | 传给 feynman 的模型 |
| `timeoutMs` | `1800000`（30 分钟） | 单次运行的上限毫秒数 |
| `maxOutputChars` | `80000` | 返回给模型的标准输出/错误各截断到多少字符 |

`cordis.patch.yml` 另外声明了预设本身在模式选择里显示的名称（`name`）和说明文字（`description`），这两个字段由 `@deepseek-ai/dsh-agent-preset` 提供。

## 常见问题

**报错「找不到 feynman 命令」怎么办？**

说明插件没找到 feynman。先执行 `npm install -g @companion-ai/feynman`；如果装在非常规位置，在配置里用 `feynmanBin` 指明绝对路径。

插件按这个顺序查找：环境变量 `FEYNMAN_BIN` → `PATH` 里的各个目录 → `~/.nvm/versions/node/<版本>/bin/feynman`（版本从大到小）→ `~/.bun/bin/feynman` → `/opt/homebrew/bin/feynman` → `/usr/local/bin/feynman`。

**默认模型在我机器上不通怎么办？**

默认值 `cpa/deepseek-v4.1-flash` 是为作者本机的本地网关写的。请在调用工具时传 `model` 参数，或改配置里的 `model` 字段，填你自己 feynman 里可用的模型。

**改了 `index.js` 或 `lib/feynman.js` 之后为什么不生效？**

插件运行在 DSH 主进程里。要在 `plugin_manager` 里对这个 bundle 再执行一次启用，或者重启 DSH。

**一次调用跑了很久没动静，正常吗？**

正常。一次调用会启动一个完整的研究代理，短则几十秒，长则几十分钟。默认上限是 30 分钟，`deepresearch`、`autoresearch` 这类可能跑得更久，需要时在调用里传 `timeoutMs`。

**能不能同时跑几个研究任务？**

不能，也不建议。这个工具被标成不适合并发，连着调用会排队，慢上加慢。

**模式选择里为什么会出现两个名字带 Feynman 的模式？**

DSH 主仓库里还有另一个子项目 `projects/dsh-feynman`，显示名为「Feynman」，走的是把 feynman 的提示词改写成 DSH skill 的路子，不调用外部命令。本插件显示名为「Feynman-Deck」，占用预设 id `feynman-deck`。DSH 的预设注册表碰到重复 id 会直接抛错（`Duplicate agent preset: <id>`），所以改动任何一边的 id，都要回头确认另一边。

### 已知限制

- 只在 macOS 上验证过。
- 插件运行在 DSH 主进程里，它拉起的 feynman 子进程不受 bash 工具那层文件沙箱限制。
- 插件加载时、以及选中预设时都不检查 feynman 是否存在，缺命令要等到第一次调用工具才暴露。

## 路线图

- 插件加载时做一次装前检查，缺 feynman 或缺模型配置时直接提示。
- 去掉写死的默认模型，改从 DSH 自己的 provider 配置里推导。
- 在 Linux 和 Windows 上验证。
- 补上效果演示截图：一张是模式选择界面里选中本模式的画面，一张是一次调用后返回的产物清单。截图本身会泄露信息，发布前必须人工过一遍画面里的系统用户名、绝对路径、通知栏、其它窗口、界面上的真实数据或密钥、个人账号。

## 贡献方式

欢迎提 issue 和 PR。

本地校验（只做语法检查）：

```bash
npm test
```

改动 `index.js` 或 `lib/feynman.js` 之后，记得让 DSH 重新加载插件再验证。

## License

[MIT](LICENSE) © 2026 panando

## 致谢

- [Companion-Inc/feynman](https://github.com/Companion-Inc/feynman)：本插件调用的科研工作流全部来自这个项目。
- [DeepSeek Harness](https://github.com/deepseek-ai)：本插件运行在它之上。

---

本子项目的设计说明见 DSH 主仓库的 `docs/superpowers/specs/2026-10-19-dsh-feynman-deck-design.md`（该文件不在本仓库内）。
