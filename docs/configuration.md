# DiceFunc 配置与 CLI 工具指南

DiceFunc 采用声明式 YAML 配置文件管理机器人行为、规则设定、访问控制与回复模板。本指南说明配置目录结构、合并继承逻辑以及 CLI 工具的真实行为。

## 配置文件结构

```
config/
├── bot.yaml                 # 机器人核心身份、QQ 场景与模块声明
├── access.yaml              # 访问控制、全局角色与权限策略
├── storage.yaml             # 存储桶、队列与 D1 数据库绑定定义
├── logging.yaml             # 运行时日志脱敏与跑团归档保留策略
├── limits.yaml              # 速率限制、并发窗口与资源预算
├── rules/
│   ├── coc7.yaml            # COC7 规则参数与房规预设
│   └── dnd5e.yaml           # DND5e 规则参数预设
├── groups/
│   └── example.yaml         # 群聊特定配置（覆盖全局设置）
└── flavors/
    ├── classic/             # 经典风格回复包（manifest 与 replies/*.yaml）
    └── gothic/              # 哥特风格回复包
```

## Schema 版本控制

所有 YAML 文件均必须包含根级 `schemaVersion` 字段（当前为数字 `1`）。配置加载与检查工具强制校验该字段，未声明或类型非数字将被拒绝。

## 配置解释与覆盖继承层级

当解析特定群会话的生效参数时，系统遵循确定的自底向上覆盖顺序：

1. **内置默认值 (Builtin Defaults)**: Core 核心代码预设的基本兜底值（例如 `ruleSet: coc7`, `diceSides: 100`, `flavor: classic`）；
2. **全局 Bot 配置 (`config/bot.yaml`)**: 全局生效的基础设定；
3. **群组配置文件 (`config/groups/<group>.yaml`)**:
   - 群组可在 `settings` 或 `overrides` 中指定局部覆盖值；
   - 群文件通过 `mutableSettings` 声明允许覆盖的配置白名单字段（如 `ruleSet`、`diceSides`、`flavor`、`enabled`）；
4. **数据库运行时会话设置 (`ConversationSession`)**: 通过管理命令（如 `.set`、`.bot`）写入 D1 的动态会话状态。

---

## CLI 工具核心命令与真实行为

全局通过 `pnpm dice` 或 `pnpm cli` 运行配置与模拟命令。

### 1. 配置检查 (`config check`)

递归扫描并检查配置目录下的所有 YAML 文件合法性。

```bash
pnpm dice config check --dir ./config
```

- **真实行为**:
  - 递归遍历目录，验证每个 YAML 文件的语法树；
  - 严格校验根结构必须为 Object 字典；
  - 拒绝重复键定义，防止配置歧义；
  - 严格校验必须包含顶层 `schemaVersion` 字段且必须为数字；
  - 若存在校验失败项，汇总报错清单并以非零状态码退出。

### 2. 配置编译与打包 (`config build`)

将分散的 YAML 配置文件编译为轻量 JSON 格式，并生成完整性校验摘要。

```bash
# 编译整个配置目录
pnpm dice config build --dir ./config --out ./dist/config.json

# 编译指定单个配置文件
pnpm dice config build --file ./config/bot.yaml
```

- **真实行为**:
  - 读取目标 YAML 文件并解析数据结构；
  - 生成标准格式的不可变 JSON 输出；
  - 计算全量内容的 SHA-256 摘要（64 位十六进制格式），用于版本校验与防篡改；
  - 校验合并过程中的最高 `schemaVersion`。

### 3. 配置解析解释 (`config explain`)

展示特定群在合并各层配置后的最终解析结果与来源追溯。

```bash
pnpm dice config explain --group ./config/groups/example.yaml --key defaults.ruleSet
```

- **真实行为**:
  - 自动定位指定的群文件（支持直接文件路径或 `config/groups/` 下群名称）；
  - 依次比对 **内置默认值** → **全局 bot.yaml** → **群组文件 (settings/overrides)**；
  - 输出每层的命中值、是否存在以及最终生效的生效值 (Effective Value)。

### 4. 回复模板预览 (`reply preview`)

预览指定风格（Flavor）下各回复事件（Event Key）的全部候选项渲染结果。

```bash
# 预览经典风格掷骰模板
pnpm dice reply preview dice.roll --flavor classic

# 预览哥特风格 COC 检定失败模板
pnpm dice reply preview coc.check.failed --flavor gothic
```

- **真实行为**:
  - 加载指定风格目录下的 `manifest.yaml`，按 `extends` 链及声明的 `files` 载入回复模板 YAML；
  - 匹配目标模板事件键（如 `dice.roll`、`coc.check.failed`、`coc.check.success`）；
  - 注入预置样本变量（如 `actor.name`、`roll.total`、`target.value` 等）；
  - 输出该模板下定义的全部候选项 variants（包含 variant id、权重 weight 以及变量插值渲染后的真实文本）。

### 5. 离线命令模拟 (`simulate`)

在本地离线环境下直接模拟真实骰点与命令求值。

```bash
# 模拟普通掷骰
pnpm dice simulate --message ".r 1d100"

# 模拟带 keep/drop 修饰符的掷骰
pnpm dice simulate --message ".r 4d6kh3+2 力量检定" --scene groupAt
```

- **真实行为**:
  - 本地调用 `@dicefunc/core` 的掷骰解析逻辑；
  - 驱动基于 WebCrypto 的加密随机数源进行真实掷骰计算；
  - 完整支持 `kl`/`kh`/`dl`/`dh`（保留/丢弃最高/最低骰）及正负修饰值计算，输出每颗骰子出目与最终总和。

---

## 规划中工具功能（待实现）

- **`config diff`**: 比较两个配置版本目录或发布包之间的差异（待实现）；
- **`config migrate`**: 针对 `schemaVersion` 变更执行自动平滑迁移脚本（待实现）。
