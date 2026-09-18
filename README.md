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
  - 严格 Fail-Closed Ed25519 验签（验证先于任何 JSON 解析，缺失凭据或验签失败直接 401）；
  - 平台校验应答：支持 `op: 13` 回调验证（使用私钥签名 `plain_token` 应答）；
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

## 云资源与配置

### 必需 Secrets 与环境变量

- `ENVIRONMENT` - 运行环境（`production` / `staging` / `development`）
- `QQ_APP_ID` - QQ 开放平台应用 ID
- `QQ_APP_SECRET` - QQ 开放平台应用密钥
- `QQ_ED25519_PUBLIC_KEY` - QQ Webhook 验签公钥
- `QQ_ED25519_PRIVATE_KEY` - QQ 校验应答私钥

### Cloudflare 资源绑定

- `DB` - Cloudflare D1 数据库
- `CONFIG_KV` - Cloudflare KV 命名空间（配置缓存）
- `STORY_LOG_BUCKET` - Cloudflare R2 私有存储桶（跑团日志分片与归档）
- `CONFIG_BUCKET` - Cloudflare R2 私有存储桶（P6 可选，版本化配置发布）
- `COMMAND_QUEUE` - Cloudflare Queues 命令任务队列
- `ARCHIVE_QUEUE` - Cloudflare Queues 归档任务队列

## 文档指引

- [完整架构设计与规划](./DESIGN.md)
- [配置管理指南](./docs/configuration.md)
- [日志与保留规范](./docs/logging-and-retention.md)
- [测试与验证指南](./docs/testing.md)
