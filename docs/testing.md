# 测试与工程质检指南

DiceFunc 采用分层自动化测试体系，包含静态类型检查、代码风格规范、本地纯运行时测试以及基于 Cloudflare `workerd` 的真实集成测试。

## 测试与质检入口

```bash
# 全局工程质检门槛 (tsc + biome + config check)
pnpm check

# 纯运行时测试 (领域逻辑、随机源、掷骰、抽牌、命令与日志)
pnpm test:runtime

# 集成测试 (真实 workerd 环境下的 D1 / R2 / KV / Queues 与数据库迁移)
pnpm test:integration

# 单元测试全量入口
pnpm test:unit
```

---

## 质检与测试类型详解

### 1. 静态质量门槛 (`pnpm check`)

在提交或合并前强制执行的三重验证：

1. **TypeScript 构建 (`tsc -b`)**: 跨 Monorepo 项目引用的全量类型编译与严格模式检查；
2. **Biome 代码检查 (`biome check .`)**: 静态语法、代码异味与格式化规范校验；
3. **配置完整性校验 (`pnpm dice config check`)**: 确保 `config/` 目录下全部 YAML 格式合法、顶层 `schemaVersion` 完整且无重复键。

### 2. 运行时测试 (`pnpm test:runtime`)

测试位于 `tests/runtime/`，验证不依赖外部 IO 的纯业务与底层接口：

- **随机数生成 (`random-source.test.ts`)**: 验证 WebCrypto 随机数发生器的无偏性与边界分布；
- **掷骰计算 (`dice.test.ts`)**: 验证面数解析、修饰值计算以及 `kl`/`kh`/`dl`/`dh` 等 keep/drop 算子；
- **抽牌引擎 (`deck.test.ts`)**: 验证 `DeckSession` 的无放回抽牌逻辑与重置状态；
- **核心命令注册 (`commands.test.ts`)**: 验证 `.r`、`.help`、`.set`、`.bot`、`.userid` 等内置命令的执行与权限过滤；
- **结构化日志脱敏 (`logger.test.ts`)**: 验证 `RuntimeLogger` 字段白名单过滤、敏感数据隐藏与单条 8 KiB 安全截断。

### 3. Workerd 集成测试 (`pnpm test:integration`)

测试位于 `tests/integration/`，通过 `@cloudflare/vitest-pool-workers` 在本地启动与生产 Worker 一致的真实 `workerd` 隔离容器：

- **数据库迁移执行**: 自动加载并执行 `migrations/001_initial_schema.sql`，构建包含 21 张表、`commit_guards` 强约束与索引的真实 D1 数据库环境；
- **原子事务与守卫测试 (`state-store.test.ts`)**:
  - 验证 `commit_guards` 表基于 `CHECK (actual_version = expected_version)` 的强一致性回滚能力；
  - 验证并发修改下的乐观锁冲突检测；
  - 验证 `fencingToken` 任务租约超时控制与任务认领机制；
  - 验证 `inbox` 去重与 `job` 调度的原子落库；
- **R2 归档交互**: 验证分片对象写入校验、SHA-256 摘要比对与读取；
- **队列调度**: 验证向 `COMMAND_QUEUE` 与 `ARCHIVE_QUEUE` 投递仅含元数据的最小任务包。

---

## 本地测试 vs 云端测试边界

### 本地环境具备的能力（已验证）

- 完整的本地 `workerd` 虚拟基础设施（D1、KV、R2、Queues）；
- 真实的 SQLite / D1 批量 SQL 事务与外键约束行为；
- 真实 Web Crypto 算法执行（Ed25519 验签、SHA-256 哈希）。

### 云端待验证事项（后续阶段）

以下能力受限于远程云资源与平台授权，尚未进行端到端云端实测：

1. **真实 Cloudflare 多节点边缘部署**: 线上 Workers 实际冷启动耗时与 CPU 限制；
2. **QQ 开放平台真实全链路**: QQ 真实网关发出的 Webhook 请求及推送回复成功率；
3. **Workers Logs 生产采集**: 云端实际采样策略与平台审计日志持久化观察；
4. **大并发生产 D1 竞争**: 多并发 Worker 写入真实 D1 时的排队延迟与熔断表现。
