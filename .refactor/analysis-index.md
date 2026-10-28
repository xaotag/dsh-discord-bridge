# index.js 结构分析与重构建议

> 目标文件：`index.js`（1595 行）· 分支 `v2-questions-modal` · 分析日期 2026-10-29
> 方式：只读分析（未修改任何文件、未建分支、未提交）。全部结论附行号证据。
> 基线复核：`node -e "await import('./index.js')"` → OK（导出 `Config/apply/inject/name`）；`npm test` → 92/92 通过。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 组合根职责 | **已明显越界**。AGENTS.md/llms.txt 规定 "index.js 只管生命周期、鉴权、路由"，实际它同时承担了 21 个业务 handler、审计埋点、错误文案、卡片拼装、DeepSeek 流式编排 |
| 可拆性 | 注册表式拆分**可行**：`handleCommand` 的 19 个分支全部只依赖 7 个已实例化的服务对象，不依赖任何可变闭包变量（`disposed/clientUser/cleanupTimer/lastActiveChannelId` 在该函数体内**零引用**） |
| 拆出的拦路虎 | 3 个"弱闭包"依赖必须先抽象：`respond()` 的目标多态（L156-163）、`runPrompt()` 在命令分支内的直接调用（L408-416）、`routeMeta()` 的配置回退（L128-147） |
| 已知历史坑现状 | `textChunks` 从 `components-v2.js` 导入 **正确**（L49，该函数确实在 `components-v2.js:210` 导出）；`interaction` 越界已修，但 `routeMeta()` 内的嵌套 `catch {}`（L128-147）是同类隐患的温床 |
| 发现总量 | 14 条，其中 P0×1、P1×7、P2×6（详见第 6 节） |

---

## 1. 函数清单：起止行、行数、闭包捕获、调用关系

### 1.1 顶层作用域（`apply` 之外）

| 符号 | 行 | 说明 |
|---|---|---|
| `PLUGIN` / `DELEGATE` / `MENTION_FOLLOWUP_WINDOW_MS` | L71-75 | 模块常量 |
| `createLogger()` | L77-82 | 6 行，纯函数 |
| `safeError()` | L1585-1588 | 4 行，纯函数（**唯一**的错误脱敏入口，但只在 5 处使用） |
| `clipForDiscord()` | L1591-1595 | 5 行，纯函数（只在 2 处使用） |

### 1.2 `apply(ctx, rawConfig)`（L84-1583，1500 行）内部函数

行数 = 含 `function` 声明行到结束 `}`（含块内注释与空行）。

| # | 函数 | 起止 | 行数 | 捕获的外部变量（闭包） | 调用的兄弟函数 |
|---|---|---|---|---|---|
| 1 | `greeting(userName)` | L117-122 | 6 | 无（纯函数，仅用 `new Date()`） | — |
| 2 | `routeMeta(conversationKey)` | L128-147 | 20 | `state`、`ctx`、`config` | — |
| 3 | `replyPayload(text, message)` | L149-154 | 6 | **无**（`text`/`message` 均未使用 → 死代码） | — |
| 4 | `respond(target, text, opts)` | L156-163 | 8 | `transport` | — |
| 5 | `runPrompt({...})` | L167-238 | 72 | `config`、`threads`、`transport`、`logger`、`agents` | `routeMeta`（L209, L220） |
| 6 | `handleCommand({...})` | L242-624 | **383** | `state`、`ctx`、`agents`、`audit`、`transport`、`config`、`logger`、`privileged`、`threads`、`approvals` | `respond`、`runPrompt`（L408）、`requestApproval`（L487, L528）；`respond` **33 次** |
| 7 | `handleMessage(message)` | L628-750 | 123 | `disposed`、`clientUser`、`config`、`lastActiveChannelId`、`audit`、`state`、`logger`、`transport`、`pendingMentions` | `greeting`(L674)、`handleCommand`(L709)、`runPrompt`(L722) |
| 8 | `handleAutocomplete(interaction)` | L754-806 | 53 | `config`、`transport`、`agents`、`logger`、`ctx` | — |
| 9 | `handleDeepSeekAutocomplete(interaction)` | L808-832 | 25 | `config`、`transport`、`deepseek` | — |
| 10 | `handleDeepSeekInteraction(interaction, request)` | L834-929 | 96 | `deepseek`、`transport`、`config`、`logger`、`routeMeta` 闭包内的 `state`/`ctx` | `routeMeta`(L877)；**内联 `new StreamReporter`**(L871-879) |
| 11 | `handleApprovalButton(interaction, customId)` | L941-985 | 45 | `config`、`transport`、`approvals`、`audit`、`logger` | — |
| 12 | `handleButton(interaction)` | L994-1043 | 50 | `config`、`transport`、`agents`、`audit`、`logger` | `handleQuestionCustom`(L997)、`handleApprovalButton`(L1003) |
| 13 | `handleInteraction(interaction)` | L1045-1151 | 107 | `disposed`、`config`、`transport`、`logger`、`audit` | `handleButton`、`handleQuestionModalSubmit`、`handleQuestionSelect`、`handleAutocomplete`、`handleDeepSeekAutocomplete`、`handleDeepSeekInteraction`、`handleCommand` |
| 14 | `resolveToken()` | L1155-1170 | 16 | `config`、`ctx`、`logger` | — |
| 15 | `start()` | L1172-1247 | 76 | `ctx`、`logger`、`config`、`disposed`、`transport`、`state`、`audit`、`agents`、`cleanupTimer`、`clientUser` | `resolveToken`(L1183)、`handleMessage`/`handleInteraction` 作为回调传入(L1204-1205) |
| 16 | `answerUserQuestions(request)` | L1264-1323 | 60 | `agents`、`questions_`、`audit`、`logger`、`transport`、`DELEGATE` | — |
| 17 | `isQuestionCustomId(customId)` | L1326-1329 | 4 | 无（纯函数） | — |
| 18 | `parseQuestionKey(customId, prefix)` | L1332-1337 | 6 | 无（纯函数） | — |
| 19 | `handleQuestionSelect(interaction)` | L1346-1407 | 62 | `config`、`transport`、`questions_`、`logger` | `parseQuestionKey` **未调用**（L1350-1353 手工内联同逻辑） |
| 20 | `handleQuestionCustom(interaction)` | L1416-1443 | 28 | `config`、`transport`、`questions_`、`logger` | `parseQuestionKey`(L1423) |
| 21 | `handleQuestionModalSubmit(interaction)` | L1451-1493 | 43 | `transport`、`questions_`、`logger` | `parseQuestionKey`(L1452) |
| 22 | `requestApproval({...})` | L1495-1524 | 30 | `approvals`、`transport`、`audit`、`logger` | — |

此外还有 3 个**非函数但同样内联在 `apply` 里**的注册点：

- `ctx.on('user-questions/request', ...)` L1538-1556（19 行，内联 lambda，重复了 `answerUserQuestions` 的 `questions` 解析 L1540-1541 和 `channelForAgent` 判断 L1543/L1547）
- `ctx.effect(...)` 卸载逻辑 L1558-1572（15 行，内联 lambda，含 `approvals.clear`/`questions_.clear`/`Promise.allSettled`）
- `void start().catch(...)` L1574-1576 + 初始化日志 L1578-1582

### 1.3 调用关系图（只画跨函数边）

```
start ──resolveToken
  └─(回调) handleMessage ──greeting / handleCommand / runPrompt
  └─(回调) handleInteraction ──handleButton ──handleQuestionCustom / handleApprovalButton
                               ├─handleQuestionModalSubmit
                               ├─handleQuestionSelect
                               ├─handleAutocomplete
                               ├─handleDeepSeekAutocomplete
                               ├─handleDeepSeekInteraction (自建 StreamReporter)
                               └─handleCommand
handleCommand ──respond(×33) / runPrompt(L408) / requestApproval(L487,L528)
runPrompt ──routeMeta
ctx.on('user-questions/request') ──answerUserQuestions
```

**扇出最高的 3 个点**：`handleCommand`（33 次 `respond`）、`handleInteraction`（7 个分支，其中 5 个用 `.catch(noop)` 包裹，L1049-1070）、`handleMessage`（3 个下游）。

### 1.4 闭包变量使用统计

| 变量 | 声明 | 被哪些函数使用 |
|---|---|---|
| `logger` | L86 | 几乎全部（29 处 `logger.warn(`） |
| `config` | L87 | 全部 handler |
| `state` | L88 | `routeMeta`(L130)、`handleCommand`(L653 见 §4.3 说明：实为 `handleMessage`)、`handleMessage` |
| `audit` | L89 | 12 个 `audit.record` 调用点（L493, 535, 562, 642, 734, 963, 1017, 1105, 1133, 1279, 1309, 1509） |
| `transport` | L95 | 全部 handler |
| `agents` | L97 | `handleCommand`、`handleMessage`、`handleAutocomplete`、`handleButton`、`start`、`answerUserQuestions` |
| `approvals` | L98 | `handleCommand`(L487,L528 经 `requestApproval`)、`handleApprovalButton`、`requestApproval` |
| `questions_` | L99 | 4 个 `handleQuestion*` + `answerUserQuestions` |
| `lastActiveChannelId` | L103 | **只写不读** → 死变量（见 §6 P2-11） |
| `privileged` | L104 | 仅 `handleCommand` 的 `system/sudo` 分支(L519, L555) |
| `deepseek` | L108 | `handleDeepSeekAutocomplete`、`handleDeepSeekInteraction` |
| `threads` | L109 | `runPrompt`(L187)、`handleCommand` 的 `thread/create`(L603) |
| `disposed` | L111 | `handleMessage`(L629)、`handleInteraction`(L1046)、`start`(多处)、`ctx.on`(L1539)、`ctx.effect`(L1560)、`start().catch`(L1575) |
| `cleanupTimer` | L112 | 仅 `start`(L1241)、`ctx.effect`(L1562) |
| `clientUser` | L113 | `handleMessage`(L629,L630,L652,L662)、`start`(L1207,L1236) |
| `pendingMentions` | L115 | 仅 `handleMessage`(L654,L672,L683,L688) → **局部性最强，无界增长** |

---

## 2. 纯路由 vs 强闭包：拆分判定与参数清单

判定标准：
- **纯路由**：函数体内只用「构造器注入即可获得的服务对象」+ 入参，不读写 `apply` 内的 `let` 变量。
- **强闭包**：读写 `disposed / clientUser / cleanupTimer / lastActiveChannelId / pendingMentions`。

### 2.1 判定结果

| 函数 | 判定 | 备注 |
|---|---|---|
| `greeting` | ✅ 纯函数 | 直接移到 `src/discord/greeting.js` 或 `src/bridge/` |
| `routeMeta` | 🟡 纯路由（需 3 个注入） | `state`/`ctx`/`config` 都是构造期固定对象 |
| `replyPayload` | ✅ 死代码 | 删除 |
| `respond` | 🟡 纯路由，但**目标多态**必须显式化 | 见 §2.3 |
| `runPrompt` | 🟡 纯路由（7 个注入） | 与 `StreamReporter`、`ThreadManager` 强耦合 |
| **`handleCommand`** | ✅ **纯路由** | 函数体内无任何 `disposed/clientUser/...` 引用 |
| `handleMessage` | ❌ 强闭包 | 用 `disposed`(L629)、`clientUser`(L629-630,L652,L662)、`pendingMentions`(L654-688)、`lastActiveChannelId`(L641) |
| `handleAutocomplete` | ✅ 纯路由 | |
| `handleDeepSeekAutocomplete` | ✅ 纯路由 | |
| `handleDeepSeekInteraction` | 🟡 纯路由 + 需注入 `StreamReporter` 工厂 | 否则拆出后要反向 import `bridge/stream-reporter.js`（依赖方向 OK，但无法注入 fake） |
| `handleApprovalButton` | ✅ 纯路由 | |
| `handleButton` | ✅ 纯路由 | 但见 §6 P2-13（提前 defer 会废掉 modal） |
| `handleInteraction` | ❌ 弱闭包（仅 `disposed` L1046） | `disposed` 可改为注入 `isDisposed()` 回调 |
| `resolveToken` | 🟡 纯路由 | 建议移到 `src/config.js` |
| `start` | ❌ 强闭包 | 改 `clientUser`、`cleanupTimer`，且注册回调 |
| `answerUserQuestions` | ✅ 纯路由 | `DELEGATE` 是模块常量 |
| `isQuestionCustomId` / `parseQuestionKey` | ✅ 纯函数 | 直接移入 `src/discord/question-ids.js` |
| `handleQuestionSelect` / `handleQuestionCustom` / `handleQuestionModalSubmit` | ✅ 纯路由 | |
| `requestApproval` | ✅ 纯路由 | |

**统计**：21 个函数中 15 个可无痛外移，3 个需小幅抽象（`respond`/`handleInteraction`/`handleDeepSeekInteraction`），3 个应留在组合根（`handleMessage`/`start`/闭包 lambda）。

### 2.2 拆出后需要传的参数（具体清单）

所有 handler 共享一份 `deps`（建议在 `src/bridge/deps.js` 定义 JSDoc typedef）：

```
deps = {
  config, logger, transport, audit, state,
  agents, threads, approvals, questions, privileged, deepseek,
  respond,                 // 见 §2.3：显式化后的回复器
  runPrompt,               // 仅 commands/task.js 需要
  requestApproval,         // 仅 commands/system.js 需要
  renderRouteMeta,         // routeMeta 改名，避免与 deps 混淆
}
```

逐函数差异：

| 函数 | 必须额外传 | 可省略 |
|---|---|---|
| `handleCommand`（拆成各 command 模块） | `deps` 全集（`privileged`/`deepseek` 仅对应模块需要） | `deps.deepseek`（`/dsh` 不用） |
| `runPrompt` | `{threads, transport, agents, logger, config, renderRouteMeta, StreamReporter}` —— 注意 **`StreamReporter` 类本身**（L203, L213 用 `new`） | — |
| `respond(target, text, opts)` | `{transport, noticeCard}` | — |
| `routeMeta(key)` | `{state, config, getDefaultSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.()}` | — |
| `handleMessage` | `{deps, isDisposed, getClientUser, pendingMentions, markActiveChannel}` | — |
| `handleInteraction` | `{deps, isDisposed}` | — |
| `start` | `{deps, ctx, fsp, setClientUser, setCleanupTimer, isDisposed}` | — |
| `handleDeepSeekInteraction` | `{deepseek, transport, config, logger, StreamReporter, renderRouteMeta}`（L871-878 需要 `new StreamReporter`） | `state`/`ctx`（经 `renderRouteMeta`） |
| `answerUserQuestions` | `{agents, questions, audit, logger, transport, DELEGATE}` | `config` |
| `handleButton` / `handleApprovalButton` | `{transport, config, audit, logger, agents, approvals, questions, handleQuestionCustom}` | `state` |
| `handleQuestionSelect/Custom/ModalSubmit` | `{transport, config, questions, logger, parseQuestionKey}` | `audit`（这四个当前**完全不记审计**，见 §5） |
| `handleAutocomplete` | `{config, transport, agents, logger, getDefaultProvider: () => ctx.get(...)}`（L788-795） | — |

### 2.3 关键抽象：`respond()` 的目标多态（L156-163）

```js
async function respond(target, text, { replyToMessageId, ephemeral = true } = {}) {
  if (target?.isRepliable) { return transport.editInteraction(target, text).catch(() => transport.replyInteraction(...)) }
  return transport.send(target, noticeCard(text), { replyToMessageId })
}
```

- **调用形态 1**（slash）：`target = interaction`（L1128）→ 走 `isRepliable` 真分支。
- **调用形态 2**（文本命令）：`target = channelId` **字符串**（L714）→ `string.isRepliable === undefined` → 走 `transport.send` 分支。
- `runPrompt({ placeholder: undefined })` 在文本命令路径上（L413）导致 `task/ask` 走文本路径时会再发一条新卡，而 placeholder 从不被清理。

条件读 `target?.isRepliable` 属**鸭子类型隐式约定**，拆模块时必须显式化，建议改为两种具名回复器：

```js
makeInteractionResponder(interaction)  // -> (text) => transport.editInteraction
makeChannelResponder(channelId, replyToMessageId) // -> (text) => transport.send
```

这样 33 处 `respond(...)` 可以原样平移，且 `ephemeral` 参数（L156，**33 个调用点无一传入**）可以删除。

---

## 3. `handleCommand` 的 switch 分支分组评估

### 3.1 分支矩阵

| 分组 | 分支 | 行 | 依赖 | 有无审计 |
|---|---|---|---|---|
| system | `help` | L250-252 | `respond` | ❌ |
| system | `ping` | L253-260 | `transport.client?.ws?.ping` | ❌ |
| system | `audit` | L420-441 | `audit.flush/recent/enabled` | （读，非写） |
| system | `ask` **（临时代码）** | L449-478 | `agents.liveAgentFor`、`ctx.userQuestions` | ❌ |
| system | `confirm` | L480-510 | `requestApproval` + `audit` | ✅ `approval.decided`(L495) |
| system | `sudo` | L511-600 | `privileged`、3 个 outcome 辅助函数 | ✅ `sudo.decision`(L537) + `sudo.exec`(L564)，**两段式** |
| session | `status` | L261-264 | `agents.touch/status` | ❌ |
| session | `list` | L265-284 | `agents.listSessions` | ❌ |
| session | `bind` | L285-315 | `extractSessionId`、`agents.isLiveOrPersisted/listSessions/bindSession` | ❌（仅 `logger.log` L288,L310） |
| session | `new` | L316-321 | `agents.newSession` | （`agent-service` 内部可能记） |
| session+task | `stop`（共用 fallthrough L322-327） | L322-327 | `agents.stop` | ❌ |
| model | `list` | L328-345 | `agents.touch/agentOptions/listModels` | ❌ |
| model | `set` | L346-362 | `agents.setSettings` | ✅ 下游 `config/settings.changed`（agent-service.js:549-551） |
| model | `reasoning` | L363-398 | `agents.listReasoningEfforts/setSettings` | ✅ 同上 |
| task | `steer` | L399-404 | `agents.steer` | ❌ |
| task | `ask` | L405-418 | `respond` + **`runPrompt`**（L408-416） | ❌（`runPrompt` 内无审计，`agents.run` 有 `agent/run.start`） |
| thread | `create` | L601-607 | `threads.create` | （`transport.createThread` 有 `thread.create`） |
| thread | `info` | L608-620 | 纯字符串 | ❌ |
| — | `default` | L621-622 | `throw new Error('未知命令...')` | — |

**规模**：19 个 case（18 个有效 + default），383 行，最长分支 `system/sudo` L511-600（**90 行**，含 stdout/stderr 拼装），其次 `system/ask` 30 行、`session/bind` 31 行。

### 3.2 拆成 `src/bridge/commands/*.js` 注册表的可行性：**可行，风险中低**

**可行的硬证据（闭包侧）**

- `handleCommand` 函数体对可变闭包变量零引用：全文件搜索 `disposed|clientUser|cleanupTimer|lastActiveChannelId|pendingMentions` 的命中行（L111-115 声明；L629-629、L641、L652、L672、L683-688、L1046、L1178-1237、L1241-1246、L1539-1575）均**不在 L242-624 区间内**。
- 每个分支只经由注入对象访问状态：`agents.*`、`threads.*`、`privileged.*`、`audit.*`、`transport.*`。

**推荐结构**

```
src/bridge/commands/
  index.js      // export function createCommandRegistry(deps) -> Map<route, handler>
  system.js     // help ping audit ask confirm sudo
  session.js    // status list bind new stop
  model.js      // list set reasoning
  task.js       // ask steer stop
  thread.js     // create info
```

`handleCommand` 退化为：

```js
const handler = registry.get(`${group}/${command}`)
if (!handler) throw new Error(`未知命令 /dsh ${group} ${command}`)
return handler(commandCtx)   // { arg, channelId, guildId, kind, target, replyToMessageId, commandUserId }
```

**风险清单（逐条给出缓解方式）**

| 风险 | 证据 | 缓解 |
|---|---|---|
| R1 错误文案与 `safeError` 只出现在 `handleInteraction` 的 `catch`（L1131-1150），命令模块必须保持「只 throw、不自行回复错误」的契约 | L1144, L1147 | 在 `commands/index.js` 注释中固化契约；给 registry 加一条单测：handler 抛错时不调用 `respond` |
| R2 `task/stop` 与 `session/stop` 共用 fallthrough（L322-327） | L322-323 | registry 里两条 route 指向同一 handler 引用即可，行为等价 |
| R3 `system/confirm` & `system/sudo` 依赖 `requestApproval`（本身依赖 `approvals` 注册表 + `audit`） | L487, L528 | 只给 `system.js` 注入 `requestApproval`，其它模块拿不到，减少误用 |
| R4 `system/sudo` 需要 `privilege-outcome.js` 的 3 个辅助函数 | L577, L588, L590 | 属于纯函数，直接 import 进 `system.js`，不增加依赖方向问题 |
| R5 文本命令 `target` 是 `channelId` 字符串，分支里 `target.channelId`（L486, L517）退回 `channelId` | L486, L517 | 显式化 responder 后（§2.3），`channelIdForApproval` 可以恒等于 `channelId`（第 517 行已 `|| channelId`） |
| R6 `system/ask` 是**临时探针**，注释要求"验证后删除"（L442-448） | L442-448 | 迁移前先删；否则会把临时代码固化进新模块 |
| R7 现有 92 个用例**没有一条**直接测 `handleCommand`（`test/helpers.test.js:843-847` 只验证入口可加载） | test/helpers.test.js:843 | 先补"registry 遍历所有 route 都有 handler" + "每个 handler 抛出时冒泡" 两条，再迁 |
| R8 `normalizeInteraction` 的 `legacy` 表有**重复键**，`ask` 实际映射到 `system/ask` | commands.js:246 & 250（见 §6 P1-8） | 拆分命令模块前先修这张表，否则依赖 legacy 路径的用户会落到探针分支 |

---

## 4. 重复代码模式

### 4.1 错误处理：`safeError` 用法**不一致**

`safeError`（L1585-1588）做的是「抹掉 ≥20 字符的 token 形串 + 截断 500」。

| 位置 | 是否用 `safeError` |
|---|---|
| L475 `system/ask` 失败 | ✅ |
| L746 `handleMessage` 失败 | ✅ |
| L927 DeepSeek 失败 | ✅ |
| L1039 停止按钮失败 | ✅ |
| L1144 / L1147 slash 命令失败 | ✅（同一文案两处重复） |
| **L1034→L1036** 停止按钮 catch 中 `logger.warn(error?.stack)` | 日志里是**原始 message**，未脱敏 |
| L734 `handleMessage` 审计 `error: error?.message` | 审计层 `db.js:107` 会 `redact`，✅ |
| L548 超时/拒绝文案 | 无需 |

**结论**：回复侧一致；**日志侧 29 处 `logger.warn(..., error?.message || String(error))` 全部未过 `safeError`**。若上游错误含 bot token / API key，会原样进 journald。建议统一为 `logger.warn(prefix, safeError(error))`。

### 4.2 审计记录：**散落 + 字段不齐**

12 个 `audit.record` 调用点（L493/535/562/642/734/963/1017/1105/1133/1279/1309/1509）。字段一致性对照：

| 调用点 | action | channelId | guildId | conversation | userId | durationMs |
|---|---|---|---|---|---|---|
| L493 | `approval.decided` | ✅ | ❌ | ✅ | ✅ | ❌ |
| L535 | `sudo.decision` | ✅ | ❌ | ✅ | ✅ | ❌ |
| L562 | `sudo.exec` | ✅ | ❌ | ✅ | ✅ | ✅ |
| L642 | `message.received` | ✅ | ✅ | ✅ | ✅ | ❌ |
| L734 | `message.handle` | ✅ | ✅ | ✅ | ✅ | ❌ |
| L963 | `button.approve/reject` | ✅ | ✅ | ✅ | ✅ | ❌ |
| L1017 | `button.stop` | ✅ | ✅ | ✅ | ✅ | ❌ |
| L1105/L1133 | `slash.command` | ✅ | ✅ | ✅ | ✅ | ❌ |
| L1279 | `question.request` | ✅ | ❌ | ✅ | ❌ | ❌ |
| L1309 | `question.answered` | ✅ | ❌ | ✅ | ❌ | ❌ |
| L1509 | `approval.request` | ✅ | ❌ | ✅ | ✅ | ❌ |

- `guildId` 只有来自 message/interaction 的 6 个点有；`approval.*`/`sudo.*`/`question.*` 全部缺失，尽管 `handleCommand` 入参里就有 `guildId`（L242）。
- `question.*` 缺 `userId`（L1279/L1309），无法回答"谁改的"。
- **完全没有审计的写操作**：`session/bind`（L285-315）、`session/new`（L316-321）、`model/set`（L346-362，仅下游 `settings.changed`）、`task/steer`（L399-404）、`thread/create`（L601-607，仅 transport 层 `thread.create`）、`system/confirm` 的批准侧（有 `decided` 但无"实际执行"）、4 个 `handleQuestion*` 交互（L1346-1493）。
- `transport.withAudit`（transport.js:27-50）自动记了 `category:'discord'` 的 REST 审计，但 **`deferButton`(transport.js:227-230) 与 `respondAutocomplete`(295-300) 走了 `limiter.run` 裸路径，绕过审计** —— 与其余 transport 方法不一致。

### 4.3 `reply` / `ephemeral` 惯用法重复

| 惯用法 | 出现处 | 重复次数 |
|---|---|---|
| `transport.replyEphemeral(interaction, ...).catch(() => undefined)` | L951, 957-959, 982-983, 1011-1013, 1034, 1039-1040, 1358, 1365, 1379, 1386, 1405-1406, 1420, 1427, 1441 | **15 处** |
| `.catch(() => undefined)` 静默吞错 | 全文件 **26 处** | 另一半是 `.catch((error) => logger.warn(...))`，共 7 处（L677, 904, 997-999, 1030-1032, 1049-1051, 1055-1057, 1061-1063, 1067-1069, 1242-1244）。两种风格混用：**同一个 transport 调用在某些位置吞错、某些位置 log**，且吞错处既不记审计也不进日志（例：L951 授权失败回复发送失败 → 用户永远收不到任何反馈，日志也没有痕迹）。 |
| `audit.record({...})` 全量重复 11 字段模板 | 12 处 | 可抽 `recordEvent(base, {action, status, ...})` |
| `notAuthorized` 文案 | L951, L1011, L1358, L1420, L1074 | **5 处**"你不在授权名单内。"，且 L1074 直接调 `interaction.reply({content, ephemeral:true})` 绕过 transport（**不记审计、不走 V2 payload**） |
| `'这个问题已经失效或已作答。'` | L1365, L1386, L1427, L1457 | 4 处 |
| `'❌ ...失败：' + safeError(error)` | L475, L745, L927, L1039, L1144, L1147 | 6 处 |
| `authorized(config, interaction.user?.id, interaction.guildId || undefined, interaction.channelId || '')` | L755, 809, 950, 1009, 1073, 1099, 1357, 1419 | **8 处**，其中 L755/L809 用 `interaction.user.id`（无 `?.`），L1357/L1419 用 `interaction.user?.id` → 解构风格不一，建议抽 `authzCheck(interaction)` |

### 4.4 `try { ... } catch { ... }` 模板

- **「defer → 授权 → 处理 → 回错误」模板**：`handleApprovalButton`(L949-984)、`handleButton`(L1008-1042)、`handleQuestionSelect`(L1355-1406) 结构几乎相同。
- **「catch → logger.warn → replyEphemeral」模板**：L1036-1041、L1439-1442、L1483-1485（后者只 warn，不回复）。
- **嵌套 `try/catch` 静默吞错**：`routeMeta` L129-146 有两个 `try`，外层 `catch {}`（L144-146）会把任何 `state.conversation()` 的异常变成 `{}`，调用方 `...routeMeta(...)`（L209/L220/L877）展开时不会报错但**丢掉模型名**。

---

## 5. 可能的 bug / 行为不一致

> 每条都给出"触发条件 + 证据行号 + 影响"。未在运行时复现的会在描述里标明"静态判定"。

### 5.1 `answerUserQuestions` 超时审计恒记 `ok`（P1）

- L1308 `const settled = await entry.answered`
- L1312 `status: settled.reason === 'timeout' ? 'expired' : 'ok'`
- 但 `question-registry.js:114` `entry.settle(buildAnswer(entry, reason))` 构造 `{ answers, reason }`，而 `buildAnswer`（question-registry.js:135-142）确实把 `reason` 放进返回值了 —— **这条没问题**。
- 真正的缺陷在 L1302-1306：发送卡片失败时 `questions_.finish(entry.id, 'error')` 后**直接 return**，跳过 L1308 `await entry.answered`，于是 `question.request`（L1279）有记录、`question.answered` **永远不写**。审计里会留下"有请求无结果"的孤儿记录。

### 5.2 `question.error` 路径的 settle 语义（P2）

`finish(entry.id, 'error')` 的 promise 结果是 `{answers: […selected: []], reason:'error'}`（question-registry.js:135-142），而 L1305 又**手动构造**了一份完全相同的 `{ answers: questions.map(...) }` 返回。两处逻辑重复，且 L1305 的返回值缺少 `reason` 字段 —— 与正常路径（L1322 `return { answers: settled.answers }`，同样剥离 reason）一致，但**与 DSH 接口约定耦合**：一旦上层需要 reason 区分 "skipped" 与 "error"，两处都要改。

### 5.3 `system/ask` 是遗留探针，仍注册在斜杠命令里（P1）

- 代码注释 L442-448 明写 "TEMPORARY probe ... Remove after the flow is verified"。
- 但 `commands.js:131-136` 仍注册了子命令；`normalizeInteraction` 也映射它（commands.js:231-235）。
- `HELP_TEXT`（commands.js:3-31）**没有列出** `ask/confirm/sudo` 三个 system 子命令 → 文档与实现不一致。
- 且它通过 `legacy` 重复键抢占（见 5.4）。

### 5.4 `legacy` 表重复键 `ask`（P1，已用 node 直接验证）

```
src/discord/commands.js:246  ask: ['task', 'ask']
src/discord/commands.js:250  ask: ['system', 'ask']   // 覆盖前者
```
实测：`normalizeInteraction(fake(null,'ask',{text:'hi'}))` → `{"group":"system","command":"ask","arg":"hi"}`。
**影响**：仍持有旧命令树的 Discord 客户端点 `/dsh ask` 不再进入 `task/ask`（真正的任务提交），而是进入探针分支；探针要求"当前频道有活跃 Agent"（L451-455），否则直接回 "先发一条消息"，用户会看到"命令失效"。

### 5.5 `handleQuestionSelect` 未做 customId 前缀校验，重复实现了 `parseQuestionKey`（P2）

- L1350-1353 手工 `slice(prefix.length)` + `lastIndexOf(':')`，与 L1332-1337 的 `parseQuestionKey` **逻辑重复**。
- 与 L1423/L1452 不同，这里**没有**用 `parsed ? … : undefined` 保护：若 `customId` 里没有 `:`，`sep = -1`，`requestId = rest.slice(0, -1)`、`index = Number(rest.slice(0))` → 得到一个看似合法但错误的键。实际不会崩（L1362 `questions_.get(undefined-ish)` 返回 undefined → L1364 走"已失效"分支），**属于健壮性问题而非崩溃**。
- 且 `handleButton`（L1054-1058）只把 `QUESTION_SELECT_PREFIX`/`QUESTION_SKIP_PREFIX` 路由过来，所以前缀本身可信；**风险在于未来新增前缀时忘了改 `isQuestionCustomId`**。

### 5.6 `handleButton` 对未知 `customId` 的兜底不完整（P2）

- L996-1001：`QUESTION_CUSTOM_PREFIX` → `handleQuestionCustom`。
- L1002-1004：非 `STOP_BUTTON_PREFIX` → `handleApprovalButton`；后者 L942-944 若既不是 approve 也不是 reject 则 `return false`。
- L1047：`handleButton` 返回 false → 落到 L1048 之后的 modal/select/autocomplete 判断 → 全部不匹配 → **函数静默返回**（L1151），interaction token 在 3 秒后过期，Discord 侧显示 "该交互失败"。
- 即：**任何未知 customId 都不会被 ack**。建议在 L1150 加 `else { await transport.deferButton(interaction).catch(()=>{}) ; logger.warn('未知 customId', customId) }`。

### 5.7 `handleInteraction` 的 `deferred` 变量是死赋值（P2）

- L1087 `let deferred = false`；L1089-1090 `await transport.deferInteraction(...)`；L1090 `deferred = true`。
- L1091-1094 的 `catch` 直接 `return`。因此到达 L1143 时 `deferred` **恒为 true**，L1145-1148 的 else 分支**不可达**。
- 与 5.6 相互独立：这里只是死代码，建议删 L1087/L1090/L1145-1148。

### 5.8 `interaction` 作用域 / `textChunks` 历史坑复核

- `textChunks` 导入：`index.js:49` `from './src/discord/components-v2.js'`，导出确认在 `components-v2.js:210` ✅
- `interaction` 引用：L834-929 的 `handleDeepSeekInteraction(interaction, request)` 参数显式；L908/L920/L921/L927 均在函数体内 ✅。L871-879 的 `StreamReporter` 用 `channelId`（L835 局部）而非 `interaction` ✅。
- **隐患**：L1264 `answerUserQuestions(request)` **不接收 interaction**，靠 `request.agent` → `agents.channelForAgent`（L1272）。这是正确方向（避免从 interaction 推 channel），但 `lastActiveChannelId`（L103, L641 写入，**永远无人读**）是这条设计转变留下的**残留死变量** —— 若未来有人"顺手"用它补 L1272 的空值，就会重新引入"抢 Web 提问"的 bug（commit `3ba450c fix: unblock modals and stop stealing questions from the Web UI` 正是在修这个）。建议**删除 L103 与 L641**。

### 5.9 `handleMessage` 重复计算 `pendingMentions` / `inMentionTurn`（P2）

- L654-658 计算 `awaiting`/`inMentionTurn`（用于 L659-660 的 requireMention 判断）；
- L683-688 **再算一遍**同样条件的 `pending`/`continuesGreeting`。
- 若两次计算之间 `Date.now()` 跨过 60s 边界，会出现"L659 放行、L684 判定不续接"的窗口（极窄，但逻辑重复本身可读性差）。合并为一次计算即可。

### 5.10 `system/sudo` 的 `available()` 与 `run()` 之间的 TOCTOU（P2）

- L519 `await privileged.available()`：`privileged-client.js:42-49` 只验证 `ensureSecret()` 能拿到密钥，**不代表守护进程在跑**。
- 用户在 5 分钟审批窗口内停止 privd → L555 `privileged.run()` 返回 `{status:'error'|'timeout'}`，L571 记 `error`，L586 回复"❌ 执行失败"。行为可接受，但"已安装"提示（L522）会误导。

### 5.11 DeepSeek `chat/create` 的工具卡片是假的（P2，静默失真）

- `api-client.js:163-167`：SSE 每个 `delta.tool_calls` **原样** yield 出去，**不累积分片、不拼接 `arguments`**（OpenAI 兼容协议的 tool_calls 是流式拼接的）。
- `index.js:891-905`：对每个分片 `toolCalls.push({ name, args, startedAt: Date.now(), endedAt: Date.now() })` —— 意味着一个逻辑工具调用会被渲染成 N 张卡（每个 SSE 分片一张），且 `startedAt === endedAt`（时长恒 0）。
- 影响：仅 `/deepseek chat create` 的展示正确性问题，不涉及数据。建议在 `api-client` 里按 `index` 聚合后再 yield。

### 5.12 `renderer.js` 依赖残留（跨模块一致性，P2）

- `index.js:30-34` 从 `renderer.js` 导入 `APPROVE/REJECT/STOP_BUTTON_PREFIX`，而注释说 renderer 是"旧，仍用于部分场景"（llms.txt 代码地图）。
- `stream-reporter.js:1` 也从 `renderer.js` 导入 `STOP_BUTTON_PREFIX`，而 `withStopRow` 来自 `cards-v2.js:484`。
- 结果：**V2 卡片的按钮前缀定义在"旧" renderer 模块里**。`cards-v2.js` 自己定义了 `QUESTION_*` 前缀（L294-298），两套前缀分居两个文件，`handleButton` 不得不从两处 import。建议统一迁到 `src/discord/custom-ids.js`。

### 5.13 `runPrompt` 在 `task/ask` 分支被直接调用（P1，见 §3 R1）

- L407 `respond(target, '⏳ 已提交，正在处理…')` 之后 L408 **await** `runPrompt(...)`，且 `placeholder: undefined`。
- 后果：`runPrompt` 走 else 分支（L212-223）`new StreamReporter({ channelId, existingMessageId: undefined })` → 会**新建一条流式卡片**，与 L407 的"已提交"卡片并存；命令结束后 L407 的卡不会被更新。
- 这是文本路径（L709-717）的必然结果：文本路径没有 placeholder 可传。**建议**：`task/ask` 在 `target` 是 interaction 时用 `editInteraction` 代替 `transport.send` 起流，或直接把 L407 的文案作为 `StreamReporter` 的初始内容。

### 5.14 `system/confirm` 与 `system/sudo` 审计字段不一致（P2）

- `approval.decided`（L495-501）记 `detail: { decision, action }` —— **`action` 是用户输入的自由文本**，直接进审计库。
- 对比 `sudo.decision`（L542）只记 `commandLength`。
- 这与 AGENTS.md「审计日志只记录操作元数据，绝不记录对话内容…不可记：参数值（路径、URL、命令内容）」**直接冲突**：`/dsh system confirm 删除 /home/xxx` 会把路径写进 `ops.detail`。
- 同样是 `confirm`：`action` 在 L532 也被 `command.slice(0,1500)` 一样拼进**卡片描述**（那是 OK 的，卡片是给用户看的）。

---

## 6. 性能观察点

| # | 观察 | 证据 | 判定 |
|---|---|---|---|
| P-1 | **`state.persist()` 全量重写**：每次 `claimEvent`/`touchConversation`/`setSettings` 都把**整个 state 文档** `JSON.stringify(state, null, 2)` 后 temp+rename 写盘 | state-store.js:87-98；调用 L681 `await state.claimEvent(...)`（每条消息一次）、L77 经 `agents.touch` 每条命令/消息一次 | 🔴 **热路径同步语义的磁盘写**（虽然是 async API，但每条消息串行 await 两次全量写）。state 随频道数线性增长 |
| P-2 | `claimEvent` 用 `Array.includes` 线性查重 | state-store.js:78；上限 `maxSeen=2048`（L7） | 🟡 2048 次比较/消息，可接受但可换 `Set` |
| P-3 | `pendingMentions` 只 `set`/`delete`，**没有过期清理**；`delete` 只在"续接成功"时发生（L688） | L115, L672, L688 | 🟡 理论上无界：每个频道最多 1 条（key 是 channelId）→ **实际有界**，但 TTL 语义靠"读时判断"（L656-658），map 条目永不清理 |
| P-4 | `routeMeta()` 每次调用都 `state.conversation(key)` + `ctx.get('agentDefaultModel')?.currentSelection?.()` | L128-147；调用点 L209, L220, L877（每次 `runPrompt`、每次 DeepSeek chat） | 🟢 每个 turn 只在 L209/L220 二选一，无重复；`currentSelection()` 是同步 getter |
| P-5 | `handleCommand` 每个分支**几乎都** `await agents.touch(key, meta)`（L262, 266, 300, 317, 329, 349, 365），而 `touch` → `state.touchConversation` → 条件 `persist()` | agent-service.js:77-80；state-store.js:43-55（L45 有早退） | 🟢 有早退（同 channelId+kind 直接 return），**仅在首次或 meta 变化时写盘** |
| P-6 | `handleMessage` 在**鉴权失败之前**就 `audit.record(message.received)` | L635 `authorized(...)` vs L642 `audit.record` —— **仔细看：L635 先 return，L642 在后**，所以未被授权消息不记审计 ✅ | 🟢 正确顺序 |
| P-7 | `audit.record` 的缓冲区满了才 flush（256 条或 250ms 定时），`record` 本身同步 push | db.js:94-113 | 🟢 设计正确；但 `system/audit` 里 `await audit.flush()`（L424）后立刻 `recent()`（L425），同一个同步 SQLite 连接（db.js:56 `DatabaseSync`）→ **读写在事件循环内同步执行**，`recent` 是 `LIMIT 15` 带 `idx_ops_channel` 索引 ✅ |
| P-8 | `handleAutocomplete` 每次按键都 `agents.listSessions()`（**全量扫描 Session**）+ `filter` + `slice(25)` | L768-782；`session.title?.toLowerCase().includes(query)`（L775）每条都算 | 🟡 由用户输入触发（Discord 侧防抖），但 `listSessions` 无缓存；建议 5s 内存缓存 |
| P-9 | `handleDeepSeekAutocomplete` 每次按键都打一次 `GET /models` 到 api.deepseek.com | L820 | 🔴 **外部 HTTP 在热路径上**，且 `catch {}`（L829-831）静默吞掉限流/额度错误，每次按键都重试。建议缓存 10 分钟 |
| P-10 | `handleCommand` 的 `system/ping`：`transport.client?.ws?.ping` 是**同步取值** ✅；`Date.now()` 两次 | L254-256 | 🟢 无 I/O |
| P-11 | `start()` 里 `fsp.stat(config.workspace)` 只跑一次 | L1189 | 🟢 |
| P-12 | `cleanupTimer` 间隔 `idleTimeoutMs/4` clamp 到 [5s, 60s] | L1241-1246 | 🟢 `unref()` 已调用（L1246）；但 **`disposed` 后未清理 `pendingMentions`**（`ctx.effect` L1558-1572 只清 registries）—— 卸载时该 Map 交给 GC，无泄漏 |
| P-13 | `question.messageIds` 只 push 从不读 | index.js:1300 push；question-registry.js:66 定义；全仓 **无读取方** | 🟢 无泄漏（registry 有 TTL），但属死数据 |
| P-14 | `readTextAttachments` 串行 `await fetch` 每个附件；总上限 1 MiB | attachments.js:20-33 | 🟢 有界 |
| P-15 | `StreamReporter` 每个 turn `new` 一次，`intervalMs=1500` | L203-221, L871-878 | 🟢 |

---

## 7. 重构路线建议（分阶段，每阶段可独立回归）

### 阶段 0：先修 bug，不改结构（1 个 commit，scope `fix`）

1. 删 `system/ask` 探针（L442-478）+ `commands.js:131-136` 注册 + legacy 表重复键（commands.js:250）
2. 删死变量 `lastActiveChannelId`（L103, L641）与死函数 `replyPayload`（L149-154）
3. `deferred` 死赋值（L1087, L1090, L1143-1149）
4. 未知 customId 兜底 ack（§5.6）
5. `system/confirm` 审计改为 `detail:{ decision, actionLength }`（L500）
6. `handleQuestionSelect` 改用 `parseQuestionKey`（L1350-1353）
7. `handleQuestion*` 补 `question.select/custom/modal` 审计（L1346-1493）

### 阶段 1：抽纯函数与纯工具（低风险）

- `safeError`/`clipForDiscord` → `src/util/errors.js`；`logger.warn(..., safeError(e))` 统一
- `greeting`/`routeMeta`/`isQuestionCustomId`/`parseQuestionKey` → `src/bridge/…`
- `authorized` 调用统一成 `authzCheck(interaction)`
- `customId` 前缀统一到 `src/discord/custom-ids.js`（收拢 renderer.js 与 cards-v2.js 两处）
- 新增单测：这 4 个纯函数（现有套件只测了 `normalizeInteraction`，commands.js 的 `normalizeInteraction` 有覆盖，`parseQuestionKey` 无）

### 阶段 2：拆 command registry（见 §3）

- 先补 registry 契约测试，再迁 `system` → `thread` → `session` → `model` → `task`
- 每迁一组跑 `npm test` + `node -e "await import('./index.js')"`

### 阶段 3：拆 interaction router

- `src/bridge/interactions/buttons.js`（`handleButton` + `handleApprovalButton`）
- `src/bridge/interactions/questions.js`（4 个 `handleQuestion*` + `answerUserQuestions` + `isQuestionCustomId`/`parseQuestionKey`）
- `src/bridge/interactions/autocomplete.js`（2 个 autocomplete + 缓存）
- `src/bridge/interactions/slash.js`（`handleInteraction`，注入 `isDisposed`）

### 阶段 4：组合根瘦身

- `src/bridge/lifecycle.js`（`resolveToken` + `start` 的重连/注册/定时器，注入 `setClientUser`/`setCleanupTimer`）
- `src/bridge/messages.js`（`handleMessage`，注入 `{isDisposed, getClientUser, pendingMentions}`）
- 目标：`index.js` ≤ 250 行，只保留 `apply` 的装配代码 + `ctx.on`/`ctx.effect` 注册

### 验收门槛（与 AGENTS.md 对齐）

```bash
npm test
node -e "await import('./index.js')"
```

> 注意：现有 92 个用例中只有 `test/helpers.test.js:843-847` 触及 `index.js`（只断言 `name` 与 `apply` 类型）。**任何把逻辑移出 `index.js` 的重构都会让覆盖率下降**——阶段 2 起必须为迁出的 `commands/*` 补用例，否则会重现 AGENTS.md 里"单测全绿但插件加载失败"的反面：这次是"单测全绿但新模块完全没被测"。

---

## 附录 A：行号索引（按关注点）

| 关注点 | 行号 |
|---|---|
| 依赖注入装配 | L84-115 |
| 常量 | L71-75 |
| 错误脱敏 | L1585-1588, L1591-1595 |
| 全部 `audit.record` | L493, 535, 562, 642, 734, 963, 1017, 1105, 1133, 1279, 1309, 1509 |
| 全部 `authorized(...)` | L635, 755, 809, 950, 1009, 1073, 1099, 1357, 1419 |
| 全部 `logger.warn(` | 29 处，见 `grep -n "logger.warn("` |
| 全部 `.catch(() => undefined)` | 28 处 |
| `respond(...)` 调用 | 33 处（L251-609） |
| 生命周期 | L1155-1247, L1538-1576 |

## 附录 B：证据获取命令（可复现）

```bash
cd /home/ecs-user/dsh-plugins/dsh-discord-bridge
node -e "await import('./index.js')"        # 入口加载 OK
npm test                                    # 92/92
grep -n "audit\.record\|action: '" index.js
grep -n 'authorized(' index.js
grep -n '\.catch(() *=> *undefined)' index.js
node -e "const {normalizeInteraction}=await import('./src/discord/commands.js'); /* 见 §5.4 */"
grep -n "textChunks" src/discord/components-v2.js src/discord/cards-v2.js index.js
```
