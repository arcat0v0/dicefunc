# SealDice-Core 功能架构与全特性深度技术手册

---

## 目录

1. [系统总体架构与数据流](#1-系统总体架构与数据流)
2. [多通讯平台适配器矩阵 (Platform Adapters)](#2-多通讯平台适配器矩阵-platform-adapters)
3. [骰点核心与语法虚拟机 (PEG & dicescript)](#3-骰点核心与语法虚拟机-peg--dicescript)
4. [内置 TRPG 规则系统与指令全集](#4-内置-trpg-规则系统与指令全集)
5. [跨规则角色卡管理与属性引擎 (AttrsManager)](#5-跨规则角色卡管理与属性引擎-attrsmanager)
6. [JavaScript 插件系统与运行时沙箱 (JS VM)](#6-javascript-插件系统与运行时沙箱-js-vm)
7. [扩展包体系与扩展商店 (SealPack & Store)](#7-扩展包体系与扩展商店-sealpack--store)
8. [跑团日志全生命周期与故事记录 (Story Log)](#8-跑团日志全生命周期与故事记录-story-log)
9. [智能牌堆系统与自定义回复 (Deck & Custom Reply)](#9-智能牌堆系统与自定义回复-deck--custom-reply)
10. [风控防封、敏感词审查与信誉黑名单 (Censor, Ban & RateLimit)](#10-风控防封敏感词审查与信誉黑名单-censor-ban--ratelimit)
11. [Bluge 倒排检索与规则百科手册 (DocEngine & Help)](#11-bluge-倒排检索与规则百科手册-docengine--help)
12. [多源密码学高安全随机数矩阵 (Randomness)](#12-多源密码学高安全随机数矩阵-randomness)
13. [WebUI RESTful API 接口完整清单 (~185 个端点)](#13-webui-restful-api-接口完整清单)
14. [完整配置体系与参数树 (Config & AdvancedConfig)](#14-完整配置体系与参数树-config--advancedconfig)
15. [数据库模型与渐进式版本迁移 (Database & migrate/v2)](#15-数据库模型与渐进式版本迁移-database--migratev2)
16. [运维部署、系统服务与自动更新 (Ops & Deployment)](#16-运维部署系统服务与自动更新-ops--deployment)

---

## 1. 系统总体架构与数据流

SealDice 采用以 `DiceManager` 为全局管理容器、`Dice` 为独立骰子实例的核心分层模型。单实例内部支持并行运行多账号、多协议端点（`EndPointInfo`）。

```
+-------------------------------------------------------------------------+
|                              DiceManager                                |
|  - DatabaseOperator (SQLite / PostgreSQL / MySQL)                       |
|  - HelpManager (Bluge 倒排检索)         - NamesGenerator (姓名生成器)      |
|  - BackupManager (Cron 定时归档与轮换)   - AccessTokens (WebUI 访问令牌)   |
|  - Update/Reboot Channels (平滑热重载)   - SysTray (操作系统托盘支持)      |
+------------------------------------+------------------------------------+
                                     | 1:N
+------------------------------------v------------------------------------+
|                                Dice 实例                                |
|  - IMSession (统一消息会话中心与路由)    - Config / AdvancedConfig (配置树)  |
|  - ExtList / ExtRegistry (扩展集合)    - ActiveWithGraph (扩展伴随图)    |
|  - AttrsManager (角色属性管理器)        - CensorManager (多级敏感词审查)  |
|  - DeckList (牌堆缓存列表)             - CustomReplyConfig (自定义回复)  |
|  - JsLoopManager (Goja JS 事件循环)   - PackageManager / StoreManager   |
|  - globalRandSource (多源高质量随机池) - BanList (信誉分与黑名单)        |
+------------------------------------+------------------------------------+
                                     | 1:N
+------------------------------------v------------------------------------+
|                            EndPointInfo (端点)                          |
|  - Platform (QQ / DISCORD / KOOK / TG / MC / DODO / SLACK / SEALCHAT)   |
|  - ProtocolType (onebot / official / milky / red / satori / walle-q)   |
|  - PlatformAdapter (各协议底层通讯驱动)                                  |
+-------------------------------------------------------------------------+
```

### 消息流转全生命周期
1. **接入层接收**：`PlatformAdapter` 接收原生网络数据，转换为统一的 `Message` 与消息段 `Segment`。
2. **上下文装配**：`IMSession.ExecuteNew` 创建 `MsgContext`，自动加载所属群组 `GroupInfo`、发送者 `GroupPlayerInfo`、当前游戏系统模板 `GameSystemTemplate`。
3. **安全审查前置**：
   - `CensorManager` 按照 `CensorMode`（全部输入 / 仅指令）进行 Trie 树与拼音模糊敏感词检测。
   - `RateLimiter` 个人与群组令牌桶限流判定，阻断刷屏攻击。
   - `BanList` 检验黑名单与用户信誉分。
4. **扩展与指令分发**：
   - 优先通过 `commandExtensionOrder` 按照当前群规则系统关联优先级排序扩展。
   - 执行插件钩子 `onCommandReceived` 或普通消息钩子 `onNotCommandReceived`。
   - 匹配指令树 `CmdMap` 执行求解 `Solve(ctx, msg, cmdArgs)`。
5. **计算与文案模板化**：
   - 调用 dicescript / RollVM 计算数值表达式。
   - 提取全局与临时变量（`$t...`），通过 `DiceFormatTmpl` 进行文案转义与插值。
6. **响应发送与后处理**：
   - 触发 `onMessageSend` 最终审查。
   - 经长文本截断器 `SplitLongText` 与平台专属发送器分段下发。

---

## 2. 多通讯平台适配器矩阵 (Platform Adapters)

SealDice 通过定义统一的 `PlatformAdapter` 接口，解耦了通讯层与核心业务逻辑：

```go
type PlatformAdapter interface {
    Serve() int
    DoRelogin() bool
    SetEnable(enable bool)
    QuitGroup(ctx *MsgContext, ID string)
    SendToPerson(ctx *MsgContext, userID string, text string, flag string)
    SendToGroup(ctx *MsgContext, groupID string, text string, flag string)
    SetGroupCardName(ctx *MsgContext, name string)
    SendSegmentToGroup(ctx *MsgContext, groupID string, msg []message.IMessageElement, flag string)
    SendSegmentToPerson(ctx *MsgContext, userID string, msg []message.IMessageElement, flag string)
    SendFileToPerson(ctx *MsgContext, userID string, path string, flag string)
    SendFileToGroup(ctx *MsgContext, groupID string, path string, flag string)
    MemberBan(groupID string, userID string, duration int64)
    MemberKick(groupID string, userID string)
    GetGroupInfoAsync(groupID string)
    EditMessage(ctx *MsgContext, msgID, message string)
    RecallMessage(ctx *MsgContext, msgID string)
}
```

### 各平台特性与实现细节

| 适配器类型 | 对应协议 / 技术栈 | 核心能力与关键技术实现 |
| :--- | :--- | :--- |
| **QQ 官方机器人**<br>`PlatformAdapterOfficialQQ` | 腾讯 QQ 开放平台 OpenAPI | 1. **双连接模式**：支持全双工 WebSocket 长连接与 Webhook HTTP 接收回调；<br>2. **富媒体单元化**：匹配图片/语音/文件 CQ 码，兼容官方通过 URL 上传时的拉取时限与超时重试；<br>3. **Markdown 渲染**：支持配置 `officialQQUseMarkdown` 自动转为 Markdown 卡片；<br>4. **身份数据迁移**：内置 `officialQQIdentityMigration`，支持群 ID、用户 ID 从旧版散列字符串到最新 OpenAPI 格式的平滑映射与批量落库。 |
| **Milky 协议**<br>`PlatformAdapterMilky` | Milky-go-sdk 新一代协议 | 1. 支持内置客户端（`lagrangeV2`、`yogurt`）及独立进程部署；<br>2. 实现 `forwardMsgSender` 接口，支持原生的消息段流式发送与合并转发；<br>3. 适配完整的 `Message.Segment` 结构。 |
| **OneBot 协议**<br>`PlatformAdapterOnebot` / `PlatformAdapterGocq` | OneBot v11 标准 / Lagrange | 1. 支持正/反向 WebSocket、HTTP API；<br>2. 内置 Lagrange C# 运行时自动管理，支持扫码登录、短信验证码确认、SignServer 签名获取；<br>3. 兼容标准 OneBot 动作（群员踢出、禁言、修改群名片、撤回消息）。 |
| **Red 协议**<br>`PlatformAdapterRed` | Chronocat / QQ NT 核心协议 | 适配新版 QQ 客户端的 Red 协议，直接处理原生消息元素，低风控开销。 |
| **Satori 协议**<br>`PlatformAdapterSatori` | Satori 标准协议规范 | 支持 Satori 标准信令交互，解析并构造基于 XML-like 的富媒体元素树。 |
| **Walle-Q 协议**<br>`PlatformAdapterWalleQ` | Walle-Q 协议客户端 | 原生支持安卓协议、设备信息管理、密码直登与会话保持。 |
| **Discord**<br>`PlatformAdapterDiscord` | `bwmarrin/discordgo` | 支持服务器频道与私信、富文本 Embed 渲染、Emoji 反应、消息编辑与撤回。 |
| **Telegram**<br>`PlatformAdapterTelegram` | `telegram-bot-api/v5` | 支持官方 Bot API，支持 MarkdownV2 / HTML 转义、命令菜单过滤、超级群（Supergroup）与话题通道。 |
| **KOOK (开黑啦)**<br>`PlatformAdapterKook` | `lonelyevil/kook` | 支持 CardMessage 卡片消息、富媒体附件上传、事件信号回调与心跳监控。 |
| **Dodo**<br>`PlatformAdapterDodo` | `Szzrain/dodo-open-go` | 适配 Dodo 开放平台，支持多频道消息收发、身份组权限识别与特定频道事件。 |
| **Slack**<br>`PlatformAdapterSlack` | `slack-go/slack` | 支持 App-Level Token 与 Socket Mode 长连接交互，无需公网 IP 接收 Webhook。 |
| **钉钉 (DingTalk)**<br>`PlatformAdapterDingTalk` | `open-dingtalk/dingtalk-stream-sdk-go` | 基于企业级 DingTalk Stream 模式长连接，企业内部群与工作通知无缝推送。 |
| **Minecraft**<br>`PlatformAdapterMinecraft` | 原生 TCP 协议桥接 | 将跑团骰点指令接入 MC 服务器聊天栏，游戏内玩家聊天与掷骰双向同步。 |
| **SealChat**<br>`PlatformAdapterSealChat` | 海豹专属实时通讯协议 | 适配自研跑团专用聊天客户端，针对跑团角色状态显示优化。 |
| **WebUI 模拟端点**<br>`PlatformAdapterHTTP` | 内置 HTTP 模拟驱动 | 后台内置虚拟端点，支持在管理后台直接调试指令，具备超长文本自动分段预览能力。 |

---

## 3. 骰点核心与语法虚拟机 (PEG & dicescript)

SealDice 具备跑团业界最完善的掷骰表达式支持，经历了 V1 (PEG 文法文件) 到 V2 (dicescript 虚拟机) 的架构升级。

### 1. 表达式语法全集

```
eDice       <- wodDicePool / doubleCrossDicePool / simpleDice / ...
kqDiceOp    <- ('k' count)? ('q' count)? ('dl' count)? ('dh' count)?
dndSuffix   <- ('优势' / 'kh') | ('劣势' / 'kl')
```

- **基础掷骰**：`D20`、`1D100`、`3D6+5`、`4D10*2-1`。
- **省略面数/骰数**：`D`（默认面数，COC 为 100，DND 为 20）、`3D`（3 颗默认面数骰）。
- **极值保留与优劣势 (Keep/Drop)**：
  - `2D20优势` 或 `2D20kh1`：投掷 2D20，保留较大值（DND 优势检定）。
  - `2D20劣势` 或 `2D20kl1`：投掷 2D20，保留较小值（DND 劣势检定）。
  - `4D6k3` / `4D6dl1`：属性生成常用语法，4D6 剔除 1 个最低值。
  - `4D6dh1` / `4D6q3`：剔除 1 个最高值 / 保留 3 个最低值。
- **暗影狂奔 / WOD 骰池**：`10a10m10k8`：10 个 10 面骰，10 加骰，8 成功线。
- **双十字 (DX) 暴击骰**：`7c8`：7 颗骰子，暴击下限为 8。
- **多轮重复掷骰**：`5#r 1d20+3 攻击`：连续执行 5 轮检定，独立计算并输出明细。
- **复杂运算表达式**：四则混合运算、取模（`%`）、乘方（`^`）、位运算（`&`、`|`）、比较符（`>`、`<`、`>=`、`<=`、`==`、`!=`）、三元表达式（`cond ? a : b`）。

### 2. dicescript 虚拟机 (RollVM) 特性
- **强类型与对象系统**：支持整型（`VMTypeInt`）、浮点型（`VMTypeFloat`）、字符串（`VMTypeString`）、数组、键值表（`ValueMap`）以及延时计算属性（`VMTypeComputedValue`）。
- **执行沙箱与安全保护**：
  - 单次执行指令最大指令数限制（防止死循环）。
  - 表达式长度限制与递归深度保护。
  - 规范化错误编码：`E1: 语法错误`、`E5: 除零异常`、`E6: 作用域变量不存在`、`E7: 栈溢出` 等。

---

## 4. 内置 TRPG 规则系统与指令全集

### 1. 核心掷骰指令 (`dice/builtin_commands.go`)

| 指令 | 语法规则 | 功能详述 |
| :--- | :--- | :--- |
| **`.r` / `.rd` / `.roll`** | `.r [表达式] [原因]`<br>例：`.r 3d6+2 力量` | 标准掷骰，支持多轮（`3#r 1d20`）、优劣势、四则运算及原因标注。 |
| **`.rh` / `.rdh`** | `.rh [表达式] [原因]` | 暗骰，掷骰过程与结果通过私聊发送给本人，群内只提示已进行暗骰。 |
| **`.rx` / `.rxh`** | `.rx [表达式] [原因]` | 扩展高级掷骰，强制启用 dicescript V2 高级语法。 |
| **`.nn`** | `.nn [新昵称]` | 快速更改群内名片；若设置了自动名片模板则同步触发模板重算。 |
| **`.userid`** | `.userid` | 查询当前发送者、当前群组在平台底层的唯一标识符（UniformID）。 |
| **`.set`** | `.set [面数]`<br>`.set [dnd/coc]`<br>`.set clr` | 设置群默认骰子面数；或一键绑定群规则并自动激活对应扩展。 |
| **`.bot`** | `.bot on` / `.bot off` | 开启或关闭骰子在当前群的服务状态。 |
| **`.dismiss`** | `.dismiss`（需 @ 骰子） | 安全退出当前群聊；防止误触，群内开启时要求必须附带 @。 |
| **`.botlist`** | `.botlist add/del/show @A` | 登记群内其他机器人，阻断多机器人互相响应死循环。 |
| **`.master`** | `.master add/del/show`<br>`.master unlock [密码]`<br>`.master reload [deck/js/helpdoc]`<br>`.master backup`<br>`.master reboot`<br>`.master jsclear [插件名]` | 骰主控制台：权限授权、解锁防抢占、资源热重载、实时备份、远程重启。 |
| **`.black` / `.ban`** | `.black add/del/trust/show/query` | 黑名单管理：增删黑名单、设置信任用户、查询用户信誉状态。 |
| **`.randalgo`** | `.randalgo`<br>`.randalgo get [面数]`<br>`.randalgo set [模式]` | 查询当前随机源；对所有算法并发单次测速对比；切换全局随机模式。 |

---

### 2. 克苏鲁的呼唤第七版 (`dice/ext_coc7.go`)

- **检定指令**：
  - `.ra <属性/技能名> [表达式修改]`：标准技能检定。
  - `.rc <属性/技能名>`：房规技能检定。
  - `.rah` / `.rch`：暗中技能检定。
  - 成功度判定：
    - 出目为 1：大成功（Critical Success）。
    - 出目 ≤ 技能值/5：极难成功（Extreme Success）。
    - 出目 ≤ 技能值/2：困难成功（Hard Success）。
    - 出目 ≤ 技能值：常规成功（Regular Success）。
    - 出目 > 技能值：失败（Failure）。
    - 技能值 < 50 且出目 ≥ 96，或技能值 ≥ 50 且出目为 100：大失败（Fumble）。
- **房规系统 (`.setcoc`)**：
  - `0`：规则书标准规（大成功 1，大失败 96-100 或 100）。
  - `1`：大成功 1-5，大失败 96-100。
  - `2`：国内常用规则（大成功 1-5，大失败 96-100 且大于技能值；技能值未满 50 时 96-100 均为大失败）。
  - `3`：大成功 1-5，大失败 100。
  - `4`：大成功 1-5 且出目 ≤ 技能值，大失败 96-100 且出目 > 技能值。
  - `5`：大成功 1-2，大失败 99-100。
  - `dg`：Delta Green 规则拓展。
- **理智检定与发疯 (`.sc`, `.ti`, `.li`)**：
  - `.sc <成功扣除>/<失败扣除>`：例 `.sc 1/1d6`，根据当前 SAN 值自动检定、扣减并判断发疯。
  - 短期临时发疯判定（单次扣除 ≥ 5 点）与不定性发疯判定（一天内累计扣除 ≥ 1/5 初始值）。
  - `.ti`：抽取 1D10 轮短期疯狂症状表（失智、恐惧、假死、狂躁等）。
  - `.li`：抽取 1D10 轮总结性（长期）疯狂发作症状表。
- **技能成长检定 (`.en`)**：
  - `.en <技能名>`：投掷 1D100，出目大于当前技能值或出目 > 95 时判定成功，自动增加 1D10 点技能值并更新人物卡。
- **制卡指令 (`.coc`)**：
  - `.coc [数量]`：按 7 版 3D6*5 / (2D6+6)*5 公式批量生成 3 组至多组随机属性候选。

---

### 3. 龙与地下城第五版 (`dice/ext_dnd5e.go`)

- **属性豁免与技能检定**：
  - `.rc <属性/技能>` / `.ra <属性/技能>`：根据核心属性自动推算调整值，结合熟练加值进行 D20 检定。
  - 支持技能熟练度标记：未受训（0）、半熟练（`*0.5`）、熟练（`*`）、专精双倍（`*2`）。
- **先攻轮管理 (`.ri`, `.init`)**：
  - `.ri [修正]`：投掷 `1d20+敏捷调整值`，自动将发送者存入群先攻序列表中。
  - `.init`：展示当前群内所有参战者先攻列表，按出目降序排布。
  - `.init clr`：一键清空战斗轮。
  - `.init set <角色名> <数值>`：手动指定参战者先攻。
  - `.init del <角色名>`：将特定角色移出先攻轮。
- **生命值与 Buff 护盾体系 (`.st hp`)**：
  - 临时生命优先抵扣：扣血时系统自动检测是否存在临时 HP，优先抵扣至 0 再扣除主 HP。
  - 上限溢出保护：治疗加血不会超过 `hpmax`。
  - `--over` 标记：强制穿透护盾直接扣除基础生命值。
- **死亡豁免系统 (`.ds`, `死亡豁免`)**：
  - 掷 1D20，出目 ≥ 10 成功，< 10 失败；出目 20 回复 1 点 HP 起死回生，出目 1 累计两次失败。
  - 自动累加并持久化成功计数（DSS）与失败计数（DSF）。
  - 达到 3 次成功触发“伤势稳定”，达到 3 次失败触发“角色死亡”，并自动更新名片。
- **法术位与休息结算**：
  - `.ss` / `.法术位`：查看各环阶法术位配置与余量。
  - `.cast <环阶>`：快捷施法扣除相应环阶法术位。
  - `.longrest` / `长休`：HP 恢复满值、清空临时生命、重置全部死亡豁免标记、完全恢复法术位。

---

### 4. 扩展娱乐与小众跑团规则 (`dice/ext_fun.go` / `dice/ext_story.go`)

| 指令 | 规则 / 来源 | 功能详述 |
| :--- | :--- | :--- |
| **`.ww` / `.w`** | 黑暗世界 (WOD) / 无限流 | 骰池检定：`.ww 10a10m10k8`，支持自选加骰线、面数与成功线，支持 `.ww set` 保存群默认值。 |
| **`.rsr`** | 暗影狂奔 (Shadowrun) | 投掷 N 个 D6，统计 5 和 6 成功度，自动结算“失误”与“严重失误”。 |
| **`.dx`** | 双十字 (Double Cross) | 暴击递进判定：`.dx 8c7`，实现出目达到暴击值时的连续滚动加骰。 |
| **`.ek` / `.ekgen`**| 共鸣性怪异 (Emoklore) | 依据能力值与技能倍率判定；`.ekgen` 自动生成符合规则的人物数据。 |
| **`.drl` / `.drlh`** | 轮盘抽签 | Fisher-Yates 无放回随机抽签骰池；`.drlh` 支持暗抽。 |
| **`.who`** | 决策辅助 | `.who A B C` 随机乱序重排候选人列表。 |
| **`.name` / `.namednd`** | 跑团角色命名 | 抽取内置中、英、日姓名库，或 DND 种族（达马拉人、卡林珊人、精灵、矮人等）姓名库。 |
| **`.modu` / `魔都`** | 模组检索 | 在线调用魔都跑团模组网 API，实现模组搜索、作者查询、编辑推荐浏览与编号提取。 |
| **`.jrrp`** | 趣味娱乐 | 基于日期特征盐与用户 UniformID 散列生成每日固定 D100 人品值。 |
| **`.gugu`** | 趣味娱乐 | 随机生成跑团鸽子请假幽默借口。 |
| **`.ping`** | 探活测试 | 验证机器人网络心跳与当前响应延迟。 |
| **`.send`** | 骰主留言 | 向 Master 留言，支持触发 SMTP 邮件直推。 |
| **`.welcome`** | 入群迎新 | 开启/关闭群欢迎语，自定义迎新辞文案。 |
| **`.check`** | 防伪认证 | 生成带有当前平台与用户标识的官方签名校验码，可在官网核验官方海豹身份。 |

---

## 5. 跨规则角色卡管理与属性引擎 (AttrsManager)

### 1. 存储设计与群隔离策略
SealDice 使用 `AttrsManager` 统一管理玩家数据，底层采用统一的 `attrs` 表（`model.AttributesItemModel`）：
- **默认群隔离**：默认情况下，玩家在每个群的数据是相互独立的（卡片 ID 格式为 `Group:123-User:456`），防止玩家在 A 群的跑团数据因 B 群操作被意外污染。
- **角色库模式 (`.pc` / `.char`)**：
  - 用户可创建独立于群的专属角色档案（`OwnerId` 归属，卡片 ID 采用 nanoid 生成）。
  - `.pc new <角色名>`：创建空白角色并绑定到当前群。
  - `.pc tag [<角色名>]`：将指定角色卡绑定到当前群组。
  - `.pc untagAll`：一键解除该角色在所有群组的绑定状态。
  - `.pc save` / `.pc load`：手动快照保存与拉取。
  - `.pc list`：查看自己名下的所有角色档案及其在各个群的绑定关系。

### 2. 属性存取与动态计算
- **基础属性**：纯数值或字符串，持久化存储于 JSON/MessagePack 数据包。
- **动态计算属性 (Computed Property)**：支持嵌套公式（例如 DND5E 的属性调整值 `(力量-10)/2`，技能值 `敏捷调整值+熟练加值`）。当基础属性变动时，相关计算属性在读取时自动重算。
- **属性操作语法 (`.st`)**：
  - 批量录入：`.st 力量:70 敏捷:60 体质:50 hp:10`（支持冒号与等号）。
  - 表达式修改：`.st hp+1d4`、`.st 理智-3`。
  - 代理代骰：`.st hp-5 @张三`（需群管理或授权）。
  - 查看与导出：`.st show` 查看全部属性，`.st show 50` 仅展示大于 50 的技能，`.st export` 导出属性文本。
  - 自动群名片联动：支持配置 `autoSetNameTemplate`（如 `{$t玩家}_{$t卡名}_HP{$thp}/{$thpmax}`），任何属性变动即刻自动修改用户群名片。

---

## 6. JavaScript 插件系统与运行时沙箱 (JS VM)

基于 Goja 引擎打造，配合 Node.js 兼容层与事件循环（EventLoop），支持异步操作与第三方通信。

### 1. 插件生命周期事件钩子 (Hooks)

```javascript
let ext = seal.ext.new('demo', 'Author', '1.0.0');

// 插件装载
ext.onLoad = function() { console.log('Loaded'); };

// 接收到任何消息
ext.onMessageReceived = function(ctx, msg) { };

// 接收到非指令聊天
ext.onNotCommandReceived = function(ctx, msg) { };

// 接收到指令
ext.onCommandReceived = function(ctx, msg, cmdArgs) { };

// 发送消息前拦截过滤
ext.onMessageSend = function(ctx, msg, flag) { };

// 群组相关事件
ext.onGroupJoined = function(ctx, msg) { };        // 骰子进群
ext.onGroupMemberJoined = function(ctx, msg) { };  // 新成员入群
ext.onGroupLeave = function(ctx, event) { };       // 骰子被踢或主动退群
ext.onPoke = function(ctx, event) { };             // 戳一戳响应
ext.onMessageDeleted = function(ctx, msg) { };     // 消息撤回
ext.onMessageEdit = function(ctx, msg) { };        // 消息编辑
```

### 2. `seal.*` 核心 API 规范

```typescript
declare namespace seal {
  // 扩展管理
  namespace ext {
    function new(name: string, author: string, version: string): ExtInfo;
    function register(ext: ExtInfo): void;
    function find(name: string): ExtInfo;
    function newCmdItemInfo(): CmdItemInfo;
    function newCmdExecuteResult(solved: boolean): CmdExecuteResult;
    // 配置项注册（WebUI 面板自动渲染）
    function registerStringConfig(ext: ExtInfo, key: string, defaultValue: string, desc: string, group?: string): void;
    function registerIntConfig(ext: ExtInfo, key: string, defaultValue: number, desc: string, group?: string): void;
    function registerBoolConfig(ext: ExtInfo, key: string, defaultValue: boolean, desc: string, group?: string): void;
    function registerFloatConfig(ext: ExtInfo, key: string, defaultValue: number, desc: string, group?: string): void;
    function registerTemplateConfig(ext: ExtInfo, key: string, defaultValue: string[], desc: string, group?: string): void;
    function registerOptionConfig(ext: ExtInfo, key: string, defaultValue: string, options: string[], desc: string, group?: string): void;
    // 定时任务
    function registerTask(ext: ExtInfo, taskType: 'cron' | 'interval', value: string, fn: (taskCtx: any) => void, key: string, desc: string, group?: string): void;
  }

  // 变量存取
  namespace vars {
    function intGet(ctx: MsgContext, key: string): [number, boolean];
    function intSet(ctx: MsgContext, key: string, val: number): void;
    function strGet(ctx: MsgContext, key: string): [string, boolean];
    function strSet(ctx: MsgContext, key: string, val: string): void;
    function computedGet(ctx: MsgContext, key: string): [string, boolean];
    function computedSet(ctx: MsgContext, key: string, expr: string): void;
  }

  // 黑名单与信任
  namespace ban {
    function addBan(ctx: MsgContext, id: string, place: string, reason: string): void;
    function addTrust(ctx: MsgContext, id: string, place: string, reason: string): void;
    function remove(ctx: MsgContext, id: string): void;
    function getList(): BanListInfoItem[];
    function getUser(id: string): BanListInfoItem | null;
  }

  // 消息发送与操作
  function replyGroup(ctx: MsgContext, msg: Message, text: string): void;
  function replyPerson(ctx: MsgContext, msg: Message, text: string): void;
  function replyToSender(ctx: MsgContext, msg: Message, text: string): void;
  function memberBan(groupId: string, userId: string, duration: number): void;
  function memberKick(groupId: string, userId: string): void;
  
  // 模板转义与多媒体
  function format(ctx: MsgContext, tmpl: string): string;
  function formatTmpl(ctx: MsgContext, tmplName: string): string;
  function base64ToImage(base64Str: string): string; // 返回 file:// 路径
}
```

### 3. 热重载与 Wrapper 代理机制
- **Wrapper 架构**：插件注册时自动生成 `IsWrapper` 代理对象存入群激活列表。当插件源码更新重载时，仅刷新底层实现，保持各群内的插件启用状态与执行次序稳定。
- **伴随激活图 (`ActiveWithGraph`)**：支持扩展配置 `activeWith`，声明当特定主扩展开启/关闭时，伴随从属扩展自动级联同步。

---

## 7. 扩展包体系与扩展商店 (SealPack & Store)

### 1. SealPack 包规范 (`info.toml`)
SealDice 统一的扩展包打包格式，支持将脚本、牌堆、文档、回复策略、规则模板打包为 `.sealpack`：

```toml
format_version = "1.0.0"

[package]
id = "sealdice/example-pack"
name = "示例扩展包"
version = "1.2.0"
authors = ["SealTeam"]
license = "MIT"
description = "提供完整的扩展能力整合包"

[package.seal]
min_version = "1.6.0"
max_version = "2.0.0"

[dependencies]
"sealdice/base-lib" = ">=1.0.0"

[permissions]
network = true
network_hosts = ["api.example.com", "api.github.com"]
file_read = ["assets/*", "config.json"]
file_write = ["cache/*"]
ipc = ["sealdice/base-lib"]

[contents]
scripts = ["main.js"]
decks = ["decks/tarot.json"]
reply = ["reply/rules.yaml"]
helpdoc = ["help/manual.json"]
templates = ["templates/custom_rule.yaml"]
```

### 2. 细粒度安全沙箱 (`sealpack.Sandbox`)
- **网络域名沙箱**：基于 HTTP 传输层劫持，仅允许访问清单中 `network_hosts` 白名单所列域名，违规请求直接拦截并抛出 `PermissionError`。
- **文件隔离**：扩展只能访问包安装路径与专用的 `data/extensions/<id>/_userdata/` 持久化目录。
- **IPC 通信隔离**：扩展间跨上下文调用需显式授权。

### 3. 扩展商店 (Store)
- **多后端协议**：支持官方源（`repo.sealdice.com`）、受信任源与第三方自定义源。
- **数字签名**：官方扩展包通过 ECDSA/RSA 进行签名防篡改验证。
- **管理能力**：支持商店一键浏览、在线搜索、依赖拓扑校验、在线安装、版本升级与卸载。

---

## 8. 跑团日志全生命周期与故事记录 (Story Log)

### 1. 指令流与生命周期管理
- `.log new [日志名]`：创建并启动新日志。
- `.log on [日志名]`：继续记录当前或指定日志。
- `.log off`：暂停记录。
- `.log end`：终结记录，生成排版归档并自动上传至云端跑团日志平台获取分享外链。
- `.log halt`：强制终止并关闭当前日志，不执行自动上传。
- `.log stat`：统计当前日志掷骰次数、出目极值分布、发言字数与活跃榜单。
- `.log export [日志名] [可选邮箱]`：导出文本文件或直接通过 SMTP 邮件发送至指定信箱。

### 2. 底层存储与上传协议
- **数据表结构**：
  - `logs`：记录元数据（群号、名字、创建/更新时间、记录行数、文件尺寸）。
  - `log_items`：存储聊天记录条目，具有 `(group_id, raw_msg_id, id)` 复合索引以支撑海量记录检索。
- **双协议云端接入**：
  - `UploadV1`：早期标准跑团日志上传格式。
  - `UploadV105`：现代增量日志上传协议，支持富文本切片与角色头像着色渲染。

---

## 9. 智能牌堆系统与自定义回复 (Deck & Custom Reply)

### 1. 牌堆系统 (`ext_deck`)
- **格式高度兼容**：兼容 `Dice!` 格式及“塔系”牌堆，支持 JSON、YAML 及纯文本定义。
- **嵌套与递归抽取**：支持词条内引用其他牌堆分支，如 `{%抽取武器%} 造成 {%1d6%} 点伤害`。
- **指令能力**：
  - `.draw <牌堆名>`：抽取词条。
  - `.draw search <关键字>` / `.draw keys`：模糊搜索本地牌组与指令词。
  - `.draw reload`：Master 权限热重载磁盘牌堆文件。

### 2. 自定义回复系统 (`ext_reply`)
- **条件匹配器 (Conditions)**：
  - `matchExact`（全字匹配）、`matchContains`（模糊包含）、`matchRegex`（正则匹配）、`matchPrefix`（前缀）、`matchSuffix`（后缀）。
  - `multiMatch`：支持将多个子条件按 `any`（逻辑或）或 `all`（逻辑与）组合。
  - `exprTrue`：当给定的 dicescript 表达式求值为真时触发。
  - `textLenLimit`：限制触发文本的最小与最大字符长度。
- **动作执行器 (Results)**：
  - `ReplyResultReplyToSender`：回复发送者。
  - `ReplyResultReplyGroup`：回复至来源群。
  - `ReplyResultReplyPrivate`：私聊回复。
  - `ReplyResultRunText`：纯执行内部脚本与状态变更，不直接回发消息。
- **调试模式**：通过 WebUI 开启 `ReplyDebugMode`，控制台可实时输出条件匹配细节。

---

## 10. 风控防封、敏感词审查与信誉黑名单 (Censor, Ban & RateLimit)

### 1. 多级敏感词审查引擎 (Censor)
- **拼音模糊与噪声过滤**：
  - 基于 Trie 树构建词库。
  - 集成 `mozillazg/go-pinyin`，同时对比汉字与全拼，防范谐音字规避。
  - 支持 `FilterRegexStr`，先清洗文本中的标点符号与干扰字符后再执行审查。
- **5 级安全响应**：
  - `忽略 (Ignore)`、`提醒 (Notice)`、`注意 (Caution)`、`警告 (Warning)`、`危险 (Danger)`。
  - 处置动作：拦截阻断、消息撤回、伪造文案混淆、私聊告警骰主、自动扣减信誉并拉黑。

### 2. 动态信誉分与黑名单机制 (Ban)
- **信誉分级**：
  - `BanRankNormal` (0)：正常用户。
  - `BanRankWarn` (-10)：警告用户。
  - `BanRankBanned` (-30)：封禁拉黑用户。
  - `BanRankTrusted` (30)：受信用户。
- **自动触发与阈值**：
  - 默认警告阈值 `ThresholdWarn = 100`，封禁阈值 `ThresholdBan = 200`。
  - 机器人被踢出群聊、高频刷屏、触碰 Danger 级敏感词将自动累加恶劣分值。
  - 达到封禁阈值后触发全网全局拉黑，并在事发群执行自动退群处置。
  - 骰主与信任群具有豁免权。

### 3. 令牌桶限流体系 (RateLimit)
- 个人与群组分别维护独立的 `rate.Limiter` 令牌桶。
- 可细化配置每秒填充速率（`ReplenishRate`）与突发容量上限（`Burst`），防范恶意消息洪泛。

---

## 11. Bluge 倒排检索与规则百科手册 (DocEngine & Help)

- **高性能全文检索内核**：集成现代化倒排索引库 `fy0/bluge`，替代传统线性遍历搜索。
- **文档树模型**：
  - 索引字段涵盖 `id`、`group`、`from`、`title`、`content`、`package`、`keywords`。
  - 内置中文分词与相关度评分机制。
- **检索指令**：
  - `.help <关键字/指令>`：查看指令手册或指定词条。
  - `.find <关键字>` / `.查询 <关键字>`：全文检索跑团规则百科，分页智能返回最佳匹配摘要与相关词条。
  - 支持在各群配置 `defaultHelpGroup` 锁定当前群专属规则书。

---

## 12. 多源密码学高安全随机数矩阵 (Randomness)

SealDice 提供金融与密码学级别的多随机源矩阵，确保绝对公正与防预测：

```
+-------------------------------------------------------------------+
|                        globalRandSource                           |
+---------------------------------+---------------------------------+
                                  |
     +-----------------+----------+--------+-----------------+
     |                 |                   |                 |
+----v----+       +----v-----+       +-----v----+      +-----v----+
|   PCG   |       |  国密SM3  |       | NIST-AES |      |  OS CRNG |
|   PRNG  |       | HashDRBG |       | CTR-DRBG |      | getrandom|
+----+----+       +----+-----+       +-----+----+      +-----+----+
     |                 |                   |                 |
     +-----------------+----------+--------+-----------------+
                                  |
                                  v (按位异或 XOR)
                      +-----------------------+
                      |   Hybrid (混合模式)   |
                      +-----------------------+
```

1. **PCG 算法 (`ModePCG`)**：高性能现代 PRNG，具有优异的统计学均匀性与极高吞吐率。
2. **国密 SM3 DRBG (`ModeGM`)**：符合商用密码标准 `GM/T 0105-2021`，集成 SP 800-90B 连续健康检测与已知答案自检（KAT）。
3. **AES-256-CTR-DRBG (`ModeNIST`)**：符合 `NIST SP 800-90A Rev.1` 规范，开启预测抵抗（Prediction Resistance）、实例级个性化串及定期重播种。
4. **操作系统 CRNG (`ModeCRNG`)**：直接索取 Linux `getrandom(2)` 或 Windows `ProcessPrng` 物理硬件熵池。
5. **多源异或混合模式 (`ModeHybrid`)**：将上述 4 种随机源输出按位异或（XOR）混合。依据信息论原理，只要其中任一随机源保持均匀随机分布，最终输出必具备绝对不可预测性。
6. **在线测速与校验 (`.randalgo`)**：支持在线查看当前算法并对全部源进行现场采样对比与毫秒级耗时输出。

---

## 13. WebUI RESTful API 接口完整清单

SealDice WebUI 提供了近 200 个 RESTful API 路由（统一带前缀，默认为 `/sd-api`）：

### 基础与鉴权
- `POST /signin`：控制台密码登录认证，颁发 AccessToken。
- `GET /signin/salt`：获取认证随机盐。
- `GET /checkSecurity`：安全模式检测（公网绑定与弱口令告警）。
- `GET /preInfo`：读取海豹前端预加载基础信息。
- `GET /baseInfo`：获取系统状态、运行时间与内存开销。
- `GET /hello`：心跳探活接口。
- `GET /log/fetchAndClear`：获取并清空 UI 控制台缓冲区日志。

### 通讯端点与协议管理 (`/im_connections`)
- `GET /im_connections/list`：获取所有端点列表及其连接状态。
- `GET /im_connections/get`：获取单个端点详情。
- `GET /im_connections/qq/get_versions`：读取内置 QQ 客户端支持协议版本。
- `POST /im_connections/qrcode`：拉取内置登录二维码。
- `POST /im_connections/sms_code_get` / `sms_code_set`：短信验证码获取与提交。
- `POST /im_connections/gocq_captcha_set`：滑动验证码结果提交。
- `POST /im_connections/addGocq` / `addOnebot11ReverseWs` / `addGocqSeparate`：添加 OneBot 端点。
- `POST /im_connections/addLagrange`：添加内置 Lagrange 客户端端点。
- `POST /im_connections/addOfficialQQ`：添加官方 QQ 机器人端点。
- `POST /im_connections/addRed`：添加 Red 协议端点。
- `POST /im_connections/addSatori`：添加 Satori 协议端点。
- `POST /im_connections/addMilky` / `addMilkyInternal`：添加 Milky 协议端点。
- `POST /im_connections/addDiscord` / `addKook` / `addTelegram` / `addMinecraft` / `addDodo` / `addDingtalk` / `addSlack` / `addSealChat`：添加各类平台端点。
- `POST /im_connections/del`：删除指定端点。
- `POST /im_connections/set_enable`：启用或停用端点。
- `POST /im_connections/set_data`：更新端点详细配置参数。
- `GET /im_connections/get_lgr_signinfo`：读取 Lagrange 签名服务配置。
- `POST /im_connections/gocqhttpRelogin` / `walleQRelogin`：强制指定端点重连登录。

### 群组与黑名单管理
- `GET /group/list`：分页获取所有服务群组信息。
- `POST /group/set_one`：修改单个群组详细设置（规则、默认面数、迎新等）。
- `POST /group/quit_one`：指示机器人退出指定群聊。
- `GET /banconfig/list`：获取黑名单完整映射列表。
- `GET /banconfig/get` / `POST /banconfig/set`：获取与修改黑名单阈值及惩罚策略。
- `POST /banconfig/map_add_one` / `map_delete_one`：手动增删黑名单或信任名单记录。
- `GET /banconfig/export` / `POST /banconfig/import`：黑名单 JSON 数据导入导出。

### 自定义文案与自定义回复 (`/configs`)
- `GET /configs/customText` / `POST /configs/customText/save`：获取与保存自定义模板文案。
- `POST /configs/customText/preview-refresh`：文案转义预览刷新。
- `GET /configs/custom_reply` / `POST /configs/custom_reply/save`：读取与保存自定义回复规则。
- `GET /configs/custom_reply/file_list`：获取回复规则文件列表。
- `POST /configs/custom_reply/file_new` / `file_delete`：新建与删除回复规则文件。
- `GET /configs/custom_reply/file_download` / `file_upload`：自定义回复配置导入导出。
- `GET /configs/custom_reply/debug_mode` / `POST /configs/custom_reply/debug_mode`：回复调试模式开关。

### 牌堆管理 (`/deck`)
- `GET /deck/list`：获取已装载牌堆列表。
- `POST /deck/reload`：从硬盘热重载所有牌堆。
- `POST /deck/upload`：上传新牌堆文件。
- `POST /deck/enable`：启用或禁用指定牌堆。
- `POST /deck/delete`：删除指定牌堆文件。
- `POST /deck/check_update` / `POST /deck/update`：网络牌堆更新检测与执行。

### JavaScript 插件管理 (`/js`)
- `GET /js/status`：获取 JS 运行时整体状态与版本。
- `GET /js/list`：获取所有已安装插件元数据列表。
- `POST /js/upload`：上传 `.js` 插件文件。
- `POST /js/delete`：删除插件文件。
- `POST /js/reload`：热重载整个 JavaScript 运行时与事件循环。
- `POST /js/shutdown`：安全停用 JS 引擎。
- `POST /js/enable` / `POST /js/disable`：单插件启停控制。
- `POST /js/execute`：控制台在线运行单行 JS 脚本并返回求值结果。
- `GET /js/get_record`：获取插件运行日志。
- `GET /js/get_configs` / `POST /js/set_configs`：读取与保存插件自定义参数。
- `POST /js/reset_config` / `POST /js/delete_unused_configs`：重置插件配置 / 清理无效配置项。

### 扩展包与商店体系 (`/package` & `/store`)
- `GET /package/list`：获取已安装的 SealPack 扩展包。
- `GET /package/:id`：获取扩展包详情。
- `GET /package/asset`：读取扩展包内的静态预览资产。
- `POST /package/refresh`：刷新扩展包列表。
- `POST /package/preview-upload`：上传扩展包并解析元数据预览。
- `POST /package/install-upload`：通过上传安装扩展包。
- `POST /package/install-url`：通过远程 URL 下载安装扩展包。
- `POST /package/uninstall`：卸载指定扩展包。
- `POST /package/enable` / `POST /package/disable`：启停指定扩展包。
- `POST /package/reload` / `reload-content` / `reload-all`：重载包逻辑与内容。
- `GET /package/:id/config` / `POST /package/:id/config`：读取与修改包自定义设置。
- `GET /package/:id/config-schema`：获取包的配置表单 Schema。
- `GET /store/backend/list`：获取配置的扩展商店后端源。
- `POST /store/backend/add` / `enable` / `disable` / `remove`：管理商店数据源。
- `GET /store/recommend` / `GET /store/page`：商店包列表与推荐分页查询。
- `GET /store/files/:namespace/:package/:version`：预览商店扩展包文件树。
- `POST /store/download`：从商店直接下载安装扩展包。
- `POST /store/install-list`：批量查询已安装包的商店状态。
- `POST /store/rating`：提交扩展包评分。

### 敏感词审查 (`/censor`)
- `GET /censor/status` / `censor/config` / `POST /censor/config`：敏感词引擎状态与参数配置。
- `POST /censor/restart` / `censor/stop`：重启或停止敏感词审查服务。
- `GET /censor/words` / `censor/files`：读取敏感词列表与规则文件列表。
- `POST /censor/files/upload` / `DELETE /censor/files`：上传与删除敏感词字典。
- `GET /censor/files/template/toml` / `template/txt`：获取字典模板。
- `GET /censor/logs/page`：分页浏览敏感词拦截审计日志。

### 跑团日志与故事管理 (`/story`)
- `GET /story/info`：获取日志系统全局统计数据。
- `GET /story/logs` / `GET /story/logs/page`：分页获取跑团日志列表。
- `GET /story/items` / `GET /story/items/page`：分页读取指定日志内的聊天文本行。
- `DELETE /story/log`：删除指定跑团日志。
- `POST /story/uploadLog`：手动上传指定日志至跑团平台。
- `GET /story/backup/list` / `download` / `batch_delete`：管理与下载日志备份归档。

### 备份、更新与系统核心
- `GET /backup/list` / `POST /backup/do_backup`：查看备份列表与触发手动备份。
- `GET /backup/config_get` / `POST /backup/config_set`：设置自动备份计划与保留轮转策略。
- `GET /backup/download` / `POST /backup/delete` / `batch_delete`：下载与删除备份包。
- `GET /dice/config/get` / `POST /dice/config/set`：核心主配置获取与保存。
- `GET /dice/config/advanced/get` / `POST /dice/config/advanced/set`：高级设置（自定义后端、API版本）。
- `POST /dice/config/mail_test`：测试 SMTP 邮件发送配置。
- `POST /dice/exec`：执行控制台模拟指令。
- `GET /dice/recentMessage`：读取控制台测试窗口消息流。
- `GET /dice/cmdList`：获取所有注册指令及别名列表。
- `POST /dice/upload_to_upgrade` / `POST /dice/upgrade`：上传离线升级包或触发在线更新。
- `GET /helpdoc/status` / `tree` / `reload` / `upload` / `delete`：帮助文档全文索引管理。
- `GET /resource/page` / `upload` / `delete` / `download`：公共静态多媒体资源管理。
- `GET /utils/check_network_health`：国内镜像与海外网络联通性自检。
- `POST /force_stop`：紧急强制停机。

---

## 14. 完整配置体系与参数树 (Config & AdvancedConfig)

SealDice 的主配置文件保存于 `data/default/serve.yaml`：

```yaml
configVersion: 1
# 基础通用设置
noticeIds: ["QQ:10001", "mail:admin@example.com"]  # 骰主告警推送通道
onlyLogCommandInGroup: false                      # 日志是否仅记录指令
messageDelayRangeStart: 0.5                       # 指令响应随机延迟下限(秒)
messageDelayRangeEnd: 1.5                         # 指令响应随机延迟上限(秒)
QQEnablePoke: true                                # 是否响应 QQ 戳一戳
officialQQFileSendBase64: true                    # 官方 QQ 是否使用 Base64 发送富媒体
officialQQUseMarkdown: false                      # 官方 QQ 消息全量转 Markdown
textCmdTrustOnly: true                            # .text 脚本指令是否仅限信任用户/Master
botExtFreeSwitch: false                           # 允许普通成员自由开关扩展（否则需管理权限）
botExitWithoutAt: false                           # 执行退群命令是否必须附带 @
trustOnlyMode: false                              # 严格模式：仅信任用户可拉群和触发
aliveNoticeEnable: true                           # 定时心跳广播开关
aliveNoticeValue: "0 0 8 * * ?"                   # 定时广播 Cron 表达式
diceRandomMode: "pcg"                             # 全局随机算法 (pcg / gm / nist / crng / hybrid)

# 频率与刷屏限制 (RateLimitConfig)
rateLimitEnabled: true
personalReplenishRate: "3s"                       # 个人令牌桶填充周期
personalBurst: 5                                  # 个人允许的最大突发请求数
groupReplenishRate: "1s"                          # 群组令牌桶填充周期
groupBurst: 20                                    # 群组允许的最大突发请求数

# 退出不活跃群组 (QuitInactiveConfig)
quitInactiveThreshold: 720h                       # 不活跃判定期 (如 30 天)
quitInactiveNoticeSummaryMode: true               # 退群通知改为汇总摘要模式
quitInactiveBatchSize: 10                         # 单批次自动退群上限
quitInactiveBatchWait: 5                          # 批次间冷却等待时间(分钟)

# 扩展全局默认设置 (ExtConfig)
defaultCocRuleIndex: 2                            # 默认 COC 房规
maxExecuteTime: 10                                # 单指令最大允许重复轮数 (3# 这种)
maxCocCardGen: 5                                  # 允许单次最大制卡套数
cocCardMergeForward: true                         # 制卡结果是否采用合并转发下发

# 敏感词审查设置 (CensorConfig)
enableCensor: true
censorMode: 0                                     # 0: 全部输入, 1: 仅指令输入
censorCaseSensitive: false                        # 区分大小写
censorMatchPinyin: true                           # 拼音模糊音匹配
censorFilterRegexStr: "[\\s\\pP]+"                # 标点符号与干扰空白前置过滤正则

# 邮件报警设置 (MailConfig)
mailEnable: true
mailFrom: "dice@example.com"
mailPassword: "password_or_token"
mailSmtp: "smtp.example.com:465"                  # 支持 465(TLS) 或 587(STARTTLS)

# 高级设置 (AdvancedConfig)
show: true
enable: true
storyLogBackendUrl: "https://log.sealdice.com"
storyLogApiVersion: "1.0.5"
```

---

## 15. 数据库模型与渐进式版本迁移 (Database & migrate/v2)

### 1. 多引擎底层抽象
通过 `engine.DatabaseOperator` 接口支持多种存储介质：
- **SQLite**：支持无 CGO 纯 Go 驱动 `glebarez/sqlite`（适配嵌入式及全平台交叉编译）与高性能 CGO 驱动 `mattn/go-sqlite3`。
- **PostgreSQL**：基于 `gorm.io/driver/postgres`，支撑百万级数据集群部署。
- **MySQL**：基于 `gorm.io/driver/mysql`。

### 2. 核心数据表结构

```sql
-- 角色属性表 (替代旧版 attrs_user/group/group_user)
CREATE TABLE attrs (
    id TEXT PRIMARY KEY,               -- 群内卡：Group:123-User:456，用户独立卡：nanoid
    data BLOB,                         -- 序列化的人物卡二进制键值表
    attrs_type TEXT,                   -- character(独立角色), group_user(群员), group(群属性), user(用户)
    binding_sheet_id TEXT DEFAULT '',  -- 群内默认卡绑定的真实独立卡 ID
    name TEXT,                         -- 角色卡名称
    owner_id TEXT,                     -- 归属用户的 UniformID
    sheet_type TEXT,                   -- 规则类型 (coc7, dnd5e 等)
    is_hidden BOOLEAN,                 -- 是否在角色列表隐藏
    created_at INTEGER,
    updated_at INTEGER
);

-- 群组配置表
CREATE TABLE group_info (
    id TEXT PRIMARY KEY,
    created_at INTEGER,
    updated_at INTEGER,
    data BLOB                          -- 序列化的群配置 (黑白名单、已启用扩展、迎新词等)
);

-- 黑名单表
CREATE TABLE ban_info (
    id TEXT PRIMARY KEY,
    ban_updated_at INTEGER,
    updated_at INTEGER,
    data BLOB                          -- 包含信誉分、触发事发记录、惩罚状态
);

-- 跑团日志明细表
CREATE TABLE log_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id INTEGER,
    group_id TEXT,
    nickname TEXT,
    im_userid TEXT,
    time INTEGER,
    message TEXT,
    is_dice BOOLEAN,
    command_id INTEGER,
    command_info TEXT,
    user_uniform_id TEXT
);
-- 复合查询索引：保障万行日志导出与渲染秒级响应
CREATE INDEX idx_log_items_group_raw ON log_items(group_id, raw_msg_id, id);
```

### 3. 全自动迁移流 (`migrate/v2`)
升级框架按 ID 字典序升序逐项执行，具备严格的幂等性校验，在 `upgrade_records` 记录执行状态：

| 迁移 ID | 适用版本 | 迁移行为与核心职责 |
| :--- | :--- | :--- |
| `001_V120Migration` | v1.2.0 | 将旧版纯文本 YAML 与 BoltDB（`data.bdb`）日志全量迁入关系数据库。 |
| `002_V120LogMessageMigration` | v1.2.x | 修复早期 SQLite 中 `log_items.message` 被误建为 INTEGER 的类型错误。 |
| `003_V131ConfigUpdateMigration` | v1.3.1 | 将配置文件历史遗留文案自动迁移并归并至 `text-template.yaml`。 |
| `004_V141ConfigUpdateMigration` | v1.4.1 | 字段重构命名：`customReplenishRate` -> `personalReplenishRate`。 |
| `005_V144RemoveOldHelpDocMigration` | v1.4.4 | 校验并物理清除旧版废弃的“怪物之锤”大体积 JSON 帮助文档。 |
| `006_V150UpgradeAttrsMigration` | v1.5.0 | **里程碑重构**：将用户卡、群员卡、群卡三表合并为统一 `attrs` 表，卡数据转为 V2 格式。 |
| `007_V150FixGroupInfoMigration` | v1.5.0 | 清理历史由于异常停机导致的空白坏行。 |
| `007_V151GORMCleanMigration` | v1.5.1 | 清除 GORM 自动同步中引入的 NULL/空脏数据。 |
| `008_V160LogIDZeroCleanMigration` | v1.6.0 | 修复日志关联异常，清理 `log_id=0` 的残留历史碎片并重新核算日志行数。 |
| `009_V160LogRawMsgIDIndexMigration`| v1.6.0 | 为 `log_items` 补建 `(group_id, raw_msg_id, id)` 复合索引，消除慢查询。 |
| `010_V160LogSizeRepairMigration` | v1.6.0 | 补齐 `logs.size` 字段并全量重新核算各日志文件体积。 |
| `011_V161NoticeIDsMigration` | v1.6.1 | 初始化通知配置，将骰主 ID 一次性补入通知列表，默认开启告警通知。 |
| `012_V161LogUpdatedAtRepairMigration`| v1.6.1 | 根据最后一条记录条目的时间戳回填修复 `logs.updated_at`。 |

---

## 16. 运维部署、系统服务与自动更新 (Ops & Deployment)

### 1. 命令行参数全景
```bash
sealdice-core [flags]
  -v, --version           # 显示当前版本号与架构信息
  -i, --install           # 一键注册为操作系统常驻服务 (Windows Service / Systemd / Launchd)
      --uninstall         # 卸载系统服务
      --service-name      # 指定服务名称 (默认: sealdice)
      --service-user      # 指定运行系统服务的用户名
      --address           # 覆盖 WebUI 监听地址 (如: 0.0.0.0:3211)
  -m, --multi-instance    # 允许在同一台 Windows 设备上通过独立目录启动多份海豹
      --hide-ui           # 启动完成后不自动唤起默认浏览器打开控制台
      --show-console      # Windows 下强制保留控制台黑框窗口
      --container-mode    # 容器化运行模式 (Docker 专用，禁用内置进程适配器与内置自动升级)
      --log-level         # 设置全局日志级别 (-1: Trace, 0: Debug, 1: Info, 2: Warn, 3: Error)
      --vacuum            # 对 SQLite 数据库执行 VACUUM 碎片清理收缩
      --db-check          # 数据库完整性检查与修复
      --mutex-profile     # 互斥锁竞用剖析采样率 (性能调优专用)
      --block-profile     # 阻塞事件分析采样率
```

### 2. 进程互斥与多实例防撞锁
- 基于 `flock` 文件锁机制（`sealdice-lock.lock`）。
- 启动时校验文件锁，若被占用立即弹性阻断并弹窗提醒，杜绝多实例同时打开同一目录数据库导致数据写穿。

### 3. 全自动平滑无感升级 (Updater)
1. 定时后台并发探测多组镜像源（Coding、GitHub、国内加速节点），提取最新 Release 版本与散列值。
2. 命中新版本后在后台静默下载增量包，校验 SHA-256 签名。
3. 自动触发全局热备（将当前 `data/` 及可执行文件归档至 `backups/`）。
4. 启动外部独立更新程序 `auto_update`，原子替换二进制文件。
5. 自动带参数热重启拉起新核心，旧版本控制台连接无缝迁移重连。

### 4. 数据备份与容灾轮转策略
- **定时热备机制**：支持配置 Cron 表达式（如每天凌晨 4 点）触发全量冷备或增量热备。
- **备份粒度选择**：可独立勾选是否打包持久化配置（`serve.yaml`）、核心数据库（`data.db`、`data-logs.db`、`data-censor.db`）、牌堆文件（`decks/`）、插件脚本（`scripts/`）、百科帮助文档（`helpdoc/`）。
- **空间保护与生命周期**：支持“按最大保留备份数（如保留最近 30 份）”或“按保存天数（如保留最近 60 天）”自动清理过期归档，避免日志爆炸耗尽磁盘。
- **灾难恢复**：WebUI 支持一键下载 `.zip` 备份，或在系统故障时通过命令行解压回滚覆盖。

---

## 结语

SealDice-Core 通过多协议接入层、图灵完备的 dicescript 解释器、基于 Goja 的 JavaScript 插件体系、全方位的安全防御矩阵以及工业级自动化数据库迁移，实现了兼具**极致拓展性**与**高可用工程可靠性**的现代 TRPG 跑团服务架构。
