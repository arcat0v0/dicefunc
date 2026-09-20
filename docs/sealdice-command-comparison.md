# SealDice 与 DiceFunc 指令处理逻辑与核心算法深度对比技术报告

本文档全面对比 **SealDice-Core**（以提交 `4493693` 为基准）与当前 **DiceFunc**（TypeScript 7 / Cloudflare Workers 架构）在**指令处理逻辑**、**执行流水线**、**底层算法实现**以及**全部业务指令**上的设计差异与功能边界。

---

## 目录

1. [系统总体架构与指令处理流水线对比](#1-系统总体架构与指令处理流水线对比)
2. [底层引擎与核心算法对比](#2-底层引擎与核心算法对比)
   - 2.1 [骰点表达式解析与求值算法](#21-骰点表达式解析与求值算法)
   - 2.2 [随机数发生器 (RNG) 与均匀采样算法](#22-随机数发生器-rng-与均匀采样算法)
   - 2.3 [检定判定与跑团规则算法 (COC7 / DND5e)](#23-检定判定与跑团规则算法-coc7--dnd5e)
   - 2.4 [角色属性与动态计算属性算法](#24-角色属性与动态计算属性算法)
   - 2.5 [牌堆抽取与带权抽样算法](#25-牌堆抽取与带权抽样算法)
3. [全指令分类详细对比清单](#3-全指令分类详细对比清单)
   - [分类 A：核心掷骰指令群 (.r, .rd, .roll, .rh, .rx)](#分类-a核心掷骰指令群-r-rd-roll-rh-rx)
   - [分类 B：会话管理与机器人控制 (.bot, .set, .dismiss, .botlist)](#分类-b会话管理与机器人控制-bot-set-dismiss-botlist)
   - [分类 C：身份标识与名片指令 (.userid, .nn)](#分类-c身份标识与名片指令-userid-nn)
   - [分类 D：COC7 克苏鲁跑团指令群 (.ra, .rc, .setcoc, .sc, .ti, .li, .en, .coc)](#分类-dcoc7-克苏鲁跑团指令群-ra-rc-setcoc-sc-ti-li-en-coc)
   - [分类 E：DND5e 龙与地下城指令群 (.ra, .rc, .ri, .init, .hp, .ss, .longrest, .ds, .dnd)](#分类-ednd5e-龙与地下城指令群-ra-rc-ri-init-hp-ss-longrest-ds-dnd)
   - [分类 F：跨规则角色卡管理指令群 (.st, .pc)](#分类-f跨规则角色卡管理指令群-st-pc)
   - [分类 G：牌堆与自定义回复指令群 (.draw, .deck, 规则回复)](#分类-g牌堆与自定义回复指令群-draw-deck-规则回复)
   - [分类 H：跑团故事日志指令群 (.log)](#分类-h跑团故事日志指令群-log)
   - [分类 I：小众规则与扩展骰点指令群 (.ww, .rsr, .dx, .ek, .drl, .who)](#分类-i小众规则与扩展骰点指令群-ww-rsr-dx-ek-drl-who)
   - [分类 J：趣味娱乐与辅助工具指令群 (.name, .jrrp, .gugu, .ping, .send, .modu, .check)](#分类-j趣味娱乐与辅助工具指令群-name-jrrp-gugu-ping-send-modu-check)
   - [分类 K：系统管理与运维配置指令群 (.master, .black, .randalgo, .help, .find)](#分类-k系统管理与运维配置指令群-master-black-randalgo-help-find)
4. [状态持久化、并发控制与事务一致性对比](#4-状态持久化并发控制与事务一致性对比)
5. [综合对比评估矩阵与演进路线](#5-综合对比评估矩阵与演进路线)

---

## 1. 系统总体架构与指令处理流水线对比

### 1.1 架构设计哲学与运行载体

| 维度 | SealDice-Core | DiceFunc (当前实现) |
| :--- | :--- | :--- |
| **运行时基础设施** | 操作系统常驻守护进程（Go compiled binary） | Serverless 边缘运行时（Cloudflare Workers, workerd） |
| **消息输入管道** | 多平台长连接/Webhook（OneBot/Milky/Red/QQ/Discord/TG 等 ~15 种） | 专注于 QQ 开放平台官方机器人 Webhook HTTP 入口 |
| **状态存储模型** | 进程内内存常驻缓存（Active Cache）+ 异步/同步落盘（SQLite / PostgreSQL / MySQL） | 无状态计算节点 + 关系型边缘数据库 Cloudflare D1（强事务/乐观并发控制） |
| **指令执行模式** | 状态机就地修改、直接调用平台适配器下发 Socket 消息 | 纯函数式单向数据流：`Event + Snapshot -> CommandDecision (Updates + Replies + LogItems)`，原子 Commit 后经 Fast-path/Queues 异步投递 |
| **扩展与插件体系** | 基于 Goja 引擎的动态 JavaScript 脚本运行时 + SealPack 打包格式 | 编译期强类型 TypeScript 模块化注册表（当前未开放动态运行时） |

### 1.2 指令处理生命周期时序对比

#### SealDice 处理时序：
```
[接收平台消息]
  │
  ▼
[PlatformAdapter 协议解码与 UniformID 统一]
  │
  ▼
[CensorManager: Trie 树 + go-pinyin 敏感词过滤] ──(触发阻断)──> [拉黑/退群/阻断]
  │
  ▼
[RateLimiter: 令牌桶限流判定] ────────────────(超频拦截)──> [丢弃/告警]
  │
  ▼
[BanList: 黑名单与信誉分核验] ────────────────(命中封禁)──> [拒绝响应]
  │
  ▼
[IMSession.ExecuteNew: 装配 MsgContext (GroupInfo, Attrs)]
  │
  ▼
[JS VM 插件前置钩子: ext.onCommandReceived / onNotCommandReceived]
  │
  ▼
[指令解析与前缀匹配: 匹配 CmdMap] ─────────────(未命中)────> [CustomReply 条件匹配]
  │
  ▼
[调用指令实现函数 Solve() -> dicescript VM 表达式求解]
  │
  ▼
[DiceFormatTmpl: 模板变量渲染与文案替换]
  │
  ▼
[PlatformAdapter.SendToGroup / SendToPerson 发送]
```

#### DiceFunc 处理时序：
```
[QQ Webhook POST /webhooks/qq]
  │
  ▼
[Ed25519 官方向量验签 + op 路由 (op=13 challenge / op=0 事件)]
  │
  ▼
[快速持久化: D1 claimEvent 原子认领与防重]
  │
  ▼
[D1 batch 加载 StateSnapshot (Conversation, Permissions, Sheet, Encounter, Deck, Log)]
  │
  ▼
[CommandExecutor.execute()]
  ├─ 1. 多轮前缀正则解包: /^(\d+)[#＃]\s*(.*)$/
  ├─ 2. 显式前缀识别: [. 。 ! ！ /] 剥离
  ├─ 3. 紧凑粘连匹配 (Sticky Match): 降序最长前缀截断
  ├─ 4. 未命中且无前缀: matchCustomReply() 静态回复
  ├─ 5. 权限校验: denied / isGroupHost / isDiceMaster 门禁检查
  ├─ 6. 注册表 Handler 执行: 纯函数产生 CommandDecision
  │     (results, updates, replies, logItems)
  │
  ▼
[D1 batch 乐观锁原子提交: actual_version = expected_version]
  │
  ▼
[回复发送链路]
  ├─ Fast-path (Promise.race): 同请求内直接调用 QQ OpenAPI 发送并落库
  └─ Slow-path / 重试: Cloudflare Queues 异步消费 + 指数退避重试
```

---

## 2. 底层引擎与核心算法对比

### 2.1 骰点表达式解析与求值算法

| 特性 | SealDice-Core | DiceFunc (当前实现) |
| :--- | :--- | :--- |
| **解析器架构** | 双引擎架构：<br>1. V1：PEG 文法文件（Packrat Parsing）；<br>2. V2：**dicescript 字节码虚拟机 (RollVM)**，含 Lexer、AST Parser、Code Generator、Stack-based VM。 | Tokenizer + **Pratt Parser** 生成类型化 AST，再由纯函数求值；不使用 `eval`。 |
| **复合算术运算** | **完全图灵完备/复杂四则运算**：<br>支持加减乘除、取模、乘方、位运算，括号无限嵌套，如 `(1d6+2)*3+2d20kh1`。 | 支持多组骰子、加减乘除、取模、乘方、一元正负号与括号，例如 `(1d6+2)*3+2d20kh1`；尚不支持位运算、比较、逻辑与三元表达式。 |
| **骰子修饰符 (Keep/Drop)** | 支持 `kh` / `kl` / `dh` / `dl` / `k` / `q`；原生支持中文**“优势”**（等价 `kh1`）、**“劣势”**（等价 `kl1`）。 | 支持 `kh` / `kl` / `dh` / `dl` / `k` / `q` 与简繁体 `优势/劣势/優勢/劣勢`；无显式骰数的 `d20优势`、`d优势` 等形式按 2 骰取高/取低处理。 |
| **骰池与特殊规则骰** | 原生支持 WOD 骰池 `10a10m10k8`（加骰线/成功线）、Double Cross 双十字 `7c8`（暴击递进加骰）。 | **未实现**。 |
| **比较与逻辑运算符** | 支持 `>`, `<`, `>=`, `<=`, `==`, `!=`, `&&`, `||`, `!`, 三元表达式 `cond ? a : b`。 | **未实现**。 |
| **安全执行预算** | VM 保护：最大指令步数熔断（防死循环）、表达式长度限制、调用栈深度保护、标准化错误码（E1~E7）。 | 静态预算检查：最大 2KiB 字节长度、单次最多 100 颗骰子、最大 10 轮、总骰数上限 1000 颗。 |

### 2.2 随机数发生器 (RNG) 与均匀采样算法

#### 1. SealDice-Core：多源密码学随机数矩阵
SealDice 内置 5 种模式，保证跑团公正与防预测：
1. **PCG PRNG (`ModePCG`)**：高性能伪随机数生成器，统计学离散度极优。
2. **国密 SM3 DRBG (`ModeGM`)**：符合商密 `GM/T 0105-2021` 规范，集成 SP 800-90B 连续健康检测与已知答案自检（KAT）。
3. **NIST AES-256-CTR-DRBG (`ModeNIST`)**：符合 `NIST SP 800-90A Rev.1`，带预测抵抗（Prediction Resistance）。
4. **操作系统 CRNG (`ModeCRNG`)**：直接调用 Linux 内核 `getrandom(2)` 或 Windows `ProcessPrng` 物理熵池。
5. **多源异或混合模式 (`ModeHybrid`)**：将上述 4 种随机源输出按位异或（$S = S_{PCG} \oplus S_{GM} \oplus S_{NIST} \oplus S_{CRNG}$）。根据信息论，只要任意一个随机源不可预测，混合结果即具备绝对不可预测性。支持 `.randalgo` 实时测速。

#### 2. DiceFunc：Web Crypto API + 拒绝采样算法 (Rejection Sampling)
DiceFunc 依托现代浏览器/边缘运行时标准的 `crypto.getRandomValues`，并通过**严格的数学拒绝采样算法**消除了经典的**模偏差（Modulo Bias）**：

```typescript
const range = maxInclusive - minInclusive + 1;
const maxRange = Math.floor(0x100000000 / range) * range; // 寻找 2^32 内 range 的最大整数倍
const buf = new Uint32Array(1);
let val: number;
do {
  crypto.getRandomValues(buf);
  val = buf[0] ?? 0;
} while (val >= maxRange); // 剔除末尾无法被 range 整除的偏差区间
return minInclusive + (val % range);
```
- **算法评价**：在不依赖外部 CGO/本地库的情况下，在 WebAssembly/V8 运行时内实现了数学上绝对均匀的离散分布，符合工业级加密需求。

---

### 2.3 检定判定与跑团规则算法 (COC7 / DND5e)

#### 1. COC7 技能检定与房规判定算法

* **出目与成功度阶梯**：
  - 出目 1：大成功（Critical Success）。
  - 出目 $\le \lfloor \text{技能值}/5 \rfloor$：极难成功（Extreme Success）。
  - 出目 $\le \lfloor \text{技能值}/2 \rfloor$：困难成功（Hard Success）。
  - 出目 $\le \text{技能值}$：常规成功（Regular Success）。
  - 出目 $> \text{技能值}$：失败（Failure）。
  - 大失败（Fumble）：技能值 $< 50$ 时出目 $\ge 96$；技能值 $\ge 50$ 时出目为 $100$。
* **奖励骰与惩罚骰（Bonus/Penalty Dice）投掷算法**：
  - **规则书机制**：投掷 1 个个位数骰（0~9）与 $1 + |B|$ 个十位数骰（00~90），组合后取最小值（奖励骰）或最大值（惩罚骰），00+0 视作 100。
  - **SealDice 实现**：支持通过 `ra b2 侦查` 等指令直接解析多颗奖惩骰并计算全部十位组合。
  - **DiceFunc 实现**：在 `performCocCheck` 中严格实现了标准十位/个位拆分逻辑：
    ```typescript
    const extraCount = Math.min(Math.abs(bonusDice), 2);
    const unit = await random.integer(0, 9);
    for (let i = 0; i <= extraCount; i++) {
      const tens = await random.integer(0, 9);
      const total = tens === 0 && unit === 0 ? 100 : tens * 10 + unit;
      outcomes.push(total);
    }
    rollTotal = bonusDice > 0 ? Math.min(...outcomes) : Math.max(...outcomes);
    ```
* **房规分支算法（House Rules）**：
  - **SealDice**：内置完整的房规模式 0~5 及 Delta Green（`dg`），可通过 `.setcoc` 自由切换大成功/大失败区间。
  - **DiceFunc**：`check.ts` 领域模型中定义了 `HouseRules` 接口（`baseDifficulty`, `dgModifier` 等），但在当前应用服务层 `checkHandler` 中尚未接入持久化配置读取，默认运行于规则书标准规（Rule 0）。

#### 2. DND5e 战斗轮与属性豁免算法

* **属性调整值公式**：$\text{Modifier} = \lfloor (\text{Attribute} - 10) / 2 \rfloor$。两者完全一致。
* **先攻轮管理算法**：
  - **SealDice**：将先攻列表序列化至群配置，支持无行动者剔除、自动倒序排序。
  - **DiceFunc**：领域对象 `CombatEncounterState`，先攻值按降序自动插入排序；实现了严密的 `advanceTurn()` 状态机（轮次 `round` 递增、`turnIndex` 环形递进与轮次跨越标记 `roundAdvanced`）。
* **生命值与护盾吸收算法 (HP & TempHP)**：
  - **扣血机制**：受到伤害时，**优先扣减临时生命值（TempHP）**，临时生命扣减至 0 后的剩余有效伤害再扣减当前 HP。
  - **回血机制**：加血时最大不能超过设定上限 `MaxHP`。两者算法逻辑完全对齐。

---

### 2.4 角色属性与动态计算属性算法

| 特性 | SealDice-Core (`AttrsManager`) | DiceFunc (`sheet.ts`) |
| :--- | :--- | :--- |
| **底层数据结构** | `model.AttributesItemModel`，单表存储 BLOB 序列化键值对，按 `Group:xxx-User:yyy` 隔离。 | D1 关系表 `character_sheets` + 内存不可变对象 `CharacterSheet`。 |
| **动态计算属性 (Computed Properties)** | **支持**：可将公式注册为属性（如 `敏捷调整值 = (敏捷-10)/2`），读取时通过 dicescript 实时动态求值。 | **暂未实现**：仅存储确定性的 `Record<string, number>` 数值属性映射。 |
| **角色档案库体系** | 完备的独立角色库：`.pc new / tag / untag / save / load / list`，多群间自由解绑与跨群拉取。 | 实现了基础的 `.pc new`、`.pc untag` 与 `.pc list`，尚未实现 `.pc save / load` 命名快照机制。 |
| **自动群名片联动** | 支持 `autoSetNameTemplate`（如 `<玩家>_HP<hp>/<maxhp>`），属性变更自动通过平台 API 修改群名片。 | 不主动调用第三方群名片修改 API（仅修改本地会话显示名），避免风控与接口权限不足。 |

---

### 2.5 牌堆抽取与带权抽样算法

* **SealDice 牌堆引擎**：
  - 兼容 `Dice!` 格式及“塔系”牌堆，支持 JSON / YAML 嵌套抽取；
  - 词条支持递归引用（例如 `{%抽取武器%} 造成 {%1d6%} 点伤害`），在展开时二次求值表达式。
* **DiceFunc 牌堆引擎**：
  - 基于 `DeckSession` 的无放回抽样机制，存储于 D1；
  - **带权抽取算法**：
    $$\text{Target} = \text{random}(1, \sum_{c \in \text{Remaining}} \text{Weight}(c))$$
    通过前缀和累加扫描命中区间，抽取后使用 `Array.splice` 将卡牌移出当前会话剩余池，直至牌堆耗尽必须手动 `.deck reset`。

---

## 3. 全指令分类详细对比清单

### 分类 A：核心掷骰指令群 (.r, .rd, .roll, .rh, .rx)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.r` / `.rd` / `.roll`** | 1. 支持标准表达式（如 `3d6+2`、`1d20+2d6+5`）；<br>2. 支持多轮重复（`3#r 1d20`）；<br>3. 支持优劣势与极值丢弃（`d20优势`, `4d6k3`）；<br>4. 支持原因文本（`.r 1d20 力量`）。 | 1. 基于 Pratt 解析器支持标准与复合多项式（`3d6+2`、`d20+d10+d4`）及括号嵌套；<br>2. 支持多轮重复（`3#` 前缀）及原因标注；<br>3. 支持 `kh/kl/dh/dl` 与中文 `优势/劣势/優勢/劣勢` 标记；`d20优势`、`d优势` 按 2 骰取高处理，劣势对应取低；<br>4. 对齐 SealDice 兼容模式：`.rd20`、`.rd20+d10+d4` 等无空格形式自动补回前导 `d`，`.rd 20` 按默认面骰并附带原因；<br>5. 执行消耗计入 `context.budget` 预算桶。 | 核心表达式能力已对齐（本地 runtime 测试验证，云端表现以重新部署后为准）。 |
| **`.rh` / `.rhd` / `.rdh` (暗骰)** | 群内执行后只提示“进行了暗骰”，掷骰结果通过私聊发送给指令发送者；私聊失败不在群内公开结果。 | 已注册 `.rh`、`.rhd`、`.rdh`。C2C 内直接返回暗骰结果；群聊通过 `.rhbind` 建立群成员与 C2C 用户的可信绑定：用户先启用主动消息并在 C2C 获取 10 分钟有效的一次性令牌，再到目标群消费令牌。绑定后，结果先以主动 C2C 消息发送，群内仅按实际投递状态报告成功或失败；`.rhbind off` 可撤销绑定。 | 相比 SealDice 自动使用平台身份，QQ 场景需要用户显式完成一次可信绑定。绑定挑战以 SHA-256 摘要校验，令牌消费后立即失效；`C2C_MSG_RECEIVE` / `C2C_MSG_REJECT` 只用于同步提示状态，不能作为硬拦截依据，主动发送 API 的实际响应才是最终判断。私聊失败时结果不会回落到群内。绑定、撤销、授权事件缺失、主动发送和条件通知已通过本地 runtime 与 workerd/D1 集成测试，真实 QQ 权限和云端投递仍待部署验证。 |
| **`.rx` / `.rxh` (高级掷骰)** | 强制启用 dicescript V2 高级语法解析，支持复杂的变量读写与脚本表达式。 | **未实现**。 | DiceFunc 未引入通用脚本虚拟机。 |

---

### 分类 B：会话管理与机器人控制 (.bot, .set, .dismiss, .botlist)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.bot`** | `.bot on` / `.bot off` 开启或关闭服务。关闭时除管理指令和 help 外不响应任何消息。 | `.bot on` / `.bot off`。写入 D1 `conversation-settings` 更新 `enabled` 状态。非开启状态拒绝常规指令。 | **对齐**。权限判定要求 `isGroupHost` 或 `isDiceMaster`。 |
| **`.set`** | 1. `.set <面数>`：设置群默认面数；<br>2. `.set <coc/dnd>`：一键切换群规则并切换伴随扩展；<br>3. `.set clr`：恢复系统默认面数。 | 仅支持固定子命令语法：<br>1. `.set rule <coc7\|dnd5e>`；<br>2. `.set sides <number>`。 | SealDice 语法更宽松（支持直接 `.set 20` 或 `.set dnd`），DiceFunc 要求提供两段式参数。 |
| **`.dismiss`** | 机器人退出当前群聊。为防止误触，默认要求必须同时 @ 机器人。 | **未实现**。 | DiceFunc 不建设自动退群功能（云端无常驻退群管理诉求）。 |
| **`.botlist`** | `.botlist add/del/show @A` 登记其他机器人，避免消息死循环。 | **未实现**。 | QQ 官方机器人平台机制已天然隔离 Bot 互发消息。 |

---

### 分类 C：身份标识与名片指令 (.userid, .nn)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.userid` / `.id`** | 输出发送者与当前群聊在通讯平台的统一标识符（UniformID，如 `QQ:12345`、`QQ-Group:67890`）。 | 输出当前发送者的 `externalId`、会话 ID、Bot ID 以及场景类型（`groupAt` / `c2c`）。 | **对齐**。主要用于排障与管理员权限授权。 |
| **`.nn` / `.nick`** | 1. `.nn <昵称>`：修改群名片；<br>2. 若配置了 `autoSetNameTemplate` 则动态重算名片；<br>3. `.nn` 查看当前昵称；<br>4. `.nn clr` 重置名片。 | 1. `.nn` 查看当前显示名；<br>2. `.nn <昵称>` 绑定并保存到当前角色卡 `CharacterSheet.name`；<br>3. `.nn clr` 重置为原始用户名。 | SealDice 会实际调用 QQ OpenAPI 变更群名片，DiceFunc 仅在服务内部维护角色卡显示名，不修改外部名片。 |

---

### 分类 D：COC7 克苏鲁跑团指令群 (.ra, .rc, .setcoc, .sc, .ti, .li, .en, .coc)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.ra` / `.rc` / `.check`** | 1. 支持 `.ra 力量` 或 `.ra 70 力量`；<br>2. 支持奖惩骰 `.ra b1 侦查`；<br>3. 根据房规（0~5/dg）自动输出大成功、极难、困难、常规、失败、大失败。 | 1. 支持 `.ra 技能名`、`.ra 技能名 目标值`；<br>2. 支持 `b1/b2/p1/p2` 奖惩骰解析；<br>3. 严格实现了 7 版标准规的 6 级成功度判定。 | **核心判定算法一致**。DiceFunc 尚未支持房规模式动态配置。 |
| **`.rah` / `.rch`** | 暗中技能检定，结果私聊发送。 | **未实现**。 | 暂缓。 |
| **`.setcoc`** | 切换群 COC 房规（0:标准, 1:常用, 2:大失败拓展, 3:严格, 4:无大成功, 5:老版, dg:三角洲）。 | **未实现**（代码内预留了数据结构，无处理函数与存储流）。 | 待支持。 |
| **`.sc` (理智检定)** | `.sc <成功扣除>/<失败扣除>`，如 `.sc 1/1d6`。自动进行 SAN 检定，扣除 SAN 值，若单次扣减 $\ge 5$ 触发临时发疯警示，若累计扣除 $\ge 1/5$ 触发不定性发疯警示。 | **未实现**。 | 核心 TRPG 机制缺失，需优先补全。 |
| **`.ti` / `.li` (发疯症状)** | `.ti` 抽取短期发疯症状表（1D10 轮）；`.li` 抽取长期总结性发疯症状表。 | **未实现**。 | 待作为内置牌堆或规则资源接入。 |
| **`.en` (技能成长)** | `.en <技能名>`：投掷 1D100，若出目 $>$ 当前技能值或出目 $> 95$，则判定成长成功，自动掷 1D10 增加技能点数并写回角色卡。 | **未实现**。 | 待支持。 |
| **`.coc` (制卡)** | `.coc [套数]`：按照 7 版公式批量生成候选人属性：<br>- 3D6*5: STR/CON/DEX/APP/POW/LUK<br>- (2D6+6)*5: SIZ/INT/EDU<br>- 计算 HP/MP/SAN/MOV/DB/体格。 | `.coc [套数]`（上限 10 套）：<br>完全按照上述公式生成，单套卡完整展示属性明细与衍生数值，批量卡紧凑展示总分。 | **完全对齐**。数学公式与展示逻辑一致。 |

---

### 分类 E：DND5e 龙与地下城指令群 (.ra, .rc, .ri, .init, .hp, .ss, .longrest, .ds, .dnd)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.ra` / `.rc` (DND 模式)** | 根据角色属性推算调整值 $\lfloor(Attr-10)/2\rfloor$，叠加热练加值，掷 1D20 与 DC 对比判定成功/失败。 | 会话规则切换为 `dnd5e` 时，`.ra <属性/技能> [DC]` 自动计算属性调整值并计算 $1D20 + \text{Mod}$ 是否达到 DC。 | **对齐**。基础检定逻辑一致。 |
| **`.ri` / `.init` (先攻轮)** | 1. `.ri [修正]` 掷 $1D20+敏捷调整值$ 加入列表；<br>2. `.init` 降序查看列表；<br>3. `.init set / del / clr` 增删改清空。 | 1. `.init` / `.ri` 投掷先攻自动加入排序；<br>2. `.init list` 查看当前轮次与当前行动者；<br>3. `.init next` 推进回合与轮次；<br>4. `.init set / end / clr` 重置与手动设定。 | **DiceFunc 增强了 `.init next` 回合轮转推进状态机**，比 SealDice 原版先攻更具结构化。 |
| **`.hp` (生命管理)** | 1. `.st hp` / `.hp`：查看当前生命；<br>2. 临时生命（TempHP）优先抵扣；<br>3. 治疗上限保护，穿透护盾保护。 | 1. `.hp` 查看；<br>2. `.hp -<伤害>` 扣血（优先吸收 TempHP）；<br>3. `.hp +<治疗>` 加血（不超过 MaxHP）；<br>4. `.hp temp <值>`、`.hp max <值>` 设定。 | **完全对齐**。核心算法与护盾吸收模型一致。 |
| **`.ss` / `.spell` (法术位)** | `.ss` 查看 1~9 环法术位；`.cast <环阶>` 消耗法术位。 | 1. `.ss` 查看法术位状态（如 `1环: 3/4`）；<br>2. `.ss use <环阶> [数量]` 消耗法术位；<br>3. `.ss set <环阶> <总数>` 设定上限。 | **基本对齐**。语法略有差异（`.ss use` vs `.cast`）。 |
| **`.longrest` / `.rest` (长休)** | HP 回满、临时生命清空、死亡豁免重置、全部法术位恢复。 | 执行长休：HP 重置为 MaxHP，TempHP 清空为 0，1~9 环所有已用法术位清零恢复。 | **完全对齐**。 |
| **`.ds` (死亡豁免)** | 掷 1D20：出目 $\ge 10$ 成功，$< 10$ 失败；出目 20 回复 1HP，出目 1 计两次失败；3 次成功伤势稳定，3 次失败角色死亡。 | **未实现**。 | 待补齐。 |
| **`.dnd` / `.dndx` (制卡)** | 4D6 剔除 1 个最低值（4D6k3），生成 6 组属性。`.dnd` 为自由分配，`.dndx` 为预设对应力量/体质/敏捷等属性。 | 完全实现：<br>1. `.dnd [数量]`：生成 6 组自由分配点数并求和；<br>2. `.dndx [数量]`：直接映射生成 6 项核心属性并展示总分。 | **完全对齐**。算法严格遵循 4D6 丢弃最低值规则。 |

---

### 分类 F：跨规则角色卡管理指令群 (.st, .pc)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.st` (属性管理)** | 1. 批量设置：`.st 力量70 敏捷60 hp10`；<br>2. 表达式修改：`.st hp+1d4`、`.st 理智-3`；<br>3. 代骰：`.st hp-5 @张三`；<br>4. 查看与过滤：`.st show`、`.st show 50`；<br>5. 动态联动群名片。 | 1. 支持无分隔符批量录入、COC7 中英文别名归一化，并按实际写入属性数简短汇总；<br>2. 支持整数与骰点表达式加减：`.st HP+2`、`.st hp+1d4`；<br>3. 支持 `.st clr`、`.st rm 力量`、`.st show` 与指定属性展示。 | **差异**：<br>1. 不支持代骰 `@他人`；<br>2. 不支持计算属性联动；<br>3. 不联动第三方平台群名片。 |
| **`.pc` (角色档案)** | 1. `.pc new <卡名>` 创建；<br>2. `.pc tag <卡名>` 绑定到当前群；<br>3. `.pc untagAll` 解除所有绑定；<br>4. `.pc save / load` 手动快照与载入；<br>5. `.pc list` 查看名下全量卡片及其群绑定关系。 | 1. `.pc new <卡名>` 创建并绑定当前会话；<br>2. `.pc untag` 解除当前会话绑定；<br>3. `.pc list` 查看当前会话绑定的卡。 | DiceFunc 目前仅支持会话级的一对一卡片绑定与解绑，**缺少全局角色库持久化快照（save/load）与多群共享切换能力**。 |

---

### 分类 G：牌堆与自定义回复指令群 (.draw, .deck, 规则回复)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.draw` (抽牌)** | 1. `.draw <牌堆名>` 抽取词条；<br>2. 支持带权抽样；<br>3. 支持嵌套牌堆引用与掷骰宏递归解析；<br>4. `.draw search <关键词>` 检索牌堆。 | 1. `.draw [牌堆名] [张数]`，默认塔罗牌；<br>2. 实现了完整的带权无放回抽样；<br>3. 抽取结果从当前会话的 `DeckSession` 移除并递减计数。 | **DiceFunc 尚未支持牌堆内的嵌套词条递归展开宏（如 `{%1d6%}`）**。 |
| **`.deck` (牌堆管理)** | 1. `.deck list` 展示所有牌堆；<br>2. `.deck reload` 从磁盘热重载牌堆；<br>3. 支持 WebUI 上传与删除牌堆。 | 1. `.deck list` 列出内置牌堆与牌数；<br>2. `.deck reset [牌堆名]` 洗牌重置当前会话的抽牌会话状态。 | DiceFunc 采用配置包预编译入库，无需本地文件重载命令。 |
| **自定义回复系统** | `ext_reply`：支持 Exact、Contains、Regex、Prefix、Suffix、MultiMatch（all/any）、表达式判断（`exprTrue`），支持私聊/群聊回发或纯脚本执行。 | `matchCustomReply`：按优先级扫描，支持 Exact、Contains、Prefix、Suffix、文本长度过滤（Min/Max），命中后返回预设模板。 | DiceFunc 满足常规关键词与问答回复，但不支持复杂正则和代码表达式匹配。 |

---

### 分类 H：跑团故事日志指令群 (.log)

| 指令 | SealDice-Core 规范与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.log new`** | 创建并开启日志记录。 | 创建并初始化状态为 `recording` 的日志模型写入 D1。 | **对齐**。 |
| **`.log on` / `.log off`** | `.log on` 恢复记录；`.log off`（或 `.log pause`）暂停记录。 | 支持 `.log on` / `.log start` / `.log resume` 与 `.log off` / `.log pause`，更新 D1 状态。 | **对齐**。 |
| **`.log end` / `.log stop`** | 终结记录，生成 HTML/TXT 排版文件并**自动上传至 SealDice 跑团日志公共平台**，返回分享外链。 | 将日志标记为 `closed`，按 SealDice 启停边界冻结包含 `.log end` 的双向记录，并将 SealDice TXT 分片写入私有 R2。 | 记录内容与 TXT 排版对齐；SealDice 使用公共平台，DiceFunc 使用私有对象存储与短时授权下载。 |
| **`.log stat`** | 统计日志总字数、掷骰总次数、极值出目分布（大成功/大失败榜单）、活跃玩家排行榜。 | 展示当前或最近日志的记录状态与归档可用状态。 | **DiceFunc 缺乏日志明细的聚合统计分析算法**。 |
| **`.log export`** | 导出文本文件或通过配置的 SMTP 发送邮件附件。 | 群主或骰主可申请 256-bit、15 分钟有效的签名链接，下载 SealDice TXT 归档。 | 文本交付格式对齐；DiceFunc 不提供 SMTP 邮件发送，访问方式为私有短时链接。 |

---

### 分类 I：小众规则与扩展骰点指令群 (.ww, .rsr, .dx, .ek, .drl, .who)

| 指令 | 所属规则 / 功能 | SealDice-Core 实现 | DiceFunc 当前实现 |
| :--- | :--- | :--- | :--- |
| **`.ww` / `.w`** | 黑暗世界 (WOD) / 无限流 | 支持 `10a10m10k8` 骰池、加骰线、成功线计算与群默认设定。 | **未实现**。 |
| **`.rsr`** | 暗影狂奔 (Shadowrun) | 投掷 N 个 D6，统计 5 和 6 成功度，结算失误与严重失误。 | **未实现**。 |
| **`.dx`** | 双十字 (Double Cross) | 暴击递进加骰（`8c7`），出目达到暴击值连续滚动追加。 | **未实现**。 |
| **`.ek` / `.ekgen`**| 共鸣性怪异 (Emoklore) | 能力值与技能倍率检定；一键生成符合规则的角色卡。 | **未实现**。 |
| **`.drl` / `.drlh`** | 轮盘抽签 | Fisher-Yates 无放回随机抽签轮盘；支持暗抽。 | **未实现**。 |
| **`.who`** | 决策辅助 | `.who A B C` 随机打乱重排候选人列表。 | **未实现**。 |

---

### 分类 J：趣味娱乐与辅助工具指令群 (.name, .jrrp, .gugu, .ping, .send, .modu, .check)

| 指令 | 功能说明 | SealDice-Core 实现 | DiceFunc 当前实现 |
| :--- | :--- | :--- | :--- |
| **`.name` / `.namednd`** | 随机角色取名 | 抽取内置中、英、日姓名库，或 DND 各种族姓名表。 | **未实现**（设计已规划作为配置资源接入，代码尚未挂载指令）。 |
| **`.jrrp`** | 今日人品 | 基于**日期盐值 + 用户 UniformID** 进行 SHA-256 散列取模生成每日固定的 1~100 人品值。 | **未实现**。 |
| **`.gugu`** | 跑团请假借口 | 随机抽取跑团鸽子借口库文本。 | **未实现**。 |
| **`.ping`** | 网络探活 | 测试机器人网络连通性与往返延迟。 | **未实现**（DiceFunc 提供 HTTP `/health` 探活端点）。 |
| **`.send`** | 骰主留言 | 向 Master 留言，支持触发 SMTP 邮件告警。 | **未实现**。 |
| **`.modu` / `魔都`** | 跑团模组查询 | 在线调用魔都模组网 API 检索模组详情。 | **未实现**。 |
| **`.check`** | 官方防伪校验 | 生成带有官方私钥签名的身份核验码，官网可查。 | **不迁移**（DiceFunc 不冒用 SealDice 官方身份，由 `.about` 提供元数据）。 |

---

### 分类 K：系统管理与运维配置指令群 (.master, .black, .randalgo, .help, .find)

| 指令 | SealDice-Core 实现与算法 | DiceFunc 当前实现与算法 | 差异与缺失分析 |
| :--- | :--- | :--- | :--- |
| **`.help` / `.find`** | 1. `.help` 查看命令指南；<br>2. 集成 **Bluge 倒排检索内核**，`.find <词条>` 全文检索规则百科并进行相关度打分展示。 | 提供硬编码的 `.help` 命令列表展示。 | DiceFunc 未引入全文检索引擎；设计规划为小型规则词条索引有界搜索。 |
| **`.master`** | 骰主控制台：密码解锁、热重载配置/牌堆/JS、远程触发备份与重启。 | **无此指令**。 | DiceFunc 采用 Serverless 架构，无常驻进程需重启，配置发布走 CI/CD 与 KV 静态分发。 |
| **`.black` / `.ban`** | 黑名单管理：信誉分增减、拉黑、信任名单。触碰敏感词或封禁阈值自动全局退群拉黑。 | 系统底层支持 `denied` 与 `isTrusted` 权限过滤，但尚未暴露群内动态管理的 `.ban` 交互指令。 | 待完善交互层。 |
| **`.randalgo`** | 查看当前全局随机数模式，现场对 5 种算法执行并发采样基准测试并切换模式。 | **未实现**。 | DiceFunc 算法已固定为密码学 Web Crypto + 拒绝采样，无需切换模式。 |

---

## 4. 状态持久化、并发控制与事务一致性对比

在指令背后引起的数据变更（扣血、消耗法术位、抽牌、改卡、开闭日志）上，两者的并发保证机制截然不同：

### SealDice-Core
- **模型**：单机有状态服务，内存作为一级权威源。
- **并发策略**：依赖 Go 进程内 `sync.RWMutex` 锁保护临界区；
- **持久化**：定时或操作后通过 ORM（GORM）向 SQLite / PostgreSQL / MySQL 异步或同步写入。在分布式多实例部署时需要外部强协调机制，否则存在脑裂风险。

### DiceFunc
- **模型**：Serverless 无状态单向数据流。
- **并发策略**：**基于 Cloudflare D1 关系型数据库的乐观并发控制（OCC）**。
- **数据不变量与一致性保障**：
  每一个状态更新（`StateUpdate`）都必须携带 `expectedVersion` 与 `newVersion`：
  ```sql
  UPDATE character_sheets
  SET version = ?, attributes = ?, updated_at = ?
  WHERE id = ? AND version = ?;
  ```
  在 Cloudflare Workers D1 批量事务中，如果同一时间发生并发指令冲突（例如两名玩家在同一毫秒对同一张卡执行 `.st hp-5`），版本检查将触发回滚，杜绝数据被脏覆盖。这在高并发群聊场景下具有更高的可靠性。

---

## 5. 综合对比评估矩阵与演进路线

### 5.1 能力成熟度矩阵 (Capability Maturity Matrix)

```
能力维度                SealDice-Core        DiceFunc (当前)      对齐度
────────────────────────────────────────────────────────────────────────
接入生态多平台          ★★★★★ (15+协议)      ★★☆☆☆ (QQ Webhook)   40%
执行环境隔离度          ★★☆☆☆ (单机进程)      ★★★★★ (Edge Sandbox) 200%
骰点语法完整度          ★★★★★ (RollVM 图灵)  ★★☆☆☆ (单行正则)      40%
随机数密码学强度        ★★★★★ (5源混合矩阵)  ★★★★☆ (WebCrypto拒绝) 90%
COC7 规则完整度         ★★★★★ (房规+理智+成长) ★★★☆☆ (标准检定+制卡) 60%
DND5e 规则完整度        ★★★★☆ (先攻+法术位)   ★★★★☆ (结构化战斗轮)  85%
角色卡与动态计算        ★★★★★ (计算属性+多卡)  ★★★☆☆ (数值属性+单卡) 60%
牌堆系统扩展性          ★★★★★ (递归宏+多格式) ★★★☆☆ (带权无放回)    60%
跑团日志全生命周期      ★★★★★ (云端平台直传)  ★★★☆☆ (D1流转+R2归档) 60%
风控、审查与限流        ★★★★★ (拼音Trie+令牌) ★☆☆☆☆ (基础权限白名单) 20%
运维与热升级复杂度      ★★★☆☆ (人工升级+备份) ★★★★★ (Serverless免运维)180%
────────────────────────────────────────────────────────────────────────
```

### 5.2 核心演进路线与补齐优先级 (Roadmap)

根据对比发现的关键缺口，建议按以下优先级推进后续开发：

1. **P1 核心跑团指令补齐（高频必需）**：
   - 实现 `.sc`（理智检定，包含单次 $\ge 5$ 与累计 $\ge 1/5$ 临时/不定性发疯判定）；
   - 实现 `.ti` / `.li` 发疯症状抽表指令；
   - 实现 `.en` 技能成长检定；
   - 补齐 DND5e 死亡豁免 `.ds`。
2. **P2 骰点表达式解析器重构（已完成）**：
   - 已废除单行 `DICE_REGEX`，改用 Tokenizer + **Pratt Parser**；
   - 已支持复合多项式（`1d20+2d6+5`）、括号嵌套（`3*(1d6+2)`）以及中文“优势/劣势”关键词原生解析。
3. **P3 角色库与属性计算升级**：
   - 增强 `.st`，支持带骰点表达式加减（如 `.st hp+1d4`）；
   - 完善 `.pc` 独立角色档案库体系（支持 `.pc save <卡名>` 与 `.pc load <卡名>`）。
4. **P4 规则百科与检索**：
   - 引入轻量级有界规则搜索，支持 `.find <关键词>` 检索 COC/DND 核心规则释义。
