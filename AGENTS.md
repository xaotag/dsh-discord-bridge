# AGENTS.md

给在本仓库工作的 AI 代理（以及人类协作者）的约定。**动手改代码前先读完本文件。**

本文件只讲"怎么做"，不讲"是什么"。项目功能见 [README.zh-CN.md](README.zh-CN.md)。

---

## 分支规范（最重要）

**`main` 只接收版本分支。任何代码改动都不得直接落在 `main` 上。**

分支命名是**前缀 + 后缀**两段式：

```
main                     生产主线
└── v2                   版本集成分支
    ├── v2-render        该版本下的一个功能
    ├── v2-privileged    该版本下的另一个功能
    └── v2-render-table  细分主题也可以
v3 / v3-xxx              下一个大版本线
```

| 角色 | 格式 | 例子 |
|---|---|---|
| 主线 | `main` | — |
| 版本集成分支 | `v<主版本>` | `v2` |
| 功能分支 | `v<主版本>-<主题>` | `v2-render` |
| 细分 | `v<主版本>-<主题>-<子主题>` | `v2-render-table` |

**不要新建 `feat/`、`feature/`、`fix/` 前缀的分支。** 版本号本身就是分类，主题词说明改什么，`feat/` 在这里不承载额外信息。

历史上存在 `feat/*` 分支，保留不删，但**不要在其上继续开发**，也不要把它们当作模板。

### 开工流程

```bash
git fetch --all --prune
git branch --show-current
```

- 在 `main` 上且有未提交改动 → **停下**，先建功能分支
- 目标版本分支 `v2` 不存在 → 先从 `main` 建 `v2`
- 功能分支不存在 → **从 `v2` 切出**，不要从 `main` 切

```bash
# 建功能分支
git checkout v2 && git pull --ff-only
git checkout -b v2-<主题>
```

### 完成流程

```bash
git push -u origin v2-<主题>
git checkout v2 && git pull --ff-only
git merge --no-ff v2-<主题>
npm test                     # 合并后必须重跑
git push origin v2
```

`--no-ff` 不可省：功能分支的意义是"一批改动构成可回滚的单元"，快进合并会抹掉这个边界。

### 发版

```bash
git checkout v2 && npm test
git checkout main && git pull --ff-only
git merge --no-ff v2
git tag -a v2.0.0 -m "v2.0.0"
git push origin main --follow-tags
```

---

## 提交信息

格式：`<type>(<scope>): <subject>`

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重构，行为不变 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建、依赖、杂务 |

scope 用模块名：`render`、`tools`、`commands`、`privileged`、`config`。

**破坏性变更加 `!` 并写 `BREAKING CHANGE:`：**

```
feat(render)!: 卡片改为 Components V2

BREAKING CHANGE: 新消息使用 V2 格式，旧 embed 消息不再产生。
```

---

## 验证要求

**改完必须实际验证，不能只看单测通过。**

这个仓库踩过两次"单测全绿但插件加载失败"的坑：

| 曾经的问题 | 为什么单测没发现 |
|---|---|
| `textChunks` 从错误的模块导入 | `node --check` 只查语法，查不出缺失的具名导出 |
| `interaction` 引用越界 | 单测覆盖的是 `stream-reporter`，绕过了 `index.js` 真实路径 |

现在的门槛：

```bash
npm test                                    # 必须全绿
node -e "await import('./index.js')"        # 入口必须能真正加载
```

第二条是硬性要求。它的作用是让"具名导出缺失""作用域错误"这类问题在开发阶段就暴露，而不是等到 bot 挂掉。`test/helpers.test.js` 里已有对应用例，不要删。

### 改渲染逻辑时

Discord 的渲染限制见 README 的「Markdown 适配」一节。改之前先确认官方文档怎么说：

```
https://docs.discord.com/developers/reference.md              # 消息格式化
https://docs.discord.com/developers/components/reference.md   # 组件（含 V2）
https://docs.discord.com/llms.txt                             # 文档索引
```

这些是 `.md` 纯文本，比 HTML 好读。**注意**：本机 `web_fetch` 工具可能因 mihomo 的 fake-ip 把 `docs.discord.com` 判为"非公网 IP"而拒绝，此时用 `curl` 直接抓。

不要凭印象断言"Discord 支持/不支持某格式"，先查文档。

---

## 代码约定

| 项目 | 约定 |
|---|---|
| 模块边界 | `index.js` 只管生命周期、鉴权、路由；业务在 `src/` |
| 依赖方向 | `src/discord/*` 不引用 DSH；`src/bridge/*` 不引用 discord.js |
| 注释 | 解释**为什么**，不解释**做什么**。`// 增加计数` 这种不要写 |
| 注释语言 | 英文（与现有代码一致）；面向用户的文案用中文 |
| 测试 | 每个新行为配用例；改行为时同步改用例，不要留断言旧行为的测试 |

### 隐私红线

审计日志（`src/audit/db.js`）**只记录操作元数据，绝不记录对话内容**。

- 可以记：长度、耗时、工具名、退出码、状态
- 不可记：消息正文、prompt、模型输出、参数值（路径、URL、命令内容）

工具调用卡片同理，只显示描述字段（`description`/`summary`/`label`/`title`/`reason`/`purpose`），**不显示参数值**。改这部分前先看 `src/discord/cards-v2.js` 里的 `describeTool`。

### 安全边界

`privd/` 是 root 守护进程，通过 HMAC 签名的请求队列执行命令。改动时保持：

- 请求必须验签，验不过一律拒绝
- 一次性 ID，执行后删除，防重放
- 有 TTL，过期不执行
- 原子认领（`rename` 到 `work/`），防重复执行
- 每条命令写审计

---

## 环境事实

| 项目 | 值 |
|---|---|
| 运行时 | Node ≥ 22（用内置 `node:sqlite`，无原生编译） |
| 插件挂载 | `~/.dsh/profiles/web/node_modules/@local/dsh-discord-bridge` → 符号链接到本目录 |
| 生效方式 | 改完需 `systemctl --user restart dsh-web.service` |
| 审计库 | `~/.dsh/dsh-discord/audit.sqlite` |
| 提权队列 | `~/.dsh/privileged/` |

**本目录是 `link:` 挂载的真实路径**，改文件即改运行代码，但没有热重载——必须重启才生效。

编辑器的 `node --check` 和语法高亮都不等于运行时正确。改完按上面的验证要求跑一遍。
