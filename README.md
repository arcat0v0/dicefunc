# DiceFunc - Cloudflare Workers 跑团服务

基于 Cloudflare Workers 的 TypeScript 7 跑团机器人，支持 COC7、DND5e 等规则。

## 项目状态

**规划阶段**: 当前为规划设计实现阶段，尚未完成全部功能开发。

参考 [DESIGN.md](./DESIGN.md) 了解完整架构和施工计划。

## 技术栈

- **语言**: TypeScript 7
- **运行时**: Cloudflare Workers
- **HTTP**: Hono
- **数据库**: Cloudflare D1
- **缓存**: Cloudflare KV
- **存储**: Cloudflare R2
- **队列**: Cloudflare Queues
- **构建**: Wrangler + pnpm

## 目录结构

```
dicefunc/
├── apps/
│   ├── worker/          # Cloudflare Worker 应用
│   └── cli/            # 命令行工具
├── packages/
│   ├── core/           # 核心领域逻辑
│   ├── config/         # 配置编译
│   └── adapters/       # 平台适配器
├── config/             # 配置文件
├── migrations/         # 数据库迁移
├── tests/              # 测试套件
└── docs/               # 文档
```

## 快速开始

### 安装依赖

```bash
pnpm install
```

### 本地开发

```bash
# 启动 Worker 开发服务器
pnpm dev:worker

# 运行 CLI 工具
pnpm cli --help
```

### 配置管理

```bash
# 检查配置
pnpm dice config check --dir ./config

# 编译配置
pnpm dice config build --dir ./config

# 模拟命令
pnpm dice simulate --message ".r 1d100"
```

### 部署

```bash
# 构建并部署
pnpm deploy:worker
```

## 主要功能

### 基础掷骰

- `.r 1d100` - 简单掷骰
- `.rd 3d6kh2` - 保留最高
- `.ra 侦查 60` - COC 技能检定

### 角色卡

- `.st` - 保存角色卡
- `.pc` - 查看/切换角色
- `.set` - 修改会话设置

### COC7 规则

- `.ra/.rc` - 技能检定/属性判定
- `.sc` - SAN 检定
- `.en` - 受伤检定

### DND5e 规则

- 技能检定与豁免
- HP 管理与死亡豁免
- 先攻与战斗轮
- 法术位与长休

### 跑团日志

- `.log new/on/off/end` - 日志管理
- R2 私有归档
- 临时下载链接

## 配置说明

### 必需环境变量

```env
QQ_APP_SECRET=your_qq_app_secret
```

### 云资源绑定

- `DB` - D1 数据库
- `CONFIG_KV` - KV 命名空间
- `STORY_LOG_BUCKET` - R2 存储桶
- `COMMAND_QUEUE` - 命令队列
- `ARCHIVE_QUEUE` - 归档队列

## 开发指南

### 添加新规则

1. 在 `packages/core/src/domain/rules/` 创建规则模块
2. 定义领域模型和纯函数
3. 注册命令到 `CommandRegistry`
4. 编写单元测试

### 添加自定义回复

编辑 `config/flavors/<flavor>/replies/*.yaml`:

```yaml
templates:
  custom.event:
    variants:
      - id: default
        weight: 1
        text: "Your message"
```

重新编译配置即可生效。

## 测试

```bash
# 代码检查
pnpm check

# 运行所有测试
pnpm test:unit
pnpm test:integration
pnpm test:runtime
```

## 文档

- [规划设计](./DESIGN.md) - 完整架构设计
- [功能清单](./SEALDICE_FEATURES.md) - 功能迁移矩阵
- [配置指南](./docs/configuration.md) - 配置详解
- [日志与保留](./docs/logging-and-retention.md) - 日志策略
- [测试指南](./docs/testing.md) - 测试说明

## 安全注意事项

- 不要将密钥提交到 Git
- 使用 1Password 或 Cloudflare Secrets 管理敏感信息
- R2 bucket 必须设为私有
- 定期审计访问日志
- 限制管理员权限范围

## 已知限制

### 已实现

- ✅ QQ 群 @ 消息
- ✅ C2C 私聊
- ✅ 基础掷骰表达式
- ✅ COC7 核心规则
- ✅ 角色卡系统
- ✅ 跑团日志归档

### 待实现

- ⏳ 全量群消息接收
- ⏳ DND5e 完整规则
- ⏳ 牌堆系统
- ⏳ 自定义回复引擎
- ⏳ 扩展包系统

### 不计划

- ❌ WebUI
- ❌ 多平台支持（除 QQ）
- ❌ Goja 插件兼容
- ❌ 自动运维系统

## 贡献

本项目处于早期开发阶段，欢迎反馈和建议。

## 许可证

继承自 SealDice 项目的许可协议。

---

**版本**: 0.1.0  
**最后更新**: 2026-09-18
