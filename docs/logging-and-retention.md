# 日志与保留策略规范

本文档定义 DiceFunc 的日志分类、跑团正文归档、数据保留周期与安全审计规范。

## 实现现状与实施边界

### 当前真实能力（已实现）

- **命令与持久化**: `.log new/on/off/end/stat/export` 已接入 Core 和 Worker；按 SealDice 的启停边界记录用户消息与已发送的机器人回复，`.log end` 原子关闭日志、冻结游标并创建可恢复的归档任务；
- **异步归档**: `ARCHIVE_QUEUE` 以每批 100 条记录为目标且不拆分同一会话序号，将 SealDice TXT 分片写入私有 R2，核对摘要与大小后生成清单；全部冻结记录完成后才把归档标记为 `ready`；
- **下载授权**: 群主或骰主使用 `.log export` 获得 256-bit、15 分钟有效的下载链接；D1 仅保存令牌哈希；
- **HTTP 路由与鉴权**: `GET /archives/:id` 同时支持链接中的短时 token 和 `Authorization: Bearer`：
  - 校验令牌哈希、归档绑定、有效期、撤销状态、读取 scope、归档 `ready` 状态与删除状态；
  - 下载前校验每个 R2 分片的摘要元数据与大小；
  - 强制 `Cache-Control: private, no-store`、附件下载、`nosniff` 与 `no-referrer`；
  - 授权签发和成功下载均写入 D1 审计记录，应用诊断日志不记录 token、完整 URL 或正文。

### 尚未实现

- `.log halt`、`.log delete` 与归档撤销/删除流程；
- 日志字数、骰点分布与活跃玩家等聚合统计；
- R2 校验完成后清理 D1 正文副本；
- 归档完成后的主动 QQ 通知；当前需要用户再次发送 `.log export` 查询。

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

- **内容**: 服务实际收到的用户消息与实际发送的机器人回复；启停指令边界与 SealDice 一致；
- **机器人昵称**: 出站记录使用 `packages/core/src/messages/zh-CN/core.ts` 中的 `bot.display_name` 文案，当前默认值为 `Dicefunc`；
- **存储**: Cloudflare D1（正文暂存与元数据索引）+ Cloudflare R2（不可变 SealDice TXT 分片与归档清单）；
- **保留期**: 由 `config/logging.yaml` 的 `archiveRetentionDays` 决定（默认永久保留）；
- **访问控制**: 当前仅群主或骰主可签发短时下载授权。

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

## 跑团日志交互命令

```text
.log new <日志名> - 创建并开启日志
.log on           - 恢复记录
.log off          - 暂停记录
.log end          - 关闭日志并触发归档
.log stat         - 查看当前或最近日志及归档状态
.log export       - 获取 15 分钟有效的归档下载链接
```

`.log export` 仅允许群主或骰主使用。对尚无归档任务的既有已关闭日志，首次执行会补建归档；归档仍在处理时会提示稍后重试。若部署未配置 `PUBLIC_BASE_URL`，归档可以完成，但机器人不会签发不可用的链接。

---

## 跑团正文持久化与归档流程

```text
[QQ 消息] ──> [D1 story_log_items 暂存]
                     │
                     ▼ (.log end 冻结游标并创建任务)
              [ARCHIVE_QUEUE 分批读取冻结记录]
                     │
                     ▼
              [写入 R2 SealDice TXT 分片并校验摘要/大小]
                     │
                     ▼
              [生成归档清单并标记 ready]
                     │
                     ▼ (.log export)
              [签发 15 分钟下载链接]
```

1. **实时暂存**: 消息去重后，按命令执行前的日志状态记录用户消息，按执行后的日志状态记录实际发送成功的机器人回复；因此 `.log new/on` 只记录成功回复，`.log off/end` 只记录指令消息。
2. **冻结归档**: `.log end` 与日志关闭状态、包含该指令消息的归档游标、归档元数据和归档任务在同一 D1 batch 中提交。
3. **有界分片**: 消费者以 100 条为每批目标，同一会话序号的双向记录不会跨分片；仍有记录时复用同一任务继续投递，进度持久化在 D1。
4. **内容校验**: 每个 R2 对象写入后核对 SHA-256 摘要与正文长度，通过后才推进分片水位。
5. **完成判定**: 冻结范围内不存在未分片记录后生成不可变清单，并将归档标记为 `ready`。
6. **下载交付**: 下载路由按序流式返回 `昵称(用户ID) YYYY-MM-DD HH:mm:ss` 开头的 SealDice TXT 记录，不公开 R2 bucket。

---

## 私有存储与下载授权规范

- **存储桶隔离**: `STORY_LOG_BUCKET` 必须独立于 `CONFIG_BUCKET`，禁止开启 `r2.dev` 公开访问，不绑定公共域名，不开放匿名列表或宽泛 CORS；
- **下载端点**: 统一走 `GET /archives/:id`；机器人签发的链接携带 15 分钟 token，API 客户端也可用 Bearer token；
- **Token 约束**: 使用 256-bit 随机 token，D1 仅保存 SHA-256 哈希、归档绑定、scope、有效期与撤销状态；
- **审计优先**: 通过授权校验后必须先完成 D1 下载审计，再开始传输正文；审计失败时拒绝下载；
- **防信息泄露**: 鉴权失败、记录不存在、归档未就绪或已标记删除时统一返回 404，诊断日志不记录 token 或完整请求 URL。

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
