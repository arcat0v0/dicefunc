# 测试指南

## 测试命令

```bash
# 代码检查
pnpm check

# 单元测试
pnpm test:unit

# 集成测试
pnpm test:integration

# 运行时测试
pnpm test:runtime
```

## 测试类型

### 单元测试 (Unit Tests)

- 纯计算逻辑
- 表达式解析
- 规则判定
- 模板渲染

### 集成测试 (Integration Tests)

- D1 数据库操作
- Queues 消息处理
- R2 文件上传下载
- 跨模块协作

### 运行时测试 (Runtime Tests)

- WebCrypto 随机源
- Dice -roll 分布
- Deck 抽牌逻辑

## 本地测试

使用 Cloudflare 官方测试工具：

```bash
# workerd 本地环境
wrangler dev

# Miniflare 模拟服务
vitest --config tests/runtime/vitest.config.ts
```

## 云端测试

需要独立的 Cloudflare 资源：

1. **D1**: 专用数据库，不包含生产数据
2. **KV**: 配置缓存命名空间
3. **R2**: 存储 bucket（私有）
4. **Queues**: 队列和死信队列
5. **Secrets**: QQ_APP_SECRET 等凭据

## 测试覆盖要求

### P0-P2 阶段

- [x] 随机数生成无偏
- [x] 骰点 roll 正确
- [x] Keep/Drop 逻辑正确
- [ ] 表达式解析边界
- [ ] 配置编译验证

### P3-P4 阶段

- [ ] D1 并发修改测试
- [ ] SAN 扣减原子性
- [ ] 版本冲突回滚
- [ ] COC7 房规边界

### P5-P7 阶段

- [ ] HP/临时 HP 事务
- [ ] 牌堆并发无放回
- [ ] R2 分片完整性
- [ ] 归档下载授权
- [ ] 日志删除流程

## 断言标准

所有关键业务流程必须通过以下验证：

1. **幂等性**: 重复执行不改变结果
2. **原子性**: 失败时全部回滚
3. **一致性**: 状态不变量始终成立
4. **恢复性**: 故障后可恢复至正确状态

## 阻碍因素

当前未完成项：

- ⚠️ 云端资源未配置
- ⚠️ QQ App 未验证实际能力
- ⚠️ Workers Logs 实际采样率未测量
- ⚠️ D1 batch 约束需实测验证
