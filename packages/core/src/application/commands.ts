import { getBuiltinDeck, listBuiltinDecks } from '../domain/deck/builtin-decks.js';
import {
  type Card,
  type DeckSession,
  createDeckSession,
  drawFromDeck,
} from '../domain/deck/deck.js';
import { collectDiceBudget, evaluateAst } from '../domain/dice/ast.js';
import { applyKeepDrop, rollDice } from '../domain/dice/expression.js';
import { parseDiceExpression } from '../domain/dice/parser.js';
import { getRandomGugu } from '../domain/fun/gugu.js';
import { computeJrrp, formatJrrpReply } from '../domain/fun/jrrp.js';
import {
  fetchCnmodsDetail,
  fetchCnmodsSearch,
  formatCnmodsDetail,
  formatCnmodsSearchResult,
} from '../domain/fun/modu.js';
import { generateDndName, generateRandomName } from '../domain/fun/name.js';
import {
  createHiddenRollLinkToken,
  hashHiddenRollLinkToken,
  isHiddenRollLinkToken,
} from '../domain/hidden-roll/binding.js';
import {
  type Coc7CardAttributes,
  formatCoc7CardBatch,
  formatCoc7CardSingle,
  generateCoc7Card,
} from '../domain/rules/coc7/character-gen.js';
import { performCocCheck } from '../domain/rules/coc7/check.js';
import {
  COC_HOUSE_RULES,
  resolveCocHouseRule,
  resultCheckBase,
} from '../domain/rules/coc7/house-rules.js';
import { rollMadnessSymptom } from '../domain/rules/coc7/madness.js';
import {
  type Dnd5eCardAttributes,
  type Dnd5eFreeAllocationCard,
  formatDnd5eFreeCard,
  formatDnd5ePresetCard,
  generateDnd5eCard,
  generateDnd5eFreeCard,
} from '../domain/rules/dnd5e/character-gen.js';
import {
  type DndHpState,
  type DndSpellSlots,
  applyDamage,
  applyHealing,
  performLongRest,
  restoreSpellSlots,
  setMaxHp,
  setTempHp,
  useSpellSlot,
} from '../domain/rules/dnd5e/character-state.js';
import {
  type CombatEncounterState,
  addCombatant,
  advanceTurn,
  createCombatEncounter,
  resetEncounter,
} from '../domain/rules/dnd5e/combat.js';
import {
  applyDeathSaveModifiers,
  deathSaveResultText,
  decideDeathSave,
} from '../domain/rules/dnd5e/death-saves.js';
import { searchRuleGlossary } from '../domain/rules/glossary.js';
import type { Clock } from '../ports/clock.js';
import type { RandomSource } from '../ports/random-source.js';
import type {
  CommandResult,
  HiddenRollLinkReader,
  InboundLogItem,
  Permissions,
  PreparedReply,
  Principal,
  StateSnapshot,
  StateUpdate,
} from '../ports/state-store.js';

export class CommandConflictError extends Error {
  constructor(name: string) {
    super(`Command conflict: '${name}' is already registered`);
    this.name = 'CommandConflictError';
  }
}

export type CommandPermission = 'all' | 'groupHost' | 'diceMaster';

export interface CommandMetadata {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly permission: CommandPermission;
  readonly allowedWhenDisabled?: boolean | undefined;
  readonly description?: string | undefined;
}

export interface CommandInput {
  readonly executionId: string;
  readonly rawText: string;
  readonly commandName: string;
  readonly args: readonly string[];
  readonly eventId: string;
  readonly messageId: string;
  readonly timestamp: Date;
  readonly sender?: Principal | undefined;
}

export interface CommandBudget {
  readonly maxDiceRolls: number;
  readonly maxRecursionDepth: number;
  readonly maxOutputBytes: number;
  consumed: {
    diceRolls: number;
    recursionDepth: number;
    outputBytes: number;
  };
}

export interface CommandContext {
  readonly snapshot: StateSnapshot;
  readonly random: RandomSource;
  readonly clock: Clock;
  readonly permissions: Permissions;
  readonly budget: CommandBudget;
  readonly configVersion: string;
  readonly botId: string;
  readonly hiddenRollLinks?: HiddenRollLinkReader | undefined;
}

export interface CommandDecision {
  readonly results: CommandResult[];
  readonly updates: StateUpdate[];
  readonly replies: PreparedReply[];
  readonly logItems: InboundLogItem[];
}

export type CommandHandler = (
  input: CommandInput,
  context: CommandContext,
) => Promise<CommandDecision>;

export interface RegisteredCommand {
  readonly metadata: CommandMetadata;
  readonly handler: CommandHandler;
}

export interface CommandRegistry {
  register(metadata: CommandMetadata, handler: CommandHandler): void;
  find(nameOrAlias: string): RegisteredCommand | undefined;
  list(): readonly RegisteredCommand[];
}

export class DefaultCommandRegistry implements CommandRegistry {
  private readonly commandMap = new Map<string, RegisteredCommand>();
  private readonly aliasMap = new Map<string, string>();

  register(metadata: CommandMetadata, handler: CommandHandler): void {
    const primary = metadata.name.toLowerCase();
    if (this.commandMap.has(primary) || this.aliasMap.has(primary)) {
      throw new CommandConflictError(primary);
    }

    const aliases = metadata.aliases ?? [];
    const lowerAliases: string[] = [];

    for (const alias of aliases) {
      const lower = alias.toLowerCase();
      if (lower === primary || lowerAliases.includes(lower)) {
        throw new CommandConflictError(lower);
      }
      if (this.commandMap.has(lower) || this.aliasMap.has(lower)) {
        throw new CommandConflictError(lower);
      }
      lowerAliases.push(lower);
    }

    const registered: RegisteredCommand = { metadata, handler };
    this.commandMap.set(primary, registered);

    for (const alias of lowerAliases) {
      this.aliasMap.set(alias, primary);
    }
  }

  find(nameOrAlias: string): RegisteredCommand | undefined {
    const lower = nameOrAlias.toLowerCase();
    const direct = this.commandMap.get(lower);
    if (direct) {
      return direct;
    }
    const resolvedPrimary = this.aliasMap.get(lower);
    if (resolvedPrimary) {
      return this.commandMap.get(resolvedPrimary);
    }
    return undefined;
  }

  list(): readonly RegisteredCommand[] {
    return Array.from(this.commandMap.values());
  }
}

async function rollHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  let exprText =
    input.args.length > 0
      ? input.args.join(' ').trim()
      : `d${context.snapshot.conversation.diceSides}`;

  const commandName = input.commandName.toLowerCase();
  const restoresLeadingDice =
    commandName === 'rd' || commandName === 'rhd' || commandName === 'rdh';
  if (input.args.length > 0 && restoresLeadingDice) {
    if (/^\d|优势|劣势|\+|-/.test(exprText)) {
      const rawBody = input.rawText.replace(/^[.。!！/]/, '').trimStart();
      const spaceBeforeArgs = /^\s/.test(rawBody.slice(input.commandName.length));
      exprText = `${spaceBeforeArgs ? 'd ' : 'd'}${exprText}`;
    }
  }

  const parseResult = parseDiceExpression(exprText, context.snapshot.conversation.diceSides);

  const deadline = new Date(input.timestamp.getTime() + 300_000);

  if (!parseResult.success || !parseResult.expression) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: context.snapshot.conversation.scene,
      targetId: context.snapshot.conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'dice.error',
      text: parseResult.error ?? 'Invalid dice expression',
      deadline,
    };
    return {
      results: [],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  const expr = parseResult.expression;
  const { totalDice } = collectDiceBudget(expr.ast);
  const totalRollsNeeded = totalDice * expr.repeat;

  if (context.budget.consumed.diceRolls + totalRollsNeeded > context.budget.maxDiceRolls) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: context.snapshot.conversation.scene,
      targetId: context.snapshot.conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'budget.exceeded',
      text: 'Dice roll budget exceeded',
      deadline,
    };
    return {
      results: [],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  context.budget.consumed.diceRolls += totalRollsNeeded;

  const repeatResults: {
    rolls: number[];
    keptRolls: number[];
    total: number;
    rendered?: string;
  }[] = [];

  for (let r = 0; r < expr.repeat; r++) {
    const evalResult = await evaluateAst(expr.ast, context.random);
    const rolls = evalResult.diceGroups.flatMap((g) => g.rolls);
    const keptRolls = evalResult.diceGroups.flatMap((g) => g.keptRolls);
    repeatResults.push({
      rolls,
      keptRolls,
      total: evalResult.value,
      rendered: evalResult.rendered,
    });
  }

  const textLines: string[] = [];
  for (const [idx, row] of repeatResults.entries()) {
    const prefix = expr.repeat > 1 ? `#${idx + 1}: ` : '';
    const reasonStr = expr.reason ? ` ${expr.reason}` : '';
    if (expr.isCompound) {
      textLines.push(`${prefix}${exprText} = ${row.rendered ?? ''} = ${row.total}${reasonStr}`);
    } else {
      const rollsStr = `[${row.rolls.join(', ')}]`;
      const modStr =
        expr.modifier !== undefined
          ? expr.modifier >= 0
            ? `+${expr.modifier}`
            : `${expr.modifier}`
          : '';
      textLines.push(
        `${prefix}${expr.count}d${expr.faces}${modStr} = ${rollsStr} = ${row.total}${reasonStr}`,
      );
    }
  }

  const firstResult = repeatResults[0];
  const allRolls = repeatResults.flatMap((r) => r.rolls);
  const totalVal =
    repeatResults.length === 1
      ? (firstResult?.total ?? 0)
      : repeatResults.map((r) => r.total).join(', ');
  const rollsVal =
    repeatResults.length === 1 ? (firstResult?.rolls.join(', ') ?? '') : allRolls.join(', ');
  const resultData: Record<string, unknown> = {
    expression: exprText,
    faces: expr.faces,
    count: expr.count,
    repeat: expr.repeat,
    repeats: repeatResults,
    total: totalVal,
    individualRolls: rollsVal,
    rolls: firstResult?.rolls ?? [],
    reason: expr.reason ?? '',
  };

  const commandResult: CommandResult = {
    executionId: input.executionId,
    kind: 'dice_roll',
    ruleVersion: '1.0.0',
    data: resultData,
  };

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: context.snapshot.conversation.scene,
    targetId: context.snapshot.conversation.externalId,
    originMessageId: input.messageId,
    templateKey: 'dice.roll',
    text: textLines.join('\n'),
    deadline,
  };

  return {
    results: [commandResult],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function hiddenRollBindingHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const conversation = context.snapshot.conversation;
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  let text: string;
  let templateKey = 'dice.hidden.binding';
  const updates: StateUpdate[] = [];

  if (conversation.scene === 'c2c') {
    if (input.args[0]?.toLowerCase() === 'off') {
      text = '请在需要解绑的群里发送 .rhbind off。';
    } else {
      const principalId = context.snapshot.principalId;
      if (!principalId) {
        text = '当前私聊身份尚未初始化，请稍后重试。';
        templateKey = 'dice.hidden.binding.error';
      } else {
        const { token, tokenHash } = await createHiddenRollLinkToken(context.random);
        const expiresAt = new Date(context.clock.now().getTime() + 600_000);
        updates.push({
          type: 'hidden-roll-link-challenge',
          challengeId: `hrc_${input.eventId}`,
          c2cPrincipalId: principalId,
          userOpenid: conversation.externalId,
          tokenHash,
          expiresAt,
        });
        text = `绑定令牌：${token}\n请在 10 分钟内到目标群发送：.rhbind ${token}\n令牌只能使用一次。`;
      }
    }
  } else {
    const subcommand = input.args[0]?.trim() ?? '';
    const binding = context.snapshot.hiddenRollBinding;

    if (!subcommand || subcommand.toLowerCase() === 'help') {
      text = binding
        ? binding.activeMessagesEnabled
          ? '本群暗骰私聊绑定有效。使用 .rh <表达式> 进行暗骰；使用 .rhbind off 解绑。'
          : '本群暗骰私聊绑定有效，但本地授权状态可能未同步。可直接使用 .rh 测试实际投递；使用 .rhbind off 解绑。'
        : '请先私聊机器人发送 .rhbind 获取一次性令牌，再在本群发送 .rhbind <令牌>。';
    } else if (subcommand.toLowerCase() === 'off') {
      if (!binding) {
        text = '本群尚未绑定暗骰私聊。';
      } else {
        updates.push({
          type: 'hidden-roll-unbind',
          bindingId: binding.id,
          expectedVersion: binding.version,
          newVersion: binding.version + 1,
        });
        text = '已解除本群暗骰私聊绑定。';
      }
    } else if (binding) {
      text = '本群已经绑定暗骰私聊；如需更换，请先发送 .rhbind off。';
    } else if (!isHiddenRollLinkToken(subcommand)) {
      text = '绑定令牌格式无效。请私聊机器人重新发送 .rhbind 获取令牌。';
      templateKey = 'dice.hidden.binding.error';
    } else if (!context.hiddenRollLinks || !context.snapshot.principalId) {
      text = '当前无法验证绑定令牌，请稍后重试。';
      templateKey = 'dice.hidden.binding.error';
    } else {
      const tokenHash = await hashHiddenRollLinkToken(subcommand);
      const challenge = await context.hiddenRollLinks.findHiddenRollLinkChallenge(
        context.botId,
        tokenHash,
        context.clock.now(),
      );
      if (!challenge) {
        text = '绑定令牌无效、已使用或已过期。请私聊机器人重新获取。';
        templateKey = 'dice.hidden.binding.error';
      } else {
        updates.push({
          type: 'hidden-roll-binding',
          bindingId: `hrb_${input.eventId}`,
          challengeId: challenge.id,
          expectedChallengeVersion: challenge.version,
          groupScopeId: conversation.externalId,
          groupPrincipalId: context.snapshot.principalId,
          c2cPrincipalId: challenge.c2cPrincipalId,
          userOpenid: challenge.userOpenid,
        });
        text = '暗骰私聊绑定成功。以后可以在本群使用 .rh <表达式>。';
      }
    }
  }

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conversation.scene,
    targetId: conversation.externalId,
    originMessageId: input.messageId,
    templateKey,
    text,
    deadline,
  };
  return {
    results: [],
    updates,
    replies: [reply],
    logItems: [],
  };
}

async function hiddenRollHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const conversation = context.snapshot.conversation;
  const deadline = new Date(input.timestamp.getTime() + 300_000);

  if (conversation.scene === 'c2c') {
    const decision = await rollHandler(input, context);
    if (decision.results.length === 0) {
      return decision;
    }
    return {
      results: decision.results.map((result) => ({
        ...result,
        data: {
          ...result.data,
          hidden: true,
        },
      })),
      updates: decision.updates,
      replies: decision.replies.map((reply) => ({
        ...reply,
        templateKey: 'dice.hidden.roll',
      })),
      logItems: decision.logItems,
    };
  }

  const binding = context.snapshot.hiddenRollBinding;
  if (!binding) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conversation.scene,
      targetId: conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'dice.hidden.binding_required',
      text: '尚未绑定暗骰私聊。请先私聊机器人发送 .rhbind 获取令牌，再回本群完成绑定。',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const decision = await rollHandler(input, context);
  if (decision.results.length === 0) {
    return decision;
  }

  const privateResult = decision.replies[0]?.text;
  if (!privateResult) {
    return { results: [], updates: [], replies: [], logItems: [] };
  }

  const results = decision.results.map((result) => ({
    ...result,
    data: {
      ...result.data,
      hidden: true,
    },
  }));
  const replies: PreparedReply[] = [
    {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: 'c2c',
      targetId: binding.userOpenid,
      templateKey: 'dice.hidden.roll',
      text: privateResult,
      deadline,
      deliveryMode: 'active',
    },
    {
      executionId: input.executionId,
      part: 2,
      msgSeq: 1,
      scene: conversation.scene,
      targetId: conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'dice.hidden.group_sent',
      text: '暗骰已完成，结果已私聊发送。',
      deadline,
      condition: { part: 1, status: 'sent' },
    },
    {
      executionId: input.executionId,
      part: 3,
      msgSeq: 1,
      scene: conversation.scene,
      targetId: conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'dice.hidden.group_failed',
      text: '暗骰结果私聊发送失败，结果未在群内公开。请检查主动消息授权后重试。',
      deadline,
      condition: { part: 1, status: 'failed' },
    },
  ];

  return {
    results,
    updates: decision.updates,
    replies,
    logItems: decision.logItems,
  };
}

async function helpHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const arg = input.args[0]?.trim();
  const fullArg = input.args.join(' ').trim();

  let text = '';

  if (!arg) {
    text =
      'DiceFunc 0.1.0\n' +
      '开源地址: https://github.com/arcat0v0/dicefunc\n' +
      '========\n' +
      '.help 骰点/骰主/协议/娱乐/跑团/扩展/查询/其他\n' +
      '========\n' +
      '跑团机器人已就绪。';
  } else {
    const lower = arg.toLowerCase();
    if (lower === 'help' || arg === '帮助') {
      text =
        '帮助指令，用于查看指令帮助和helpdoc中录入的信息:\n' +
        '.help // 查看本帮助\n' +
        '.help 指令 // 查看某指令信息\n' +
        '.help 扩展模块 // 查看扩展信息，如.help coc7\n' +
        '.help 关键字 // 查看任意帮助，同.find\n' +
        '.help reload // 重新加载帮助文档，需要Master权限';
    } else if (lower === 'reload') {
      text = context.snapshot.permissions.isDiceMaster
        ? '帮助文档已经重新装载'
        : '你不具备Master权限';
    } else if (arg === '骰点') {
      text =
        '.help 骰点：\n' +
        ' .r  //丢一个100面骰\n' +
        '.r d10 //丢一个10面骰(数字可改)\n' +
        '.r 3d6 //丢3个6面骰(数字可改)\n' +
        '.ra 侦查 //侦查技能检定\n' +
        '.ra 侦查+10 //技能临时加值检定\n' +
        '.ra 3#p 射击 // 连续射击三次';
    } else if (arg === '跑团') {
      text =
        '.help 跑团：\n' +
        '.st 力量50 //载入技能/属性\n' +
        '.coc // coc7版人物做成\n' +
        '.dnd // dnd5版任务做成\n' +
        '.pc new <角色名> // 创建角色并自动绑卡，无角色名则为当前\n' +
        '.pc tag <角色名> // 当前群绑卡/解除绑卡(不填角色名)\n' +
        '.pc save <角色名> // 保存角色[不绑卡时需要手动保存]，无角色名则为当前\n' +
        '.pc load <角色名> // 加载角色[不绑卡]，无角色名则为当前\n' +
        '.pc list //列出当前角色\n' +
        '.pc del <角色名> //删除角色\n' +
        '.setcoc 2 //设置为coc2版房规\n' +
        '.nn 张三 //将自己的角色名设置为张三';
    } else if (arg === '扩展') {
      text =
        '.help 扩展：\n' +
        '扩展功能可以让你开关部分指令。\n' +
        '例如你希望你的骰子是纯TRPG骰，那么可以通过.ext xxx off关闭一系列娱乐模块。\n' +
        '或者目前正在进行dnd5e游戏，你可以通过如下指令开关dnd特化扩展。COC亦然。\n' +
        '注意一点，不同扩展允许存在同名指令，例如dnd和coc都有st和rc，但他们本质上不是同一个指令，并不通用，还请注意。\n\n' +
        '.ext coc7 on // 打开coc7版扩展\n' +
        '.ext dnd5e off // 关闭dnd5版扩展\n\n' +
        '.ext dnd5e on // 打开dnd5版扩展\n' +
        '.ext coc7 off // 关闭coc7版扩展';
    } else if (arg === '骰主' || arg === '骰主信息') {
      text = '骰主很神秘，什么都没有说——';
    } else if (arg === '协议' || arg === '使用协议') {
      text =
        '请在遵守以下规则前提下使用:\n' +
        '1. 遵守国家法律法规\n' +
        '2. 在跑团相关群进行使用\n' +
        '3. 不要随意踢出、禁言、刷屏\n' +
        '4. 务必信任骰主，有事留言\n' +
        '如不同意使用.bot bye使其退群，谢谢。\n' +
        '祝玩得愉快。';
    } else if (arg === '娱乐') {
      text = '帮助:娱乐\n.gugu // 随机召唤一只鸽子\n.jrrp 今日人品';
    } else if (arg === '其他' || arg === '其它') {
      text =
        '帮助:其他\n' +
        '.find 克苏鲁星之眷族 //查找对应怪物资料\n' +
        '.find 70尺 法术 // 查找关联资料（仅在全文搜索开启时可用）';
    } else if (arg === '查询') {
      text = '查询指令：\n' + '.find <关键字> // 查找规则百科\n' + '例：.find 力量 或 .find 狂暴';
    } else if (arg === '指令') {
      text =
        '核心指令列表:\n' +
        '.r / .rh // 掷骰与暗骰\n' +
        '.ra / .rc // 技能与属性检定\n' +
        '.st // 属性与角色卡管理\n' +
        '.pc // 角色卡切换与绑定\n' +
        '.nn // 昵称设置\n' +
        '.coc / .dnd // 制卡指令\n' +
        '.sc / .en // 理智检定与技能成长\n' +
        '.hp / .init / .ss / .ds // DND战斗与状态管理\n' +
        '.set / .bot // 群规则与服务开关\n' +
        '.log // 跑团日志\n' +
        '.draw / .deck // 牌堆抽牌\n' +
        '.jrrp / .gugu / .name // 娱乐指令\n' +
        '.find / .modu // 规则与模组查询\n' +
        '输入 .help <指令名> 查看对应指令详情';
    } else if (lower === 'r' || lower === 'roll' || lower === 'rd') {
      text = '.r <表达式> [<原因>] // 骰点指令\n.rh <表达式> <原因> // 暗骰';
    } else if (lower === 'rh' || lower === 'rhd' || lower === 'rdh') {
      text = '.rh <表达式> <原因> // 暗骰';
    } else if (lower === 'rhbind') {
      text =
        '暗骰私聊绑定：\n' +
        '.rhbind // 查看当前绑定状态\n' +
        '.rhbind on // 启用当前群私聊暗骰绑定\n' +
        '.rhbind off // 关闭当前群私聊暗骰绑定';
    } else if (lower === 'ra' || lower === 'rc' || lower === 'check') {
      text =
        '检定指令:\n' +
        '.ra/rc <属性表达式> // 属性检定指令，当前者小于等于后者，检定通过\n' +
        '.ra <难度><属性> // 如 .ra 困难侦查\n' +
        '.ra b <属性表达式> // 奖励骰或惩罚骰\n' +
        '.ra p <属性表达式>';
    } else if (lower === 'st' || lower === 'cst' || lower === 'dst') {
      text =
        '属性与角色卡设置:\n' +
        '.st 力量50 // 载入技能/属性\n' +
        '.st show // 展示个人属性\n' +
        '.st clr // 清除属性\n' +
        '.st help // 查看详细帮助';
    } else if (lower === 'nn' || lower === 'nick') {
      text =
        '角色名设置:\n' +
        '.nn // 查看当前角色名\n' +
        '.nn <角色名> // 改为指定角色名，若有卡片不会连带修改\n' +
        '.nn clr // 重置回群名片';
    } else if (lower === 'pc' || lower === 'char' || lower === 'ch') {
      text =
        '角色卡管理命令：\n' +
        '.pc new <角色名> - 创建并绑定新卡\n' +
        '.pc list - 查看当前绑定卡\n' +
        '.pc untag - 解除当前绑定';
    } else if (lower === 'coc' || lower === 'coc7' || lower === 'coc6') {
      text = 'COC制卡指令:\n.coc [<数量>] // 制卡指令，返回<数量>组人物属性';
    } else if (lower === 'dnd' || lower === 'dnd5e' || lower === 'dndx' || lower === 'dnd5ex') {
      text =
        'DND5E制卡指令:\n' +
        '.dnd [<数量>] // 制卡指令，返回<数量>组人物属性，最高为10次\n' +
        '.dndx [<数量>] // 制卡指令，但带有属性名，最高为10次';
    } else if (lower === 'bot') {
      text = '.bot on // 开启服务\n.bot off // 关闭服务';
    } else if (lower === 'set' || lower === 's') {
      text =
        '群设置指令:\n' +
        '.set rule <coc7|dnd5e> // 切换当前规则\n' +
        '.set sides <面数> // 设置群默认骰子面数';
    } else if (lower === 'setcoc') {
      text =
        '.setcoc 0-5 // 设置常见的0-5房规\n' +
        '.setcoc dg // delta green 扩展规则\n' +
        '.setcoc details // 列出所有规则及其解释文本';
    } else if (lower === 'sc' || lower === 'sancheck') {
      text =
        '理智检定指令：\n' +
        '.sc <成功掉san>/<失败掉san> [san值]\n' +
        '.sc <失败掉san> [san值]\n' +
        '例：.sc 1/1d6 或 .sc 1d3';
    } else if (lower === 'en') {
      text =
        '技能成长指令：\n' +
        '.en <技能名> [技能点数] [+<成长值>]\n' +
        '例：.en 侦查 或 .en 侦查 70 或 .en 侦查 +1d10';
    } else if (lower === 'hp') {
      text =
        'HP 管理命令：\n' +
        '.hp - 查看生命值\n' +
        '.hp -<伤害> - 扣除生命值\n' +
        '.hp +<治疗> - 恢复生命值\n' +
        '.hp temp <数值> - 设定临时生命值\n' +
        '.hp max <数值> - 设定最大生命值';
    } else if (lower === 'log') {
      text =
        '跑团日志管理：\n' +
        '.log new <日志名> - 新建并开启日志\n' +
        '.log on - 恢复记录\n' +
        '.log pause - 暂停记录\n' +
        '.log end - 关闭日志\n' +
        '.log stat - 查看当前状态';
    } else if (lower === 'draw') {
      text =
        '牌堆命令：\n' +
        '.draw [牌堆名] [张数] - 从牌堆抽牌 (默认塔罗牌)\n' +
        '.deck list - 查看可用牌堆\n' +
        '.deck reset [牌堆名] - 重置牌堆洗牌';
    } else if (lower === 'deck') {
      text =
        '牌堆命令：\n' + '.deck list // 查看可用牌堆\n' + '.deck reset [牌堆名] // 重置牌堆洗牌';
    } else if (lower === 'init' || lower === 'ri' || lower === 'initiative') {
      text =
        '先攻管理：\n' +
        '.init // 查看先攻列表\n' +
        '.init <先攻值> // 加入先攻\n' +
        '.ri <技能表达式> // 掷骰加入先攻\n' +
        '.init clr // 清空先攻列表';
    } else if (lower === 'ss' || lower === 'spell' || lower === 'spellslots') {
      text =
        '法术位管理：\n' +
        '.ss // 查看当前法术位\n' +
        '.ss set <环阶> <当前值>/<最大值> // 设置法术位\n' +
        '.ss use <环阶> // 消耗法术位\n' +
        '.ss reset // 恢复所有法术位';
    } else if (lower === 'ds' || arg === '死亡豁免') {
      text =
        '死亡豁免检定：\n' +
        '.ds // 进行一次死亡豁免检定\n' +
        '.ds status // 查看当前豁免状态\n' +
        '.ds reset // 重置死亡豁免状态';
    } else if (lower === 'longrest' || lower === 'rest') {
      text = '.longrest // 进行一次长休并恢复全部HP与法术位';
    } else if (lower === 'jrrp') {
      text = '.jrrp // 今日人品';
    } else if (lower === 'gugu') {
      text = '.gugu // 随机召唤一只鸽子';
    } else if (lower === 'name') {
      text = '.name // 生成一个随机姓名';
    } else if (lower === 'namednd') {
      text = 'DND名字生成：\n' + '.namednd [精灵/矮人/兽人] [<数量>]\n' + '例：.namednd 精灵 3';
    } else if (lower === 'modu' || arg === '魔都') {
      text = '魔都模组网查询：\n' + '.modu <关键字> // 搜索模组\n' + '.modu help // 查看帮助';
    } else if (lower === 'find') {
      text = '查询指令：\n' + '.find <关键字> // 查找规则百科\n' + '例：.find 力量 或 .find 狂暴';
    } else if (lower === 'userid' || lower === 'uid' || lower === 'id') {
      text = '.userid // 查看自己的用户ID与场景标识';
    } else if (lower === 'ti') {
      text = '.ti // 临时疯狂症状检定';
    } else if (lower === 'li') {
      text = '.li // 总结疯狂症状检定';
    } else {
      const { matches } = searchRuleGlossary(fullArg, 3);
      if (matches.length > 0) {
        const entries = matches.map((m) => `📖 【${m.title}】\n${m.content}`);
        text = `查询「${fullArg}」的结果：\n\n${entries.join('\n\n')}`;
      } else {
        text = '未找到搜索结果';
      }
    }
  }
  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: context.snapshot.conversation.scene,
    targetId: context.snapshot.conversation.externalId,
    originMessageId: input.messageId,
    templateKey: 'system.help',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'help',
        ruleVersion: '1.0.0',
        data: { text },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function setHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);

  if (input.args.length === 0) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: context.snapshot.conversation.scene,
      targetId: context.snapshot.conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'set.usage',
      text: 'Usage: .set <面数> OR .set <coc/dnd> OR .set clr OR .set rule <coc7|dnd5e>',
      deadline,
    };
    return {
      results: [],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  const conv = context.snapshot.conversation;
  const changes: {
    ruleSet?: string | undefined;
    diceSides?: number | undefined;
    enabled?: boolean | undefined;
  } = {};
  let confirmationText = '';

  const firstArg = input.args[0]?.toLowerCase().trim() ?? '';

  if (input.args.length === 1) {
    if (firstArg === 'clr' || firstArg === 'clear') {
      changes.diceSides = 100;
      confirmationText = 'Default dice sides reset to 100';
    } else if (firstArg === 'coc' || firstArg === 'coc7') {
      changes.ruleSet = 'coc7';
      confirmationText = 'Rule set changed to coc7';
    } else if (firstArg === 'dnd' || firstArg === 'dnd5e') {
      changes.ruleSet = 'dnd5e';
      confirmationText = 'Rule set changed to dnd5e';
    } else {
      const sides = Number.parseInt(firstArg, 10);
      if (!Number.isNaN(sides) && sides > 0) {
        changes.diceSides = sides;
        confirmationText = `Default dice sides set to ${sides}`;
      } else {
        const reply: PreparedReply = {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'set.error',
          text: `Invalid setting argument: ${firstArg}`,
          deadline,
        };
        return {
          results: [],
          updates: [],
          replies: [reply],
          logItems: [],
        };
      }
    }
  } else {
    const [subKeyRaw, subValue = ''] = input.args;
    const subKey = subKeyRaw?.toLowerCase();

    if (subKey === 'rule') {
      changes.ruleSet = subValue;
      confirmationText = `Rule set changed to ${subValue}`;
    } else if (subKey === 'sides' || subKey === 'dicesides') {
      const sides = Number.parseInt(subValue, 10);
      if (Number.isNaN(sides) || sides <= 0) {
        const reply: PreparedReply = {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'set.error',
          text: `Invalid dice sides: ${subValue}`,
          deadline,
        };
        return {
          results: [],
          updates: [],
          replies: [reply],
          logItems: [],
        };
      }
      changes.diceSides = sides;
      confirmationText = `Default dice sides set to ${sides}`;
    } else {
      const reply: PreparedReply = {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'set.unknown_key',
        text: `Unknown setting key: ${subKey}`,
        deadline,
      };
      return {
        results: [],
        updates: [],
        replies: [reply],
        logItems: [],
      };
    }
  }
  const update: StateUpdate = {
    type: 'conversation-settings',
    conversationId: conv.id,
    expectedVersion: conv.version,
    changes,
    newVersion: conv.version + 1,
  };

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'set.success',
    text: confirmationText,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'set_setting',
        ruleVersion: '1.0.0',
        data: changes,
      },
    ],
    updates: [update],
    replies: [reply],
    logItems: [],
  };
}

async function botHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const sub = input.args[0]?.toLowerCase();
  const conv = context.snapshot.conversation;

  if (sub !== 'on' && sub !== 'off') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'bot.usage',
      text: 'Usage: .bot on OR .bot off',
      deadline,
    };
    return {
      results: [],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  const nextEnabled = sub === 'on';
  const update: StateUpdate = {
    type: 'conversation-settings',
    conversationId: conv.id,
    expectedVersion: conv.version,
    changes: {
      enabled: nextEnabled,
    },
    newVersion: conv.version + 1,
  };

  const text = nextEnabled
    ? 'Bot has been enabled in this conversation.'
    : 'Bot has been disabled in this conversation.';

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: nextEnabled ? 'bot.enabled' : 'bot.disabled',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'bot_toggle',
        ruleVersion: '1.0.0',
        data: { enabled: nextEnabled },
      },
    ],
    updates: [update],
    replies: [reply],
    logItems: [],
  };
}

async function useridHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const text = `User External ID: ${conv.externalId}\nScene: ${conv.scene}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'user.id',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'userid',
        ruleVersion: '1.0.0',
        data: { scene: conv.scene, externalId: conv.externalId },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}
async function stHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const args = input.args;

  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    if (!sheet) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'character.sheet.unbound',
            text: '未绑定角色卡，请先使用 .pc new <角色名> 创建或 .pc load 绑定角色卡。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const requestedAttrs = args[0] === 'show' || args[0] === 'list' ? args.slice(1) : args;
    let text = '';
    if (requestedAttrs.length === 1 && /^\d+$/.test(requestedAttrs[0] ?? '')) {
      const threshold = Number.parseInt(requestedAttrs[0] ?? '0', 10);
      const filtered = Object.entries(sheet.attributes).filter(([_, v]) => v >= threshold);
      text = `「${sheet.name}」的属性 (≥${threshold})：\n${filtered.length > 0 ? filtered.map(([k, v]) => `${k}: ${v}`).join(', ') : '(无符合条件属性)'}`;
    } else if (requestedAttrs.length > 0) {
      const items = requestedAttrs.map((k) => `${k}: ${sheet.attributes[k] ?? '未设置'}`);
      text = `「${sheet.name}」的属性：${items.join(', ')}`;
    } else {
      const entries = Object.entries(sheet.attributes);
      const attrsStr =
        entries.length > 0 ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : '(无属性)';
      text = `「${sheet.name}」的属性：\n${attrsStr}`;
    }
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.attributes.show',
          ruleVersion: '1.0.0',
          data: { sheetId: sheet.id, name: sheet.name, attributes: sheet.attributes },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.attributes.show',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (args[0] === 'clr' || args[0] === 'clear') {
    if (!sheet) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'character.sheet.unbound',
            text: '未绑定角色卡，无法清空属性。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: {} },
      newVersion: sheet.version + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.attributes.clear',
          ruleVersion: '1.0.0',
          data: { sheetId: sheet.id },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.attributes.clear',
          text: `「${sheet.name}」的属性已清空。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (args[0] === 'rm' || args[0] === 'del') {
    if (!sheet) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'character.sheet.unbound',
            text: '未绑定角色卡，无法删除属性。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const toRemove = args.slice(1);
    const nextAttrs = { ...sheet.attributes };
    for (const key of toRemove) {
      delete nextAttrs[key];
    }

    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: nextAttrs },
      newVersion: sheet.version + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.attributes.remove',
          ruleVersion: '1.0.0',
          data: { sheetId: sheet.id, removed: toRemove },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.attributes.remove',
          text: `「${sheet.name}」已删除属性：${toRemove.join(', ')}。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const rawText = args.join(' ');
  const regex =
    /([\u4e00-\u9fa5a-zA-Z0-9_]+)\s*([:+=-]?)\s*([+-]?\d*d\d*(?:[a-zA-Z\u4e00-\u9fa5]+\d*)?|-?\d+)/gi;
  const changes: Record<string, number> = {};
  const changeDescriptions: string[] = [];
  const currentAttrs = sheet ? { ...sheet.attributes } : {};

  let match: RegExpExecArray | null = regex.exec(rawText);
  while (match !== null) {
    const key = match[1];
    const op = match[2];
    const valStr = match[3] ?? '0';
    if (key) {
      const prev = currentAttrs[key] ?? 0;
      let val = 0;
      if (/[dD]/.test(valStr)) {
        const parsed = parseDiceExpression(valStr);
        if (parsed.success && parsed.expression) {
          const evalRes = await evaluateAst(parsed.expression.ast, context.random);
          val = evalRes.value;
        }
      } else {
        val = Number.parseInt(valStr, 10);
      }
      if (!Number.isNaN(val)) {
        let nextVal = val;
        if (op === '+') {
          nextVal = prev + val;
          changeDescriptions.push(
            /[dD]/.test(valStr)
              ? `${key}: ${prev} ➯ ${nextVal} (+${valStr}=${val})`
              : `${key}: ${nextVal}`,
          );
        } else if (op === '-') {
          nextVal = prev - val;
          changeDescriptions.push(
            /[dD]/.test(valStr)
              ? `${key}: ${prev} ➯ ${nextVal} (-${valStr}=${val})`
              : `${key}: ${nextVal}`,
          );
        } else {
          nextVal = val;
          changeDescriptions.push(`${key}: ${nextVal}`);
        }
        currentAttrs[key] = nextVal;
        changes[key] = nextVal;
      }
    }
    match = regex.exec(rawText);
  }
  if (changeDescriptions.length === 0) {
    return {
      results: [],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.attributes.invalid',
          text: '未能识别属性变更，格式示例：.st 力量 60 敏捷 70 或 .st HP+2',
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const updates: StateUpdate[] = [];
  let sheetName = sheet?.name ?? '新角色';

  if (!sheet) {
    const senderId = input.sender?.externalId ?? 'unknown';
    const sheetId = `sheet_${context.botId}_${senderId}_${Date.now()}`;
    sheetName = `角色_${senderId.slice(-4) || '1'}`;
    updates.push({
      type: 'character-sheet',
      sheetId,
      expectedVersion: 0,
      changes: {
        name: sheetName,
        attributes: currentAttrs,
        ownerPrincipal: senderId,
        ruleSet: conv.ruleSet,
      },
      newVersion: 1,
    });
    updates.push({
      type: 'character-binding',
      conversationId: conv.id,
      principalId: context.snapshot.principalId ?? senderId,
      expectedVersion: context.snapshot.characterBinding?.version ?? 0,
      changes: { sheetId },
      newVersion: (context.snapshot.characterBinding?.version ?? 0) + 1,
    });
  } else {
    updates.push({
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: currentAttrs },
      newVersion: sheet.version + 1,
    });
  }

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'character.attributes.set',
        ruleVersion: '1.0.0',
        data: { name: sheetName, changes },
      },
    ],
    updates,
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'character.attributes.set',
        text: `「${sheetName}」属性变更：${changeDescriptions.join(', ')}`,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function pcHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const args = input.args;
  const sub = args[0]?.toLowerCase();

  if (sub === 'new') {
    const name = args.slice(1).join(' ').trim() || '未命名角色';
    const senderId = input.sender?.externalId ?? 'unknown';
    const sheetId = `sheet_${context.botId}_${senderId}_${Date.now()}`;
    const currentVer = context.snapshot.characterBinding?.version ?? 0;
    const updates: StateUpdate[] = [
      {
        type: 'character-sheet',
        sheetId,
        expectedVersion: 0,
        changes: {
          name,
          attributes: {},
          ownerPrincipal: senderId,
          ruleSet: conv.ruleSet,
        },
        newVersion: 1,
      },
      {
        type: 'character-binding',
        conversationId: conv.id,
        principalId: context.snapshot.principalId ?? senderId,
        expectedVersion: currentVer,
        changes: { sheetId },
        newVersion: currentVer + 1,
      },
    ];

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.create',
          ruleVersion: '1.0.0',
          data: { sheetId, name },
        },
      ],
      updates,
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.create',
          text: `已创建并绑定新角色卡「${name}」(ID: ${sheetId})。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'untag' || sub === 'release' || sub === 'unbind') {
    const currentVer = context.snapshot.characterBinding?.version ?? 0;
    const senderId = input.sender?.externalId ?? 'unknown';
    const updates: StateUpdate[] = [
      {
        type: 'character-binding',
        conversationId: conv.id,
        principalId: context.snapshot.principalId ?? senderId,
        expectedVersion: currentVer,
        changes: { sheetId: null },
        newVersion: currentVer + 1,
      },
    ];

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.unbind',
          ruleVersion: '1.0.0',
          data: { previousSheetId: sheet?.id ?? null },
        },
      ],
      updates,
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.unbind',
          text: '已解除当前会话的角色卡绑定。',
          deadline,
        },
      ],
      logItems: [],
    };
  }
  if (sub === 'save') {
    if (!sheet) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'character.sheet.unbound',
            text: '未绑定角色卡，无法保存快照。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const saveName = args.slice(1).join(' ').trim() || sheet.name;
    const senderId = input.sender?.externalId ?? 'unknown';
    const snapshotSheetId = `sheet_${context.botId}_${senderId}_${saveName}`;
    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: snapshotSheetId,
      expectedVersion: 0,
      changes: {
        name: saveName,
        attributes: { ...sheet.attributes },
        ownerPrincipal: senderId,
        ruleSet: sheet.ruleSet,
      },
      newVersion: 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.save',
          ruleVersion: '1.0.0',
          data: { sheetId: snapshotSheetId, name: saveName },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.save',
          text: `已保存角色卡「${saveName}」(ID: ${snapshotSheetId}) 快照。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'load') {
    const target = args.slice(1).join(' ').trim();
    if (!target) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'character.load.help',
            text: '请指定要载入的角色卡名称或ID：.pc load <卡名/ID>',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const senderId = input.sender?.externalId ?? 'unknown';
    const currentVer = context.snapshot.characterBinding?.version ?? 0;
    const sheetId = target.startsWith('sheet_')
      ? target
      : `sheet_${context.botId}_${senderId}_${target}`;

    const update: StateUpdate = {
      type: 'character-binding',
      conversationId: conv.id,
      principalId: context.snapshot.principalId ?? senderId,
      expectedVersion: currentVer,
      changes: { sheetId },
      newVersion: currentVer + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.load',
          ruleVersion: '1.0.0',
          data: { sheetId, name: target },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.load',
          text: `已将当前会话绑定至角色卡「${target}」(ID: ${sheetId})。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'list' || sub === 'show' || !sub) {
    const text = sheet
      ? `当前绑定角色卡：「${sheet.name}」(ID: ${sheet.id})`
      : '当前未绑定角色卡。使用 .pc new <角色名> 创建或 .pc load <卡名/ID> 绑定。';

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.list',
          ruleVersion: '1.0.0',
          data: { sheetId: sheet?.id ?? null, name: sheet?.name ?? null },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.list',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  return {
    results: [],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'character.help',
        text: '角色卡管理命令：\n.pc new <角色名> - 创建并绑定新卡\n.pc list - 查看当前绑定卡\n.pc untag - 解除当前绑定',
        deadline,
      },
    ],
    logItems: [],
  };
}

async function nnHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const defaultName = input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const currentName = sheet?.name ?? defaultName;
  const sub = input.args[0]?.trim();

  if (!sub) {
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.nn',
          ruleVersion: '1.0.0',
          data: { name: currentName },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.nn_current',
          text: `玩家的当前昵称为: <${currentName}>`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub.toLowerCase() === 'help') {
    const helpText =
      '角色名设置:\n' +
      '.nn // 查看当前角色名\n' +
      '.nn <角色名> // 改为指定角色名，若有卡片不会连带修改\n' +
      '.nn clr // 重置回群名片';
    return {
      results: [],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.nn_help',
          text: helpText,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub.toLowerCase() === 'clr' || sub.toLowerCase() === 'reset') {
    const updates: StateUpdate[] = [];
    if (sheet) {
      updates.push({
        type: 'character-sheet',
        sheetId: sheet.id,
        expectedVersion: sheet.version,
        changes: {
          name: defaultName,
        },
        newVersion: sheet.version + 1,
      });
    }
    const text = `<${currentName}>(${senderId.slice(-4)})的昵称已重置为<${defaultName}>`;
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.nn',
          ruleVersion: '1.0.0',
          data: { oldName: currentName, newName: defaultName },
        },
      ],
      updates,
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.nn_reset',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const newName = sub;
  const updates: StateUpdate[] = [];
  if (sheet) {
    updates.push({
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: {
        name: newName,
      },
      newVersion: sheet.version + 1,
    });
  } else {
    const principalId = context.snapshot.principalId ?? senderId;
    const currentVer = context.snapshot.characterBinding?.version ?? 0;
    const newSheetId = `sheet_${senderId}_${input.timestamp.getTime()}`;
    updates.push({
      type: 'character-sheet',
      sheetId: newSheetId,
      expectedVersion: 0,
      changes: {
        name: newName,
        ownerPrincipal: senderId,
        ruleSet: conv.ruleSet,
        attributes: {},
      },
      newVersion: 1,
    });
    updates.push({
      type: 'character-binding',
      conversationId: conv.id,
      principalId,
      expectedVersion: currentVer,
      changes: { sheetId: newSheetId },
      newVersion: currentVer + 1,
    });
  }
  const text = `<${currentName}>(${senderId.slice(-4)})的昵称被设定为<${newName}>`;
  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'character.nn',
        ruleVersion: '1.0.0',
        data: { oldName: currentName, newName },
      },
    ],
    updates,
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'character.nn_set',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function logHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const activeLog = context.snapshot.activeStoryLog;
  const args = input.args;
  const sub = args[0]?.toLowerCase();

  if (sub === 'new') {
    if (activeLog && activeLog.status !== 'closed') {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'story_log.already_active',
            text: `当前已有未结束的跑团日志「${activeLog.name}」，请先使用 .log end 关闭后再新建。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const logName =
      args.slice(1).join(' ').trim() || `log_${new Date().toISOString().slice(0, 10)}`;
    const logId = `log_${conv.id}_${Date.now()}`;
    const update: StateUpdate = {
      type: 'story-log',
      logId,
      conversationId: conv.id,
      expectedVersion: 0,
      changes: {
        name: logName,
        status: 'recording',
      },
      newVersion: 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.new',
          ruleVersion: '1.0.0',
          data: { logId, name: logName },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.new',
          text: `已创建并开启跑团日志「${logName}」。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'pause' || sub === 'off') {
    if (!activeLog || activeLog.status === 'closed') {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'story_log.not_recording',
            text: '当前会话无进行中的跑团日志。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const update: StateUpdate = {
      type: 'story-log',
      logId: activeLog.id,
      conversationId: conv.id,
      expectedVersion: activeLog.version,
      changes: {
        name: activeLog.name,
        status: 'paused',
      },
      newVersion: activeLog.version + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.pause',
          ruleVersion: '1.0.0',
          data: { logId: activeLog.id },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.pause',
          text: `跑团日志「${activeLog.name}」已暂停记录。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'on' || sub === 'start' || sub === 'resume') {
    if (!activeLog || activeLog.status === 'closed') {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'story_log.not_found',
            text: '当前会话未开启跑团日志，请先使用 .log new <日志名> 创建。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const update: StateUpdate = {
      type: 'story-log',
      logId: activeLog.id,
      conversationId: conv.id,
      expectedVersion: activeLog.version,
      changes: {
        name: activeLog.name,
        status: 'recording',
      },
      newVersion: activeLog.version + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.resume',
          ruleVersion: '1.0.0',
          data: { logId: activeLog.id },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.resume',
          text: `跑团日志「${activeLog.name}」已恢复记录。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'end' || sub === 'stop') {
    if (!activeLog || activeLog.status === 'closed') {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'story_log.not_recording',
            text: '当前会话无进行中的跑团日志。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const update: StateUpdate = {
      type: 'story-log',
      logId: activeLog.id,
      conversationId: conv.id,
      expectedVersion: activeLog.version,
      changes: {
        name: activeLog.name,
        status: 'closed',
      },
      newVersion: activeLog.version + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.end',
          ruleVersion: '1.0.0',
          data: { logId: activeLog.id },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.end',
          text: `跑团日志「${activeLog.name}」已关闭，等待归档。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'stat' || sub === 'status') {
    if (!activeLog || activeLog.status === 'closed') {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'story_log.stat',
            text: '当前群未开启跑团日志。使用 .log new <日志名> 开启。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const statusMap = {
      new: '新建',
      recording: '记录中',
      paused: '已暂停',
      closed: '已关闭',
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.stat',
          ruleVersion: '1.0.0',
          data: { log: activeLog },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.stat',
          text: `跑团日志「${activeLog.name}」状态：${statusMap[activeLog.status]} (版本: ${activeLog.version})`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  return {
    results: [],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'story_log.help',
        text: '跑团日志管理：\n.log new <日志名> - 新建并开启日志\n.log on - 恢复记录\n.log pause - 暂停记录\n.log end - 关闭日志\n.log stat - 查看当前状态',
        deadline,
      },
    ],
    logItems: [],
  };
}

async function checkHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const args = input.args;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  if (conv.ruleSet === 'dnd5e') {
    let skillName = '检定';
    let dc: number | undefined;

    if (args.length === 1) {
      const maybeDc = Number.parseInt(args[0] ?? '', 10);
      if (!Number.isNaN(maybeDc)) {
        dc = maybeDc;
      } else {
        skillName = args[0] ?? '检定';
      }
    } else if (args.length >= 2) {
      skillName = args[0] ?? '检定';
      const maybeDc = Number.parseInt(args[1] ?? '', 10);
      if (!Number.isNaN(maybeDc)) {
        dc = maybeDc;
      }
    }

    const attrScore = sheet?.attributes[skillName] ?? 10;
    const modifier = Math.floor((attrScore - 10) / 2);
    const d20Rolls = await rollDice(20, 1, context.random);
    const d20 = d20Rolls[0] ?? 10;
    const total = d20 + modifier;
    const sign = modifier >= 0 ? `+ ${modifier}` : `- ${Math.abs(modifier)}`;

    let outcomeText = '';
    if (dc !== undefined) {
      outcomeText = total >= dc ? '成功' : '失败';
    }

    const text = `${actorName} 进行 ${skillName} 检定：1D20(${d20}) ${sign} = ${total}${dc !== undefined ? ` (DC: ${dc}，${outcomeText})` : ''}`;

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.check',
          ruleVersion: '1.0.0',
          data: {
            actor: actorName,
            skill: skillName,
            d20,
            modifier,
            total,
            dc: dc ?? null,
            success: dc !== undefined ? total >= dc : true,
          },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.check',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  let skillName = '检定';
  let targetValue: number | undefined;
  let bonusDice = 0;

  for (const arg of args) {
    if (/^[bB]\d+$/.test(arg)) {
      bonusDice = Number.parseInt(arg.slice(1), 10);
      continue;
    }
    if (/^[pP]\d+$/.test(arg)) {
      bonusDice = -Number.parseInt(arg.slice(1), 10);
      continue;
    }
    const num = Number.parseInt(arg, 10);
    if (!Number.isNaN(num)) {
      targetValue = num;
    } else {
      skillName = arg;
    }
  }

  if (targetValue === undefined && sheet) {
    targetValue = sheet.attributes[skillName];
  }
  if (targetValue === undefined) {
    targetValue = 50;
  }

  const isRc = input.commandName.toLowerCase() === 'rc';
  const ruleId = isRc ? '0' : (conv.cocRule ?? '0');
  const checkResult = await performCocCheck(
    {
      character: sheet,
      skillName,
      targetValue,
      bonusDice,
      ruleId,
    },
    context.random,
  );

  const levelCnMap: Record<string, string> = {
    critical: '大成功',
    extreme: '极难成功',
    hard: '困难成功',
    regular: '常规成功',
    failure: '失败',
    fumble: '大失败',
  };
  const levelCn = levelCnMap[checkResult.level] ?? (checkResult.success ? '成功' : '失败');
  const text = `${actorName} 进行 ${skillName} 检定：1D100 = ${checkResult.rollTotal} / ${checkResult.targetValue}，${levelCn}！`;

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.check',
        ruleVersion: '1.0.0',
        data: {
          ...(checkResult as unknown as Record<string, unknown>),
          skill: { name: skillName },
          roll: { total: checkResult.rollTotal },
          target: { value: checkResult.targetValue },
        },
      },
    ],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: checkResult.success ? 'coc.check.success' : 'coc.check.failed',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}
async function initHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const args = input.args;
  const sub = args[0]?.toLowerCase();

  let currentEnc: CombatEncounterState;
  const rawEnc = context.snapshot.encounter;
  if (rawEnc && typeof rawEnc === 'object' && 'combatants' in rawEnc) {
    currentEnc = rawEnc as unknown as CombatEncounterState;
  } else if (rawEnc && typeof rawEnc === 'object' && 'state' in rawEnc && rawEnc.state) {
    currentEnc = rawEnc.state as CombatEncounterState;
  } else {
    currentEnc = createCombatEncounter({
      id: `enc_${conv.id}`,
      conversationId: conv.id,
      version: 1,
    });
  }

  if (sub === 'next') {
    const { encounter: nextEnc, currentCombatant, roundAdvanced } = advanceTurn(currentEnc);
    const update: StateUpdate = {
      type: 'encounter',
      encounterId: nextEnc.id,
      conversationId: conv.id,
      expectedVersion: currentEnc.version,
      changes: { state: nextEnc },
      newVersion: nextEnc.version,
    };

    const text = `已推进至第 ${nextEnc.round} 轮，当前回合：${currentCombatant ? `「${currentCombatant.name}」(先攻: ${currentCombatant.initiative})` : '无行动者'}${roundAdvanced ? ' (下一轮/回合)' : ''}`;

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.init.next',
          ruleVersion: '1.0.0',
          data: { round: nextEnc.round, current: currentCombatant?.name ?? null },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.init.next',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'end' || sub === 'clr' || sub === 'clear') {
    const nextEnc = resetEncounter(currentEnc);
    const update: StateUpdate = {
      type: 'encounter',
      encounterId: nextEnc.id,
      conversationId: conv.id,
      expectedVersion: currentEnc.version,
      changes: { state: nextEnc },
      newVersion: nextEnc.version,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.init.end',
          ruleVersion: '1.0.0',
          data: { encounterId: nextEnc.id },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.init.end',
          text: '战斗轮已结束，先攻列表已重置。',
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (
    sub === 'list' ||
    sub === 'show' ||
    (!sub && currentEnc.combatants.length > 0 && args.length === 0)
  ) {
    if (currentEnc.combatants.length === 0) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.init.empty',
            text: '当前战斗轮暂无参与者。使用 .ri 或 .init 加入战斗轮。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const currentActor = currentEnc.combatants[currentEnc.turnIndex];
    const lines = currentEnc.combatants.map(
      (c, i) => `${i === currentEnc.turnIndex ? '👉 ' : '   '}${c.name}: ${c.initiative}`,
    );
    const text = `第 ${currentEnc.round} 轮战斗 先攻列表：\n${lines.join('\n')}\n当前行动：${currentActor ? currentActor.name : '无'}`;

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.init.list',
          ruleVersion: '1.0.0',
          data: { round: currentEnc.round, combatants: currentEnc.combatants },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.init.list',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'set') {
    const targetName = args[1] ?? actorName;
    const targetVal = Number.parseInt(args[2] ?? '', 10);
    const finalVal = Number.isNaN(targetVal) ? 10 : targetVal;
    const nextEnc = addCombatant(currentEnc, {
      id: `actor_${targetName}`,
      name: targetName,
      initiative: finalVal,
    });
    const update: StateUpdate = {
      type: 'encounter',
      encounterId: nextEnc.id,
      conversationId: conv.id,
      expectedVersion: currentEnc.version,
      changes: { state: nextEnc },
      newVersion: nextEnc.version,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.init.set',
          ruleVersion: '1.0.0',
          data: { name: targetName, initiative: finalVal },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.init.set',
          text: `「${targetName}」先攻已设为 ${finalVal}，已加入战斗轮！`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  let modifier = 0;
  if (args.length > 0) {
    const rawMod = Number.parseInt(args[0] ?? '', 10);
    if (!Number.isNaN(rawMod)) {
      modifier = rawMod;
    }
  } else if (sheet) {
    const dexScore = sheet.attributes.敏捷 ?? sheet.attributes.dex ?? 10;
    modifier = Math.floor((dexScore - 10) / 2);
  }

  const d20Rolls = await rollDice(20, 1, context.random);
  const d20 = d20Rolls[0] ?? 10;
  const initiative = d20 + modifier;
  const nextEnc = addCombatant(currentEnc, { id: senderId, name: actorName, initiative });

  const update: StateUpdate = {
    type: 'encounter',
    encounterId: nextEnc.id,
    conversationId: conv.id,
    expectedVersion: currentEnc.version,
    changes: { state: nextEnc },
    newVersion: nextEnc.version,
  };

  const sign = modifier >= 0 ? `+ ${modifier}` : `- ${Math.abs(modifier)}`;
  const text = `「${actorName}」掷出先攻：1D20(${d20}) ${sign} = ${initiative}，已加入战斗轮！`;

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd5e.init.roll',
        ruleVersion: '1.0.0',
        data: { actor: actorName, d20, modifier, initiative },
      },
    ],
    updates: [update],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'dnd5e.init.roll',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function hpHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const args = input.args;

  if (!sheet) {
    return {
      results: [],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.sheet.unbound',
          text: '未绑定角色卡，请先使用 .pc new <角色名> 创建角色卡。',
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const currentHp = sheet.attributes.HP ?? sheet.attributes.hp ?? 20;
  const maxHp = sheet.attributes.MaxHP ?? sheet.attributes.maxhp ?? 20;
  const tempHp = sheet.attributes.TempHP ?? sheet.attributes.temphp ?? 0;

  const hpState: DndHpState = { currentHp, maxHp, tempHp };
  const rawArg = args.join(' ').trim();

  if (!rawArg) {
    const text = `「${sheet.name}」当前 HP: ${hpState.currentHp}/${hpState.maxHp}${hpState.tempHp > 0 ? ` (+${hpState.tempHp} 临时HP)` : ''}`;
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.hp.show',
          ruleVersion: '1.0.0',
          data: { name: sheet.name, ...hpState },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.hp.show',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (rawArg.startsWith('-')) {
    const dmg = Number.parseInt(rawArg.slice(1).trim(), 10);
    if (!Number.isNaN(dmg)) {
      const { nextState, effectiveDamage, tempHpAbsorbed } = applyDamage(hpState, dmg);
      const nextAttrs = {
        ...sheet.attributes,
        HP: nextState.currentHp,
        TempHP: nextState.tempHp,
        MaxHP: nextState.maxHp,
      };
      const update: StateUpdate = {
        type: 'character-sheet',
        sheetId: sheet.id,
        expectedVersion: sheet.version,
        changes: { attributes: nextAttrs },
        newVersion: sheet.version + 1,
      };

      const text = `「${sheet.name}」受到 ${dmg} 点伤害${tempHpAbsorbed > 0 ? ` (临时HP吸收 ${tempHpAbsorbed})` : ''}，当前 HP: ${nextState.currentHp}/${nextState.maxHp}${nextState.tempHp > 0 ? ` (+${nextState.tempHp})` : ''}`;

      return {
        results: [
          {
            executionId: input.executionId,
            kind: 'dnd5e.hp.damage',
            ruleVersion: '1.0.0',
            data: { damage: dmg, effectiveDamage, tempHpAbsorbed, ...nextState },
          },
        ],
        updates: [update],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.hp.damage',
            text,
            deadline,
          },
        ],
        logItems: [],
      };
    }
  }

  if (rawArg.startsWith('+')) {
    const heal = Number.parseInt(rawArg.slice(1).trim(), 10);
    if (!Number.isNaN(heal)) {
      const { nextState, effectiveHealing } = applyHealing(hpState, heal);
      const nextAttrs = {
        ...sheet.attributes,
        HP: nextState.currentHp,
        TempHP: nextState.tempHp,
        MaxHP: nextState.maxHp,
      };
      const update: StateUpdate = {
        type: 'character-sheet',
        sheetId: sheet.id,
        expectedVersion: sheet.version,
        changes: { attributes: nextAttrs },
        newVersion: sheet.version + 1,
      };

      const text = `「${sheet.name}」恢复 ${effectiveHealing} 点生命，当前 HP: ${nextState.currentHp}/${nextState.maxHp}`;

      return {
        results: [
          {
            executionId: input.executionId,
            kind: 'dnd5e.hp.heal',
            ruleVersion: '1.0.0',
            data: { heal, effectiveHealing, ...nextState },
          },
        ],
        updates: [update],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.hp.heal',
            text,
            deadline,
          },
        ],
        logItems: [],
      };
    }
  }

  if (args[0]?.toLowerCase() === 'temp') {
    const tempVal = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isNaN(tempVal)) {
      const nextState = setTempHp(hpState, tempVal);
      const nextAttrs = {
        ...sheet.attributes,
        TempHP: nextState.tempHp,
      };
      const update: StateUpdate = {
        type: 'character-sheet',
        sheetId: sheet.id,
        expectedVersion: sheet.version,
        changes: { attributes: nextAttrs },
        newVersion: sheet.version + 1,
      };

      return {
        results: [
          {
            executionId: input.executionId,
            kind: 'dnd5e.hp.temp',
            ruleVersion: '1.0.0',
            data: { tempHp: nextState.tempHp },
          },
        ],
        updates: [update],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.hp.temp',
            text: `「${sheet.name}」获得临时 HP: ${nextState.tempHp}`,
            deadline,
          },
        ],
        logItems: [],
      };
    }
  }

  if (args[0]?.toLowerCase() === 'max') {
    const maxVal = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isNaN(maxVal)) {
      const nextState = setMaxHp(hpState, maxVal);
      const nextAttrs = {
        ...sheet.attributes,
        MaxHP: nextState.maxHp,
        HP: nextState.currentHp,
      };
      const update: StateUpdate = {
        type: 'character-sheet',
        sheetId: sheet.id,
        expectedVersion: sheet.version,
        changes: { attributes: nextAttrs },
        newVersion: sheet.version + 1,
      };

      return {
        results: [
          {
            executionId: input.executionId,
            kind: 'dnd5e.hp.max',
            ruleVersion: '1.0.0',
            data: { maxHp: nextState.maxHp },
          },
        ],
        updates: [update],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.hp.max',
            text: `「${sheet.name}」最大生命值已设为 ${nextState.maxHp}`,
            deadline,
          },
        ],
        logItems: [],
      };
    }
  }

  return {
    results: [],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'dnd5e.hp.help',
        text: 'HP 管理命令：\n.hp - 查看生命值\n.hp -<伤害> - 扣除生命值\n.hp +<治疗> - 恢复生命值\n.hp temp <数值> - 设定临时生命值\n.hp max <数值> - 设定最大生命值',
        deadline,
      },
    ],
    logItems: [],
  };
}

async function spellSlotHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const args = input.args;

  if (!sheet) {
    return {
      results: [],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.sheet.unbound',
          text: '未绑定角色卡，请先使用 .pc new <角色名> 创建角色卡。',
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const sub = args[0]?.toLowerCase();
  const slots: Record<number, { level: number; total: number; used: number }> = {};
  for (let i = 1; i <= 9; i++) {
    const total = sheet.attributes[`法术位_${i}`] ?? 0;
    const used = sheet.attributes[`法术位_${i}_已用`] ?? 0;
    if (total > 0) {
      slots[i] = { level: i, total, used };
    }
  }

  if (sub === 'use') {
    const lvl = Number.parseInt(args[1] ?? '1', 10);
    const count = Number.parseInt(args[2] ?? '1', 10);
    const slot = slots[lvl];
    if (!slot || slot.total - slot.used < count) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.spell.insufficient',
            text: `「${sheet.name}」的 ${lvl} 环法术位不足（当前可用：${slot ? slot.total - slot.used : 0}）。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const nextAttrs = {
      ...sheet.attributes,
      [`法术位_${lvl}_已用`]: slot.used + count,
    };
    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: nextAttrs },
      newVersion: sheet.version + 1,
    };

    const remaining = slot.total - (slot.used + count);
    const text = `「${sheet.name}」消耗了 ${count} 个 ${lvl} 环法术位，剩余：${remaining}/${slot.total}`;

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.spell.use',
          ruleVersion: '1.0.0',
          data: { level: lvl, count, remaining },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'dnd5e.spell.use',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'set') {
    const lvl = Number.parseInt(args[1] ?? '', 10);
    const total = Number.parseInt(args[2] ?? '', 10);
    if (!Number.isNaN(lvl) && lvl >= 1 && lvl <= 9 && !Number.isNaN(total)) {
      const nextAttrs = {
        ...sheet.attributes,
        [`法术位_${lvl}`]: Math.max(0, total),
        [`法术位_${lvl}_已用`]: 0,
      };
      const update: StateUpdate = {
        type: 'character-sheet',
        sheetId: sheet.id,
        expectedVersion: sheet.version,
        changes: { attributes: nextAttrs },
        newVersion: sheet.version + 1,
      };

      return {
        results: [
          {
            executionId: input.executionId,
            kind: 'dnd5e.spell.set',
            ruleVersion: '1.0.0',
            data: { level: lvl, total },
          },
        ],
        updates: [update],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd5e.spell.set',
            text: `「${sheet.name}」${lvl} 环法术位已设定为 ${total} 个。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }
  }

  const lines: string[] = [];
  for (let i = 1; i <= 9; i++) {
    const slot = slots[i];
    if (slot && slot.total > 0) {
      lines.push(`${i}环: ${slot.total - slot.used}/${slot.total}`);
    }
  }

  const text =
    lines.length > 0
      ? `「${sheet.name}」法术位状态：\n${lines.join('  ')}`
      : `「${sheet.name}」暂无设定法术位。使用 .ss set <环阶> <数量> 进行设定。`;

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd5e.spell.show',
        ruleVersion: '1.0.0',
        data: { slots },
      },
    ],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'dnd5e.spell.show',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function longRestHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;

  if (!sheet) {
    return {
      results: [],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'character.sheet.unbound',
          text: '未绑定角色卡，无法长休。',
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const maxHp = sheet.attributes.MaxHP ?? sheet.attributes.maxhp ?? 20;
  const nextAttrs: Record<string, number> = {
    ...sheet.attributes,
    HP: maxHp,
    TempHP: 0,
  };

  for (let i = 1; i <= 9; i++) {
    if (nextAttrs[`法术位_${i}_已用`] !== undefined) {
      nextAttrs[`法术位_${i}_已用`] = 0;
    }
  }

  const update: StateUpdate = {
    type: 'character-sheet',
    sheetId: sheet.id,
    expectedVersion: sheet.version,
    changes: { attributes: nextAttrs },
    newVersion: sheet.version + 1,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd5e.longrest',
        ruleVersion: '1.0.0',
        data: { name: sheet.name, maxHp },
      },
    ],
    updates: [update],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'dnd5e.longrest',
        text: `「${sheet.name}」完成了长休：生命值完全恢复 (${maxHp}/${maxHp})，临时生命值已清空，所有法术位已完全恢复！`,
        deadline,
      },
    ],
    logItems: [],
  };
}
async function drawHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const args = input.args;

  let deckId = 'tarot';
  let count = 1;

  if (args.length === 1) {
    const num = Number.parseInt(args[0] ?? '', 10);
    if (!Number.isNaN(num)) {
      count = Math.max(1, Math.min(10, num));
    } else {
      deckId = args[0] ?? 'tarot';
    }
  } else if (args.length >= 2) {
    deckId = args[0] ?? 'tarot';
    const num = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isNaN(num)) {
      count = Math.max(1, Math.min(10, num));
    }
  }

  const deck = getBuiltinDeck(deckId) ?? getBuiltinDeck('tarot');
  if (!deck) {
    return {
      results: [],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'deck.not_found',
          text: `未找到牌堆「${deckId}」。使用 .deck list 查看可用牌堆。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const existing = context.snapshot.deckSessions?.[deck.id];
  let session: DeckSession;
  if (existing?.remaining && existing.remaining.length > 0) {
    session = {
      sessionId: existing.id,
      deckId: deck.id,
      remaining: existing.remaining as Card[],
      drawnCount: existing.drawnCount ?? 0,
      version: existing.version,
    };
  } else {
    session = createDeckSession(`deck_${conv.id}_${deck.id}`, deck);
  }

  const { session: nextSession, drawn } = await drawFromDeck(session, count, context.random);

  const update: StateUpdate = {
    type: 'deck-session',
    sessionId: nextSession.sessionId,
    expectedVersion: existing?.version ?? 0,
    changes: {
      remaining: [...nextSession.remaining],
      drawnCount: nextSession.drawnCount,
    },
    newVersion: nextSession.version,
  };

  const drawnLines = drawn.map((c) => `🎴 ${c.text}`).join('\n');
  const text = `「${actorName}」从「${deck.name}」中抽取了：\n${drawnLines}\n(剩余: ${nextSession.remaining.length} 张)`;

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'deck.draw',
        ruleVersion: '1.0.0',
        data: {
          deckId: deck.id,
          deckName: deck.name,
          drawn: drawn.map((c) => c.text),
          remaining: nextSession.remaining.length,
        },
      },
    ],
    updates: [update],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'deck.draw',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function deckHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const args = input.args;
  const sub = args[0]?.toLowerCase();

  if (sub === 'list') {
    const decks = listBuiltinDecks();
    const lines = decks.map((d) => `• ${d.id}: ${d.name} (${d.cards.length} 张)`);
    const text = `可用牌堆列表：\n${lines.join('\n')}\n使用 .draw <牌堆名> [张数] 进行抽牌。`;

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'deck.list',
          ruleVersion: '1.0.0',
          data: { decks: decks.map((d) => ({ id: d.id, name: d.name })) },
        },
      ],
      updates: [],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'deck.list',
          text,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'reset' || sub === 'reload') {
    const deckId = args[1]?.toLowerCase() ?? 'tarot';
    const deck = getBuiltinDeck(deckId);
    if (!deck) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'deck.not_found',
            text: `未找到牌堆「${deckId}」。使用 .deck list 查看可用牌堆。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const existing = context.snapshot.deckSessions?.[deck.id];
    const freshSession = createDeckSession(`deck_${conv.id}_${deck.id}`, deck);

    const update: StateUpdate = {
      type: 'deck-session',
      sessionId: freshSession.sessionId,
      expectedVersion: existing?.version ?? 0,
      changes: {
        remaining: [...freshSession.remaining],
        drawnCount: 0,
      },
      newVersion: (existing?.version ?? 0) + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'deck.reset',
          ruleVersion: '1.0.0',
          data: { deckId: deck.id, total: deck.cards.length },
        },
      ],
      updates: [update],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'deck.reset',
          text: `「${deck.name}」牌堆已重置洗牌，共有 ${deck.cards.length} 张卡牌。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  return {
    results: [],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'deck.help',
        text: '牌堆命令：\n.draw [牌堆名] [张数] - 从牌堆抽牌 (默认塔罗牌)\n.deck list - 查看可用牌堆\n.deck reset [牌堆名] - 重置牌堆洗牌',
        deadline,
      },
    ],
    logItems: [],
  };
}
async function cocHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const actorName =
    sheet?.name ?? input.sender?.name ?? `用户_${input.sender?.externalId.slice(-4) || '1'}`;
  const rawCount = input.args[0];
  let count = 1;
  if (rawCount !== undefined && rawCount !== '') {
    const parsed = Number.parseInt(rawCount, 10);
    if (Number.isNaN(parsed)) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'coc.help',
            text: 'COC制卡指令:\n.coc [<数量>] // 制卡指令，返回<数量>组人物属性',
            deadline,
          },
        ],
        logItems: [],
      };
    }
    count = Math.min(10, Math.max(1, parsed));
  }

  const cards: Coc7CardAttributes[] = [];
  for (let i = 0; i < count; i++) {
    cards.push(await generateCoc7Card(context.random));
  }

  const firstCard = cards[0];
  const text =
    count === 1 && firstCard
      ? formatCoc7CardSingle(actorName, firstCard)
      : formatCoc7CardBatch(actorName, cards);

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.card_gen',
        ruleVersion: '1.0.0',
        data: { count, cards },
      },
    ],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'coc.card_gen',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function dndHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const actorName =
    sheet?.name ?? input.sender?.name ?? `用户_${input.sender?.externalId.slice(-4) || '1'}`;
  const isModePreset =
    input.commandName.toLowerCase().startsWith('dndx') ||
    input.commandName.toLowerCase().startsWith('dnd5ex');
  const rawCount = input.args[0];
  let count = 1;
  if (rawCount !== undefined && rawCount !== '') {
    const parsed = Number.parseInt(rawCount, 10);
    if (Number.isNaN(parsed)) {
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'dnd.help',
            text: 'DND5E制卡指令:\n.dnd [<数量>] // 制卡指令，返回<数量>组人物属性，最高为10次\n.dndx [<数量>] // 制卡指令，但带有属性名，最高为10次',
            deadline,
          },
        ],
        logItems: [],
      };
    }
    count = Math.min(10, Math.max(1, parsed));
  }

  let text: string;
  if (isModePreset) {
    const cards: Dnd5eCardAttributes[] = [];
    for (let i = 0; i < count; i++) {
      cards.push(await generateDnd5eCard(context.random));
    }
    text = formatDnd5ePresetCard(actorName, cards);
  } else {
    const cards: Dnd5eFreeAllocationCard[] = [];
    for (let i = 0; i < count; i++) {
      cards.push(await generateDnd5eFreeCard(context.random));
    }
    text = formatDnd5eFreeCard(actorName, cards);
  }

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd.card_gen',
        ruleVersion: '1.0.0',
        data: { count, mode: isModePreset ? 'preset' : 'free' },
      },
    ],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'dnd.card_gen',
        text,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function scHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const args = input.args;

  if (args.length === 0 || args[0]?.toLowerCase() === 'help') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'coc.sc.help',
      text: '理智检定指令：\n.sc <成功掉san>/<失败掉san> [san值]\n.sc <失败掉san> [san值]\n例：.sc 1/1d6 或 .sc 1d3',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const exprArg = args[0] ?? '';
  let customSan: number | undefined;
  if (args.length > 1) {
    const maybeSan = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isNaN(maybeSan) && maybeSan >= 0) {
      customSan = maybeSan;
    }
  }

  const currentSan =
    customSan ?? sheet?.attributes.理智 ?? sheet?.attributes.SAN ?? sheet?.attributes.san ?? 50;

  let successLossExpr = '0';
  let failLossExpr = '1d6';

  if (exprArg.includes('/')) {
    const parts = exprArg.split('/');
    successLossExpr = parts[0]?.trim() || '0';
    failLossExpr = parts[1]?.trim() || '1d6';
  } else {
    failLossExpr = exprArg.trim();
  }

  const rollTotal = await context.random.integer(1, 100);
  const ruleId = conv.cocRule ?? '0';
  const { successRank } = resultCheckBase(ruleId, rollTotal, currentSan);
  const isSuccess = successRank > 0;

  const chosenExpr = isSuccess ? successLossExpr : failLossExpr;
  let sanLoss = 0;

  const parsedLoss = parseDiceExpression(chosenExpr, 6);
  if (parsedLoss.success && parsedLoss.expression) {
    const evalRes = await evaluateAst(parsedLoss.expression.ast, context.random);
    sanLoss = Math.max(0, evalRes.value);
  } else {
    const num = Number.parseInt(chosenExpr, 10);
    sanLoss = Number.isNaN(num) ? 0 : Math.max(0, num);
  }

  const sanNew = Math.max(0, currentSan - sanLoss);

  let madnessTip = '';
  if (sanNew === 0) {
    madnessTip = '\n提示：理智归零，已永久疯狂(可用.ti或.li抽取症状)';
  } else if (sanLoss >= 5) {
    madnessTip =
      '\n提示：单次损失理智超过5点，若智力检定(.ra 智力)通过，将进入临时性疯狂(可用.ti或.li抽取症状)';
  }

  const updates: StateUpdate[] = [];
  if (sheet) {
    const nextAttrs = { ...sheet.attributes };
    nextAttrs.理智 = sanNew;
    if (nextAttrs.SAN !== undefined) nextAttrs.SAN = sanNew;
    if (nextAttrs.san !== undefined) nextAttrs.san = sanNew;
    updates.push({
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: nextAttrs },
      newVersion: sheet.version + 1,
    });
  }

  const outcomeCn = isSuccess ? '成功' : '失败';
  const text = `${actorName} 的理智检定:\n1D100=${rollTotal}/${currentSan} ${outcomeCn}\n理智变化: ${currentSan} ➯ ${sanNew} (扣除${chosenExpr}=${sanLoss}点)${madnessTip}`;

  const result: CommandResult = {
    executionId: input.executionId,
    kind: 'coc.sc',
    ruleVersion: '1.0.0',
    data: {
      actor: actorName,
      roll: rollTotal,
      sanOld: currentSan,
      sanNew,
      sanLoss,
      success: isSuccess,
    },
  };

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'coc.sc',
    text,
    deadline,
  };

  return { results: [result], updates, replies: [reply], logItems: [] };
}

async function tiHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;

  const res = await rollMadnessSymptom('temporal', context.random);
  const text = `「${actorName}」的疯狂发作-即时症状:\n${res.expressionText}\n${res.description}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'coc.ti',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.ti',
        ruleVersion: '1.0.0',
        data: { actor: actorName, ...res },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function liHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;

  const res = await rollMadnessSymptom('summary', context.random);
  const text = `「${actorName}」的疯狂发作-总结症状:\n${res.expressionText}\n${res.description}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'coc.li',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.li',
        ruleVersion: '1.0.0',
        data: { actor: actorName, ...res },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function enHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const args = input.args;

  if (args.length === 0 || args[0]?.toLowerCase() === 'help') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'coc.en.help',
      text: '技能成长指令：\n.en <技能名> [技能点数] [+<成长值>]\n例：.en 侦查 或 .en 侦查 70 或 .en 侦查 +1d10',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  let skillName = args[0] ?? '';
  let customValue: number | undefined;
  let plusExpr = '1d10';

  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('+')) {
      plusExpr = arg.slice(1).trim() || '1d10';
    } else {
      const num = Number.parseInt(arg, 10);
      if (!Number.isNaN(num)) {
        customValue = num;
      }
    }
  }

  const matchPlus = skillName.match(/^(.*?)\+(\d*d\d+|\d+)$/);
  if (matchPlus?.[1] && matchPlus[2]) {
    skillName = matchPlus[1].trim();
    plusExpr = matchPlus[2].trim();
  }

  const currentValue = customValue ?? sheet?.attributes[skillName] ?? 50;
  const rollTotal = await context.random.integer(1, 100);

  const growthSuccess = rollTotal > 95 || rollTotal > currentValue;
  let increment = 0;

  if (growthSuccess) {
    const parsed = parseDiceExpression(plusExpr, 10);
    if (parsed.success && parsed.expression) {
      const evalRes = await evaluateAst(parsed.expression.ast, context.random);
      increment = Math.max(0, evalRes.value);
    } else {
      const n = Number.parseInt(plusExpr, 10);
      increment = Number.isNaN(n) ? await context.random.integer(1, 10) : Math.max(0, n);
    }
  }

  const newValue = currentValue + increment;

  const updates: StateUpdate[] = [];
  if (sheet && growthSuccess && increment > 0) {
    const nextAttrs = { ...sheet.attributes, [skillName]: newValue };
    updates.push({
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: nextAttrs },
      newVersion: sheet.version + 1,
    });
  }

  let resultDetail = '';
  if (growthSuccess) {
    resultDetail = `“${skillName}” 增加了 ${plusExpr}=${increment} 点，当前为 ${newValue} 点`;
  } else {
    resultDetail = `“${skillName}” 成长失败了！`;
  }

  const text = `「${actorName}」的“${skillName}”成长检定：\nD100=${rollTotal}/${currentValue} ${growthSuccess ? '成功' : '失败'}\n${resultDetail}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'coc.en',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.en',
        ruleVersion: '1.0.0',
        data: {
          actor: actorName,
          skill: skillName,
          roll: rollTotal,
          oldValue: currentValue,
          newValue,
          increment,
          success: growthSuccess,
        },
      },
    ],
    updates,
    replies: [reply],
    logItems: [],
  };
}

async function dsHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const args = input.args;
  const sub = args[0]?.trim();

  if (!sheet || (sheet.attributes.HP === undefined && sheet.attributes.hp === undefined)) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'dnd5e.ds.nohp',
      text: `${actorName} 未设置生命值，无法进行死亡豁免检定。`,
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const currentHp = sheet.attributes.HP ?? sheet.attributes.hp ?? 0;
  if (currentHp > 0) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'dnd5e.ds.alive',
      text: `${actorName} 生命值大于0(当前为${currentHp})，无法进行死亡豁免检定。`,
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  let dss = sheet.attributes.DSS ?? sheet.attributes.dss ?? 0;
  let dsf = sheet.attributes.DSF ?? sheet.attributes.dsf ?? 0;

  if (sub === 'stat') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'dnd5e.ds.stat',
      text: `${actorName} 当前的死亡豁免情况: 成功${dss} 失败${dsf}`,
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const manualMatch = sub?.match(/^(s|S|成功|f|F|失败)([+-＋－])(\d+)$/);
  if (manualMatch?.[1] && manualMatch[2] && manualMatch[3]) {
    const kind = manualMatch[1];
    const isNeg = manualMatch[2] === '-' || manualMatch[2] === '－';
    const val = Number.parseInt(manualMatch[3], 10) * (isNeg ? -1 : 1);
    if (kind === 's' || kind === 'S' || kind === '成功') {
      dss = Math.max(0, dss + val);
    } else {
      dsf = Math.max(0, dsf + val);
    }
    const { stable, dead } = deathSaveResultText({ successes: dss, failures: dsf });
    let exText = '';
    if (stable) {
      exText = '\n累计获得了3次死亡豁免检定成功，伤势稳定了！';
      dss = 0;
      dsf = 0;
    } else if (dead) {
      exText = '\n累计获得了3次死亡豁免检定失败，不幸去世了！';
      dss = 0;
      dsf = 0;
    }
    const nextAttrs = { ...sheet.attributes, DSS: dss, DSF: dsf };
    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: sheet.id,
      expectedVersion: sheet.version,
      changes: { attributes: nextAttrs },
      newVersion: sheet.version + 1,
    };
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'dnd5e.ds.manual',
      text: `${actorName} 当前的死亡豁免情况: 成功${dss} 失败${dsf}${exText}`,
      deadline,
    };
    return { results: [], updates: [update], replies: [reply], logItems: [] };
  }

  let d20 = await context.random.integer(1, 20);
  if (sub === '优势' || sub === 'kh' || sub === 'kh1') {
    const d20b = await context.random.integer(1, 20);
    d20 = Math.max(d20, d20b);
  } else if (sub === '劣势' || sub === 'kl' || sub === 'kl1') {
    const d20b = await context.random.integer(1, 20);
    d20 = Math.min(d20, d20b);
  }

  const { outcome, successPlus, failurePlus } = decideDeathSave(d20);
  const nextAttrs = { ...sheet.attributes };
  let outcomeText = '';
  let exText = '';

  if (outcome === 'revive') {
    outcomeText = '你觉得你还可以抢救一下！HP回复1点！伤势稳定了！';
    nextAttrs.HP = 1;
    nextAttrs.hp = 1;
    dss = 0;
    dsf = 0;
  } else {
    dss = Math.max(0, dss + successPlus);
    dsf = Math.max(0, dsf + failurePlus);
    if (outcome === 'criticalFailure') {
      outcomeText = '伤势莫名加重了！死亡豁免失败+2！';
    } else if (outcome === 'success') {
      outcomeText = '伤势暂时得到控制！死亡豁免成功+1';
    } else {
      outcomeText = '有些不妙！死亡豁免失败+1';
    }
    const { stable, dead } = deathSaveResultText({ successes: dss, failures: dsf });
    if (stable) {
      exText = '\n累计获得了3次死亡豁免检定成功，伤势稳定了！';
      dss = 0;
      dsf = 0;
    } else if (dead) {
      exText = '\n累计获得了3次死亡豁免检定失败，不幸去世了！';
      dss = 0;
      dsf = 0;
    }
  }

  nextAttrs.DSS = dss;
  nextAttrs.DSF = dsf;

  const update: StateUpdate = {
    type: 'character-sheet',
    sheetId: sheet.id,
    expectedVersion: sheet.version,
    changes: { attributes: nextAttrs },
    newVersion: sheet.version + 1,
  };

  const statusText = outcome === 'revive' ? '' : `\n当前情况: 成功${dss} 失败${dsf}`;
  const text = `${actorName} 的死亡豁免检定: 1D20=${d20} ${outcomeText}${exText}${statusText}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'dnd5e.ds.roll',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd5e.ds',
        ruleVersion: '1.0.0',
        data: { actor: actorName, d20, dss, dsf },
      },
    ],
    updates: [update],
    replies: [reply],
    logItems: [],
  };
}

async function setcocHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const arg = input.args[0]?.toLowerCase().trim();

  if (!arg) {
    const currentRule = conv.cocRule ?? '0';
    const def = resolveCocHouseRule(currentRule) ?? COC_HOUSE_RULES[0];
    const text = `当前房规: ${def ? def.name : currentRule}\n${def ? def.desc : ''}`;
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'coc.setcoc.current',
      text,
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  if (arg === 'details') {
    const lines = COC_HOUSE_RULES.map(
      (r) => `.setcoc ${r.key} // ${r.name}：${r.desc.replaceAll('\n', ' ')}`,
    );
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'coc.setcoc.details',
      text: `COC房规列表：\n${lines.join('\n')}`,
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const targetRule = resolveCocHouseRule(arg);
  if (!targetRule) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'coc.setcoc.invalid',
      text: `无效的房规：${arg}。可选规则：0~5，dg。使用 .setcoc details 查看详细说明。`,
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const update: StateUpdate = {
    type: 'conversation-settings',
    conversationId: conv.id,
    expectedVersion: conv.version,
    changes: { cocRule: targetRule.key },
    newVersion: conv.version + 1,
  };

  const text = `已切换房规为 ${targetRule.name} (${targetRule.key}):\n${targetRule.desc}\nCOC7规则扩展已自动开启`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'coc.setcoc.set',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.setcoc',
        ruleVersion: '1.0.0',
        data: { rule: targetRule.key, name: targetRule.name },
      },
    ],
    updates: [update],
    replies: [reply],
    logItems: [],
  };
}

async function findHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const query = input.args.join(' ').trim();

  if (!query) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'find.help',
      text: '规则查询指令：.find <关键词>\n例：.find 理智 或 .find 死亡豁免',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const { matches } = searchRuleGlossary(query, 3);
  let text = '';
  if (matches.length === 0) {
    text = `未找到与「${query}」相关的规则条目。`;
  } else {
    const entries = matches.map((m) => `📖 【${m.title}】\n${m.content}`);
    text = `查询「${query}」的结果：\n\n${entries.join('\n\n')}`;
  }

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'find.result',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'rule.find',
        ruleVersion: '1.0.0',
        data: { query, count: matches.length },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function jrrpHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;

  const jrrp = computeJrrp(senderId, input.timestamp);
  const text = formatJrrpReply(actorName, jrrp);

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'fun.jrrp',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'fun.jrrp',
        ruleVersion: '1.0.0',
        data: { actor: actorName, jrrp },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function guguHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const firstArg = input.args[0]?.toLowerCase().trim();

  if (firstArg === 'help') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.gugu.help',
      text: '咕咕理由指令：\n.gugu // 随机获取一个跑团请假借口\n.gugu 来源 // 附带作者署名',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const showFrom =
    firstArg === 'from' || firstArg === 'showfrom' || firstArg === '来源' || firstArg === '作者';

  const text = await getRandomGugu(context.random, actorName, showFrom);

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'fun.gugu',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'fun.gugu',
        ruleVersion: '1.0.0',
        data: { actor: actorName, text },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function nameHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const args = input.args;

  if (args[0]?.toLowerCase() === 'help') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.name.help',
      text: '随机名字生成：\n.name [cn/en/jp] [<数量>] [<男/女>]\n例：.name cn 3 男 或 .name en',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  let type: 'cn' | 'en' | 'jp' = 'cn';
  let count = 1;
  let gender: 'M' | 'F' | 'any' = 'any';

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === 'cn' || lower === 'zh' || lower === '中文' || lower === '中国') {
      type = 'cn';
    } else if (lower === 'en' || lower === '英文' || lower === '英国' || lower === '美国') {
      type = 'en';
    } else if (lower === 'jp' || lower === '日文' || lower === '日本') {
      type = 'jp';
    } else if (lower === '男' || lower === 'm' || lower === 'male') {
      gender = 'M';
    } else if (lower === '女' || lower === 'f' || lower === 'female') {
      gender = 'F';
    } else {
      const num = Number.parseInt(arg, 10);
      if (!Number.isNaN(num) && num > 0) {
        count = Math.min(10, num);
      }
    }
  }

  const names = await generateRandomName(type, count, gender, context.random);
  const text = `生成随机名字 (${type})：\n${names.join('\n')}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'fun.name',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'fun.name',
        ruleVersion: '1.0.0',
        data: { type, count, gender, names },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function namedndHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const args = input.args;

  if (args[0]?.toLowerCase() === 'help') {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.namednd.help',
      text: 'DND名字生成：\n.namednd [精灵/矮人/兽人] [<数量>]\n例：.namednd 精灵 3',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const race = args[0] ?? '精灵';
  let count = 1;
  if (args.length > 1) {
    const num = Number.parseInt(args[1] ?? '', 10);
    if (!Number.isNaN(num) && num > 0) {
      count = Math.min(10, num);
    }
  }

  const names = await generateDndName(race, count, context.random);
  const text = `生成 DND 名字 (${race})：\n${names.join('\n')}`;

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'fun.namednd',
    text,
    deadline,
  };

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'fun.namednd',
        ruleVersion: '1.0.0',
        data: { race, count, names },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function moduHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const args = input.args;
  const sub = args[0]?.toLowerCase().trim() ?? 'help';

  if (sub === 'help' || args.length === 0) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.modu.help',
      text:
        '魔都模组网查询：\n' +
        '.modu search <关键字> [<页码>] - 搜索关键字\n' +
        '.modu rec <关键字> [<页码>] - 搜索编辑推荐\n' +
        '.modu author <作者> [<页码>] - 搜索指定作者\n' +
        '.modu luck [<页码>] - 查看编辑推荐\n' +
        '.modu get <编号> - 查看指定详情\n' +
        '.modu roll - 随机抽取推荐模组\n' +
        '.modu help - 显示帮助',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  if (sub === 'get') {
    const keyId = args[1]?.trim() ?? '';
    if (!keyId) {
      const reply: PreparedReply = {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'fun.modu.error',
        text: '请提供模组编号：.modu get <编号>',
        deadline,
      };
      return { results: [], updates: [], replies: [reply], logItems: [] };
    }

    const detail = await fetchCnmodsDetail(keyId);
    const text = detail ? formatCnmodsDetail(detail) : '魔都查询出错，请稍后再试';

    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.modu.detail',
      text,
      deadline,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'fun.modu.detail',
          ruleVersion: '1.0.0',
          data: { keyId },
        },
      ],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  if (sub === 'roll') {
    const searchRes = await fetchCnmodsSearch('', 1, true);
    let text = '魔都查询出错，请稍后再试';
    if (searchRes && searchRes.list.length > 0) {
      const idx = await context.random.integer(0, searchRes.list.length - 1);
      const chosen = searchRes.list[idx];
      if (chosen) {
        const detail = await fetchCnmodsDetail(String(chosen.keyId));
        text = detail
          ? formatCnmodsDetail(detail)
          : `[${chosen.keyId}] ${chosen.title} - by ${chosen.article}`;
      }
    }

    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.modu.roll',
      text,
      deadline,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'fun.modu.roll',
          ruleVersion: '1.0.0',
          data: {},
        },
      ],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  if (sub === 'search' || sub === 'find' || sub === 'rec' || sub === 'luck' || sub === 'author') {
    let keyword = args[1]?.trim() ?? '';
    let page = 1;
    let isRec = false;
    let author = '';

    if (sub === 'luck') {
      keyword = '';
      isRec = true;
      const maybePage = Number.parseInt(args[1] ?? '', 10);
      if (!Number.isNaN(maybePage) && maybePage > 0) {
        page = maybePage;
      }
    } else if (sub === 'rec') {
      isRec = true;
      const maybePage = Number.parseInt(args[2] ?? '', 10);
      if (!Number.isNaN(maybePage) && maybePage > 0) {
        page = maybePage;
      }
    } else if (sub === 'author') {
      author = keyword;
      keyword = '';
      const maybePage = Number.parseInt(args[2] ?? '', 10);
      if (!Number.isNaN(maybePage) && maybePage > 0) {
        page = maybePage;
      }
    } else {
      const maybePage = Number.parseInt(args[2] ?? '', 10);
      if (!Number.isNaN(maybePage) && maybePage > 0) {
        page = maybePage;
      }
    }

    const result = await fetchCnmodsSearch(keyword, page, isRec, author);
    const text = result ? formatCnmodsSearchResult(page, result) : '魔都查询出错，请稍后再试';

    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'fun.modu.search',
      text,
      deadline,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'fun.modu.search',
          ruleVersion: '1.0.0',
          data: { keyword, page, isRec, author },
        },
      ],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  const reply: PreparedReply = {
    executionId: input.executionId,
    part: 1,
    msgSeq: 1,
    scene: conv.scene,
    targetId: conv.externalId,
    originMessageId: input.messageId,
    templateKey: 'fun.modu.help',
    text: '未知魔都子指令，输入 .modu help 查看帮助',
    deadline,
  };
  return { results: [], updates: [], replies: [reply], logItems: [] };
}

export function createDefaultCommandRegistry(): CommandRegistry {
  const registry = new DefaultCommandRegistry();

  registry.register(
    {
      name: 'r',
      aliases: ['roll', 'rd'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Roll dice',
    },
    rollHandler,
  );

  registry.register(
    {
      name: 'rh',
      aliases: ['rhd', 'rdh'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Roll dice through a trusted C2C binding',
    },
    hiddenRollHandler,
  );

  registry.register(
    {
      name: 'rhbind',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: true,
      description: 'Manage hidden-roll C2C binding',
    },
    hiddenRollBindingHandler,
  );

  registry.register(
    {
      name: 'help',
      aliases: ['h', '?', '帮助'],
      permission: 'all',
      allowedWhenDisabled: true,
      description: 'Show help message',
    },
    helpHandler,
  );

  registry.register(
    {
      name: 'set',
      aliases: ['s'],
      permission: 'groupHost',
      allowedWhenDisabled: true,
      description: 'Change conversation settings',
    },
    setHandler,
  );

  registry.register(
    {
      name: 'bot',
      aliases: [],
      permission: 'groupHost',
      allowedWhenDisabled: true,
      description: 'Turn bot on or off',
    },
    botHandler,
  );

  registry.register(
    {
      name: 'userid',
      aliases: ['uid', 'id'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Display user and scene identifier',
    },
    useridHandler,
  );

  registry.register(
    {
      name: 'st',
      aliases: ['cst', 'dst'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'View or modify character sheet attributes',
    },
    stHandler,
  );

  registry.register(
    {
      name: 'pc',
      aliases: ['char', 'ch'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Manage and switch character sheets',
    },
    pcHandler,
  );

  registry.register(
    {
      name: 'log',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Manage story logging sessions',
    },
    logHandler,
  );

  registry.register(
    {
      name: 'ra',
      aliases: ['rc', 'check'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Perform skill or attribute check',
    },
    checkHandler,
  );

  registry.register(
    {
      name: 'init',
      aliases: ['ri', 'initiative'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e initiative and combat tracker',
    },
    initHandler,
  );

  registry.register(
    {
      name: 'hp',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e HP and temporary HP manager',
    },
    hpHandler,
  );

  registry.register(
    {
      name: 'ss',
      aliases: ['spell', 'spellslots'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e spell slot manager',
    },
    spellSlotHandler,
  );

  registry.register(
    {
      name: 'longrest',
      aliases: ['rest'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e long rest recovery',
    },
    longRestHandler,
  );

  registry.register(
    {
      name: 'draw',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Draw card from deck',
    },
    drawHandler,
  );

  registry.register(
    {
      name: 'deck',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Deck management',
    },
    deckHandler,
  );

  registry.register(
    {
      name: 'coc',
      aliases: ['coc7', 'coc6'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'COC character generation',
    },
    cocHandler,
  );

  registry.register(
    {
      name: 'dnd',
      aliases: ['dnd5e'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e character generation',
    },
    dndHandler,
  );

  registry.register(
    {
      name: 'dndx',
      aliases: ['dnd5ex'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e character generation (preset mode)',
    },
    dndHandler,
  );

  registry.register(
    {
      name: 'nn',
      aliases: ['nick'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Set or inspect player nickname',
    },
    nnHandler,
  );

  registry.register(
    {
      name: 'sc',
      aliases: ['sancheck'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'COC sanity check',
    },
    scHandler,
  );

  registry.register(
    {
      name: 'ti',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'COC temporary madness symptom table',
    },
    tiHandler,
  );

  registry.register(
    {
      name: 'li',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'COC summary madness symptom table',
    },
    liHandler,
  );

  registry.register(
    {
      name: 'en',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'COC skill growth check',
    },
    enHandler,
  );

  registry.register(
    {
      name: 'ds',
      aliases: ['死亡豁免'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e death saving throws',
    },
    dsHandler,
  );

  registry.register(
    {
      name: 'setcoc',
      aliases: [],
      permission: 'groupHost',
      allowedWhenDisabled: true,
      description: 'Set COC house rules',
    },
    setcocHandler,
  );

  registry.register(
    {
      name: 'find',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: true,
      description: 'Search TRPG rule glossary',
    },
    findHandler,
  );

  registry.register(
    {
      name: 'jrrp',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Daily luck',
    },
    jrrpHandler,
  );

  registry.register(
    {
      name: 'gugu',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Excuses generator',
    },
    guguHandler,
  );

  registry.register(
    {
      name: 'name',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Random name generator',
    },
    nameHandler,
  );

  registry.register(
    {
      name: 'namednd',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Random DND name generator',
    },
    namedndHandler,
  );

  registry.register(
    {
      name: 'modu',
      aliases: ['魔都'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Search cnmods modules',
    },
    moduHandler,
  );
  return registry;
}
