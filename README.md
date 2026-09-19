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
  - 一键质检入口 `pnpm check`（`tsc -b && biome check . && pnpm dice config check`）。
- **核心领域模型**:
  - 掷骰引擎：支持面数解析、加减修饰值，以及 `kl`/`kh`/`dl`/`dh`（保留/丢弃最高/最低骰）；
  - 纯领域抽牌：`DeckSession` 与 `drawFromDeck` 无放回随机抽牌；
  - COC7 检定：`performCocCheck` 规则判定逻辑（常规/困难/极难/大成功/大失败/失败）；
  - 状态模型：会话设置（`ConversationSession`）、角色卡（`CharacterSheet`）、策略限流（`PolicyEntry`/`RateBucket`）与日志状态机（`StoryLog`/`ArchiveChunk`）。
- **命令行工具 (CLI)**:
  - `config check`: 校验 YAML 语法、结构对象与根级 `schemaVersion`；
  - `config build`: 编译打包单文件或全量配置为 JSON，并计算输出 SHA-256 校验摘要；
  - `config explain`: 依据 内置默认值 → 全局 `bot.yaml` → 群配置文件 三层优先级解析生效设置；
  - `reply preview`: 解析加载指定风格回复模板，预览全部候选 variants 渲染结果；
  - `simulate`: 本地真实模拟掷骰命令执行与分词解析。
- **QQ 开放平台 Webhook 适配**:
  - 按官方协议从 AppSecret 派生 Ed25519 密钥，对 `timestamp + body` 验签（缺失凭据或验签失败直接 401，经官方向量验证）；
  - 平台校验应答：支持 `op: 13` 回调验证（按官方算法签名 `event_ts + plain_token` 应答，官方向量逐字节匹配）；
  - 消息场景解析：映射群聊 @ 消息（`GROUP_AT_MESSAGE_CREATE`）、C2C 私聊（`C2C_MESSAGE_CREATE`）与频道私信（`DIRECT_MESSAGE_CREATE`）；
  - 状态持久化：`inbox` 接收记录与 `job` 调度任务在 StateStore 中原子落库；
  - 队列调度：`COMMAND_QUEUE` 仅传递 `{ jobId, botId }` 最小元数据。
- **D1 状态存储 (StateStore)**:
  - 基于 Cloudflare D1 驱动；
  - 使用 `commit_guards` 表与 `CHECK (actual_version = expected_version)` 约束提供批处理事务乐观并发守卫；
  - 基于 `fencingToken` 的任务租约控制，支持异常任务重试、补投与死信清理。
- **R2 归档存储**:
  - `R2ArchiveStore` 提供私有分片写入与读取校验；
  - `GET /archives/:id` 路由实现下载授权校验、审计记录写入与安全响应头控制。
- **运行时日志规范 (RuntimeLogger)**:
  - 严格字段白名单机制，过滤所有敏感字段（密钥、token、聊天正文等）；
  - 单条序列化日志严格执行 8 KiB 截断，超限安全截断并标记。
- **数据库架构**:
  - `migrations/001_initial_schema.sql` 提供 21 张完整表，包含强一致性版本守卫与复合唯一约束。

### 未实现 / 后续规划 (P1-P8)

- **业务命令扩展**: `.st`（角色卡属性）、`.pc`（角色切换）、`.log`（跑团日志管理交互命令）、`.ra`/`.rc` 等检定命令尚未注册至 Core 命令注册表；
- **C2C 端到端实测**: 尚待结合真实 QQ 开放平台接口进行端到端闭环验证；
- **DND5e 完整规则**: 战斗轮、先攻、HP/临时 HP 与法术位管理尚未实现；
- **牌堆与自定义回复命令**: 领域模型就绪，尚未接入聊天命令处理管线；
- **模板渲染引擎进 Worker**: 当前 Worker 链路使用内置纯文本回复，动态模板引擎尚未与 Worker 发送链路联通；
- **配置版本化发布**: 基于 KV/R2 的不可变配置包发布流（P6）尚未实现；
- **云端实测**: 尚未在 Cloudflare 真实多区域节点及生产资源上进行全链路压测与日志验证。

## 当前核心命令 (Core CommandRegistry)

当前核心框架注册并支持的命令：

- `.r [expr] [reason]` - 基础掷骰（例如 `.r 1d100`、`.r 3d6+2 力量检定`）
- `.help` / `.h` / `.?` - 查看命令帮助列表
- `.set rule <coc7|dnd5e>` - 切换当前会话规则集
- `.set sides <number>` - 修改当前会话默认骰子面数
- `.bot on` / `.bot off` - 开启或关闭机器人在当前会话中的响应
- `.userid` / `.uid` / `.id` - 查询当前用户外部 ID 与场景信息

## 快速开始

### 安装依赖

```bash
pnpm install
```

### CLI 配置与模拟工具

```bash
# 检查配置语法与 schemaVersion
pnpm dice config check --dir ./config

# 编译配置并生成 SHA-256 摘要
pnpm dice config build --dir ./config

# 解释特定群配置的最终生效值
pnpm dice config explain --group ./config/groups/example.yaml --key defaults.ruleSet

# 预览回复模板
pnpm dice reply preview dice.roll --flavor classic

# 本地模拟掷骰命令
pnpm dice simulate --message ".r 1d100" --scene groupAt
```

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

远程命令会列出待执行的迁移并询问，输入 `y` 回车。成功标志：`🌀 Mapping SQL input into an array of statements ... ✅` 且列出 `001_initial_schema.sql` 已应用（共 21 张表）。

### 4. 拿到 QQ 机器人的两份密钥

打开 [QQ 开放平台](https://q.qq.com) 你的机器人后台，在"开发管理/开发设置"页复制 **App ID** 和 **App Secret**。不需要自己生成密钥对——QQ 官方的 webhook 签名密钥就是由 AppSecret 按固定算法派生的，平台和你两边算出来的自动一致。

然后在机器人后台的 webhook 设置页（开发设置 → 事件订阅/回调配置）：

- 回调地址填 `https://<第 2 步复制的 Worker 域名>/webhooks/qq`（`workers.dev` 默认 443 端口，符合平台允许的 80/443/8080/8443）；
- 勾选要监听的事件：群聊 @ 消息（`GROUP_AT_MESSAGE_CREATE`），按需加 C2C 私聊（`C2C_MESSAGE_CREATE`）。

先保存即可，"校验"按钮留到第 7 步再点。

### 5. 把两份密钥存进 Worker

逐条执行，每条命令会提示 `Enter a secret value:`，**粘贴对应值后回车**（粘贴时屏幕不显示是正常的）：

```bash
npx wrangler secret put QQ_APP_ID -c apps/worker/wrangler.jsonc      # 第 4 步的 App ID
npx wrangler secret put QQ_APP_SECRET -c apps/worker/wrangler.jsonc  # 第 4 步的 App Secret
```

成功标志：每条都输出 `✅ Success! ...`。密钥写入即时生效，无需重新部署。

> 本地开发不要执行上面的命令，改为新建 `apps/worker/.dev.vars` 文件，按 `KEY=值` 每行一个写入同名键值（该文件已被 `.gitignore` 排除，不会进仓库）。

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

注意：配置包的运行时发布（KV/R2 versioned，P6）尚未实现；当前规则、模板等 YAML 变更由 CLI 校验，Worker 行为以代码内注册内容为准。

## 云资源与配置

### Secrets 与环境变量

- `ENVIRONMENT` - 运行环境（`production` / `staging` / `development`）
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
