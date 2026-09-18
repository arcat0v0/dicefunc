# 日志与保留策略规范

本文档定义 DiceFunc 的日志分类、跑团正文归档、数据保留周期与安全审计规范。

## 实现现状与实施边界

### 当前真实能力（已实现）

- **Adapter 存储层**: `R2ArchiveStore` 基于 Cloudflare R2 实现了归档文件的 `put`（带摘要与大小校验）和 `read`；
- **HTTP 路由与鉴权**: Worker 已实现 `GET /archives/:id` 路由：
  - 校验 Authorization Bearer token（比对 D1 存储的哈希值，校验绑定归档 ID、生效时间、过期时间与撤销状态）；
  - 验证归档状态（`ready` 且未标记 `deleting`）；
  - 强制安全响应头：`Cache-Control: private, no-store`、`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；
  - 每次下载尝试先向 D1 记录审计记录（记录归档 ID、客户端 IP、状态，严禁记录 token 明文）；
- **领域状态机**: `StoryLog` 与 `ArchiveChunk` 状态模型与校验方法已在 Core 中就绪。

### 目标架构与后续规划（待实现 / P7 阶段实施要求）

- **交互管理命令**: `.log new/on/off/end/halt/stat/export/delete` 用户交互命令尚未接入 Worker 命令注册表；
- **持续异步分片归档**: 队列消费 `ARCHIVE_QUEUE` 异步拉取 D1 暂存日志、生成不可变 256 KiB JSONL 分片并回写 R2 水位的后台机制尚未完全串联；
- **QQ 交互式授权签发**: 通过 QQ 会话申请 256-bit 临时下载 token 并返回安全链接的端到端交互待实现。

---

## 日志分类与规范（实施要求）

### 1. 运行时诊断日志 (RuntimeLogger)

- **内容**: 组件名、运行状态、耗时、固定错误码、重试与资源失败；
- **存储与通道**: Cloudflare Workers Logs / 标准控制台流；
- **格式规范**:
  - 必须经过字段白名单过滤；
  - 严禁记录 AppSecret、token、Authorization/Cookie、完整 URL、下载令牌、用户昵称、OpenID、人物卡与聊天正文；
  - 序列化后单条严格限制在 8 KiB 以内，超限丢弃元数据并标记 `truncated`。

### 2. 跑团正文与归档日志 (StoryLog & Archive)

- **内容**: 会话接收并确认的聊天文本、骰点结果、发送回执与规则版本；
- **存储**: Cloudflare D1（暂存与元数据索引）+ Cloudflare R2（不可变分片与最终归档文件）；
- **保留期**: 由 `config/logging.yaml` 的 `archiveRetentionDays` 决定（默认永久保留）；
- **访问控制**: 仅会话绑定的日志管理者经审计后可申请导出。

### 3. 数据访问与审计日志 (AuditLog)

- **内容**: 归档记录启停、导出申请、下载鉴权尝试、撤销与删除操作；
- **存储**: Cloudflare D1 独立审计表；
- **保留期**: 默认 90 天；
- **权限**: 仅项目维护者只读，不向普通玩家提供开放查询。

### 4. 执行恢复与幂等数据

- **内容**: `inbox` 去重流水、命令执行状态、已准备回复意图；
- **存储**: Cloudflare D1 有界表；
- **保留期**: 命令结果 7 天，去重流水 30 天。

---

## 跑团日志目标交互命令（待实现设计）

以下命令为完整架构下的设计规格，待 P7 接入 Core 注册表：

```
.log new           - 创建新日志并设为活跃
.log on            - 开始/恢复收录当前会话消息
.log off           - 暂停收录
.log end           - 结束记录并触发完整归档任务
.log halt          - 暂停记录且不生成分享链接
.log stat          - 查看当前日志条数与状态
.log export        - 申请生成日志临时下载授权
.log delete <id>   - 发起删除归档流程（需二次确认）
```

---

## 跑团正文持久化与归档流程（目标架构规范）

```
[QQ 消息] ──> [D1 inbox + story_log_items (暂存)]
                     │
                     ▼ (ARCHIVE_QUEUE 异步消费)
              [生成有界不可变分片 (目标 256 KiB)]
                     │
                     ▼ (写入 R2)
              [R2 校验摘要/大小一致]
                     │
                     ▼
              [D1 标记 verified 并清理暂存正文]
                     │
                     ▼ (.log end / export)
              [汇总结算生成 TXT/JSON 归档文件]
```

1. **实时暂存**: 消息确认后原子写入 D1 `story_log_items`。未送达或失败的机器人消息标注实际状态，不伪造已送达记录。
2. **异步落盘**: `ARCHIVE_QUEUE` 消费者在 D1 固定待写分片的序号范围，生成不可变 JSONL 分片并写入 R2。
3. **内容校验**: 写入 R2 成功后必须核对对象 SHA-256 摘要与正文长度，通过后在 D1 标记 `verified`。
4. **清理暂存**: 分片在 R2 校验确认后，方可清理 D1 中的暂存正文。
5. **归档生成**: 仅当冻结游标内的全部记录齐全、摘要全部通过时，归档方可标记为 `ready` 状态供下载。

---

## 私有存储与下载授权规范（已实现实施要求）

- **存储桶隔离**: `STORY_LOG_BUCKET` 必须独立于 `CONFIG_BUCKET`，禁止开启 `r2.dev` 公开访问，不绑定公共域名，不开放匿名列表或宽泛 CORS；
- **下载端点**: 统一走 `GET /archives/:id`，凭 Bearer token 鉴权；
- **Token 约束**: 使用至少 256 bit 加密随机 token，D1 仅保存其哈希值与有效期限（默认 15 分钟，上限 60 分钟）；
- **审计优先**: 下载请求到达时，必须先在 D1 完成审计记录持久化，方可向客户端传输文件正文；
- **防信息泄露**: 鉴权失败、记录不存在或已标记删除时，统一返回 404 或受限状态码，避免泄露内部对象存在性。

---

## 保留策略配置样例

`config/logging.yaml`:

```yaml
schemaVersion: 1
story:
  enabledByDefault: false
  archiveRetentionDays: null  # null 表示永久保留
  stagingPurgeAfterVerifiedHours: 24
  archiveLagWarningSeconds: 60
  archiveLagPauseSeconds: 900
  stagingMaxBytesPerConversation: 8388608
  shareLinksEnabled: false
  grantTtlSeconds: 900
  auditRetentionDays: 90

execution:
  resultRetentionDays: 7
  dedupRetentionDays: 30
```
