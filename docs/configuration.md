# DiceFunc 配置指南

## 配置文件结构

DiceFunc 使用 YAML 格式的配置文件，支持多文件组织和继承。

### 核心配置文件

- `config/bot.yaml` - Bot 基本配置
- `config/access.yaml` - 访问控制和权限
- `config/storage.yaml` - 存储和队列绑定
- `config/logging.yaml` - 日志配置
- `config/limits.yaml` - 速率限制和资源预算

### 规则配置

- `config/rules/coc7.yaml` - COC7 规则设置
- `config/rules/dnd5e.yaml` - DND5e 规则设置

### 群组配置

- `config/groups/*.yaml` - 各群组的特定配置

### 风格配置

- `config/flavors/*/manifest.yaml` - 风格定义
- `config/flavors/*/replies/*.yaml` - 回复模板

## 配置合并顺序

1. 内置默认值
2. 全局文件 (`bot.yaml`, `access.yaml` 等)
3. 群组文件 (`groups/*.yaml`)
4. 数据库中的允许覆盖项

## 编译配置

使用 CLI 工具编译配置：

```bash
# 检查配置
pnpm dice config check --dir ./config

# 编译配置
pnpm dice config build --dir ./config

# 解释配置值
pnpm dice config explain --group ./config/groups/example.yaml --key defaults.ruleSet
```

## 预览回复模板

```bash
# 预览 COC 检定失败模板
pnpm dice reply preview coc-check-failed --flavor gothic
```

## 模拟命令

```bash
# 模拟掷骰命令
pnpm dice simulate --message ".r 1d100" --scene groupAt
```

## Schema 版本

所有配置文件都包含 `schemaVersion` 字段，用于版本管理和迁移。当前版本为 `1`。

## 安全注意事项

- 不要在配置文件中存储明文密钥
- 使用环境变量或 1Password 引用敏感信息
- 定期审计 `access.yaml` 中的权限设置
- 限制 `limits.yaml` 中的资源预算防止滥用
