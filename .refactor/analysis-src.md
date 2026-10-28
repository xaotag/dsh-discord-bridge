# `src/` 源码分析报告（只读审查）

- 目标：`/home/ecs-user/dsh-plugins/dsh-discord-bridge`
- 分支：`v2-questions-modal`（HEAD `9a646e8`），`git status` 干净，本次未做任何代码改动
- 基线验证：`npm test` 92 pass / 0 fail；`node -e "await import('./index.js')"` 正常加载
- 依据：`AGENTS.md`（代码约定、依赖方向、隐私红线、测试门槛）+ `README.zh-CN.md`
- 采集方式：逐文件通读；`grep` 交叉引用；脚本提取全部 `export` 并做跨文件引用计数；用小脚本做渲染耗时抽样

---

## 0. 模块清单与体量

| 文件 | 行数 | 备注 |
|---|---|---|
| `index.js`（组合根，供参照） | 1595 | 超出"只管生命周期/鉴权/路由"的定位（见 §7） |
| `src/bridge/agent-service.js` | 875 | 本次重点 1 |
| `src/discord/renderer.js` | 553 | 本次重点 2（`wc -l` 显示 552，文件末尾无换行） |
| `src/discord/cards-v2.js` | 527 | 本次重点 2 |
| `src/discord/markdown.js` | 316 | 本次重点 2 |
| `src/discord/transport.js` | 301 | |
| `src/bridge/stream-reporter.js` | 299 | |
| `src/discord/commands.js` | 259 | |
| `src/discord/components-v2.js` | 226 | |
| `src/deepseek/api-client.js` | 203 | |
| `src/audit/db.js` | 192 | 本次重点 4 |
| `src/config.js` | 167 | |
| `src/bridge/question-registry.js` | 142 | |
| `src/bridge/privilege-outcome.js` | 138 | |
| `src/bridge/privileged-client.js` | 130 | |
| `src/bridge/privileged-protocol.js` | 125 | |
| `src/state-store.js` | 104 | |
| `src/discord/deepseek-commands.js` | 93 | |
| `src/bridge/approval.js` | 79 | |
| `src/discord/rate-limiter.js` | 66 | |
| `src/bridge/thread-manager.js` | 38 | |
| `src/discord/attachments.js` | 37 | |
| `src/bridge/untrusted.js` | 18 | |
| `src/discord/mention.js` | 17 | |
| **合计** | **4904** | |

---

## 1. `src/bridge/agent-service.js`（875 行）

### 1.1 方法清单、行数与职责

| # | 方法 / 函数 | 行号 | 行数 | 实际职责 | 混杂判定 |
|---|---|---|---|---|---|
| 1 | `constructor` | 12–23 | 12 | 装配 + 注册 3 个 `ctx.on` 全局监听 | 监听注册放构造函数，导致 §7 的订阅-调用依赖环 |
| 2 | `channelForAgent` | 33–39 | 7 | 反查 Channel（线性扫描 runtimes） | 纯查询 |
| 3 | `liveAgentFor` | 42–46 | 5 | 取活 Agent | 纯查询 |
| 4 | `runtime` | 48–75 | 28 | **Runtime 状态工厂**（20 个字段）+ 惰性建表 | 状态管理 |
| 5 | `touch` | 77–80 | 4 | 持久化 + 建 runtime | 状态管理 |
| 6 | `status` | 82–98 | 17 | **UI 文案**（`Session: …` 中文多行） | ⚠ 面向用户的展示文案写在 bridge 层 |
| 7 | `agentOptions` | 100–130 | 31 | **模型解析**（runtime → state → config → `agentDefaultModel`） | 模型解析 |
| 8 | `mountPreset` | 141–188 | 48 | Agent preset 挂载 + 审计 | Session/Agent 生命周期 |
| 9 | `setupAgent` | 190–207 | 18 | preset + 系统提示 + selection | Session 生命周期 |
| 10 | `installSelection` | 214–270 | 57 | **模型路由**：劫持 `system-prompt/assemble` 与 `agent/request` 两个中间件 | 模型解析（最"魔法"的一段） |
| 11 | `routeFor` | 272–279 | 8 | 模型路由投影 | 模型解析 |
| 12 | `ensureAgent` | 281–299 | 19 | 并发去重（`opening`）+ 活体校验 | Session 生命周期 |
| 13 | `openAgent` | 301–388 | 88 | **resume / create 双分支** + 审计 + 错误包装 | Session 生命周期 |
| 14 | `releaseRuntime` | 390–428 | 39 | 释放（cancel + dispose + 清 selection） | Session 生命周期 |
| 15 | `run` | 430–498 | 69 | **回合执行**：串行化队列 + 审计 + 最终文本回退 + `sessions.flush` | 流事件 / followup 调度 / 审计 三者混在一个事务里 |
| 16 | `steer` | 500–505 | 6 | 注入引导 | followup 调度 |
| 17 | `stop` | 507–512 | 5 | 取消 | followup 调度 |
| 18 | `newSession` | 514–523 | 10 | 释放 + 重建 | Session 生命周期 |
| 19 | `setSettings` | 525–568 | 44 | **模型/推理等级变更**：校验 + 持久化 + 审计 + 重装 selection | 模型解析 + 状态 + 审计 |
| 20 | `listReasoningEfforts` | 574–588 | 15 | 查询 adapter 能力 | 模型解析 |
| 21 | `listModels` | 590–597 | 8 | 查询模型目录 | 模型解析 |
| 22 | `observeStream` | 599–615 | 17 | **流事件**：text/reasoning delta 聚合 + 派发 sink | 流事件 |
| 23 | `observeSession` | 617–647 | 31 | **工具事件**：`tool/call`、`tool/result`（写审计 + 派发 sink）+ `turn/end` 状态 | 工具事件 + 审计 |
| 24 | `listSessions` | 649–712 | 64 | **Session 目录**：`sessionQuery` / `agents.list` / `sessionPersistence` 三源合并 | Session 查询 |
| 25 | `bindSession` | 714–728 | 15 | 绑定既有 Session | Session 生命周期 |
| 26 | `observeDisposed` | 730–739 | 10 | `agent/disposed` 清理 | 流/生命周期事件 |
| 27 | `isLiveOrPersisted` | 742–756 | 15 | 存在性探测 | Session 查询 |
| 28 | `cleanupIdle` | 758–779 | 22 | **空闲回收 + LRU 上限** | 生命周期（**无任何测试覆盖**，`index.js:1242` 是唯一调用点） |
| 29 | `dispose` | 781–802 | 22 | 卸载 | 生命周期 |
| — | `makeUserMessage` | 805–812 | 8 | 消息构造 | 工具函数 |
| — | `assistantTexts` | 814–828 | 19 | Session 派生消息读取（兜底最终文本） | 工具函数 |
| — | `findRuntime` | 830–835 | 9 | 线性查找 | 工具函数 |
| — | `EXTRACT_SESSION_ID` 段 + `extractSessionId` | 837–859 | 23 | **Discord 输入解析**（解析 `title · session-uuid · live`） | ⚠ 与 DSH Agent 生命周期无关 |
| — | `greetingPrompt` | 861–875 | 15 | **提示词文案** | ⚠ 面向 Discord 的问候提示词 |

聚类统计（方法数）：Session 生命周期 10（#1,4,5,8,9,12,13,14,18,25,27）、流/工具事件 4（#22,23,26,+ `run` 的一部分）、模型解析 6（#7,10,11,19,20,21）、followup 调度 3（#15,16,17）、状态查询 3（#2,3,24,28）、UI 文案 / 解析 3（#6、`extractSessionId`、`greetingPrompt`）。

### 1.2 可拆分边界（按内聚度由高到低）

| 边界 | 迁出内容（行号） | 目标模块 | 拆分风险 |
|---|---|---|---|
| **B1 模型路由** | `agentOptions`(100–130)、`routeFor`(272–279)、`installSelection`(214–270)、`setSettings`(525–568)、`listReasoningEfforts`(574–588)、`listModels`(590–597) | `src/bridge/model-route.js`（`ModelRouter`，持有 `cfg/state/ctx`，暴露 `optionsFor(key)`、`install(agentCtx, runtime)`、`apply(key, settings)`） | 低。测试 `agentPreset` 用例直接 new `AgentService`，只要构造签名不变即可 |
| **B2 Session 目录查询** | `listSessions`(649–712)、`isLiveOrPersisted`(742–756) | `src/bridge/session-catalog.js` | 低。当前**无测试覆盖**，拆出后可补 |
| **B3 事件观测** | `observeStream`(599–615)、`observeSession`(617–647)、`observeDisposed`(730–739) + 构造函数里 3 个 `ctx.on`(20–22) | `src/bridge/agent-observer.js`（由 `AgentService` 注入 sink 与 audit） | 中。`dispose()`(781–802) 与测试的 `ctx.on: () => () => {}` 桩有耦合；但顺带解掉 P1-01 的环 |
| **B4 Runtime / 生命周期** | `runtime`(48–75)、`touch`、`ensureAgent`、`openAgent`、`releaseRuntime`、`newSession`、`bindSession`、`cleanupIdle`、`dispose` | 留在 `agent-service.js`（拆完后约 300 行） | 中（最大块搬迁） |
| **B5 展示/解析杂项** | `extractSessionId`(847–859)、`greetingPrompt`(866–875) | `extractSessionId` → `src/discord/session-id.js`（纯字符串，无依赖）；`greetingPrompt` → `src/discord/prompts.js` | 低，但会动测试 import（`test/helpers.test.js:117`） |
| **B6 回合执行 + 审计** | `run`(430–498) 里的 4 处 `audit.record` | 抽 `src/bridge/turn-audit.js`（`recordRunStart/End/Error`），`run` 只留调度 | 低。合规上仍由 `agent-service` 调用 |

拆分后建议结构：`agent-service.js`（生命周期，~300 行）+ `model-route.js` + `session-catalog.js` + `agent-observer.js` +（可选）`turn-audit.js`。`channelForAgent`/`liveAgentFor` 按 1.3 改索引后也可并入 `session-catalog.js`。

### 1.3 其它结构性问题

- `this.runtimes` 被 9 个方法反复 `for…of` 线性扫描：`channelForAgent`(35)、`observeSession`(618)、`observeDisposed`(733)、`cleanupIdle`(761,772)、`findRuntime`(831)、`status`/`liveAgentFor` 的 `get`。建议加 `agentToKey: WeakMap`，检索从 O(n) 变 O(1)；`test/helpers.test.js:1219-1247` 依赖 `channelForAgent` 语义，改实现不改签名即可。
- runtime 字面量 20 字段（52–70）无类型/无注释，`runtime.selection`（222）、`greeting`（439）、`agentPreset`（148）是**后续动态挂上去的字段**，`runtime()` 里并不存在 → 阅读时无法判断完整形状。建议集中为一个 `createRuntime()` + 注释块的字段表。
- `run()` 同时承担：串行队列（`delivery`/`pendingDeliveries`）、审计、`sessions.flush`（455）、空文本兜底（460–463）。任意一条失败都会把整轮判为错误，但 `sessions.flush` 的失败被单独吞掉（456–458），语义不统一。
- `installSelection` 用 `agent/request` 中间件改写 provider/model（246–259），`selection.assembled` 依赖 `system-prompt/assemble` 先执行（230–243），顺序耦合无断言保护 → 若 DSH 调整中间件顺序，模型切换会静默失效。

---

## 2. 渲染四件套：职责重叠与重复实现

`cards-v2.js`(527) / `renderer.js`(553) / `components-v2.js`(226) / `markdown.js`(316)

### 2.1 实际依赖关系（`grep` 结果）

```
transport.js ──► renderer.js (normalizePayload) ──► markdown.js (adaptMarkdownForEmbed)
            └─► cards-v2.js (noticeCard) ──► components-v2.js
                                          ├─► renderer.js (suppressMentions)   ← 反向依赖
                                          └─► markdown.js (adaptMarkdownForTextDisplay)
bridge/stream-reporter.js ──► renderer.js + cards-v2.js
```

- `components-v2.js` 与 `markdown.js` 是**真正的底层**（无内部依赖）。
- `renderer.js` **同时是底层和业务层**：`suppressMentions`/`formatDuration`/`progressCaption`/`normalizePayload` 被上层使用，而 `buildEmbed`/`answerPayload`/`finalPayloads`/`toolCardsPayload`/`approvalPayload` 是已废弃的 Embed 卡片体系。
- `cards-v2.js` 是 V2 业务卡片层，却反向 import `renderer.js` 的 `suppressMentions`（`cards-v2.js:29`）——两个同级渲染模块互相纠缠，而不是共享底座。

**结论**：需要拆出一个 `src/discord/text.js`（`suppressMentions`、`clipOneLine`、`formatDuration`、`chunk`），把 `renderer.js` 净化为"遗留 Embed 适配器"或直接删除（见 §5）。

### 2.2 重复实现清单（同一逻辑存在两份）

| 能力 | 实现 A | 实现 B | 差异 / 风险 |
|---|---|---|---|
| **工具描述提取** | `renderer.js:248-265 describeToolCall`（`DESCRIPTIVE_FIELDS` 240） | `cards-v2.js:225-252 describeTool`（字段列表内联 236） | **两套隐私策略**：A 只看意图字段、`clipOneLine(…,48)`；B 额外允许 `FILE_TOOL_FIELDS`(207–213) 输出文件路径、`shortenPath`(259–269) 截断。同一份参数在两条路径上得到不同结果（测试同时锁死两套：`test:527-545` vs `test:901-928`） |
| **工具调用单行** | `renderer.js:267-273 toolListLine` | `cards-v2.js:157-173 inlineToolLines` | 字面量 `⟳`/`✓`、`·`、`…更早的 N 次已省略`、`slice(-maxLines)` 各写一遍 |
| **工具列表卡片** | `renderer.js:282-300 toolCardsPayload`（embed，`TOOL_LIST_MAX_LINES=24`） | `cards-v2.js:183-199 toolListCard`（V2，`maxLines=24`） | 后者**只被测试引用**（`test:850`），线上无调用方 |
| **分片** | `renderer.js:44-59 chunkDiscordText`（1850，`0.4` 回退比例，`trimEnd`） | `components-v2.js:210-226 textChunks`（4000，`0.5`，不 `trimEnd`） | 两段几乎逐行同构的 `while (rest.length > limit)` 循环；改一处易漏另一处 |
| **截断** | `renderer.js:61-67 boundedText` | `components-v2.js` 无对应（卡片靠 `textChunks`） | 语义不统一：一条路径静默截断，一条路径分裂成多个 Text Display |
| **表格渲染** | `markdown.js:156-187 convertTables` → `renderRecordTable`(283-303) | 仅此一份 | ✅ 未重复。但 `adaptMarkdownForEmbed`(43–50) 在表格之上又叠加 `convertTaskLists`/`downgradeHeadings`/`flattenDeepNesting`——这些**只有 Embed 路径用**，V2 路径（`adaptMarkdownForTextDisplay` 30–34）明确"标题原样保留"。结论：**表格不再重复，但旧的 Embed 转换链整体属于死路径** |
| **代码块处理** | `markdown.js:105-134 mapOutsideCode`（按行 toggle ```） | `markdown.js:64-81 wrapLongCodeLines` 又实现了一遍 `inFence` 状态机 | 同一文件里两套围栏状态机，且 toggle 判定为 `line.trimStart().startsWith('````)`，行内 ``` 也会被当成围栏 |
| **时长格式化** | `renderer.js:80-88 formatDuration`（<10s 1 位小数、取整规则） | `cards-v2.js:506-513 formatElapsed`（总是 `toFixed(1)`，且 `ms<1000` 含义不同） | 同一卡片的不同分区显示不同精度；`1m60s`/`60.0s` 边界表现不一致 |
| **卡片页脚** | `renderer.js:317-325 cardFooter`（`model (effort:x) · 耗时`） | `cards-v2.js:495-504 footerBits`（同结构 + `caption`） | 复制粘贴 + 语义扩展 |
| **状态标题/颜色** | `renderer.js:26-33 EMBED_COLORS`、`360-370 FINAL_TITLES/FINAL_COLORS` | `cards-v2.js:33-40 ACCENT`、`282-286 FINAL_STATES` | **两份调色板与两份标题表**，靠注释"matching the embed palette"(32) 维持一致 |
| **停止按钮** | `renderer.js:411-426 stopButton` + `429-432 withStopButton` | `cards-v2.js:484-493 withStopRow` | 两份实现，`custom_id` 前缀共享 `STOP_BUTTON_PREFIX` 但构造路径不同 |
| **批准按钮** | `renderer.js:444-465 approvalButtons` | `cards-v2.js:434-459 approvalCard` | 同上，`custom_id` 上限保护只在 renderer 版有（`clipOneLine(requestId,60)`，445） |
| **批准卡片（三态）** | `renderer.js:474-505 approvalPayload/decidedApprovalPayload` | `cards-v2.js:468-481 decidedApprovalCard` | V2 版支持 `denied`（`APPROVAL_STATES` 480），Embed 版只有 2 态 → 两套行为已经分叉 |
| **超时文案** | `renderer.js:477-479` / `cards-v2.js:369-372`、`444-447` | — | `Math.ceil(left/1000)s 后失效` 写了 3 遍 |
| **Discord 长度常量** | `renderer.js:3-24`（8 个 EMBED_* + 2 个 content） | `components-v2.js:36-44` | V2 实际生效的只有 `TEXT_DISPLAY_LIMIT/CONTAINER_TEXT_LIMIT/MAX_TOTAL_COMPONENTS`；EMBED_* 常量在 V2 路径上无意义 |
| **mention 中和** | `renderer.js:36-41 suppressMentions` | 无重复，但 `normalizePayload`(522-553) 又对 `content` 调一次 `boundedText`（内部已 `suppressMentions`） | 幂等，仅冗余 |

### 2.3 数据流层面的重叠（比代码重复更值得处理）

`stream-reporter.js` 现在同时持有两套 payload 生成器：
- V2：`streamCard`(cards-v2:98)、`finalCard`(272)、`placeholderCard`(87)、`withStopRow`(484)
- 但仍从 `renderer.js` 取 `STOP_BUTTON_PREFIX`、`formatDuration`、`progressCaption`（`stream-reporter.js:1`）

也就是说**"遗留 Embed 体系"的唯一线上消费者是 3 个纯函数**。只要把这 3 个迁到 `text.js`，`renderer.js` 里 ~380 行（96–505）可整体移除，约删 8 个不会被线上调用、只被测试引用的导出。

---

## 3. 依赖方向检查（逐条）

检查命令：
```bash
grep -rn "deepseek-ai|dsh-|from '.*bridge/" src/discord/
grep -rn "discord" src/bridge/
grep -rn "^import" src/
```

### 3.1 `src/discord/*` 是否引用 DSH —— **未发现违规**

- `src/discord/` 下 `import` 全部指向 `discord.js`、`node:*` 或同目录文件：
  - `commands.js:1`、`deepseek-commands.js:1`、`transport.js:1-8` → `discord.js`（允许）
  - 其余 → `./*.js`（允许）
- 全仓库（`index.js` + `src/`）**没有**任何 `@deepseek-ai/*` 的 `import`。唯一命中 `@deepseek-ai/dsh-scope` 的是注释 `index.js:1530`。
- DSH 能力全部通过 `ctx` 注入（`ctx.agents`/`ctx.get`/`ctx.on`/`ctx.userQuestions`），未落在 `src/discord/`。

### 3.2 `src/bridge/*` 是否引用 discord.js —— **未发现直接违规，但存在越层依赖**

- `src/bridge/` 中无 `from 'discord.js'`（`grep "discord"` 仅命中注释与字符串）。
- **但越层依赖成立**（AGENTS.md 的分层意图是 bridge 不碰 Discord 渲染）：
  - `src/bridge/stream-reporter.js:1` → `../discord/renderer.js`（`STOP_BUTTON_PREFIX`, `formatDuration`, `progressCaption`）
  - `src/bridge/stream-reporter.js:2-7` → `../discord/cards-v2.js`（`finalCard/placeholderCard/streamCard/withStopRow`）
  - 该文件注释自称 "It has no DSH or discord.js imports"（`stream-reporter.js:24`），只对了一半。
- **反向越层**：`src/discord/attachments.js:1` import `../bridge/untrusted.js`。`untrusted.js` 只含 `wrapUntrusted` + 策略常量，是两个纯函数；把它放在 `bridge/` 导致 `discord → bridge`，与 `bridge → discord` 形成**双向依赖**，模块图不再是分层 DAG。
  - 建议：`wrapUntrusted`/`UNTRUSTED_INPUT_POLICY` 下沉到 `src/text/untrusted.js`（无依赖），两侧共同引用。
- `src/discord/cards-v2.js:29` → `./renderer.js` 的反向依赖见 §2.1，属**同层内方向错误**（V2 层依赖遗留层）。

**结论**：题面要求的两个"硬"违规（discord→DSH、bridge→discord.js）在代码中均为 0 处；真正存在的问题是 **bridge→discord 渲染层**（`stream-reporter.js:1-7`）与 **discord→bridge 双向**（`attachments.js:1`）**以及同层反向依赖**（`cards-v2.js:29`）。

---

## 4. 隐私红线

### 4.1 `src/audit/db.js`

实现本身是合规的：
- 只接受固定字段（79–91），`detail` 走 `safeJson`(175) → `redact`(183) → `truncate(…,4000)`(191)；`error` 走 `redact` + 截断 2000（107）。
- `redact` 覆盖 Discord token `MT…`(185)、`sk-…`(186)、`Bearer …`(187)。
- 批量写 + 事务（109–113、116–136），失败回滚并计数（125–133）。

**风险点（全部为调用方把内容塞进 `error`/`detail`）**：

| # | 位置 | 内容 | 判定 |
|---|---|---|---|
| A1 | `index.js:571` `error: result.message \|\| result.stderr`（`sudo.exec`） | 写入 **root 进程的 stderr**。`privd/dsh-privd.cjs:117` 采集全部子进程 stderr，`privileged-client.js:107-108` 原样返回 | ⚠ **P0**：与 AGENTS.md「不可记 … 命令内容」冲突。会落库：命令自身报错路径、`cat /etc/xxx` 的 `Permission denied` 路径、脚本里的 token |
| A2 | `index.js:742`、`index.js:1141` `error: error?.message`（`message.handle` / `slash.command`） | 异常消息链条上可能带用户文本（如 `bind … 找不到 Session ${trimmed}`，`agent-service.js:719`） | ⚠ 间接，取决于异常来源；`agent-service.js:344/386` 把 `saved`/`cause.message` 拼进 `Error` 后再经此处落库 |
| A3 | `src/deepseek/api-client.js:65` `error: error?.message` | `apiError()`(190–199) 把**上游 API 的 `error.message` 原文**拼进消息。DeepSeek 的内容审核错误常回显提示词片段 | ⚠ 中：可能把 prompt 片段写进审计 |
| A4 | `src/bridge/agent-service.js:628` `argumentBytes: String(event.data.arguments \|\| '').length` | 只存长度 | ✅ 合规（符合 README「只记录 argumentBytes」） |
| A5 | `index.js:500` `detail: { decision, action }`（`approval.decided`） | `action` 是用户输入的操作描述原文 | ⚠ 中：属"操作描述"而非元数据 |
| A6 | `src/deepseek/api-client.js:42-47` `model: body?.model` | 模型名 | ✅ |
| A7 | `src/bridge/privileged-client.js:76` `message: \`提交提权请求失败：${error.message}\`` | `fs` 错误含**队列文件完整路径** | 轻微，与 A1 同链路 |

额外：`redact` 正则为 `/MT[A-Za-z0-9._-]{20,}/g`（`db.js:185`），只匹配以 `MT` 开头的 token；新格式的 Discord bot token（`MTA…` 符合，但 `Nzk…`/`OTk…` 这类旧 base64 前缀）不会被脱敏。建议改为 `/[MN][A-Za-z\d]{23,}\.[\w-]{6,}\.[\w-]{27,}/` 形态匹配。

### 4.2 卡片渲染路径（重点 `cards-v2.js:describeTool`）

`describeTool(args, toolName)`，225–252：

```
1) 意图字段白名单 ['description','summary','label','title','reason','purpose']  → 通过（236-239）
2) if (FILE_TOOL_FIELDS[name]) 输出 file_path/path/…（read/write/edit/multiedit）或 glob.pattern → 输出
3) 其余返回 ''
```

与 AGENTS.md 第 154 行对照：「工具调用卡片同理，只显示描述字段（…），**不显示参数值**」。
`FILE_TOOL_FIELDS`(207–213) 使 `read/write/edit/glob` **确实显示参数值**（文件路径 / glob 模式），`shortenPath`(259–269) 只做长度裁剪不做脱敏。

| # | 位置 | 问题 | 判定 |
|---|---|---|---|
| C1 | `cards-v2.js:207-213,241-250` | 文件路径属"参数值"，与红线字面冲突（README §「两卡布局」157 行承认"过长的路径会截成 `…/src/file.js`"，即文档与 AGENTS.md 有分歧） | ⚠ **需产品决策**：要么改 AGENTS.md 明确豁免，要么删除 `FILE_TOOL_FIELDS` |
| C2 | `cards-v2.js:259-269` `shortenPath` | 仅按 `/` 切段，**不处理 `\r\n`/控制字符**以外的 URL、账号、私钥片段；`…${clean.slice(-(maxWidth-1))}`（268）会原样保留尾部 | ⚠ 低（路径本身可接受，但无统一脱敏入口） |
| C3 | `cards-v2.js:236` 字段白名单 | `title` 在白名单内。`write`/`edit` 工具的 `title` 字段可能承载用户/文件标题原文；`reason` 是权限审批理由，常含完整命令 | ⚠ 中 |
| C4 | `renderer.js:196-225 toolEmbed({showArgs:'full'})` | **直接把完整参数渲染进卡片**（`**参数**：\`${clipOneLine(args||'{}',900)}\``，212） | 🔴 **P0（潜在）**：当前线上无调用方（下表 §5 已确认 `toolEmbed` 未使用），一旦被"恢复"即构成红线破坏 |
| C5 | `renderer.js:332-351 streamPayload({toolName, toolArgs})` | `**参数**：\`${args}\``（345）原样渲染参数 | 🔴 **P0（潜在）**：仅测试 `test/helpers.test.js:34-42` 调用 |
| C6 | `renderer.js:165-188 summarizeToolArgs` | 优先取 `command`/`path`/`file_path`/`pattern`/`query`/`prompt`（178），**明确把文本/命令值产出为可见摘要** | 🔴 **P0（潜在）**：仅被 C4/C5 使用 |
| C7 | `cards-v2.js:387` `answeredQuestionCard` 渲染 `custom` 自由文本 | 落卡片，但不落审计 | ✅（用户自己的输入） |
| C8 | `index.js:442-449` `system/ask` 的临时探针在 `respond` 里 `JSON.stringify(answer.answers)` | 答案回显到频道 | ✅ 用户可见场景 |

**判断**：审计侧红线**基本守住**，唯一实质性越界是 A1（root stderr 入 `error`）；卡片侧 `cards-v2` 的 `describeTool` 属"文档与约定不一致"的灰区（C1/C3），而**真正危险的是 `renderer.js` 中 C4–C6 这组"参数全量渲染"函数仍然存在且被测试固化**——它们既是死代码，又是随时可能被复用的地雷。

---

## 5. 死代码 / 无人引用的导出

方法：脚本提取 `src/**/*.js` 全部 `export`，在 `index.js` + `src/**` + `test/helpers.test.js` 中做 `\bNAME\b` 计数（排除定义文件自身）。

### 5.1 完全无人引用（src/index/test 均无）

| 文件:行 | 导出 |
|---|---|
| `src/bridge/approval.js:11` | `DEFAULT_APPROVAL_TIMEOUT_MS` |
| `src/bridge/privileged-protocol.js:24` | `REQUEST_TTL_MS` |
| `src/bridge/privileged-protocol.js:28` | `DEFAULT_COMMAND_TIMEOUT_MS` |
| `src/bridge/privileged-protocol.js:37` | `workDir`（daemon 侧概念，JS 侧不用） |
| `src/bridge/privileged-protocol.js:43` | `secretPath` |
| `src/bridge/privileged-protocol.js:61` | `canonicalize`（只在文件内部用，不必 export） |
| `src/bridge/question-registry.js:135` | `buildAnswer`（仅内部使用） |
| `src/bridge/thread-manager.js:14` | `threadTitle`（仅内部使用） |
| `src/config.js:167` | 再导出 `listValue` / `boolValue` / `nonEmpty` / `positiveNumber`（4 个，仅内部用） |
| `src/discord/cards-v2.js:282` | `FINAL_STATES`（仅内部用） |
| `src/discord/cards-v2.js:477` | `APPROVAL_STATES`（仅内部用） |
| `src/discord/commands.js:52` | `dshCommand`（`DSH_COMMAND_BODY` 已够用） |
| `src/discord/components-v2.js:21` | `COMPONENT_TYPE`（内部用数字字面量代替） |
| `src/discord/components-v2.js:36` | `MODAL_MAX_COMPONENTS`、`MODAL_TITLE_LIMIT`（36–37） |
| `src/discord/components-v2.js:44` | `CONTAINER_TEXT_LIMIT` |
| `src/discord/components-v2.js:82-83` | `STRING_SELECT_MAX_OPTIONS`、`STRING_SELECT_LABEL_LIMIT` |
| `src/discord/deepseek-commands.js:64` | `DEEPSEEK_HELP_TEXT` |
| `src/discord/markdown.js:62-64` | `CODE_LINE_WIDTH`、`wrapLongCodeLines`（仅被 `adaptMarkdownForEmbed` 用） |
| `src/discord/markdown.js:105` | `mapOutsideCode`（内部用） |
| `src/discord/markdown.js:137` | `downgradeHeadings`（仅 Embed 路径） |
| `src/discord/markdown.js:306` | `convertTaskLists`（仅 Embed 路径） |
| `src/discord/markdown.js:314` | `flattenDeepNesting`（仅 Embed 路径） |
| `src/discord/renderer.js:3-24` | `DISCORD_CONTENT_LIMIT`、`EMBED_TITLE_LIMIT`、`EMBED_FOOTER_LIMIT`、`EMBED_AUTHOR_NAME_LIMIT`、`EMBED_FIELD_NAME_LIMIT`、`EMBED_FIELD_VALUE_LIMIT`、`EMBED_FIELD_COUNT_LIMIT`、`EMBED_TOTAL_LIMIT`、`EMBED_DESCRIPTION_SAFE_LIMIT`、`MAX_CARD_EMBEDS`、`MAX_TOOL_CARDS`（其中 `MAX_TOOL_CARDS` 自带 `@deprecated` 注释，22-24） |
| `src/discord/renderer.js:96` | `buildEmbed`（仅文件内部用） |
| `src/discord/renderer.js:150` | `placeholderPayload` |
| `src/discord/renderer.js:155-156` | `TOOL_ARGS_INLINE_LIMIT`、`TOOL_ARGS_SUMMARY_LIMIT` |
| `src/discord/renderer.js:165` | `summarizeToolArgs` |
| `src/discord/renderer.js:196` | `toolEmbed` 🔴 见 C4 |
| `src/discord/renderer.js:360` | `FINAL_TITLES` |
| `src/discord/renderer.js:381` | `finalEmbed`（仅内部用） |
| `src/discord/renderer.js:400` | `finalPayload`（仅被 `finalPayloads` 内部等效实现） |
| `src/discord/renderer.js:404` | `notificationPayload` |
| `src/discord/renderer.js:522` | `normalizePayload` 有使用（见下），非死 |

> 说明：`DISCORD_SAFE_LIMIT`(4)、`EMBED_DESCRIPTION_LIMIT`(8) 被测试引用；`EMBED_COLORS`(26)、`formatDuration`(80)、`suppressMentions`(36)、`progressCaption`(508)、`chunkDiscordText`(44)、`boundedText`(61) 有真实/测试使用，**不算死**。`EMBED_COLORS` 虽被测试 import，但生产代码里 `ACCENT` 已取代它。

### 5.2 只被测试引用（生产代码零调用）——最容易误判的一类

| 文件:行 | 导出 | 唯一引用 |
|---|---|---|
| `renderer.js:165/196/332` | `summarizeToolArgs` / `toolEmbed` / `streamPayload` | `test/helpers.test.js:35,45` |
| `renderer.js:248` | `describeToolCall` | `test:521-560` |
| `renderer.js:282` | `toolCardsPayload` | `test:466-562` |
| `renderer.js:303` | `answerPayload` | `test:6,439` |
| `renderer.js:376` | `finalPayloads` | `test:9,59-85,311` |
| `renderer.js:413-432` | `stopButton` / `withStopButton` | `test:304-317` |
| `renderer.js:444-505` | `approvalButtons` / `approvalPayload` / `decidedApprovalPayload` | `test:597-618` |
| `cards-v2.js:183` | `toolListCard` | `test:850` |
| `renderer.js:522` | `normalizePayload` | ✅ **例外：`transport.js:10,129,154` 真实使用** |
| `markdown.js:40` | `adaptMarkdownForEmbed` | ✅ **例外：`renderer.js:109` 使用**（但整条链只服务死代码） |

**结论**：`renderer.js` 中 96–505 行（约 410 行）除 `normalizePayload`、`suppressMentions`、`formatDuration`、`progressCaption` 外，**全部只被测试驱动**。`test/helpers.test.js` 有 92 个用例，其中约 20 个（1–5、34–101、294–317、438–445、466–562、596–618、717–749）在给已下线能力保活，是"删代码"的主要阻力。

### 5.3 非导出的死代码 / 无用字段

| 位置 | 内容 | 证据 |
|---|---|---|
| `index.js:149` | `replyPayload()` 定义后从未调用 | `grep replyPayload index.js` 仅 1 处 |
| `index.js:801` | `assertComponentBudget` 注释文案 | `cards-v2.js:519` 的 `assertComponentBudget` 只被测试调用 |
| `markdown.js:244-264` | `padTo`、`clipToWidth` 无任何调用方 | 各出现 1 次（自身定义）；它们只为已被推翻的"空格对齐列宽"方案服务（README 171-172 行仍在描述该方案，**文档过时**） |
| `markdown.js:270-272` | `renderCodeTable` 只是 `renderRecordTable` 的 1 行转发 | 纯残留 |
| `question-registry.js:65-66` + `index.js:1300` | `messageIds` 只 push，从不读取 | 期望"稍后编辑"，但无消费方 |
| `approval.js:66-69`、`question-registry.js:78-80` | `channelOf()` 无调用方 | — |
| `renderer.js:13` `EMBED_FIELD_COUNT_LIMIT` 等 | 常量从未参与任何逻辑 | — |
| `renderer.js:167` | `if (raw.length <= 80) return raw.replace(...)` —— **短参数原样返回**，正是 C6 泄漏的第一级 | — |

---

## 6. 性能观察点

### 6.1 SQLite 写入（`src/audit/db.js`）

- ✅ **已批量 + 已用事务**：缓冲 256 条或 250ms 定时 flush（109–113），`BEGIN … COMMIT` 包住整批（122–124），WAL + `synchronous=NORMAL` + `busy_timeout`（57）。
- ⚠ **每批新建 BEGIN/COMMIT**（122–124）会触发一次 WAL 提交；突发流量下（每回合约 6–10 条记录）这批只装几条，事务意义有限。可改为固定窗口（如 100ms）或 `defer` 到 `setImmediate`。
- ⚠ **`DatabaseSync` 是同步 API**（`db.js:3`）：`flush()` 在事件循环里同步执行 `for (const row of rows) this.statement.run(...)`（123）。虽然 256 行很快，但 `PRAGMA wal_checkpoint(TRUNCATE)`（167）在 `close()` 中是**同步阻塞**，大库（`~/.dsh/dsh-discord/audit.sqlite`）关闭时可能卡百毫秒级。
- ⚠ `record()` 里 `setTimeout(...).unref()`（111–112）—— 进程若在 250ms 内退出，这批审计会丢；`close()` 会 `await this.flush()`（161）兜底，属可接受设计。
- ⚠ 无「`dropped` 计数上报」路径，仅 `logger.warn`（132）。

### 6.2 同步调用出现在异步路径

| 位置 | 说明 | 影响 |
|---|---|---|
| `src/audit/db.js:56,59,122-124,152,167` `DatabaseSync.*` | 全部在 async 链里 | 低（批量小），但 `recent()`（139–157）是**在 `index.js:425` 的异步命令处理里同步查库**，`/dsh system audit` 会阻塞事件循环 |
| `src/config.js:49-51` `fs.existsSync` + `fs.readFileSync` | `loadEnvFile()` 在 `apply()` 同步执行（`index.js:86`） | 启动期一次性，可接受 |
| `src/discord/cards-v2.js:370,445` `Date.now()` 在构造载荷时调用 | 纯计算 | 无问题 |
| `src/bridge/question-registry.js:23-27`、`approval.js:13-19` 模块级 `let counter` | 全局可变状态，多实例共享 | 非性能问题，但影响可测试性（同进程两实例 id 不独立） |

### 6.3 Markdown 渲染的重复解析 / 正则风险

实测（`node`，本机）：

| 场景 | 耗时 |
|---|---|
| `adaptMarkdownForTextDisplay` × 20 次，53.6 KB 文档（含 200 张表） | **86.8 ms**（≈4.3 ms/次） |
| `streamCard` × 50 次（40 KB 正文 + 20 个工具） | **233.7 ms**（≈4.7 ms/次） |
| `toolListCard` × 200 次（40 次调用） | 43.3 ms（≈0.2 ms/次） |
| 20 万字符单行全是 `\|` | 0.3 ms（**未发现 ReDoS**） |
| 5 万行 ``` | 19.5 ms（线性，无回溯爆炸） |

结论与观察：

1. **没有 ReDoS 级回溯**。`markdown.js` 的正则均为行内/单行锚定（`downgradeHeadings` 139、`convertTaskLists` 307、`flattenDeepNesting` 315），最坏情况线性。
2. ⚠ **每次流式编辑都全量重解析整段正文**：`StreamReporter.flush()`(202) → `buildAnswerPayload`(161) → `streamCard` → `cardPayload` → `adaptMarkdownForTextDisplay`(`cards-v2.js:65`)。40 KB 正文约 4.7 ms/次 × 约 1.5–4.5 s 一次 = 可接受，但**没有增量缓存**；`cards-v2.js:65` 对**每一帧**都跑 `mapOutsideCode` + `convertTables`（两遍 `split('\n')`）。
3. ⚠ **正文被解析两次**：`interleaveTools`（`cards-v2.js:127-148`）拼接工具行后，`cardPayload` 再对**整个拼好的 body** 做 `adaptMarkdownForTextDisplay` + `suppressMentions`；工具行本身是已知安全的，重复解析无收益。
4. ⚠ **`suppressMentions` 每次 3 次全串扫描**（`renderer.js:37-40`，2 次 `replaceAll` + 1 次正则）且在 `cardPayload` 里对 title/body/footer 各调一次（59,66,70），body 那条又覆盖了 title 之外的全部内容。
5. ⚠ **`mapOutsideCode` 的围栏判定 `line.trimStart().startsWith('```')`**（118）对行内代码里的 ``` 也成立；虽然没有性能问题，但在长代码文档上会产生不必要的大段"视为围栏"的缓冲区，间接影响表格解析覆盖率（正确性 > 性能）。
6. ✅ `textChunks`/`chunkDiscordText` 的 while 循环每次 `rest.slice(cut)` 复制剩余串（`components-v2.js:222`、`renderer.js:55`），对 40 KB 是 O(n²/limit) 次拷贝；实测未构成瓶颈，但 4000 字符分片 × 超大正文（如 1 MB 输出）会有可感知分配。
7. ⚠ `index.js:426-436` 的 `/dsh system audit` 输出在 **每个 row** 上再做一次 template 拼接，无上限保护以外的风险。

### 6.4 rate-limiter 与 transport 的重试逻辑

| 层 | 实现 | 退避策略 |
|---|---|---|
| `DiscordRateLimiter`（`rate-limiter.js:24-42`） | 串行化 + 全局 `blockedUntil` | `retry_after` 或 `min(30s, 500·2^attempt) + rand(250)`，`maxRetries=5` |
| `DiscordTransport`（`transport.js:27-50`） | **无自身重试**，只 `withAudit` 包 `limiter.run` | 依赖下层 |
| Gateway 登录重连（`index.js:1215-1232`） | **独立第 2 套退避** | `min(30s, 1000·2^min(attempt-1,5))`，无抖动，无上限次数 |
| `DeepSeekApiClient.requestWithRetry`（`api-client.js:71-103`） | **独立第 3 套退避** | `retry_after*1000` 或 `min(30s, 500·2^attempt) + rand(250)`，`maxRetries=4` |
| `StreamReporter.flush` 间隔退避（`stream-reporter.js:182-188`） | 第 4 套"退避"（其实是节流） | 按文本长度拉长 1×–3×，上限 4500ms |

**重复点**：
- `rate-limiter.js:34-36` 与 `api-client.js:89-92` 是**几乎逐字相同**的指数退避 + 随机抖动公式，但两处 `maxRetries` 硬编码/注入方式不同（`config.maxRateLimitRetries` 只作用于前者，`index.js:99`；后者 `this.maxRetries = 4` 写死在 `api-client.js:21`，**配置项管不到**）。
- ①②③ 三条路各自 `sleep`，无统一「退避策略」模块；`sleep` 函数在 `rate-limiter.js:64`、`api-client.js:201`、`privileged-client.js:128` 各写一份。
- ⚠ `api-client.js:73-75` 每次重试新建 `AbortController` + `AbortSignal.any`，`clearTimeout` 在 `finally`（99–101）——**正确**，但 `streamChatCompletion`(129) 在整个流式读取期间持有 `timeout`（120s），长输出会被中途 abort，且 `signal` 组合对象未释放。
- ⚠ `rate-limiter.js:37` `this.blockedUntil = Math.max(...)` 是**全局**的：一次 429 会把所有频道的编辑一起卡住（串行队列本就如此，属设计选择，但与 `stream-reporter` 的 per-turn 节流叠加，长任务下最坏延迟 = 队列长度 × 退避）。

---

## 7. 按模块的拆分 / 合并建议（含改动代价与测试影响）

代价定义：**低** = 纯移动 + 改 import，行为不变；**中** = 顺带改内部结构，需补测试；**高** = 触及线上行为或有潜在回归面。

| # | 建议 | 涉及文件:行 | 代价 | 测试影响 | 备注 |
|---|---|---|---|---|---|
| R1 | **先修 P0 隐私缺陷**（`sudo.exec` 的 stderr 入审计） | `index.js:571` | **低** | 补 1 个用例 | 与重构正交，应最先做 |
| R2 | 拆 `agent-service.js` → `model-route.js` | `agent-service.js:100-130,214-279,525-597` | 低 | `test:318-398` 需改为直接测 `ModelRouter`（或保持 `AgentService` 门面不破） | 拆完 `agent-service.js` 约 −190 行 |
| R3 | 拆 `agent-service.js` → `session-catalog.js` | `agent-service.js:649-712,742-756` | 低 | 当前 0 覆盖，新增即可 | 顺带把 `channelForAgent`/`liveAgentFor` 的线性扫描换 `WeakMap` |
| R4 | 拆 `agent-service.js` → `agent-observer.js`（含 3 个 `ctx.on`） | `agent-service.js:20-22,599-647,730-739` | 中 | `test:318-388` 的 `ctx: { on: () => () => {} }` 桩仍可用 | 解掉 §7.1 的订阅-调用环 |
| R5 | `extractSessionId` → `src/discord/session-id.js`；`greetingPrompt` → `src/discord/prompts.js` | `agent-service.js:837-875` | 低 | 改 `test:117` 的 import 路径 | 让 bridge 层不再含 Discord 输入格式知识 |
| R6 | **新增 `src/discord/text.js`**：`suppressMentions`、`clipOneLine`、`formatDuration`、`chunk` | 从 `renderer.js:36-88` 迁 | 低 | `test:4-14` 的 import 来源需改 | 打断 `cards-v2 → renderer` 的反向依赖 |
| R7 | **删除 `renderer.js` 的 Embed 卡片体系**（96–505），保留 `text.js` + `normalizePayload` | `renderer.js:96-505` | **中→高** | **约 20 个用例作废**（`test:34-101,294-317,438-445,466-562,596-618,717-749`），需删除或改为 V2 等价断言 | 收益最大：−410 行、消除 C4–C6 隐私地雷、两份调色板/两份时长格式化合一；风险是误删 `normalizePayload`/`progressCaption` 的线上依赖 |
| R8 | 合并 `cards-v2` 与 `components-v2` 的重复：`formatElapsed` 合并进 `text.js:formatDuration`；`withStopRow`/`approvalCard` 与 `renderer` 版二选一 | `cards-v2.js:484-513`、`renderer.js:411-505` | 低 | 改 3–5 个断言 | 与 R7 一起做最划算 |
| R9 | `markdown.js` 清理：删 `padTo`/`clipToWidth`/`renderCodeTable`(转发层)；`wrapLongCodeLines` 与 `mapOutsideCode` 共用一套围栏状态机 | `markdown.js:64-98,244-272` | 低 | `test:426-430` 仍覆盖未闭合围栏 | 顺带更新 README「171-172 行」已过时的列宽说明 |
| R10 | `untrusted.js` 下沉为 `src/text/untrusted.js` | `attachments.js:1`、`agent-service.js:2` | 低 | 改 `test:15` import | 消除 `discord → bridge` 反向依赖 |
| R11 | 统一退避：抽 `src/util/backoff.js`（含 `sleep`），`rate-limiter` 与 `api-client` 共用；`DeepSeekApiClient.maxRetries` 接入配置 | `rate-limiter.js:34-36,64`、`api-client.js:21,89-92,201`、`privileged-client.js:128`、`index.js:1215-1232` | 中 | 需补 `api-client` 的重试单测（当前无） | 4 → 1 份退避实现 |
| R12 | `index.js` 减负：`handleCommand` 的 switch（约 250 行）迁 `src/discord/command-router.js`；`system/ask` 探针（`index.js:442-478`）删除 | `index.js:243-597,442-478` | 中 | `describeInteraction` 日志用例需替换 | 恢复 AGENTS.md「index.js 只管生命周期/鉴权/路由」 |
| R13 | 清理纯死导出（§5.1 中 `privileged-protocol` 的 5 个、`components-v2` 的 6 个常量、`config` 的再导出） | 见 §5.1 | 低 | 无（均无引用） | 需注意 `workDir`/`secretPath` 是 `privd/` 的协议概念，删除前确认与 `privd/dsh-privd.cjs` 无共享需求 |
| R14 | `question-registry.messageIds`、`approval.channelOf`、`index.js:149 replyPayload` 删除 | — | 低 | 无 | — |

建议节奏：**R1 → R6/R10（打断反向依赖）→ R2/R3/R5 → R7/R8（最大删除）→ R9/R13/R14 → R4/R11/R12**。每一轮都跑 `npm test` + `node -e "await import('./index.js')"`（AGENTS.md 114-119 的硬门槛）。

### 7.1 顺带发现的旁证

- **`cleanupIdle` 无任何测试覆盖**：`index.js:1242` 是唯一调用点（`setInterval`），`grep -n "cleanupIdle" index.js src` 仅 2 处，`npm test` 92 个用例无一触及。**注意**：审查过程中我曾怀疑 `void agents.cleanupIdle().catch(...)` 会抛 `TypeError`，实测**不成立**——`async` 方法返回 Promise，`.catch` 合法（`node -e` 验证：打印 `cleanup body ran` / `no throw`）。该调用点写法正确，但**零覆盖**意味着空闲回收与 LRU 上限的回归无法被测试发现，建议在 R4 拆分时补一个纯函数化的 `selectIdleRuntimes()` 单测。
- **`mountPreset` 的审计字段**：`agent-service.js:165-166,181-182` 使用 `runtime.channelId`/`runtime.key`；`runtime()`(52–54) 保证两者存在，**未发现问题**，仅提示拆分 R2/R3 时不要丢掉这两个字段。

---

## 8. 发现汇总（按优先级）

| 优先级 | 编号 | 发现 | 位置 | 证据 |
|---|---|---|---|---|
| **P0** | 1 | `sudo.exec` 把 root 进程 stderr 写进审计 `error`，违反「不可记命令内容/参数值」红线 | `index.js:571`；来源 `privd/dsh-privd.cjs:116-126` → `privileged-client.js:106-111` | `db.js:107` 对 `error` 只做 token 脱敏 + 2000 截断，不区分内容类型 |
| **P0** | 2 | `renderer.js` 中 `toolEmbed({showArgs:'full'})` / `streamPayload` / `summarizeToolArgs` 会**原样渲染工具参数值**（含 `command`/`prompt`/`path`/`query`），与 `cards-v2.describeTool` 的白名单策略正好相反；目前仅靠"生产无调用方"守住红线，测试还在主动加固这条链路 | `renderer.js:165-188,196-225,332-351` | §4.2 C4–C6；§5.2 引用表（`test:34-42` 直接断言参数 `cmd` 被渲染） |
| **P1** | 4 | `renderer.js` 96–505 行（≈410 行）为遗留 Embed 体系，生产零调用、仅测试驱动；与 `cards-v2` 重复了工具描述/分片/格式化/调色板/按钮/批准三态 | `renderer.js:96-505` vs `cards-v2.js:33-40,157-199,225-269,282-286,468-513` | §2.2 对照表；§5.2 |
| **P1** | 5 | `cards-v2.describeTool` 对 `read/write/edit/glob` 输出文件路径，与 AGENTS.md「不显示参数值」冲突（README 157 行反向承认）；`title`/`reason` 字段也可能携带用户原文 | `cards-v2.js:207-213,236-250` | §4.2 C1/C3；AGENTS.md:154 |
| **P1** | 6 | `agent-service.js` 875 行承担 6 类职责，`runtimes` 被 9 处线性扫描；`installSelection` 依赖两个中间件的执行顺序 | `agent-service.js:35,222,230,246,618,733,761,772,831` | §1.1/§1.3 |
| **P2** | 7 | 依赖方向：无 DSH/discord.js 硬违规，但存在 `bridge → discord` 渲染层（`stream-reporter.js:1-7`）、`discord → bridge` 反向（`attachments.js:1`）、`cards-v2 → renderer` 同层反向（`cards-v2.js:29`） | 同左 | §3 |
| **P2** | 8 | 退避逻辑 4 套并存（rate-limiter / api-client / gateway 重连 / reporter 节流），`sleep` 三份；`DeepSeekApiClient.maxRetries=4` 写死不受配置控制 | `rate-limiter.js:34-36,64`、`api-client.js:21,89-92,201`、`privileged-client.js:128`、`index.js:1215-1232` | §6.4 |
| P2 | 9 | 渲染无 ReDoS，但每次流式编辑全量重解析（40KB≈4.7ms/次）、`suppressMentions` 每帧 3 次全串扫描、`shortenPath`/`clipToWidth` 等死工具残留 | `cards-v2.js:59,65-70,127-148`；`markdown.js:244-264` | §6.3 实测表 |
| P2 | 10 | 死导出 40+ 个（完全无引用 ~37 个 + 仅测试引用 ~9 个）；`messageIds`、`channelOf`、`replyPayload`、`renderCodeTable` 等非导出死代码 | §5.1/§5.2/§5.3 | 脚本化交叉引用 |
| P2 | 11 | `index.js` 1595 行，`handleCommand` switch ≈250 行、`system/ask` 临时探针未删 | `index.js:243-597,442-478` | 与 AGENTS.md:141 冲突 |
| P2 | 12 | `StateStore.claimEvent` 先 push 后 `persist`（`state-store.js:77-85`），持久化失败会被 `writes` 吞掉，去重窗口只在内存里；`audit` 脱敏正则只覆盖 `MT…` 形态 token | `state-store.js:87-98`；`audit/db.js:185` | 阅读 + `persist()` 的 `catch(() => undefined)`(96) |

---

## 附录 A：复现命令

```bash
cd /home/ecs-user/dsh-plugins/dsh-discord-bridge
npm test                                                # 92 pass
node -e "await import('./index.js'); console.log('ok')"  # ok
grep -rn "deepseek-ai|dsh-|from '.*bridge/" src/discord/ # 仅 commands.js:4 文案 + attachments.js:1
grep -rn "discord" src/bridge/                           # 仅注释/字符串，无 import
node /tmp/exports.mjs                                    # 导出交叉引用（§5）
```

## 附录 B：本次审查未覆盖

- `index.js` 仅作参照阅读（未逐函数深审），其拆分建议（R12）基于体量与 `AGENTS.md` 定位，未做逐行行为核对。
- `privd/`（`dsh-privd.cjs`、`install-privd.sh`）只读了与审计链路（A1）相关的 90–226 行。
- 未运行集成测试（需真实 Discord token 与 DSH 会话），所有结论均来自静态阅读 + 单测 + 本机微基准。
