# 日志和保留策略

## 日志分类

### 运行时诊断日志

- **内容**: 状态、耗时、错误码、重试与资源失败
- **存储**: Workers Logs
- **保留期**: 默认 7 天 (Workers Paid)
- **权限**: 仅项目维护者最小只读权限

### 跑团日志

- **内容**: 实际收到的对话、骰点、发送结果和规则版本
- **存储**: R2 私有存储 + D1 索引
- **保留期**: 配置决定 (`archiveRetentionDays`)
- **权限**: 当前群配置的日志管理者可申请导出

### 日志访问审计

- **内容**: 启停、导出、授权、下载、撤销与删除
- **存储**: D1 独立审计表
- **保留期**: 默认 90 天
- **权限**: 维护者；普通玩家无查询接口

### 执行恢复数据

- **内容**: inbox、结果、回复意图、随机种子
- **存储**: D1 有界保留
- **保留期**: 结果 7 天，去重 30 天
- **权限**: 仅应用内部

## 日志管理命令

```
.log new      - 创建新日志
.log on       - 开启记录
.log off      - 暂停记录
.log end      - 结束并归档
.log halt     - 暂停且不生成分享
.log stat     - 查看统计
.log export   - 导出日志
```

## 保留策略配置

`config/logging.yaml`:

```yaml
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

## 归档流程

1. **开启记录**: `.log on` - 开始收录聊天
2. **实时落盘**: 每条消息异步写入 R2 分片
3. **结束归档**: `.log end` - 冻结游标，创建完整归档
4. **下载授权**: 签发临时链接（默认 15 分钟）
5. **清理暂存**: 验证归档后 24 小时清理 D1 正文

## 删除流程

```
.log delete <id>
```

1. 展示目标与范围
2. 授权管理者确认（5 分钟窗口）
3. 标记 `deleting`，撤销所有下载授权
4. 异步删除 R2 分片和 D1 正文
5. 保留最小审计记录

## 故障恢复

- **R2 不可用**: 保留 D1 暂存，自动重试
- **D1 不可用**: 无法 ACK，队列重试
- **归档损坏**: 从 D1 暂存重试，无法恢复则标 `unavailable`

## 安全保护

- R2 bucket 必须设为私有
- 不绑定公共域名
- 关闭 `r2.dev` 公开访问
- TLS 传输 + 平台静态加密
- 下载链接不含身份标识
- 审计记录不包含正文或 token
