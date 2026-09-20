# DiceFunc - Cloudflare Workers 跑团服务

基于 Cloudflare Workers 的轻量无服务器跑团机器人（TypeScript），面向 QQ 开放平台 Webhook 架构设计。

## 技术栈与基础设施

- **运行时**: Cloudflare Workers (`workerd`)
- **HTTP 框架**: Hono
- **数据库**: Cloudflare D1（SQLite，事务守卫）
- **配置与缓存**: Cloudflare KV + R2（可选）
- **归档存储**: Cloudflare R2（私有存储桶）
- **异步队列**: Cloudflare Queues
- **工程规范**: TypeScript 7 + Biome + pnpm workspace + Vitest

## 目录结构

```
dicefunc/
├── apps/
│   ├── worker/          # Cloudflare Worker 服务入口与路由
│   └── cli/             # 配置管理、校验与模拟 CLI 工具
├── packages/
│   ├── core/            # 领域模型、命令注册表与业务核心
│   ├── config/          # 配置加载与合并编译
│   └── adapters/        # QQ Webhook、D1、R2、Queues 外部适配器
├── config/              # 机器人、权限、规则与回复模板配置
├── migrations/          # D1 数据库架构迁移脚本
├── tests/               # 运行时测试与 Workerd 集成测试
└── docs/                # 设计与运维规范文档
```

## 功能与交付状态

### 当前已实现（真实能力）

- **Monorepo 工程门槛**:
  - 全局 TypeScript 严格编译（`tsc -b`）；
  - Biome 规范校验；
  - 单元测试（Vitest）与基于 `@cloudflare/vitest-pool-workers` 的真实 workerd 虚拟运行时集成测试；
  - 一键质检入口 `pnpm check`（`tsc -b && biome check .`）。
- **核心领域模型**:
  - 掷骰引擎：支持面数解析、加减修饰值，以及 `kl`/`kh`/`dl`/`dh`（保留/丢弃最高/最低骰）；
  - 纯领域抽牌：`DeckSession` 与 `drawFromDeck` 无放回随机抽牌；
  - COC7 检定：`performCocCheck` 规则判定逻辑（常规/困难/极难/大成功/大失败/失败）；
  - 状态模型：会话设置（`ConversationSession`）、角色卡（`CharacterSheet`）、策略限流（`PolicyEntry`/`RateBucket`）与日志状态机（`StoryLog`/`ArchiveChunk`）。
- **QQ 开放平台 Webhook 适配**:
  - 按官方协议从 AppSecret 派生 Ed25519 密钥，对 `timestamp + body` 验签（缺失凭据或验签失败直接 401，经官方向量验证）；
  - 平台校验应答：支持 `op: 13` 回调验证（按官方算法签名 `event_ts + plain_token` 应答，官方向量逐字节匹配）；
  - 消息场景解析：映射群聊 @ 消息（`GROUP_AT_MESSAGE_CREATE`）、C2C 私聊（`C2C_MESSAGE_CREATE`）、主动消息授权变更（`C2C_MSG_RECEIVE` / `C2C_MSG_REJECT`）与频道私信（`DIRECT_MESSAGE_CREATE`）；
  - 状态持久化：`inbox` 接收记录与 `job` 调度任务在 StateStore 中原子落库；
  - 队列调度：`COMMAND_QUEUE` 仅传递 `{ jobId, botId }` 最小元数据。
- **D1 状态存储 (StateStore)**:
  - 基于 Cloudflare D1 驱动；
  - 使用 `commit_guards` 表与 `CHECK (actual_version = expected_version)` 约束提供批处理事务乐观并发守卫；
  - 基于 `fencingToken` 的任务租约控制，支持异常任务重试、补投与死信清理。
- **R2 归档存储**:
  - `.log end` 将冻结的双向日志记录按有界 SealDice 文本分片写入私有 R2，并在全部分片校验后将归档标记为可下载；
  - `.log export` 为群主或骰主签发 15 分钟下载链接，`GET /archives/:id` 校验授权、记录审计并返回 SealDice TXT 归档。
- **运行时日志规范 (RuntimeLogger)**:
  - 严格字段白名单机制，过滤所有敏感字段（密钥、token、聊天正文等）；
  - 单条序列化日志严格执行 8 KiB 截断，超限安全截断并标记。
- **数据库架构**:
  - `migrations/001_initial_schema.sql` 至 `006_sealdice_story_log.sql` 提供基础架构、任务恢复索引、暗骰可信绑定及 SealDice 兼容的双向日志记录。

### 未实现 / 后续规划 (P1-P8)

- **业务命令扩展**: `.log halt/delete`、跑团日志聚合统计与角色卡的完整 SealDice 兼容语义尚未实现；
- **C2C 端到端实测**: 尚待结合真实 QQ 开放平台接口进行端到端闭环验证；
- **DND5e 完整规则**: 战斗轮、先攻、HP/临时 HP 与法术位管理尚未实现；
- **牌堆与自定义回复命令**: 领域模型就绪，尚未接入聊天命令处理管线；
- **模板渲染引擎进 Worker**: 当前 Worker 链路使用内置纯文本回复，动态模板引擎尚未与 Worker 发送链路联通；
- **配置版本化发布**: 基于 KV/R2 的不可变配置包发布流（P6）尚未实现；
- **云端实测**: 尚未在 Cloudflare 真实多区域节点及生产资源上进行全链路压测与日志验证。

## 当前核心命令 (Core CommandRegistry)

当前核心框架注册并支持的命令：

- `.r [expr] [reason]` - 基础掷骰（例如 `.r 1d100`、`.r d20优势`、`.r 3d6+2 力量检定`）
- `.rh [expr] [reason]` / `.rhd` / `.rdh` - 暗骰；C2C 中直接返回结果，群聊中仅在可信绑定后主动私聊发送，群内只报告发送成功或失败，绝不公开结果
  - 首次使用：在 QQ 启用机器人的主动消息权限，私聊发送 `.rhbind` 获取 10 分钟有效的一次性令牌，再到目标群发送 `.rhbind <令牌>`
  - 授权事件可能因订阅时间或平台投递而缺失；`.rhbind` 不依赖本地授权缓存，实际 `.rh` 的主动私聊响应才是最终判断，失败时仍不会公开结果
  - 解除绑定：在目标群发送 `.rhbind off`
- `.help` / `.h` / `.?` - 查看命令帮助列表
- `.set rule <coc7|dnd5e>` - 切换当前会话规则集
- `.set sides <number>` - 修改当前会话默认骰子面数
- `.bot on` / `.bot off` - 开启或关闭机器人在当前会话中的响应
- `.userid` / `.uid` / `.id` - 查询当前用户外部 ID 与场景信息
- `.log new/on/off/end/stat/export` - 记录跑团消息、关闭后异步归档，并由群主或骰主获取 15 分钟下载链接

## 快速开始

### 安装依赖

```bash
pnpm install
```

### 自定义机器人回复文案

回复文案位于 `config/flavors/<风格>/replies/*.yaml`：

- `config/flavors/classic/replies/core.yaml`：机器人名称和基础掷骰文案；
- `config/flavors/classic/replies/coc7.yaml`：COC7 检定文案；
- `config/flavors/gothic/replies/coc7.yaml`：覆盖 `classic` 的古典怪谈风格文案。

每个模板由一个或多个 `variants` 组成。`id` 用于稳定标识候选文案，`weight` 控制随机选中权重，`text` 支持 `{{actor.name}}` 等结构化模板字段。例如修改机器人在跑团日志中的名称：

```yaml
schemaVersion: 1
templates:
  bot.name:
    variants:
      - id: default
        weight: 1
        text: Dicefunc
```

`bot.name` 使用第一个 variant 的 `text`；未配置或内容为空时默认为 `Dicefunc`。修改后执行：

```bash
pnpm check
pnpm test:runtime
pnpm deploy:worker
```

当前 Worker 会在构建时直接打包并使用 `classic/replies/core.yaml` 中的 `bot.name`，不需要设置名称环境变量。其他 YAML 回复模板尚未接入 Worker 运行时，修改它们不会改变线上回复；当前没有面向用户的回复文案 CLI。

### 本地开发与测试

```bash
# 执行代码风格与类型自查
pnpm check

# 运行单元测试
pnpm test:unit

# 运行 Workerd 环境集成测试（D1 / R2 / KV / Queues 模拟）
pnpm test:integration

# 运行运行时测试
pnpm test:runtime

# 启动本地 Worker 调试服务
pnpm dev:worker
```

## 部署流程

按顺序照做即可，每步都附"成功标志"。首次部署约 15 分钟。

### 0. 准备好这三样东西

| 需要 | 怎么确认 | 没有怎么办 |
| --- | --- | --- |
| Node.js ≥ 22、pnpm 9 | `node -v`、`pnpm -v` | 安装 Node.js 22+，然后 `corepack enable && corepack prepare pnpm@9 --activate` |
| Cloudflare 账号（Workers Paid 计划，约 $5/月） | 登录 [dash.cloudflare.com](https://dash.cloudflare.com) 能看到 Workers 面板 | 免费计划缺 Queues 消费与 R2，机器人在收到消息时会报错，请先升级 |
| QQ 开放平台机器人（webhook 接入模式，已通过基础资料审核） | [q.qq.com](https://q.qq.com) 后台能看到你的机器人 | 先注册并完成审核，部署可以先行，第 4 步再回来填 |

然后登录 Wrangler（首次使用会打开浏览器授权）：

```bash
npx wrangler login
```

成功标志：浏览器提示已授权，终端显示 `Successfully logged in`。

### 1. 拉代码、装依赖、跑自检

```bash
git clone <repo> && cd dicefunc
pnpm install
pnpm check
```

成功标志：最后一行输出 `Configuration check passed: ... 0 errors.`

### 2. 一条命令部署，自动创建全部云资源

```bash
pnpm deploy:worker
```

这条命令会做两件事：

1. **自动创建云资源**（Wrangler 4 的 auto-provisioning）：D1 数据库 `dicefunc-db`、KV 命名空间 `CONFIG_KV`、R2 私有桶 `dicefunc-story-logs` / `dicefunc-config`、队列 `command-queue` / `archive-queue` 及死信队列 `command-dlq` / `archive-dlq`。终端会逐项询问，一路回车确认即可；已存在的同名资源会直接复用。D1 和 KV 的真实 ID 会自动写回 `apps/worker/wrangler.jsonc`，部署完后请把这个文件提交进 Git。
2. **发布 Worker**，并在结尾打印你的 Worker 域名，形如：

```
Deployed dicefunc-worker triggers ...
  https://dicefunc-worker.<你的子域>.workers.dev
```

成功标志：看到上面这行 URL。**先把它复制下来**，后面第 4、6 步要用。

> 此刻 Worker 还没配密钥、没建表：访问 Webhook 会返回 401，定时任务会报缺表错误——都是预期，走完下面几步自动恢复。

### 3. 建数据库表

```bash
# 远程库（线上用）
npx wrangler d1 migrations apply dicefunc-db --remote -c apps/worker/wrangler.jsonc

# 本地开发库（想在本地 pnpm dev:worker 调试时才需要，首次执行一次即可）
npx wrangler d1 migrations apply dicefunc-db --local -c apps/worker/wrangler.jsonc
```

远程命令会列出待执行的迁移并询问，输入 `y` 回车。成功标志：`🌀 Mapping SQL input into an array of statements ... ✅`，且 `001_initial_schema.sql` 至 `006_sealdice_story_log.sql` 均已应用。

### 4. 拿到 QQ 机器人的两份密钥

打开 [QQ 开放平台](https://q.qq.com) 你的机器人后台，在"开发管理/开发设置"页复制 **App ID** 和 **App Secret**。不需要自己生成密钥对——QQ 官方的 webhook 签名密钥就是由 AppSecret 按固定算法派生的，平台和你两边算出来的自动一致。

然后在机器人后台的 webhook 设置页（开发设置 → 事件订阅/回调配置）：

- 回调地址填 `https://<第 2 步复制的 Worker 域名>/webhooks/qq`（`workers.dev` 默认 443 端口，符合平台允许的 80/443/8080/8443）；
- 勾选群聊 @ 消息（`GROUP_AT_MESSAGE_CREATE`）和 C2C 私聊（`C2C_MESSAGE_CREATE`）；建议同时订阅主动消息授权变更（`C2C_MSG_RECEIVE`、`C2C_MSG_REJECT`）以同步提示状态，但暗骰不会仅因授权事件缺失而拒绝绑定。

先保存即可，"校验"按钮留到第 7 步再点。

### 5. 把密钥和公开下载地址存进 Worker

逐条执行，每条命令会提示 `Enter a secret value:`，粘贴对应值后回车（粘贴时屏幕不显示是正常的）。`PUBLIC_BASE_URL` 不是密钥，但使用同一部署入口可以避免把部署专属域名提交进仓库：

```bash
npx wrangler secret put QQ_APP_ID -c apps/worker/wrangler.jsonc         # 第 4 步的 App ID
npx wrangler secret put QQ_APP_SECRET -c apps/worker/wrangler.jsonc     # 第 4 步的 App Secret
npx wrangler secret put PUBLIC_BASE_URL -c apps/worker/wrangler.jsonc   # 第 2 步复制的 https://...workers.dev
```

成功标志：每条都输出 `✅ Success! ...`。这些绑定写入即时生效，无需重新部署。

> 本地开发不要执行上面的命令，改为新建 `apps/worker/.dev.vars` 文件，按 `KEY=值` 每行一个写入同名键值（该文件已被 `.gitignore` 排除，不会进仓库）。本地 `PUBLIC_BASE_URL` 通常填写 Wrangler 打印的本地地址。

### 6. 确认线上服务正常

```bash
curl https://<你的 Worker 域名>/health
```

成功标志：返回 `ok`。

### 7. 让 QQ 真正连上机器人

1. 回到 QQ 平台后台，点 webhook 的"校验"按钮——Worker 会用私钥自动应答，平台提示校验通过；
2. 在群里 @机器人 发送 `.r 1d100`，应收到掷骰回复；
3. 没反应就看实时日志定位：`npx wrangler tail -c apps/worker/wrangler.jsonc`；
4. 失败任务会自动重试并进入死信队列；每 2 分钟的定时任务会自动补投遗漏任务、清理过期数据，无需人工干预。

### 8. 以后每次改代码

```bash
pnpm check && pnpm test:integration   # 自检
pnpm deploy:worker                    # 重新部署（资源已存在，秒级完成）
```

注意：配置包的运行时发布（KV/R2 versioned，P6）尚未实现。`config/flavors/classic/replies/core.yaml` 中的 `bot.name` 会在 Worker 构建时直接打包；其他规则和回复模板 YAML 尚未接入 Worker 运行时，Worker 行为仍以代码内注册内容为准。

## 云资源与配置

### Secrets 与环境变量

机器人在跑团日志中的默认昵称来自 `config/flavors/classic/replies/core.yaml` 的 `bot.name` 文案；当前默认值为 `Dicefunc`，不使用独立环境变量。

- `ENVIRONMENT` - 运行环境（`production` / `staging` / `development`）
- `PUBLIC_BASE_URL` - Worker 对外 HTTPS 根地址，用于生成 15 分钟有效的跑团日志下载链接
- `BOT_TIMEZONE` - 跑团日志时间文本使用的 IANA 时区（默认部署配置为 `Asia/Shanghai`）
- `QQ_APP_ID` - QQ 开放平台应用 ID（同时作为单实例 botId）
- `QQ_APP_SECRET` - QQ 开放平台应用密钥（OpenAPI access token 获取；同时按官方算法派生 Webhook 验签与 `op=13` 应答签名密钥）

### Cloudflare 资源绑定

- `DB` - Cloudflare D1 数据库（业务状态唯一权威存储）
- `CONFIG_KV` - KV 命名空间（配置缓存；配置发布为 P6 能力）
- `STORY_LOG_BUCKET` - R2 私有桶（跑团日志分片与归档）
- `CONFIG_BUCKET` - R2 私有桶（P6 可选，版本化配置发布）
- `COMMAND_QUEUE` / `command-dlq` - 命令任务队列与死信
- `ARCHIVE_QUEUE` / `archive-dlq` - 归档任务队列与死信

## 文档指引

- [开发约定与架构边界](./AGENTS.md)
- [配置管理指南](./docs/configuration.md)
- [日志与保留规范](./docs/logging-and-retention.md)
- [测试与验证指南](./docs/testing.md)
