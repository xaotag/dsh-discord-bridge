# 子代理会话树（v3）

## 问题

桥接插件一直是**以根 Agent 为中心**的：

| 位置 | 现有判定 | 后果 |
|---|---|---|
| `AgentService.channelForAgent(agent)` | `runtime.agent === agent` 才算「我们的」 | 子代理的 `approval/request`、`user-questions/request` 匹配不到频道 → `DELEGATE` 交给 Web answerer |
| `AgentService.observeSession(session, event)` | `runtime.agent.session === session` 才观察 | 子代理的 `tool/call`、`tool/result`、`turn/end` 全部丢弃 |
| `AgentService.observeStream({agent, frame})` | 同上 | 子代理的流式文本不可见 |

于是出现两个症状：

1. **子代理陷进去**：子代理要授权/要提问时无人应答。桥接 `next()` 之后，Web answerer 在无头进程里
   通常不会接（或没有客户端在线），DSH 侧该工具调用一直挂在 promise 上；即使超时也只会
   fail-closed 成一次拒绝。父卡片看不到任何"有东西在等审批"的迹象。
2. **父子链路丢失**：桥接没有"这个 Session 属于哪个频道、深度多少"的概念。子代理跑完，
   父会话里只有 `subagent` 工具的一行返回值，子代理做过什么、卡在哪，事后无法追溯。

根因不是 Discord 渲染，而是**身份匹配**：DSH 给每个被委派的 Agent 一个独立 Session，
桥接只认自己创建的那一个对象。

## DSH 提供的、可用的公开信息

| 事实 | 来源 | 用途 |
|---|---|---|
| `session.header.parentSession` | `@deepseek-ai/dsh-session` 的 `SessionHeader` | 血缘，可多层向上走 |
| `session.header.origin === 'subagent'` | 同上 | 区分委派子会话 |
| `session.header.delegationDepth` | 同上 | 深度（跨重启持久） |
| `agent.session.header` | `@deepseek-ai/dsh-agent` 的 `Agent` | 从 Agent 拿到它的 Session |
| `agent/created` 事件 | `ctx.agents` | 新 Agent 诞生（含子代理） |
| `session/event` 的 `subagent/catalog` | `@deepseek-ai/dsh-subagent` 的 catalog 投影 | **子代理的人类可读名字**（`label`）与 `mode` |

`subagent/catalog` 是挂在**父 Session 日志**上的一条事件：

```js
{ type: 'subagent/catalog', data: { childId, childCreatedAt, version, mode, label } }
```

它是 DSH 里唯一给子代理命名的地方（Web UI 的子代理标题也读它）。桥接只要从自己根会话的
`session/event` 流里收下这条事实，就能给子代理起标题。

## 设计

新增 `src/bridge/session-tree.js`：一个纯数据模块（不 import Discord、不 import DSH），
只回答两个问题——「这个 Session 属于哪个会话键」「它有多深、叫什么」。

```
SessionTree
  attachRoot(key, session)          根会话（bridge 自己 create/resume 的那个）
  learnChild(parentId, {childId, label, mode})   来自 subagent/catalog
  note(session)                     观察到的任意 Session，读 header 建节点
  resolve(sessionOrAgent) -> { key, rootId, sessionId, parentId, depth, label } | undefined
  childrenOf(key) / childCount(key)
  detachRoot(key)
```

解析规则：

- 从节点沿 `parentId` 向上走，直到命中一个 `attachRoot` 过的根；
- 走不到根（没有根、父节点未知、超过 8 层、成环）→ `undefined`；
- **绝不猜测频道**。解析失败时调用方保持旧行为（`DELEGATE` / 忽略），避免把别人的会话
  错投到某个频道。

### 三个接入点

1. **请求应答**（`index.js` → `interactions/approval.js`、`interactions/question.js`）
   `agents.channelForAgent(agent)` 改为走 `SessionTree.resolve`。子代理的授权卡与提问卡
   落在**父会话所在频道**，卡片标题带 `子代理「<label>」`，审计里带子会话 id 与深度。
   仍然只答「桥接自己这棵树」里的请求，其余 `next()`。
   例外是提问卡：DSH 只允许根代理发 `ask_user_question`（子代理调用会 `DELEGATED_CALLER`），
   根代理把子代理 `label` 写进 `header` 时，卡片改发进该子代理的子线程；标注不出的问题
   留在父频道。

2. **事件观察**（`agent-service.js`）
   `observeSession` 不再按对象身份匹配：解析出根 runtime 后，把子会话事件转成
   `sink.onSubagentEvent({ kind, child, ... })`；根的 `tool/call` 等行为完全不变。
   另外从根会话的 `session/event` 里收 `subagent/catalog` → `learnChild`。

3. **呈现**（`stream-reporter.js` + `cards-v2.js`）
   父卡片底部多一段 `-#` 小字块：

   ```
   -# 🧩 子代理 1 个运行中
   -# ↳ 「校验渲染器」⟳ `read` · src/discord/cards-v2.js
   ```

   子代理的流式正文**不混进父答案**（否则父子上下文互相污染），只在块里显示最近一次动作；
   工具行是最新 N 条；子代理结束时行尾变 `✓` 或 `✖`。卡片页脚显示运行中的子代理数量。

### sink 契约

```js
sink.onSubagentEvent({
  kind: 'start' | 'tool-call' | 'tool-result' | 'text' | 'end',
  child: { id, label, depth },
  name?, args?, result?, text?, status?,
})
```

单入口、单对象，StreamReporter 与测试都只依赖这一层。

## 呈现：每个子代理一个 Thread

子代理的活动全挤在父卡片上时，两行摘要就到顶了。默认给每个子代理单开一个 Discord 子线程：

- 子代理第一次报事件时，在父频道下建线程 `🧩 <label>`；`createThread` 失败直接退回旧行为；
- 线程里只有一张卡片，随事件原地刷新：状态图标、最新正文摘要、最近一次工具与描述；
- 强调色跟着状态走：运行中琥珀、完成绿、失败红；
- 父卡片的子代理行在子线程建好后只剩 `-# ↳ 「<label>」🧵 <#threadId>`：状态、工具与
  正文都在子线程的卡片里，父卡片不再重复；子线程没建成时仍保留状态 + 工具摘要；
- 父频道本身是 Thread 时无法再嵌套，直接沿用父线程，不新建；
- 开关 `DSH_DISCORD_SUBAGENT_THREADS=false` 关闭，只保留父卡片摘要。

实现：`src/bridge/subagent-threads.js`（`SubagentThreads`），由 `StreamReporter.onSubagentEvent`
驱动；不 import DSH，不改父答案正文。

## 兼容与回退

- 根 Agent 行为零变化：解析深度 0，走原路径。
- DSH 未挂 `subagent` 能力、或 catalog 事件缺失：子会话仍能靠 `header.parentSession`
  解析到频道，标题退化成 `子代理 <id 前 6 位>`。
- 解析失败：保持 `DELEGATE`，不抢占 Web 的应答权。

## 验证

```bash
npm test                                   # 单测（含 session-tree 与卡片）
node -e "await import('./index.js')"       # 入口必须能加载
```

真机回归（Discord）：

1. 在频道里让 Agent 调 `subagent` 跑一个需要 `bash` 提权的任务；
2. 卡片上应出现 `子代理「…」` 的审批卡，点批准后子代理继续；
3. 父卡片的 `-#` 块应显示子代理的工具行，页脚计数归零；
4. 重启 `dsh-web` 后，历史卡片不变，新会话行为一致。
