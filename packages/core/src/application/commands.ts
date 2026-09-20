import {
  normalizeAttributeName,
  parseAttributeAssignments,
} from '../domain/character/attribute-input.js';
import { getBuiltinDeck, listBuiltinDecks } from '../domain/deck/builtin-decks.js';
import {
  type Card,
  type DeckSession,
  createDeckSession,
  drawFromDeck,
} from '../domain/deck/deck.js';
import { type AstNode, collectDiceBudget, evaluateAst } from '../domain/dice/ast.js';
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
import { cocSuccessRank, parseCocCheckArgs } from '../domain/rules/coc7/command.js';
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
  DND_ABILITY_NAMES,
  parseDndCheckArgs,
  resolveDndCheckModifier,
} from '../domain/rules/dnd5e/check.js';
import {
  type CombatEncounterState,
  addCombatant,
  advanceTurn,
  createCombatEncounter,
  removeCombatant,
  resetEncounter,
} from '../domain/rules/dnd5e/combat.js';
import {
  applyDeathSaveModifiers,
  deathSaveResultText,
  decideDeathSave,
} from '../domain/rules/dnd5e/death-saves.js';
import { listRuleGlossary, searchRuleGlossary } from '../domain/rules/glossary.js';
import { createArchiveAccessToken } from '../domain/story-log/log.js';
import type { Clock } from '../ports/clock.js';
import type { RandomSource } from '../ports/random-source.js';
import type {
  CommandResult,
  HiddenRollLinkReader,
  Permissions,
  PreparedReply,
  Principal,
  StateSnapshot,
  StateUpdate,
  StoryLogItem,
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
  readonly publicBaseUrl?: string | undefined;
}

export interface CommandDecision {
  readonly results: CommandResult[];
  readonly updates: StateUpdate[];
  readonly replies: PreparedReply[];
  readonly logItems: StoryLogItem[];
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

function replyOnly(
  input: CommandInput,
  context: CommandContext,
  templateKey: string,
  text: string,
): CommandDecision {
  return {
    results: [],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: context.snapshot.conversation.scene,
        targetId: context.snapshot.conversation.externalId,
        originMessageId: input.messageId,
        templateKey,
        text,
        deadline: new Date(input.timestamp.getTime() + 300_000),
      },
    ],
    logItems: [],
  };
}

interface NumericExpression {
  readonly source: string;
  readonly constant?: number | undefined;
  readonly ast?: AstNode | undefined;
}

function parseNumericExpression(
  source: string,
  defaultSides: number,
): NumericExpression | undefined {
  const trimmed = source.trim();
  if (/^[+-]?\d+$/u.test(trimmed)) {
    return { source: trimmed, constant: Number.parseInt(trimmed, 10) };
  }
  const parsed = parseDiceExpression(trimmed, defaultSides);
  if (!parsed.success || !parsed.expression || parsed.expression.reason) {
    return undefined;
  }
  return { source: trimmed, ast: parsed.expression.ast };
}

async function evaluateNumericExpression(
  expression: NumericExpression,
  random: RandomSource,
): Promise<number> {
  if (expression.constant !== undefined) {
    return expression.constant;
  }
  if (!expression.ast) {
    throw new Error(`Missing AST for numeric expression ${expression.source}`);
  }
  return (await evaluateAst(expression.ast, random)).value;
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
    detail: textLines.join('\n'),
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

const HELP_OVERVIEW = [
  'DiceFunc 指令帮助',
  '.help 骰点',
  '.help COC7',
  '.help DND5E',
  '.help 角色卡',
  '.help 日志',
  '.help 牌堆',
  '.help 娱乐',
  '.help 查询',
  '.help 指令',
].join('\n');

const HELP_BY_TOPIC: Readonly<Record<string, string>> = {
  help: '帮助格式：.help [分类、指令或规则关键字]',
  骰点: [
    '骰点与检定：',
    '.r [表达式] [原因]',
    '.rh [表达式] [原因]',
    '.ra/rc <属性或技能> [目标值]',
    '.check 仅说明官方防伪功能未提供',
  ].join('\n'),
  coc7: [
    'COC7：',
    '.setcoc [0-5|dg|details]',
    '.ra/rc <技能或目标值>',
    '.sc <成功损失>/<失败损失> [SAN]',
    '.en <技能> [当前值] [+成长表达式]',
    '.st <属性><数值>',
    '.coc [数量]',
    '.ti',
    '.li',
  ].join('\n'),
  dnd5e: [
    'DND5E：',
    '.ra/rc [优势|劣势] <属性、技能或豁免> [DC]',
    '.ri [调整值]',
    '.init [list|set|del|end|clr]',
    '.hp [-伤害|+治疗|temp 数值|max 数值]',
    '.buff [属性:数值|属性*:数值|del 属性|clr]',
    '.ss [init|set|clr|rest|环阶变更]',
    '.cast <环阶> [数量]',
    '.ds [stat|优势|劣势|s±N|f±N]',
    '.longrest',
    '.dnd [数量]',
    '.dndx [数量]',
  ].join('\n'),
  角色卡: [
    '角色卡：',
    '.st [show [属性]|clr|rm <属性>|<属性变更>]',
    '.pc [new <名称>|list|save <名称>|load <名称或ID>|untag]',
    '.nn [新名称|clr]',
  ].join('\n'),
  日志: [
    '跑团日志：',
    '.log new <名称>',
    '.log on|pause|halt|end',
    '.log list',
    '.log get [名称或ID]',
    '.log stat [名称或ID]',
    '.log export',
    '.log del <名称或ID>',
  ].join('\n'),
  牌堆: [
    '牌堆：',
    '.draw/.deck [牌堆] [数量]',
    '.deck [list|keys|search <关键字>]',
    '.deck reset [牌堆]',
  ].join('\n'),
  娱乐: [
    '娱乐与生成：',
    '.jrrp',
    '.gugu [来源]',
    '.who <选项...>',
    '.ping',
    '.name [cn|en|jp] [数量] [M|F]',
    '.namednd [达马拉|卡林珊|莱瑟曼|受国|精灵|矮人|兽人|海族|地精] [数量]',
  ].join('\n'),
  查询: [
    '查询：',
    '.find <关键字>',
    '.find list <分组> [页码]',
    '.find #<条目ID>',
    '.modu help',
    '.userid',
  ].join('\n'),
  指令: [
    '核心指令：',
    '.r .rh .ra .rc .st .pc .set .bot .userid',
    '.coc .setcoc .sc .en .ti .li',
    '.dnd .dndx .ri .init .hp .buff .ss .cast .ds .longrest',
    '.draw .deck .log .find .modu .black',
    '.jrrp .gugu .who .ping .name .namednd',
  ].join('\n'),
  r: '.r [表达式] [原因]\n省略表达式时使用当前默认骰面。',
  rh: '.rh [表达式] [原因]\n群聊暗骰需要先完成 .rhbind 绑定。',
  rhbind: '.rhbind [on|off]\n用于管理群成员与 C2C 身份的可信暗骰绑定。',
  ra: '.ra/rc <属性或技能> [目标值]\n未提供目标值时必须从当前角色卡读取。',
  check: '.check 不执行检定；当前部署不提供 SealDice 官方实例防伪。',
  st: '.st [show [属性]|clr|rm <属性>|<属性变更>]',
  pc: '.pc [new <名称>|list|save <名称>|load <名称或ID>|untag]',
  nn: '.nn [新名称|clr]\n修改当前本地角色卡名称，不修改 QQ 群名片。',
  coc: '.coc [数量]\n生成一至十组 COC7 属性。',
  dnd: '.dnd [数量]\n生成一至十组自由分配属性。',
  dndx: '.dndx [数量]\n生成一至十组带属性名的结果。',
  bot: '.bot on\n.bot off',
  set: '.set <面数|coc7|dnd5e|clr>\n.set rule <coc7|dnd5e>\n.set sides <面数>',
  setcoc: '.setcoc [0-5|dg|details]\n设置房规时同时切换到 COC7。',
  sc: '.sc <成功损失>/<失败损失> [SAN]\n角色卡没有 SAN 时必须显式提供。',
  en: '.en <技能> [当前值] [+成长表达式]\n省略当前值时必须从角色卡读取。',
  hp: '.hp [-伤害|+治疗|temp 数值|max 数值]\n角色卡必须已有 HP 与 MaxHP。',
  log: '.log new <名称>\n.log on|pause|halt|end\n.log list\n.log get [名称或ID]\n.log stat [名称或ID]\n.log export\n.log del <名称或ID>',
  draw: '.draw/.deck [牌堆] [数量]\n未知牌堆会直接报错。',
  deck: '.deck [牌堆] [数量]\n.deck list\n.deck keys\n.deck search <关键字>\n.deck reset <牌堆>\n内置牌堆不支持运行时 reload。',
  init: '.init\n.init list\n.init set <名称> <先攻>\n.init del <名称>\n.init end\n.init clr\nend 推进，clr 清空。',
  ri: '.ri [调整值]\n掷先攻并加入当前列表。',
  buff: '.buff\n.buff 属性:数值\n.buff 属性*:数值\n.buff del 属性\n.buff clr',
  ss: '.ss\n.ss init <一环数量>...\n.ss set <环阶> <总数> [<环阶> <总数>...]\n.ss clr|rest\n.ss <环阶>±<数量>',
  cast: '.cast <环阶> [数量]',
  ds: '.ds\n.ds stat\n.ds 优势\n.ds 劣势\n.ds s±N\n.ds f±N',
  longrest: '.longrest\n恢复已有 MaxHP、法术位并清空临时 HP 和死亡豁免。',
  jrrp: '.jrrp',
  gugu: '.gugu [来源]',
  name: '.name [cn|en|jp] [数量] [M|F]\n默认生成五个。',
  namednd: '.namednd [达马拉|卡林珊|莱瑟曼|受国|精灵|矮人|兽人|海族|地精] [数量]',
  modu: '.modu help\n.modu <关键字>',
  find: '.find <关键字>\n.find list <分组> [页码]\n.find #<条目ID>',
  userid: '.userid\n显示发送者标识、会话标识和场景。',
  ti: '.ti',
  li: '.li',
};

const HELP_TOPIC_ALIASES: Readonly<Record<string, string>> = {
  h: 'help',
  帮助: 'help',
  roll: 'r',
  rd: 'r',
  rhd: 'rh',
  rdh: 'rh',
  rc: 'ra',
  cst: 'st',
  dst: 'st',
  char: 'pc',
  ch: 'pc',
  nick: 'nn',
  coc7: 'coc7',
  dnd5e: 'dnd5e',
  dnd5ex: 'dndx',
  sancheck: 'sc',
  spell: 'ss',
  spellslots: 'ss',
  rest: 'longrest',
  initiative: 'init',
  死亡豁免: 'ds',
  uid: 'userid',
  id: 'userid',
  魔都: 'modu',
};

async function helpHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const fullArg = input.args.join(' ').trim();
  let text = HELP_OVERVIEW;
  if (fullArg) {
    const lower = fullArg.toLowerCase();
    const topic = HELP_TOPIC_ALIASES[lower] ?? lower;
    const exact = HELP_BY_TOPIC[topic];
    if (exact) {
      text = exact;
    } else {
      const { matches } = searchRuleGlossary(fullArg, 3);
      text =
        matches.length > 0
          ? `查询「${fullArg}」的结果：\n\n${matches
              .map((match) => `【${match.title}】\n${match.content}`)
              .join('\n\n')}`
          : `未找到「${fullArg}」的帮助或规则条目。`;
    }
  }

  const decision = replyOnly(input, context, 'system.help', text);
  return {
    ...decision,
    results: [
      {
        executionId: input.executionId,
        kind: 'help',
        ruleVersion: '1.0.0',
        data: { text },
      },
    ],
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
      const ruleSet =
        subValue === 'coc' || subValue === 'coc7'
          ? 'coc7'
          : subValue === 'dnd' || subValue === 'dnd5e'
            ? 'dnd5e'
            : undefined;
      if (!ruleSet) {
        return replyOnly(
          input,
          context,
          'set.error',
          `不支持规则「${subValue}」。可选规则：coc7、dnd5e。`,
        );
      }
      changes.ruleSet = ruleSet;
      confirmationText = `Rule set changed to ${ruleSet}`;
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
  const userExternalId = input.sender?.externalId ?? 'unknown';
  const conversationExternalId = conv.externalId;
  const text = `用户标识: ${userExternalId}\n会话标识: ${conversationExternalId}\n场景: ${conv.scene}`;

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
        data: { scene: conv.scene, userExternalId, conversationExternalId },
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
      const items = requestedAttrs.map((requestedName) => {
        const name = normalizeAttributeName(conv.ruleSet, requestedName);
        const calculated =
          conv.ruleSet === 'dnd5e' ? resolveDndCheckModifier(sheet.attributes, name) : undefined;
        const value =
          calculated?.modifier ??
          sheet.attributes[name] ??
          sheet.attributes[requestedName] ??
          '未设置';
        return `${name}: ${value}`;
      });
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

    const toRemove = [
      ...new Set(args.slice(1).map((name) => normalizeAttributeName(conv.ruleSet, name))),
    ];
    const removedNames = new Set(toRemove);
    const nextAttrs = { ...sheet.attributes };
    for (const storedName of Object.keys(nextAttrs)) {
      if (removedNames.has(normalizeAttributeName(conv.ruleSet, storedName))) {
        delete nextAttrs[storedName];
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
  const changes: Record<string, number> = {};
  const modificationDescriptions: string[] = [];
  const currentAttrs: Record<string, number> = {};
  for (const [storedName, value] of Object.entries(sheet?.attributes ?? {})) {
    const name = normalizeAttributeName(conv.ruleSet, storedName);
    if (name === storedName || currentAttrs[name] === undefined) {
      currentAttrs[name] = value;
    }
  }

  if (conv.ruleSet === 'dnd5e') {
    const proficiencyPattern =
      /([\p{L}_]+)\s*\*\s*(0(?:\.5)?|1)?\s*[:=]?\s*((?:\d*[dD]\d+(?:[*/]\d+)*|-?\d+))/gu;
    for (const match of rawText.matchAll(proficiencyPattern)) {
      const rawName = match[1] ?? '';
      const rawValue = match[3] ?? '';
      const parsedValue = parseNumericExpression(rawValue, 20);
      if (!rawName || !parsedValue) {
        continue;
      }
      const name = normalizeAttributeName(conv.ruleSet, rawName);
      const value = await evaluateNumericExpression(parsedValue, context.random);
      const factor = match[2] === undefined ? 1 : Number.parseFloat(match[2]);
      const proficiencyKey = (DND_ABILITY_NAMES as readonly string[]).includes(name)
        ? `${name}豁免熟练`
        : `${name}熟练`;
      currentAttrs[name] = value;
      currentAttrs[proficiencyKey] = factor;
      changes[name] = value;
      changes[proficiencyKey] = factor;
    }
  }
  for (const assignment of parseAttributeAssignments(rawText)) {
    const key = normalizeAttributeName(conv.ruleSet, assignment.name);
    const prev = currentAttrs[key] ?? 0;
    const valStr = assignment.expression;
    let val: number;
    if (/[dD]/.test(valStr)) {
      const parsed = parseDiceExpression(valStr);
      if (!parsed.success || !parsed.expression) {
        continue;
      }
      const evalRes = await evaluateAst(parsed.expression.ast, context.random);
      val = evalRes.value;
    } else {
      val = Number.parseInt(valStr, 10);
    }
    if (Number.isNaN(val)) {
      continue;
    }

    let nextVal = val;
    if (assignment.operator === '+') {
      nextVal = prev + val;
      modificationDescriptions.push(
        /[dD]/.test(valStr)
          ? `${key}: ${prev} ➯ ${nextVal} (+${valStr}=${val})`
          : `${key}: ${nextVal}`,
      );
    } else if (assignment.operator === '-') {
      nextVal = prev - val;
      modificationDescriptions.push(
        /[dD]/.test(valStr)
          ? `${key}: ${prev} ➯ ${nextVal} (-${valStr}=${val})`
          : `${key}: ${nextVal}`,
      );
    }
    if (conv.ruleSet === 'dnd5e' && key === 'HP' && currentAttrs.MaxHP !== undefined) {
      const hpState: DndHpState = {
        currentHp: currentAttrs.HP ?? 0,
        maxHp: currentAttrs.MaxHP,
        tempHp: currentAttrs.TempHP ?? 0,
        deathSaveSuccesses: currentAttrs.DSS ?? 0,
        deathSaveFailures: currentAttrs.DSF ?? 0,
      };
      const nextState =
        assignment.operator === '+'
          ? applyHealing(hpState, val).nextState
          : assignment.operator === '-'
            ? applyDamage(hpState, val).nextState
            : {
                ...hpState,
                currentHp: Math.min(hpState.maxHp, Math.max(0, nextVal)),
                deathSaveSuccesses: nextVal > 0 ? 0 : (hpState.deathSaveSuccesses ?? 0),
                deathSaveFailures: nextVal > 0 ? 0 : (hpState.deathSaveFailures ?? 0),
              };
      currentAttrs.HP = nextState.currentHp;
      currentAttrs.MaxHP = nextState.maxHp;
      currentAttrs.TempHP = nextState.tempHp;
      currentAttrs.DSS = nextState.deathSaveSuccesses ?? 0;
      currentAttrs.DSF = nextState.deathSaveFailures ?? 0;
      changes.HP = nextState.currentHp;
      changes.MaxHP = nextState.maxHp;
      changes.TempHP = nextState.tempHp;
      changes.DSS = nextState.deathSaveSuccesses ?? 0;
      changes.DSF = nextState.deathSaveFailures ?? 0;
      continue;
    }
    if (conv.ruleSet === 'dnd5e' && key === 'MaxHP') {
      const nextState = setMaxHp(
        {
          currentHp: currentAttrs.HP ?? 0,
          maxHp: currentAttrs.MaxHP ?? 1,
          tempHp: currentAttrs.TempHP ?? 0,
          deathSaveSuccesses: currentAttrs.DSS ?? 0,
          deathSaveFailures: currentAttrs.DSF ?? 0,
        },
        nextVal,
      );
      currentAttrs.HP = nextState.currentHp;
      currentAttrs.MaxHP = nextState.maxHp;
      changes.HP = nextState.currentHp;
      changes.MaxHP = nextState.maxHp;
      continue;
    }
    if (conv.ruleSet === 'dnd5e' && (key === 'TempHP' || key === 'DSS' || key === 'DSF')) {
      nextVal = Math.max(0, key === 'TempHP' ? nextVal : Math.min(3, nextVal));
    }
    currentAttrs[key] = nextVal;
    changes[key] = nextVal;
  }
  if (Object.keys(changes).length === 0) {
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
        ownerPrincipal: context.snapshot.principalId ?? senderId,
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
        text:
          modificationDescriptions.length > 0
            ? `「${sheetName}」的属性变化：\n${modificationDescriptions.join('\n')}`
            : `「${sheetName}」的${conv.ruleSet.toUpperCase()}属性录入完成，本次录入了${Object.keys(changes).length}条数据`,
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
  const senderId = input.sender?.externalId ?? 'unknown';
  const principalId = context.snapshot.principalId ?? senderId;
  const ownedSheets = context.snapshot.ownedSheets ?? (sheet ? [sheet] : []);

  const resolveOwnedSheet = (target: string): StateSnapshot['sheet'] => {
    const byId = ownedSheets.find((candidate) => candidate.id === target);
    if (byId) {
      return byId;
    }
    const byName = ownedSheets.filter((candidate) => candidate.name === target);
    return byName.length === 1 ? byName[0] : undefined;
  };

  if (sub === 'new') {
    const name = args.slice(1).join(' ').trim() || '未命名角色';
    const sheetId = `sheet_${context.botId}_${input.executionId}`;
    const currentVer = context.snapshot.characterBinding?.version ?? 0;
    const updates: StateUpdate[] = [
      {
        type: 'character-sheet',
        sheetId,
        expectedVersion: 0,
        changes: {
          name,
          attributes: {},
          ownerPrincipal: principalId,
          ruleSet: conv.ruleSet,
        },
        newVersion: 1,
      },
      {
        type: 'character-binding',
        conversationId: conv.id,
        principalId,
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
    const update: StateUpdate = {
      type: 'character-binding',
      conversationId: conv.id,
      principalId,
      expectedVersion: currentVer,
      changes: { sheetId: null },
      newVersion: currentVer + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.unbind',
          ruleVersion: '1.0.0',
          data: { previousSheetId: sheet?.id ?? null },
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
      return replyOnly(input, context, 'character.sheet.unbound', '未绑定角色卡，无法保存副本。');
    }
    const saveName = args.slice(1).join(' ').trim() || sheet.name;
    const snapshotSheetId = `sheet_${context.botId}_${input.executionId}_saved`;
    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: snapshotSheetId,
      expectedVersion: 0,
      changes: {
        name: saveName,
        attributes: { ...sheet.attributes },
        ownerPrincipal: principalId,
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
          text: `已保存角色卡副本「${saveName}」(ID: ${snapshotSheetId})。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'load' || sub === 'tag') {
    const target = args.slice(1).join(' ').trim();
    if (!target) {
      return replyOnly(
        input,
        context,
        'character.load.help',
        '请指定要绑定的角色卡：.pc load <卡名或ID>',
      );
    }
    const targetSheet = resolveOwnedSheet(target);
    if (!targetSheet) {
      return replyOnly(
        input,
        context,
        'character.not_found',
        '名下没有唯一匹配的角色卡，请先用 .pc list 查看。',
      );
    }
    const currentVer = context.snapshot.characterBinding?.version ?? 0;
    const update: StateUpdate = {
      type: 'character-binding',
      conversationId: conv.id,
      principalId,
      expectedVersion: currentVer,
      changes: { sheetId: targetSheet.id },
      newVersion: currentVer + 1,
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.load',
          ruleVersion: '1.0.0',
          data: { sheetId: targetSheet.id, name: targetSheet.name },
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
          text: `当前会话已绑定角色卡「${targetSheet.name}」(ID: ${targetSheet.id})。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'rename') {
    if (args.length < 2) {
      return replyOnly(
        input,
        context,
        'character.rename.help',
        '用法：.pc rename [原卡名或ID] <新卡名>',
      );
    }
    const targetSheet = args.length === 2 ? sheet : resolveOwnedSheet(args[1] ?? '');
    const newName = (args.length === 2 ? args[1] : args.slice(2).join(' '))?.trim() ?? '';
    if (!targetSheet || !ownedSheets.some((candidate) => candidate.id === targetSheet.id)) {
      return replyOnly(input, context, 'character.not_found', '没有找到可改名的名下角色卡。');
    }
    if (!newName) {
      return replyOnly(input, context, 'character.rename.help', '新卡名不能为空。');
    }
    const update: StateUpdate = {
      type: 'character-sheet',
      sheetId: targetSheet.id,
      expectedVersion: targetSheet.version,
      changes: { name: newName },
      newVersion: targetSheet.version + 1,
    };
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.rename',
          ruleVersion: '1.0.0',
          data: { sheetId: targetSheet.id, oldName: targetSheet.name, newName },
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
          templateKey: 'character.rename',
          text: `角色卡「${targetSheet.name}」已改名为「${newName}」。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'del' || sub === 'delete') {
    const target = args.slice(1).join(' ').trim();
    const targetSheet = target ? resolveOwnedSheet(target) : undefined;
    if (!targetSheet) {
      return replyOnly(input, context, 'character.not_found', '没有找到要删除的名下角色卡。');
    }
    const update: StateUpdate = {
      type: 'character-sheet-delete',
      sheetId: targetSheet.id,
      ownerPrincipal: principalId,
      expectedVersion: targetSheet.version,
    };
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.delete',
          ruleVersion: '1.0.0',
          data: { sheetId: targetSheet.id, name: targetSheet.name },
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
          templateKey: 'character.delete',
          text: `已删除角色卡「${targetSheet.name}」。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'list' || sub === 'show' || !sub) {
    const sheets = ownedSheets.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      ruleSet: candidate.ruleSet,
      active: candidate.id === sheet?.id,
    }));
    const text =
      sheets.length > 0
        ? `名下角色卡：\n${sheets
            .map(
              (candidate) => `${candidate.active ? '* ' : '- '}${candidate.name} (${candidate.id})`,
            )
            .join('\n')}`
        : '名下还没有角色卡。使用 .pc new <角色名> 创建。';
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'character.list',
          ruleVersion: '1.0.0',
          data: { activeSheetId: sheet?.id ?? null, sheets },
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

  return replyOnly(
    input,
    context,
    'character.help',
    '角色卡命令：.pc new/list/load/tag/untag/save/rename/del',
  );
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
        ownerPrincipal: context.snapshot.principalId ?? senderId,
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
  const args = input.args;
  const sub = args[0]?.toLowerCase();
  const activeLog = context.snapshot.activeStoryLog;
  const fallbackLog = context.snapshot.latestStoryLog ?? activeLog;
  const storyLogs =
    context.snapshot.storyLogs ??
    (fallbackLog
      ? activeLog && activeLog.id !== fallbackLog.id
        ? [fallbackLog, activeLog]
        : [fallbackLog]
      : []);
  const targetText = args.slice(1).join(' ').trim();
  const latestLog = targetText
    ? storyLogs.find(
        (log) => log.id === targetText || log.name.toLowerCase() === targetText.toLowerCase(),
      )
    : fallbackLog;

  if (sub === 'list') {
    const logs = storyLogs.filter((log) => log.status !== 'deleted');
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.list',
          ruleVersion: '1.0.0',
          data: { logs },
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
          templateKey: 'story_log.list',
          text:
            logs.length > 0
              ? logs
                  .map((log) => `${log.id}: ${log.name} [${log.status}] ${log.itemCount ?? 0} 条`)
                  .join('\n')
              : '当前会话没有跑团日志。',
          deadline,
        },
      ],
      logItems: [],
    };
  }

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

  if (sub === 'halt') {
    if (!activeLog || activeLog.status === 'closed') {
      return replyOnly(input, context, 'story_log.not_recording', '当前会话无进行中的跑团日志。');
    }
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.halt',
          ruleVersion: '1.0.0',
          data: { logId: activeLog.id },
        },
      ],
      updates: [
        {
          type: 'story-log',
          logId: activeLog.id,
          conversationId: conv.id,
          expectedVersion: activeLog.version,
          changes: { name: activeLog.name, status: 'closed' },
          newVersion: activeLog.version + 1,
        },
      ],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.halt',
          text: `跑团日志「${activeLog.name}」已停止记录，未发起归档。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'del' || sub === 'rm') {
    if (!context.permissions.isGroupHost && !context.permissions.isDiceMaster) {
      return replyOnly(
        input,
        context,
        'story_log.delete_forbidden',
        '只有群主或骰主可以删除跑团日志。',
      );
    }
    if (!targetText || !latestLog) {
      return replyOnly(
        input,
        context,
        'story_log.not_found',
        '未找到指定跑团日志。使用 .log list 查看日志 ID 和名称。',
      );
    }
    if (activeLog?.id === latestLog.id || latestLog.status !== 'closed') {
      return replyOnly(
        input,
        context,
        'story_log.delete_active',
        '进行中或尚未关闭的跑团日志不能删除。',
      );
    }
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.delete',
          ruleVersion: '1.0.0',
          data: { logId: latestLog.id },
        },
      ],
      updates: [
        {
          type: 'story-log-delete',
          logId: latestLog.id,
          expectedVersion: latestLog.version,
          newVersion: latestLog.version + 1,
          jobId: `job_delete_log_${input.eventId}`,
        },
      ],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.delete',
          text: `跑团日志「${latestLog.name}」已进入删除流程，删除收敛前不可下载。`,
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
    const archiveUpdate: StateUpdate = {
      type: 'story-log-archive',
      archiveId: `archive_${activeLog.id}`,
      jobId: `job_archive_${input.eventId}`,
      logId: activeLog.id,
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
      updates: [update, archiveUpdate],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'story_log.end',
          text: `跑团日志「${activeLog.name}」已关闭，正在归档。归档完成后使用 .log export 获取下载链接。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'export' || sub === 'get') {
    if (!context.permissions.isGroupHost && !context.permissions.isDiceMaster) {
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
            templateKey: 'story_log.export_forbidden',
            text: '只有群主或骰主可以导出跑团日志。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    if (!latestLog) {
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
            text: '当前群没有可导出的跑团日志。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    if (latestLog.status !== 'closed') {
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
            templateKey: 'story_log.export_active',
            text: `跑团日志「${latestLog.name}」仍在记录，请先使用 .log end 关闭。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const archive = latestLog.archive;
    if (!archive) {
      const archiveUpdate: StateUpdate = {
        type: 'story-log-archive',
        archiveId: `archive_${latestLog.id}`,
        jobId: `job_archive_${input.eventId}`,
        logId: latestLog.id,
      };
      return {
        results: [
          {
            executionId: input.executionId,
            kind: 'log.archive_requested',
            ruleVersion: '1.0.0',
            data: { logId: latestLog.id, archiveId: archiveUpdate.archiveId },
          },
        ],
        updates: [archiveUpdate],
        replies: [
          {
            executionId: input.executionId,
            part: 1,
            msgSeq: 1,
            scene: conv.scene,
            targetId: conv.externalId,
            originMessageId: input.messageId,
            templateKey: 'story_log.export_requested',
            text: `跑团日志「${latestLog.name}」已提交归档，请稍后再次使用 .log export。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    if (archive.status === 'pending' || archive.status === 'uploading') {
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
            templateKey: 'story_log.export_pending',
            text: `跑团日志「${latestLog.name}」正在归档，请稍后再次使用 .log export。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    if (archive.status !== 'ready') {
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
            templateKey: 'story_log.export_unavailable',
            text: `跑团日志「${latestLog.name}」归档暂不可用，请联系管理员。`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const publicBaseUrl = context.publicBaseUrl?.replace(/\/+$/, '');
    if (!publicBaseUrl) {
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
            templateKey: 'story_log.export_unconfigured',
            text: '归档已就绪，但下载地址尚未配置，请联系管理员设置 PUBLIC_BASE_URL。',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const { token, tokenHash } = await createArchiveAccessToken(context.random);
    const expiresAt = new Date(context.clock.now().getTime() + 900_000);
    const update: StateUpdate = {
      type: 'archive-grant',
      archiveId: archive.id,
      tokenHash,
      actorScopeId: context.snapshot.principalId ?? input.sender?.externalId ?? 'unknown',
      expiresAt,
      auditId: `audit_archive_grant_${input.eventId}`,
    };
    const downloadUrl = `${publicBaseUrl}/archives/${encodeURIComponent(archive.id)}?token=${encodeURIComponent(token)}`;

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.export',
          ruleVersion: '1.0.0',
          data: { logId: latestLog.id, archiveId: archive.id },
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
          templateKey: 'story_log.export',
          text: `跑团日志「${latestLog.name}」已归档。下载链接（15 分钟内有效）：\n${downloadUrl}`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'stat' || sub === 'status') {
    if (!latestLog) {
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

    const statusMap: Record<string, string> = {
      new: '新建',
      recording: '记录中',
      paused: '已暂停',
      closed: '已关闭',
      deleting: '删除中',
      deleted: '已删除',
    };

    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'log.stat',
          ruleVersion: '1.0.0',
          data: { log: latestLog },
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
          text: `${latestLog.status === 'closed' ? '已关闭' : (statusMap[latestLog.status] ?? latestLog.status)}跑团日志「${latestLog.name}」：共 ${latestLog.itemCount ?? 0} 条记录，其中 ${latestLog.rollCount ?? 0} 条骰点；归档：${
            latestLog.archive?.status === 'ready'
              ? '可下载（使用 .log get <名称或ID>）'
              : latestLog.archive
                ? latestLog.archive.status
                : '无'
          }`,
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
        text: '跑团日志管理：\n.log new <日志名> - 新建并开启日志\n.log on - 恢复记录\n.log pause/off - 暂停记录\n.log halt - 停止但不归档\n.log end - 关闭并归档日志\n.log list - 查看日志\n.log stat [名称或ID] - 查看统计\n.log get [名称或ID] - 获取归档下载链接\n.log del <名称或ID> - 删除已关闭日志',
        deadline,
      },
    ],
    logItems: [],
  };
}

async function unsupportedCheckHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  return replyOnly(
    input,
    context,
    'system.check.unsupported',
    '当前部署不提供 SealDice 官方实例防伪校验；此命令不会执行规则检定。',
  );
}

function ensureSheetRule(
  input: CommandInput,
  context: CommandContext,
  expectedRuleSet: 'coc7' | 'dnd5e',
  sheet: StateSnapshot['sheet'] = context.snapshot.sheet,
): CommandDecision | undefined {
  if (!sheet || sheet.ruleSet.toLowerCase() === expectedRuleSet) {
    return undefined;
  }
  return replyOnly(
    input,
    context,
    'character.rule_mismatch',
    `当前角色卡使用 ${sheet.ruleSet}，会话规则为 ${expectedRuleSet}。请切换角色卡后重试。`,
  );
}

const COC_LEVEL_LABELS: Readonly<Record<string, string>> = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  regular: '常规成功',
  failure: '失败',
  fumble: '大失败',
};

const MAX_RANDOM_SOURCE: RandomSource = {
  async integer(_minInclusive: number, maxInclusive: number): Promise<number> {
    return maxInclusive;
  },
  async bytes(length: number): Promise<Uint8Array> {
    return new Uint8Array(length).fill(255);
  },
};

async function checkHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const firstArg = input.args[0] ?? '';
  const explicitMention = firstArg.match(/^<@!?([^>]+)>$/u);
  const hasDelegateToken = explicitMention !== null || firstArg.startsWith('@');
  const delegateSheet = hasDelegateToken
    ? explicitMention?.[1]
      ? context.snapshot.delegateSheets?.[explicitMention[1]]
      : Object.values(context.snapshot.delegateSheets ?? {})[0]
    : undefined;
  if (hasDelegateToken && !delegateSheet) {
    return replyOnly(
      input,
      context,
      'coc.check.delegate_missing',
      '被提及的参与者没有在当前会话绑定可用角色卡。',
    );
  }
  const checkArgs = hasDelegateToken ? input.args.slice(1) : input.args;
  const sheet = delegateSheet ?? context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;

  if (checkArgs.length === 0) {
    return replyOnly(
      input,
      context,
      conv.ruleSet === 'dnd5e' ? 'dnd5e.check.help' : 'coc.check.help',
      conv.ruleSet === 'dnd5e'
        ? '检定格式：.ra/rc <属性或技能> [难度等级]'
        : '检定格式：.ra/rc [困难|极难] [b|p][数量] <属性或技能> [临时加值] [原因]',
    );
  }

  if (conv.ruleSet === 'dnd5e') {
    const parsed = parseDndCheckArgs(checkArgs);
    if (!parsed.success) {
      return replyOnly(input, context, 'dnd5e.check.invalid', `检定参数无效：${parsed.error}。`);
    }
    const skillName = normalizeAttributeName('dnd5e', parsed.value.name);
    const checkModifier = sheet ? resolveDndCheckModifier(sheet.attributes, skillName) : undefined;
    if (!checkModifier) {
      return replyOnly(
        input,
        context,
        'dnd5e.check.missing_attribute',
        `角色卡未记录「${skillName}」所需的属性，请先录入。`,
      );
    }
    let parsedExtra: NumericExpression | undefined;
    let extraSign = 1;
    if (parsed.value.extraModifier) {
      extraSign = parsed.value.extraModifier.startsWith('-') ? -1 : 1;
      parsedExtra = parseNumericExpression(parsed.value.extraModifier.slice(1), 20);
      if (!parsedExtra) {
        return replyOnly(input, context, 'dnd5e.check.invalid', '检定加值表达式无法解析。');
      }
    }

    const items: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    for (let index = 0; index < parsed.value.repeat; index += 1) {
      const rolls = await rollDice(20, parsed.value.advantage === 0 ? 1 : 2, context.random);
      const d20 =
        parsed.value.advantage > 0
          ? Math.max(...rolls)
          : parsed.value.advantage < 0
            ? Math.min(...rolls)
            : (rolls[0] ?? 1);
      const extraModifier = parsedExtra
        ? extraSign * (await evaluateNumericExpression(parsedExtra, context.random))
        : 0;
      const total = d20 + checkModifier.modifier + extraModifier;
      const success = parsed.value.dc === undefined || total >= parsed.value.dc;
      items.push({
        rolls,
        d20,
        baseModifier: checkModifier.modifier,
        extraModifier,
        total,
        success,
      });
      const diceText = rolls.length === 1 ? `1D20(${d20})` : `2D20(${rolls.join(',')})取${d20}`;
      lines.push(
        `${parsed.value.repeat > 1 ? `${index + 1}. ` : ''}${actorName}进行「${skillName}」检定：${diceText} + ${checkModifier.modifier}${extraModifier === 0 ? '' : ` ${extraModifier > 0 ? '+' : '-'} ${Math.abs(extraModifier)}`} = ${total}${parsed.value.dc === undefined ? '' : `，DC ${parsed.value.dc}，${success ? '通过' : '未通过'}`}`,
      );
    }
    const first = items[0] ?? {};
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.check',
          ruleVersion: '1.0.0',
          data: {
            actor: actorName,
            skill: skillName,
            repeat: parsed.value.repeat,
            modifier: checkModifier.modifier,
            advantage: parsed.value.advantage,
            dc: parsed.value.dc ?? null,
            reason: parsed.value.reason,
            calculation: checkModifier,
            ...first,
            items,
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
          text: `${lines.join('\n')}${parsed.value.reason ? `\n原因：${parsed.value.reason}` : ''}`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const mismatch = ensureSheetRule(input, context, 'coc7', sheet);
  if (mismatch) {
    return mismatch;
  }
  const parsed = parseCocCheckArgs(checkArgs);
  if (!parsed.success) {
    return replyOnly(input, context, 'coc.check.invalid', `检定参数无效：${parsed.error}。`);
  }

  const skillName = normalizeAttributeName('coc7', parsed.value.skillName);
  const baseTarget =
    parsed.value.explicitTarget ??
    sheet?.attributes[skillName] ??
    sheet?.attributes[parsed.value.skillName];
  if (baseTarget === undefined) {
    return replyOnly(
      input,
      context,
      'coc.check.missing_attribute',
      `角色卡未记录「${skillName}」，请先录入技能值或在命令中给出目标值。`,
    );
  }

  const command = input.commandName.toLowerCase();
  const forceRulebook =
    command === 'rc' || command === 'crc' || command === 'rch' || command === 'crch';
  const ruleId = forceRulebook ? '0' : (conv.cocRule ?? '0');
  const items: Record<string, unknown>[] = [];
  const lines: string[] = [];

  for (let index = 0; index < parsed.value.repeat; index += 1) {
    const check = await performCocCheck(
      {
        character: sheet,
        skillName,
        targetValue: baseTarget,
        modifier: parsed.value.modifier,
        bonusDice: parsed.value.bonusDice,
        ruleId,
      },
      context.random,
    );
    const rank = cocSuccessRank(check.level);
    const success = rank >= parsed.value.requiredLevel;
    const item = {
      ...check,
      success,
      rank,
      ruleId,
      difficulty: parsed.value.difficulty,
      requiredLevel: parsed.value.requiredLevel,
      bonusDice: parsed.value.bonusDice,
      modifier: parsed.value.modifier,
      reason: parsed.value.reason,
      skill: { name: skillName },
      roll: { total: check.rollTotal, values: check.rolls },
      target: { value: check.targetValue, base: baseTarget },
    };
    items.push(item);
    const requirement =
      parsed.value.requiredLevel > 1
        ? `，要求${COC_LEVEL_LABELS[parsed.value.difficulty] ?? parsed.value.difficulty}`
        : '';
    lines.push(
      `${parsed.value.repeat > 1 ? `${index + 1}. ` : ''}${actorName}进行「${skillName}」检定：D100=${check.rollTotal}/${check.targetValue}${requirement}，${success ? '通过' : '未通过'}（${COC_LEVEL_LABELS[check.level]}）`,
    );
  }

  const firstItem = items[0] ?? {};
  const data =
    items.length === 1
      ? { actor: actorName, ...firstItem, items }
      : {
          actor: actorName,
          skill: { name: skillName },
          repeat: parsed.value.repeat,
          bonusDice: parsed.value.bonusDice,
          difficulty: parsed.value.difficulty,
          requiredLevel: parsed.value.requiredLevel,
          reason: parsed.value.reason,
          items,
        };
  const allSucceeded = items.every((item) => item.success === true);
  const reasonText = parsed.value.reason ? `\n原因：${parsed.value.reason}` : '';

  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.check',
        ruleVersion: '1.0.0',
        data,
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
        templateKey: allSucceeded ? 'coc.check.success' : 'coc.check.failed',
        text: `${lines.join('\n')}${reasonText}`,
        deadline,
      },
    ],
    logItems: [],
  };
}

async function hiddenCheckHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const conversation = context.snapshot.conversation;
  if (conversation.scene === 'c2c') {
    const decision = await checkHandler(input, context);
    return {
      ...decision,
      results: decision.results.map((result) => ({
        ...result,
        data: { ...result.data, hidden: true },
      })),
      replies: decision.replies.map((reply) => ({
        ...reply,
        templateKey: 'coc.hidden.check',
      })),
    };
  }

  const binding = context.snapshot.hiddenRollBinding;
  if (!binding) {
    return replyOnly(
      input,
      context,
      'coc.hidden.binding_required',
      '尚未建立可信私聊绑定，暗中检定未执行。',
    );
  }
  const decision = await checkHandler(input, context);
  if (decision.results.length === 0 || !decision.replies[0]) {
    return decision;
  }
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  return {
    ...decision,
    results: decision.results.map((result) => ({
      ...result,
      data: { ...result.data, hidden: true },
    })),
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: 'c2c',
        targetId: binding.userOpenid,
        templateKey: 'coc.hidden.check',
        text: decision.replies[0].text,
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
        templateKey: 'coc.hidden.group_sent',
        text: '暗中检定已完成，结果只发送到绑定私聊。',
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
        templateKey: 'coc.hidden.group_failed',
        text: '暗中检定的私聊发送失败，结果未在群内公开。',
        deadline,
        condition: { part: 1, status: 'failed' },
      },
    ],
  };
}

async function opposedCheckHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const mismatch = ensureSheetRule(input, context, 'coc7');
  if (mismatch) {
    return mismatch;
  }
  if (input.args.length < 2) {
    return replyOnly(
      input,
      context,
      'coc.opposed.help',
      '对抗检定格式：.rav/.rcv <技能或技能值> <技能或技能值>',
    );
  }

  const leftParsed = parseCocCheckArgs([input.args[0] ?? '']);
  const rightParsed = parseCocCheckArgs([input.args[1] ?? '']);
  if (!leftParsed.success || !rightParsed.success) {
    return replyOnly(input, context, 'coc.opposed.invalid', '无法解析对抗双方的技能。');
  }
  const sheet = context.snapshot.sheet;
  const leftSkill = normalizeAttributeName('coc7', leftParsed.value.skillName);
  const rightSkill = normalizeAttributeName('coc7', rightParsed.value.skillName);
  const leftTarget =
    leftParsed.value.explicitTarget ??
    sheet?.attributes[leftSkill] ??
    sheet?.attributes[leftParsed.value.skillName];
  const rightTarget =
    rightParsed.value.explicitTarget ??
    sheet?.attributes[rightSkill] ??
    sheet?.attributes[rightParsed.value.skillName];
  if (leftTarget === undefined || rightTarget === undefined) {
    return replyOnly(
      input,
      context,
      'coc.opposed.missing_attribute',
      '角色卡缺少对抗检定所需技能，请在技能名后提供数值。',
    );
  }

  const command = input.commandName.toLowerCase();
  const ruleId = command === 'rcv' ? '0' : (context.snapshot.conversation.cocRule ?? '0');
  const leftCheck = await performCocCheck(
    {
      skillName: leftSkill,
      targetValue: leftTarget,
      modifier: leftParsed.value.modifier,
      ruleId,
    },
    context.random,
  );
  const rightCheck = await performCocCheck(
    {
      skillName: rightSkill,
      targetValue: rightTarget,
      modifier: rightParsed.value.modifier,
      ruleId,
    },
    context.random,
  );
  const leftRank = cocSuccessRank(leftCheck.level);
  const rightRank = cocSuccessRank(rightCheck.level);
  let winner: 'left' | 'right' | 'tie';
  if (leftCheck.success !== rightCheck.success) {
    winner = leftCheck.success ? 'left' : 'right';
  } else if (leftRank !== rightRank) {
    winner = leftRank > rightRank ? 'left' : 'right';
  } else if (leftTarget !== rightTarget) {
    winner = leftTarget > rightTarget ? 'left' : 'right';
  } else if (leftCheck.rollTotal !== rightCheck.rollTotal) {
    winner = leftCheck.rollTotal < rightCheck.rollTotal ? 'left' : 'right';
  } else {
    winner = 'tie';
  }

  const left = {
    skill: leftSkill,
    target: leftCheck.targetValue,
    roll: leftCheck.rollTotal,
    level: leftCheck.level,
    rank: leftRank,
  };
  const right = {
    skill: rightSkill,
    target: rightCheck.targetValue,
    roll: rightCheck.rollTotal,
    level: rightCheck.level,
    rank: rightRank,
  };
  const winnerText = winner === 'left' ? leftSkill : winner === 'right' ? rightSkill : '平局';
  const decision = replyOnly(
    input,
    context,
    'coc.opposed',
    `对抗检定：${leftSkill} D100=${left.roll}/${left.target}；${rightSkill} D100=${right.roll}/${right.target}。结果：${winnerText}。`,
  );
  return {
    ...decision,
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.opposed',
        ruleVersion: '1.0.0',
        data: { left, right, winner, ruleId },
      },
    ],
  };
}
async function initiativeRollHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  if (context.snapshot.conversation.ruleSet !== 'dnd5e') {
    return replyOnly(input, context, 'dnd5e.rule_required', '先攻指令需要 DND5E 会话规则。');
  }
  const conv = context.snapshot.conversation;
  const rawEncounter = context.snapshot.encounter;
  let encounter =
    rawEncounter &&
    typeof rawEncounter === 'object' &&
    'state' in rawEncounter &&
    rawEncounter.state
      ? (rawEncounter.state as CombatEncounterState)
      : createCombatEncounter({
          id: `enc_${conv.id}`,
          conversationId: conv.id,
          version: 1,
        });
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName =
    context.snapshot.sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;
  const raw = input.args.join(' ').trim();
  const segments = raw ? raw.split(/[,，]/u).map((value) => value.trim()) : [actorName];
  if (segments.some((value) => value.length === 0)) {
    return replyOnly(input, context, 'dnd5e.initiative.invalid', '先攻项目不能为空。');
  }

  const items: Array<{ name: string; initiative: number; expression: string }> = [];
  for (const segment of segments) {
    let rest = segment;
    let advantage: 'advantage' | 'disadvantage' | undefined;
    if (/^(优势|優勢)/u.test(rest)) {
      advantage = 'advantage';
      rest = rest.replace(/^(优势|優勢)/u, '').trim();
    } else if (/^(劣势|劣勢)/u.test(rest)) {
      advantage = 'disadvantage';
      rest = rest.replace(/^(劣势|劣勢)/u, '').trim();
    }

    const [firstToken = '', ...nameTokens] = rest.split(/\s+/u);
    let name = nameTokens.join(' ').trim();
    let initiative: number;
    let expression: string;
    if (firstToken.startsWith('=')) {
      const parsed = parseNumericExpression(firstToken.slice(1), 20);
      if (!parsed || !name) {
        return replyOnly(
          input,
          context,
          'dnd5e.initiative.invalid',
          '自定义先攻格式应为 =表达式 名称。',
        );
      }
      initiative = await evaluateNumericExpression(parsed, context.random);
      expression = parsed.source;
    } else if (/^[+-]/u.test(firstToken)) {
      const parsed = parseNumericExpression(firstToken, 20);
      if (!parsed || !name) {
        return replyOnly(
          input,
          context,
          'dnd5e.initiative.invalid',
          '先攻加值格式应为 +表达式 名称。',
        );
      }
      const modifier = await evaluateNumericExpression(parsed, context.random);
      const rolls = await rollDice(20, advantage ? 2 : 1, context.random);
      const d20 =
        advantage === 'advantage'
          ? Math.max(...rolls)
          : advantage === 'disadvantage'
            ? Math.min(...rolls)
            : (rolls[0] ?? 1);
      initiative = d20 + modifier;
      expression = `d20${parsed.source}`;
    } else if (/^\d+$/u.test(firstToken) && name) {
      initiative = Number.parseInt(firstToken, 10);
      expression = firstToken;
    } else {
      name = rest;
      const dexterity = name === actorName ? context.snapshot.sheet?.attributes.敏捷 : undefined;
      const modifier = dexterity === undefined ? 0 : Math.floor((dexterity - 10) / 2);
      const rolls = await rollDice(20, advantage ? 2 : 1, context.random);
      const d20 =
        advantage === 'advantage'
          ? Math.max(...rolls)
          : advantage === 'disadvantage'
            ? Math.min(...rolls)
            : (rolls[0] ?? 1);
      initiative = d20 + modifier;
      expression = modifier === 0 ? 'd20' : `d20${modifier > 0 ? '+' : ''}${modifier}`;
    }
    if (!name || !Number.isSafeInteger(initiative)) {
      return replyOnly(input, context, 'dnd5e.initiative.invalid', '无法解析先攻项目。');
    }
    const id = name === actorName ? senderId : `actor_${name}`;
    encounter = addCombatant(encounter, { id, name, initiative });
    items.push({ name, initiative, expression });
  }

  const update: StateUpdate = {
    type: 'encounter',
    encounterId: encounter.id,
    conversationId: conv.id,
    expectedVersion:
      rawEncounter && typeof rawEncounter === 'object' && 'version' in rawEncounter
        ? rawEncounter.version
        : 0,
    changes: { state: encounter },
    newVersion: encounter.version,
  };
  const orderedItems = [...items].sort(
    (left, right) => right.initiative - left.initiative || left.name.localeCompare(right.name),
  );
  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd5e.initiative.roll',
        ruleVersion: '1.0.0',
        data: { items: orderedItems },
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
        templateKey: 'dnd5e.initiative.roll',
        text: `先攻结果：\n${orderedItems
          .map(
            (item, index) => `${index + 1}. ${item.name}: ${item.initiative} (${item.expression})`,
          )
          .join('\n')}`,
        deadline: new Date(input.timestamp.getTime() + 300_000),
      },
    ],
    logItems: [],
  };
}

async function initHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
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

  if (sub === 'next' || sub === 'end' || sub === 'ed') {
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

  if (sub === 'clr' || sub === 'clear') {
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
          kind: 'dnd5e.init.clear',
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
          templateKey: 'dnd5e.init.clear',
          text: '先攻列表已清空。',
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'list' || sub === 'show' || !sub) {
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

  if (sub === 'del' || sub === 'rm') {
    const names = args.slice(1).filter((name) => name.length > 0);
    if (names.length === 0) {
      return replyOnly(input, context, 'dnd5e.init.invalid', '删除格式：.init del <名称...>');
    }
    const removed = currentEnc.combatants.filter((combatant) => names.includes(combatant.name));
    if (removed.length === 0) {
      return replyOnly(input, context, 'dnd5e.init.not_found', '先攻列表中没有匹配的单位。');
    }
    let nextEnc = currentEnc;
    for (const combatant of removed) {
      nextEnc = removeCombatant(nextEnc, combatant.id);
    }
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
          kind: 'dnd5e.init.remove',
          ruleVersion: '1.0.0',
          data: { removed: removed.map((combatant) => combatant.name) },
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
          templateKey: 'dnd5e.init.remove',
          text: `已从先攻列表移除：${removed.map((combatant) => combatant.name).join('、')}`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'set') {
    const targetName = args[1]?.trim();
    const parsedTarget = parseNumericExpression(args.slice(2).join(''), 20);
    if (!targetName || !parsedTarget) {
      return replyOnly(
        input,
        context,
        'dnd5e.init.invalid',
        '设置先攻格式：.init set <名称> <先攻表达式>',
      );
    }
    const finalVal = await evaluateNumericExpression(parsedTarget, context.random);
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

  return replyOnly(
    input,
    context,
    'dnd5e.init.help',
    '先攻管理：.init list/end/del/set/clr；批量掷先攻使用 .ri。',
  );
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

  const currentHp = sheet.attributes.HP ?? sheet.attributes.hp;
  const maxHp = sheet.attributes.MaxHP ?? sheet.attributes.maxhp;
  const tempHp = sheet.attributes.TempHP ?? sheet.attributes.temphp ?? 0;
  if (currentHp === undefined || maxHp === undefined) {
    return replyOnly(
      input,
      context,
      'dnd5e.hp.missing',
      '角色卡缺少 HP 或 MaxHP，请先录入完整生命值。',
    );
  }

  const hpState: DndHpState = {
    currentHp,
    maxHp,
    tempHp,
    deathSaveSuccesses: sheet.attributes.DSS ?? 0,
    deathSaveFailures: sheet.attributes.DSF ?? 0,
  };
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
    const parsedDamage = parseNumericExpression(rawArg.slice(1).trim(), 20);
    if (parsedDamage) {
      const dmg = Math.max(0, await evaluateNumericExpression(parsedDamage, context.random));
      const { nextState, effectiveDamage, tempHpAbsorbed, deathSaveFailureAdded, massiveDamage } =
        applyDamage(hpState, dmg);
      const nextAttrs = {
        ...sheet.attributes,
        HP: nextState.currentHp,
        TempHP: nextState.tempHp,
        MaxHP: nextState.maxHp,
        DSS: nextState.deathSaveSuccesses ?? 0,
        DSF: nextState.deathSaveFailures ?? 0,
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
            data: {
              damage: dmg,
              effectiveDamage,
              tempHpAbsorbed,
              deathSaveFailureAdded,
              massiveDamage,
              ...nextState,
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
    const parsedHealing = parseNumericExpression(rawArg.slice(1).trim(), 20);
    if (parsedHealing) {
      const heal = Math.max(0, await evaluateNumericExpression(parsedHealing, context.random));
      const { nextState, effectiveHealing } = applyHealing(hpState, heal);
      const nextAttrs = {
        ...sheet.attributes,
        HP: nextState.currentHp,
        TempHP: nextState.tempHp,
        MaxHP: nextState.maxHp,
        DSS: nextState.deathSaveSuccesses ?? 0,
        DSF: nextState.deathSaveFailures ?? 0,
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
    const parsedTempHp = parseNumericExpression(args.slice(1).join(''), 20);
    if (parsedTempHp) {
      const tempVal = await evaluateNumericExpression(parsedTempHp, context.random);
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
    const parsedMaxHp = parseNumericExpression(args.slice(1).join(''), 20);
    if (parsedMaxHp) {
      const maxVal = await evaluateNumericExpression(parsedMaxHp, context.random);
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

async function buffHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const sheet = context.snapshot.sheet;
  if (!sheet || sheet.ruleSet !== 'dnd5e') {
    return replyOnly(input, context, 'dnd5e.buff.card_required', '临时加值需要绑定 DND5E 角色卡。');
  }
  const sub = input.args[0]?.toLowerCase();
  const currentBuffs = Object.entries(sheet.attributes).filter(([name]) =>
    name.startsWith('Buff_'),
  );
  if (!sub || sub === 'show' || sub === 'list') {
    const data = Object.fromEntries(currentBuffs);
    const decision = replyOnly(
      input,
      context,
      'dnd5e.buff.show',
      currentBuffs.length > 0
        ? `「${sheet.name}」的临时加值：${currentBuffs.map(([name, value]) => `${name.slice(5)}:${value}`).join('，')}`
        : `「${sheet.name}」当前没有临时加值。`,
    );
    return {
      ...decision,
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.buff.show',
          ruleVersion: '1.0.0',
          data,
        },
      ],
    };
  }

  const nextAttrs: Record<string, number> = { ...sheet.attributes };
  const changed: Record<string, number | null> = {};
  if (sub === 'clr' || sub === 'clear') {
    for (const [name] of currentBuffs) {
      delete nextAttrs[name];
      changed[name] = null;
    }
  } else if (sub === 'del' || sub === 'rm') {
    for (const rawName of input.args.slice(1)) {
      const name = normalizeAttributeName('dnd5e', rawName);
      for (const key of [`Buff_${name}`, `Buff_${name}熟练`, `Buff_${name}豁免熟练`]) {
        if (nextAttrs[key] !== undefined) {
          delete nextAttrs[key];
          changed[key] = null;
        }
      }
    }
  } else {
    const raw = input.args.join(' ');
    const proficiencyPattern =
      /([\p{L}_]+)\s*\*\s*(0(?:\.5)?|1)?\s*[:=]?\s*((?:\d*[dD]\d+(?:[*/]\d+)*|-?\d+))/gu;
    for (const match of raw.matchAll(proficiencyPattern)) {
      const name = normalizeAttributeName('dnd5e', match[1] ?? '');
      const parsedValue = parseNumericExpression(match[3] ?? '', 20);
      if (!name || !parsedValue) {
        continue;
      }
      const value = await evaluateNumericExpression(parsedValue, context.random);
      const factor = match[2] === undefined ? 1 : Number.parseFloat(match[2]);
      const valueKey = `Buff_${name}`;
      const proficiencyKey = (DND_ABILITY_NAMES as readonly string[]).includes(name)
        ? `Buff_${name}豁免熟练`
        : `Buff_${name}熟练`;
      nextAttrs[valueKey] = value;
      nextAttrs[proficiencyKey] = factor;
      changed[valueKey] = value;
      changed[proficiencyKey] = factor;
    }
    for (const assignment of parseAttributeAssignments(raw)) {
      const name = normalizeAttributeName('dnd5e', assignment.name);
      const parsedValue = parseNumericExpression(assignment.expression, 20);
      if (!parsedValue) {
        continue;
      }
      const key = `Buff_${name}`;
      const value = await evaluateNumericExpression(parsedValue, context.random);
      const previous = nextAttrs[key] ?? 0;
      const nextValue =
        assignment.operator === '+'
          ? previous + value
          : assignment.operator === '-'
            ? previous - value
            : value;
      nextAttrs[key] = nextValue;
      changed[key] = nextValue;
    }
  }
  if (Object.keys(changed).length === 0) {
    return replyOnly(
      input,
      context,
      'dnd5e.buff.invalid',
      '临时加值格式：.buff 属性:数值、.buff 属性*:数值、.buff del 属性、.buff clr',
    );
  }
  const update: StateUpdate = {
    type: 'character-sheet',
    sheetId: sheet.id,
    expectedVersion: sheet.version,
    changes: { attributes: nextAttrs },
    newVersion: sheet.version + 1,
  };
  const decision = replyOnly(
    input,
    context,
    'dnd5e.buff.update',
    `「${sheet.name}」的临时加值已更新。`,
  );
  return {
    ...decision,
    results: [
      {
        executionId: input.executionId,
        kind: 'dnd5e.buff.update',
        ruleVersion: '1.0.0',
        data: { changed },
      },
    ],
    updates: [update],
  };
}

async function spellSlotHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  if (!sheet) {
    return replyOnly(
      input,
      context,
      'character.sheet.unbound',
      '未绑定角色卡，请先创建或绑定角色卡。',
    );
  }

  const slots: Record<number, { level: number; total: number; used: number }> = {};
  for (let level = 1; level <= 9; level += 1) {
    const total = sheet.attributes[`法术位_${level}`] ?? 0;
    const used = sheet.attributes[`法术位_${level}_已用`] ?? 0;
    if (total > 0) {
      slots[level] = { level, total, used };
    }
  }
  const args = input.args;
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === 'show' || sub === 'list') {
    const lines = Object.values(slots).map(
      (slot) => `${slot.level}环: ${slot.total - slot.used}/${slot.total}`,
    );
    const decision = replyOnly(
      input,
      context,
      'dnd5e.spell.show',
      lines.length > 0
        ? `「${sheet.name}」法术位状态：\n${lines.join('  ')}`
        : `「${sheet.name}」尚未设置法术位。`,
    );
    return {
      ...decision,
      results: [
        {
          executionId: input.executionId,
          kind: 'dnd5e.spell.show',
          ruleVersion: '1.0.0',
          data: { slots },
        },
      ],
    };
  }

  const nextAttrs: Record<string, number> = { ...sheet.attributes };
  let kind = 'dnd5e.spell.update';
  let data: Record<string, unknown> = {};
  let text = '';

  if (sub === 'use') {
    const level = Number.parseInt(args[1] ?? '', 10);
    const count = Number.parseInt(args[2] ?? '1', 10);
    const slot = slots[level];
    if (
      !Number.isInteger(level) ||
      level < 1 ||
      level > 9 ||
      !Number.isInteger(count) ||
      count < 1 ||
      !slot ||
      slot.total - slot.used < count
    ) {
      return replyOnly(
        input,
        context,
        'dnd5e.spell.insufficient',
        `无法消耗法术位；当前 ${level || '?'} 环可用 ${slot ? slot.total - slot.used : 0} 个。`,
      );
    }
    nextAttrs[`法术位_${level}_已用`] = slot.used + count;
    const remaining = slot.total - slot.used - count;
    kind = 'dnd5e.spell.use';
    data = { level, count, remaining };
    text = `「${sheet.name}」消耗 ${count} 个 ${level} 环法术位，剩余 ${remaining}/${slot.total}。`;
  } else if (sub === 'init') {
    const totals = args.slice(1).map((value) => Number.parseInt(value, 10));
    if (
      totals.length === 0 ||
      totals.length > 9 ||
      totals.some((value) => !Number.isInteger(value) || value < 0)
    ) {
      return replyOnly(
        input,
        context,
        'dnd5e.spell.invalid',
        '初始化格式：.ss init <一环数量> <二环数量> ...',
      );
    }
    totals.forEach((total, index) => {
      nextAttrs[`法术位_${index + 1}`] = total;
      nextAttrs[`法术位_${index + 1}_已用`] = 0;
    });
    kind = 'dnd5e.spell.init';
    data = { totals };
    text = `「${sheet.name}」已初始化 ${totals.length} 个环阶的法术位。`;
  } else if (sub === 'set') {
    const raw = args.slice(1).join(' ');
    const matches = Array.from(raw.matchAll(/(\d+)(?:环|[cC])?\s*(\d+)|[lL][vV](\d+)\s+(\d+)/gu));
    const updates: Array<{ level: number; total: number }> = [];
    for (const match of matches) {
      const level = Number.parseInt(match[1] ?? match[3] ?? '', 10);
      const total = Number.parseInt(match[2] ?? match[4] ?? '', 10);
      if (level >= 1 && level <= 9 && total >= 0) {
        nextAttrs[`法术位_${level}`] = total;
        nextAttrs[`法术位_${level}_已用`] = 0;
        updates.push({ level, total });
      }
    }
    if (updates.length === 0) {
      return replyOnly(input, context, 'dnd5e.spell.invalid', '设置格式：.ss set 1环4 2环3');
    }
    kind = 'dnd5e.spell.set';
    data = { updates };
    text = `「${sheet.name}」已设置法术位：${updates.map((item) => `${item.level}环${item.total}`).join('，')}。`;
  } else if (sub === 'clr' || sub === 'clear') {
    for (let level = 1; level <= 9; level += 1) {
      delete nextAttrs[`法术位_${level}`];
      delete nextAttrs[`法术位_${level}_已用`];
    }
    kind = 'dnd5e.spell.clear';
    text = `「${sheet.name}」的法术位记录已清除。`;
  } else if (sub === 'rest') {
    for (const slot of Object.values(slots)) {
      nextAttrs[`法术位_${slot.level}_已用`] = 0;
    }
    kind = 'dnd5e.spell.rest';
    data = { restoredLevels: Object.keys(slots).map(Number) };
    text = `「${sheet.name}」的法术位已恢复。`;
  } else {
    const raw = args.join(' ');
    const matches = Array.from(
      raw.matchAll(/(\d+)(?:环|[cC])\s*([+-])\s*(\d+)|[lL][vV](\d+)\s*([+-])\s*(\d+)/gu),
    );
    const changes: Array<{ level: number; delta: number; remaining: number }> = [];
    for (const match of matches) {
      const level = Number.parseInt(match[1] ?? match[4] ?? '', 10);
      const operator = match[2] ?? match[5] ?? '';
      const amount = Number.parseInt(match[3] ?? match[6] ?? '', 10);
      const slot = slots[level];
      if (!slot || amount < 0) {
        return replyOnly(input, context, 'dnd5e.spell.invalid', '法术位环阶或变更数量无效。');
      }
      const used = operator === '-' ? slot.used + amount : Math.max(0, slot.used - amount);
      if (used > slot.total) {
        return replyOnly(input, context, 'dnd5e.spell.insufficient', `${level} 环法术位不足。`);
      }
      nextAttrs[`法术位_${level}_已用`] = used;
      changes.push({
        level,
        delta: operator === '-' ? -amount : amount,
        remaining: slot.total - used,
      });
    }
    if (changes.length === 0) {
      return replyOnly(
        input,
        context,
        'dnd5e.spell.help',
        '法术位命令：.ss init/set/clr/rest，或 .ss 3环-1；施法可用 .cast。',
      );
    }
    data = { changes };
    text = `「${sheet.name}」的法术位已变更。`;
  }

  const update: StateUpdate = {
    type: 'character-sheet',
    sheetId: sheet.id,
    expectedVersion: sheet.version,
    changes: { attributes: nextAttrs },
    newVersion: sheet.version + 1,
  };
  const decision = replyOnly(input, context, kind, text);
  return {
    ...decision,
    results: [
      {
        executionId: input.executionId,
        kind,
        ruleVersion: '1.0.0',
        data,
      },
    ],
    updates: [update],
  };
}

async function castHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  return spellSlotHandler({ ...input, args: ['use', ...input.args] }, context);
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

  const maxHp = sheet.attributes.MaxHP ?? sheet.attributes.maxhp;
  if (maxHp === undefined) {
    return replyOnly(
      input,
      context,
      'dnd5e.longrest.missing_max_hp',
      '角色卡未记录 MaxHP，无法恢复生命值。',
    );
  }
  const nextAttrs: Record<string, number> = {
    ...sheet.attributes,
    HP: maxHp,
    TempHP: 0,
    DSS: 0,
    DSF: 0,
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

  if (sub === 'list' || sub === 'keys') {
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

  if (sub === 'search') {
    const query = args.slice(1).join(' ').trim().toLowerCase();
    if (!query) {
      return replyOnly(input, context, 'deck.search_invalid', '请提供牌堆或卡牌关键字。');
    }
    const matches: Array<{
      deckId: string;
      deckName: string;
      cardId?: string | undefined;
      text?: string | undefined;
    }> = listBuiltinDecks()
      .flatMap((deck) => {
        const deckMatch =
          deck.id.toLowerCase().includes(query) || deck.name.toLowerCase().includes(query);
        if (deckMatch) {
          return [{ deckId: deck.id, deckName: deck.name }];
        }
        return deck.cards
          .filter(
            (card) =>
              card.id.toLowerCase().includes(query) || card.text.toLowerCase().includes(query),
          )
          .map((card) => ({
            deckId: deck.id,
            deckName: deck.name,
            cardId: card.id,
            text: card.text,
          }));
      })
      .slice(0, 20);
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'deck.search',
          ruleVersion: '1.0.0',
          data: { query, matches },
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
          templateKey: 'deck.search',
          text:
            matches.length > 0
              ? matches
                  .map((match) =>
                    match.text !== undefined
                      ? `${match.deckId}/${match.cardId}: ${match.text}`
                      : `${match.deckId}: ${match.deckName}`,
                  )
                  .join('\n')
              : `没有找到与「${query}」匹配的牌堆或卡牌。`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'reload') {
    return replyOnly(
      input,
      context,
      'deck.reload_unsupported',
      '当前部署使用编译期内置牌堆，不支持聊天侧重新加载资源。',
    );
  }

  if (sub === 'reset') {
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

  return drawHandler(input, context);
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
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName = sheet?.name ?? input.sender?.name ?? `用户_${senderId.slice(-4) || '1'}`;

  if (input.args.length === 0 || input.args[0]?.toLowerCase() === 'help') {
    return replyOnly(
      input,
      context,
      'coc.sc.help',
      '理智检定格式：.sc [b|p][数量] [判定表达式] <成功损失>/<失败损失> [SAN] [--half] [--cap=上限]',
    );
  }
  const mismatch = ensureSheetRule(input, context, 'coc7');
  if (mismatch) {
    return mismatch;
  }

  const tokens: string[] = [];
  let half = false;
  let cap: number | undefined;
  for (let index = 0; index < input.args.length; index += 1) {
    const token = input.args[index] ?? '';
    if (token === '--half') {
      half = true;
    } else if (token.startsWith('--cap=')) {
      const value = Number.parseInt(token.slice('--cap='.length), 10);
      if (!Number.isNaN(value) && value > 0) {
        cap = value;
      }
    } else if (token === '--cap') {
      const value = Number.parseInt(input.args[index + 1] ?? '', 10);
      if (!Number.isNaN(value) && value > 0) {
        cap = value;
        index += 1;
      }
    } else {
      tokens.push(token);
    }
  }

  let bonusDice = 0;
  const bonusMatch = tokens[0]?.match(/^([bBpP])(\d*)$/u);
  if (bonusMatch) {
    const count = bonusMatch[2] ? Number.parseInt(bonusMatch[2], 10) : 1;
    bonusDice = bonusMatch[1]?.toLowerCase() === 'b' ? count : -count;
    tokens.shift();
  }

  let checkExpression: string | undefined;
  if (
    tokens.length >= 2 &&
    !tokens[0]?.includes('/') &&
    (tokens[1]?.includes('/') || /d100/i.test(tokens[0] ?? ''))
  ) {
    checkExpression = tokens.shift();
  }
  const lossExpression = tokens.shift();
  if (!lossExpression) {
    return replyOnly(input, context, 'coc.sc.invalid', '缺少理智损失表达式。');
  }
  const customSanToken = tokens.find((token) => /^\d+$/u.test(token));
  const customSan = customSanToken !== undefined ? Number.parseInt(customSanToken, 10) : undefined;
  const storedSan = sheet?.attributes.理智 ?? sheet?.attributes.SAN ?? sheet?.attributes.san;
  const currentSan = customSan ?? storedSan;
  if (currentSan === undefined) {
    return replyOnly(
      input,
      context,
      'coc.sc.missing_san',
      '角色卡未记录理智值，请先录入 SAN，或在命令末尾提供明确数值。',
    );
  }

  const slash = lossExpression.indexOf('/');
  const successLossExpression = slash >= 0 ? lossExpression.slice(0, slash).trim() || '0' : '0';
  const failureLossExpression =
    slash >= 0 ? lossExpression.slice(slash + 1).trim() : lossExpression.trim();
  const parsedSuccessLoss = parseNumericExpression(successLossExpression, 6);
  const parsedFailureLoss = parseNumericExpression(failureLossExpression, 6);
  if (!parsedSuccessLoss || !parsedFailureLoss) {
    return replyOnly(input, context, 'coc.sc.invalid', '理智损失表达式无法解析。');
  }

  const ruleId = conv.cocRule ?? '0';
  let rollTotal: number;
  let rolls: readonly number[];
  let successRank: number;
  if (checkExpression) {
    const parsedCheck = parseNumericExpression(checkExpression, 100);
    if (!parsedCheck) {
      return replyOnly(input, context, 'coc.sc.invalid', '判定表达式无法解析。');
    }
    rollTotal = await evaluateNumericExpression(parsedCheck, context.random);
    if (!Number.isInteger(rollTotal) || rollTotal < 1 || rollTotal > 100) {
      return replyOnly(input, context, 'coc.sc.invalid', '判定结果必须在 1 到 100 之间。');
    }
    rolls = [rollTotal];
    successRank = resultCheckBase(ruleId, rollTotal, currentSan).successRank;
  } else {
    const check = await performCocCheck(
      {
        skillName: '理智',
        targetValue: currentSan,
        bonusDice,
        ruleId,
      },
      context.random,
    );
    rollTotal = check.rollTotal;
    rolls = check.rolls;
    successRank = cocSuccessRank(check.level);
  }

  const success = successRank > 0;
  const chosenExpression = success ? parsedSuccessLoss : parsedFailureLoss;
  const originalSanLoss = Math.max(
    0,
    await evaluateNumericExpression(
      chosenExpression,
      successRank === -2 ? MAX_RANDOM_SOURCE : context.random,
    ),
  );
  let sanLoss = half ? Math.floor(originalSanLoss / 2) : originalSanLoss;
  if (cap !== undefined) {
    sanLoss = Math.min(sanLoss, cap);
  }
  const sanNew = Math.max(0, currentSan - sanLoss);

  const shifted = new Date(input.timestamp.getTime() + 8 * 60 * 60 * 1000);
  const dayKey =
    shifted.getUTCFullYear() * 10_000 + (shifted.getUTCMonth() + 1) * 100 + shifted.getUTCDate();
  const previousDailyLoss =
    sheet?.attributes.理智损失日期 === dayKey ? (sheet.attributes.当日理智损失 ?? 0) : 0;
  const dailyLoss = previousDailyLoss + sanLoss;
  const dailyThreshold = Math.ceil((currentSan + previousDailyLoss) / 5);
  const indefiniteMadness = dailyLoss >= dailyThreshold && dailyThreshold > 0;

  const updates: StateUpdate[] = [];
  if (sheet) {
    const nextAttrs: Record<string, number> = {
      ...sheet.attributes,
      理智: sanNew,
      理智损失日期: dayKey,
      当日理智损失: dailyLoss,
      ...(indefiniteMadness ? { 不定性疯狂: 1 } : {}),
    };
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

  let madness = '';
  if (sanNew === 0) {
    madness = '\n理智归零，角色进入永久疯狂。';
  } else if (indefiniteMadness) {
    madness = `\n当日累计损失 ${dailyLoss} 点，达到五分之一阈值 ${dailyThreshold}，进入不定性疯狂。`;
  } else if (sanLoss >= 5) {
    madness = '\n单次损失至少 5 点，需要进行智力检定判断是否进入临时疯狂。';
  }
  const chosenText = success ? successLossExpression : failureLossExpression;
  const text = `${actorName}的理智检定：D100=${rollTotal}/${currentSan}，${success ? '通过' : '未通过'}；损失 ${chosenText}=${originalSanLoss}${half || cap !== undefined ? `，调整为 ${sanLoss}` : ''}；SAN ${currentSan}→${sanNew}。${madness}`;

  const result: CommandResult = {
    executionId: input.executionId,
    kind: 'coc.sc',
    ruleVersion: '1.0.0',
    data: {
      actor: actorName,
      roll: rollTotal,
      rolls,
      successRank,
      bonusDice,
      sanOld: currentSan,
      sanNew,
      sanLoss,
      originalSanLoss,
      success,
      half,
      cap: cap ?? null,
      dailyLoss,
      dailyThreshold,
      indefiniteMadness,
    },
  };
  const decision = replyOnly(input, context, 'coc.sc', text);
  return { ...decision, results: [result], updates };
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
  const sheet = context.snapshot.sheet;
  if (input.args.length === 0 || input.args[0]?.toLowerCase() === 'help') {
    return replyOnly(
      input,
      context,
      'coc.en.help',
      '成长格式：.en <技能>[当前值] [+[失败增量/]成功增量]；多个技能可用空格或 | 分隔。',
    );
  }
  if (!sheet) {
    return replyOnly(input, context, 'coc.en.missing_sheet', '技能成长需要先绑定角色卡。');
  }
  const mismatch = ensureSheetRule(input, context, 'coc7');
  if (mismatch) {
    return mismatch;
  }

  const raw = input.args.join(' ');
  const pattern = /([\p{L}_]+)\s*(\d+)?\s*(?:\+\s*(?:([^/\s|]+)\s*\/)?\s*([^\s|]+))?/gu;
  const parsedItems = Array.from(raw.matchAll(pattern), (match) => ({
    skill: normalizeAttributeName('coc7', match[1] ?? ''),
    explicitValue: match[2] ? Number.parseInt(match[2], 10) : undefined,
    failureExpression: match[3]?.trim() || undefined,
    successExpression: match[4]?.trim() || '1d10',
  })).filter((item) => item.skill.length > 0);
  if (parsedItems.length === 0 || parsedItems.length > 10) {
    return replyOnly(
      input,
      context,
      'coc.en.invalid',
      parsedItems.length > 10 ? '单次最多处理十项技能。' : '无法解析技能成长参数。',
    );
  }

  const prepared: {
    readonly skill: string;
    readonly oldValue: number;
    readonly failureExpression?: NumericExpression | undefined;
    readonly successExpression: NumericExpression;
  }[] = [];
  for (const item of parsedItems) {
    const oldValue = item.explicitValue ?? sheet.attributes[item.skill];
    if (oldValue === undefined) {
      return replyOnly(
        input,
        context,
        'coc.en.missing_skill',
        `角色卡未记录「${item.skill}」，请先录入或在技能名后提供数值。`,
      );
    }
    const successExpression = parseNumericExpression(item.successExpression, 10);
    const failureExpression = item.failureExpression
      ? parseNumericExpression(item.failureExpression, 10)
      : undefined;
    if (!successExpression || (item.failureExpression && !failureExpression)) {
      return replyOnly(
        input,
        context,
        'coc.en.invalid_increment',
        `「${item.skill}」的成长表达式无法解析。`,
      );
    }
    prepared.push({
      skill: item.skill,
      oldValue,
      ...(failureExpression ? { failureExpression } : {}),
      successExpression,
    });
  }

  const nextAttributes = { ...sheet.attributes };
  const items: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let changed = false;
  for (const item of prepared) {
    const roll = await context.random.integer(1, 100);
    const success = roll > item.oldValue || roll > 95;
    const incrementExpression = success ? item.successExpression : item.failureExpression;
    const increment = incrementExpression
      ? await evaluateNumericExpression(incrementExpression, context.random)
      : 0;
    const newValue = item.oldValue + increment;
    if (nextAttributes[item.skill] !== newValue) {
      nextAttributes[item.skill] = newValue;
      changed = true;
    }
    items.push({
      skill: item.skill,
      roll,
      oldValue: item.oldValue,
      newValue,
      increment,
      incrementExpression: incrementExpression?.source ?? null,
      success,
    });
    lines.push(
      `${item.skill}：D100=${roll}/${item.oldValue}，${success ? '成长成功' : '未成长'}${incrementExpression ? `，${incrementExpression.source}=${increment}，当前 ${newValue}` : ''}`,
    );
  }

  const updates: StateUpdate[] = changed
    ? [
        {
          type: 'character-sheet',
          sheetId: sheet.id,
          expectedVersion: sheet.version,
          changes: { attributes: nextAttributes },
          newVersion: sheet.version + 1,
        },
      ]
    : [];
  const first = items[0] ?? {};
  const data =
    items.length === 1
      ? { actor: sheet.name, ...first, items }
      : { actor: sheet.name, count: items.length, items };
  const decision = replyOnly(
    input,
    context,
    'coc.en',
    `「${sheet.name}」的技能成长：\n${lines.join('\n')}`,
  );
  return {
    ...decision,
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.en',
        ruleVersion: '1.0.0',
        data,
      },
    ],
    updates,
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

  const manualMatch = args.join('').match(/^(s|S|成功|f|F|失败)([+-＋－])(.+)$/u);
  if (manualMatch?.[1] && manualMatch[2] && manualMatch[3]) {
    const kind = manualMatch[1];
    const isNeg = manualMatch[2] === '-' || manualMatch[2] === '－';
    const parsedValue = parseNumericExpression(manualMatch[3], 20);
    if (!parsedValue) {
      return replyOnly(input, context, 'dnd5e.ds.invalid', '死亡豁免计数表达式无法解析。');
    }
    const val = (await evaluateNumericExpression(parsedValue, context.random)) * (isNeg ? -1 : 1);
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

  const rollArgs = [...args];
  let advantage = 0;
  if (/^(优势|優勢|kh|kh1)$/u.test(rollArgs[0] ?? '')) {
    advantage = 1;
    rollArgs.shift();
  } else if (/^(劣势|劣勢|kl|kl1)$/u.test(rollArgs[0] ?? '')) {
    advantage = -1;
    rollArgs.shift();
  }
  const rolls = await rollDice(20, advantage === 0 ? 1 : 2, context.random);
  const d20 =
    advantage > 0 ? Math.max(...rolls) : advantage < 0 ? Math.min(...rolls) : (rolls[0] ?? 1);
  const modifierExpression = rollArgs.join('').trim();
  const parsedModifier = modifierExpression
    ? parseNumericExpression(modifierExpression.replace(/^\+/u, ''), 20)
    : undefined;
  if (modifierExpression && !parsedModifier) {
    return replyOnly(input, context, 'dnd5e.ds.invalid', '死亡豁免加值表达式无法解析。');
  }
  const modifier = parsedModifier
    ? await evaluateNumericExpression(parsedModifier, context.random)
    : 0;
  const total = d20 + modifier;
  const { outcome, successPlus, failurePlus } =
    d20 === 20
      ? decideDeathSave(20)
      : d20 === 1
        ? decideDeathSave(1)
        : decideDeathSave(total >= 10 ? 10 : 2);
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
  const text = `${actorName} 的死亡豁免检定: 1D20=${d20}${modifier === 0 ? '' : `，加值 ${modifier}`}，合计 ${total}。${outcomeText}${exText}${statusText}`;

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
        data: { actor: actorName, rawRoll: d20, rolls, modifier, total, outcome, dss, dsf },
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
    changes: { cocRule: targetRule.key, ruleSet: 'coc7' },
    newVersion: conv.version + 1,
  };

  const text = `已切换为 COC7 规则，并采用房规 ${targetRule.name} (${targetRule.key})：\n${targetRule.desc}`;

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

  const first = input.args[0]?.toLowerCase();
  const isList = first === 'list' || first === '目录';
  const directGroup =
    first === 'coc7' || first === 'dnd5e' || first === 'general' || first === 'all'
      ? first
      : undefined;
  if (isList || directGroup) {
    const rawGroup = directGroup ?? input.args[1]?.toLowerCase() ?? 'all';
    const group =
      rawGroup === 'coc7' || rawGroup === 'dnd5e' || rawGroup === 'general'
        ? rawGroup
        : rawGroup === 'all'
          ? undefined
          : null;
    if (group === null) {
      return replyOnly(
        input,
        context,
        'find.group_invalid',
        '规则分组仅支持 coc7、dnd5e、general 或 all。',
      );
    }
    const pageArg = directGroup ? input.args[1] : input.args[2];
    const requestedPage = Number.parseInt(pageArg ?? '1', 10);
    const entries = listRuleGlossary(group);
    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Number.isInteger(requestedPage)
      ? Math.max(1, Math.min(totalPages, requestedPage))
      : 1;
    const pageEntries = entries.slice((page - 1) * pageSize, page * pageSize);
    const groupName = group?.toUpperCase() ?? 'ALL';
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'rule.find.list',
          ruleVersion: '1.0.0',
          data: { group: group ?? 'all', page, totalPages, entries: pageEntries },
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
          templateKey: 'find.list',
          text: `${groupName} 规则目录 ${page}/${totalPages}：\n${pageEntries
            .map((entry) => `#${entry.id} ${entry.title}`)
            .join('\n')}`,
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const { matches } = searchRuleGlossary(query, 5);
  let text = '';
  if (matches.length === 0) {
    text = `未找到与「${query}」相关的规则条目。`;
  } else {
    const entries = matches.map(
      (match) => `📖 #${match.id} [${match.ruleSet}]【${match.title}】\n${match.content}`,
    );
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
        data: { query, count: matches.length, matches },
      },
    ],
    updates: [],
    replies: [reply],
    logItems: [],
  };
}

async function pingHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const now = context.clock.now();
  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'utility.ping',
        ruleVersion: '1.0.0',
        data: { receivedAt: input.timestamp.toISOString(), repliedAt: now.toISOString() },
      },
    ],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: context.snapshot.conversation.scene,
        targetId: context.snapshot.conversation.externalId,
        originMessageId: input.messageId,
        templateKey: 'utility.ping',
        text: 'Pong',
        deadline: new Date(input.timestamp.getTime() + 300_000),
      },
    ],
    logItems: [],
  };
}

async function whoHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const choices = input.args
    .join(' ')
    .split(/[\s,，]+/u)
    .map((choice) => choice.trim())
    .filter(Boolean);
  if (choices.length < 2) {
    return replyOnly(input, context, 'utility.who.help', '用法：.who <候选1> <候选2> [...]');
  }
  for (let index = choices.length - 1; index > 0; index -= 1) {
    const target = await context.random.integer(0, index);
    [choices[index], choices[target]] = [choices[target] ?? '', choices[index] ?? ''];
  }
  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'utility.who',
        ruleVersion: '1.0.0',
        data: { choices },
      },
    ],
    updates: [],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: context.snapshot.conversation.scene,
        targetId: context.snapshot.conversation.externalId,
        originMessageId: input.messageId,
        templateKey: 'utility.who',
        text: `随机顺序：${choices.join('、')}`,
        deadline: new Date(input.timestamp.getTime() + 300_000),
      },
    ],
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
  let count = 5;
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
      text: 'DND名字生成：\n.namednd [达马拉/卡林珊/莱瑟曼/受国/精灵/矮人/兽人/海族/地精] [<数量>]\n例：.namednd 精灵 3',
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }
  const supportedRaces: Record<string, true> = {
    达马拉: true,
    卡林珊: true,
    莱瑟曼: true,
    受国: true,
    精灵: true,
    矮人: true,
    兽人: true,
    海族: true,
    地精: true,
  };
  if (args[0] && !supportedRaces[args[0]]) {
    return replyOnly(
      input,
      context,
      'fun.namednd.unknown_race',
      `不支持种族「${args[0]}」。当前可选：${Object.keys(supportedRaces).join('、')}。`,
    );
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

async function policyHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  const conv = context.snapshot.conversation;
  const sub = input.args[0]?.toLowerCase() ?? 'list';
  const delegates = context.snapshot.delegatePrincipals ?? [];
  if (delegates.length > 1) {
    return replyOnly(input, context, 'policy.target_ambiguous', '一次只能指定一名被提及用户。');
  }
  const target = delegates[0];
  if (sub === 'list' || sub === 'show') {
    const entries = target
      ? [context.snapshot.delegatePolicyEntries?.[target.externalId]].filter(
          (entry) => entry !== undefined,
        )
      : context.snapshot.policyEntries;
    return replyOnly(
      input,
      context,
      'policy.list',
      entries.length > 0
        ? entries
            .map(
              (entry) => `${entry.id}: ${entry.effect}${entry.reason ? ` (${entry.reason})` : ''}`,
            )
            .join('\n')
        : '当前范围没有策略记录。',
    );
  }
  if (!target) {
    return replyOnly(input, context, 'policy.target_required', '请通过平台提及指定要管理的用户。');
  }
  const current = context.snapshot.delegatePolicyEntries?.[target.externalId];
  if (sub === 'rm' || sub === 'del' || sub === 'remove') {
    if (!current) {
      return replyOnly(input, context, 'policy.not_found', '该用户在当前群没有策略记录。');
    }
    return {
      results: [
        {
          executionId: input.executionId,
          kind: 'policy.remove',
          ruleVersion: '1.0.0',
          data: { entryId: current.id, target: target.externalId },
        },
      ],
      updates: [
        {
          type: 'policy-entry-delete',
          entryId: current.id,
          expectedVersion: current.version,
        },
      ],
      replies: [
        {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'policy.remove',
          text: `已移除「${target.name ?? target.externalId}」在当前群的策略记录。`,
          deadline: new Date(input.timestamp.getTime() + 300_000),
        },
      ],
      logItems: [],
    };
  }
  const effect = sub === 'trust' ? 'trust' : sub === 'add' || sub === 'deny' ? 'deny' : undefined;
  if (!effect) {
    return replyOnly(
      input,
      context,
      'policy.help',
      '用法：.black add @用户 [原因]、.black trust @用户 [原因]、.black rm @用户、.black list',
    );
  }
  const reason = input.args.slice(1).join(' ').trim();
  const entryId = current?.id ?? `policy_${conv.id}_${target.externalId}`;
  return {
    results: [
      {
        executionId: input.executionId,
        kind: 'policy.set',
        ruleVersion: '1.0.0',
        data: { entryId, target: target.externalId, effect },
      },
    ],
    updates: [
      {
        type: 'policy-entry',
        entryId,
        expectedVersion: current?.version ?? 0,
        changes: {
          scope: 'group',
          scopeId: conv.externalId,
          principalId: target.externalId,
          effect,
          ...(reason ? { reason } : {}),
        },
        newVersion: (current?.version ?? 0) + 1,
      },
    ],
    replies: [
      {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'policy.set',
        text: `已将「${target.name ?? target.externalId}」在当前群设为 ${effect === 'deny' ? '拒绝' : '信任'}。`,
        deadline: new Date(input.timestamp.getTime() + 300_000),
      },
    ],
    logItems: [],
  };
}

async function unsupportedAdministrationHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  return replyOnly(
    input,
    context,
    'system.unsupported',
    `「.${input.commandName}」依赖 SealDice 的常驻进程或扩展管理模型，Cloudflare Workers 部署不提供该运行时操作。`,
  );
}

async function unsupportedRulesetHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  return replyOnly(
    input,
    context,
    'ruleset.unsupported',
    `当前部署尚未启用「.${input.commandName}」对应规则集；已支持的核心规则为 COC7 与 DND5E。`,
  );
}

async function unsupportedMessagingHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  return replyOnly(
    input,
    context,
    'messaging.unsupported',
    `「.${input.commandName}」依赖平台主动消息、群成员事件或可信骰主收件身份；当前 QQ 官方机器人部署未验证该权限，因此不会伪造成功。群内处置请使用 .black，固定欢迎语和回复应由配置包发布。`,
  );
}

async function unsupportedExtensionHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  return replyOnly(
    input,
    context,
    'extension.unsupported',
    `当前部署未启用「.${input.commandName}」对应的聊天侧扩展能力。`,
  );
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
      aliases: ['rc', 'drc', 'cra', 'crc'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Perform skill or attribute check',
    },
    checkHandler,
  );

  registry.register(
    {
      name: 'rah',
      aliases: ['rch', 'crah', 'crch'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Perform a hidden rules check through a trusted C2C binding',
    },
    hiddenCheckHandler,
  );

  registry.register(
    {
      name: 'rav',
      aliases: ['rcv'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Perform a COC opposed check',
    },
    opposedCheckHandler,
  );

  registry.register(
    {
      name: 'check',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: true,
      description: 'Explain unsupported SealDice authenticity verification',
    },
    unsupportedCheckHandler,
  );

  registry.register(
    {
      name: 'ri',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e batch initiative rolls',
    },
    initiativeRollHandler,
  );

  registry.register(
    {
      name: 'init',
      aliases: ['initiative'],
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
      name: 'buff',
      aliases: ['dbuff'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e temporary attribute and proficiency modifiers',
    },
    buffHandler,
  );

  registry.register(
    {
      name: 'ss',
      aliases: ['spell', 'spellslots', 'dss', '法术位'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'DND5e spell slot manager',
    },
    spellSlotHandler,
  );

  registry.register(
    {
      name: 'cast',
      aliases: ['dcast'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Consume DND5e spell slots',
    },
    castHandler,
  );

  registry.register(
    {
      name: 'longrest',
      aliases: ['rest', '长休', 'dlongrest'],
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
      aliases: ['查询', '査詢'],
      permission: 'all',
      allowedWhenDisabled: true,
      description: 'Search TRPG rule glossary',
    },
    findHandler,
  );

  registry.register(
    {
      name: 'ping',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: true,
      description: 'Confirm the command path is responsive',
    },
    pingHandler,
  );

  registry.register(
    {
      name: 'who',
      aliases: [],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Randomize candidate order',
    },
    whoHandler,
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
      aliases: ['咕咕'],
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
      aliases: ['魔都', 'cnmods'],
      permission: 'all',
      allowedWhenDisabled: false,
      description: 'Search cnmods modules',
    },
    moduHandler,
  );
  registry.register(
    {
      name: 'black',
      aliases: ['ban'],
      permission: 'groupHost',
      allowedWhenDisabled: true,
      description: 'Manage group-scoped user policies',
    },
    policyHandler,
  );

  for (const name of ['send', 'reply', 'welcome', 'team']) {
    registry.register(
      {
        name,
        aliases: [],
        permission: 'all',
        allowedWhenDisabled: true,
        description: 'Explain an unavailable platform messaging workflow',
      },
      unsupportedMessagingHandler,
    );
  }

  for (const command of [
    { name: 'alias', aliases: ['a', '&'] },
    { name: 'text', aliases: [] },
    { name: 'ob', aliases: [] },
    { name: 'sn', aliases: [] },
    { name: 'command', aliases: [] },
    { name: 'stat', aliases: ['hiy'] },
  ]) {
    registry.register(
      {
        name: command.name,
        aliases: command.aliases,
        permission: 'all',
        allowedWhenDisabled: false,
        description: 'Explain an unavailable extension workflow',
      },
      unsupportedExtensionHandler,
    );
  }

  for (const name of ['dismiss', 'botlist', 'master', 'randalgo', 'ext']) {
    registry.register(
      {
        name,
        aliases: [],
        permission: 'all',
        allowedWhenDisabled: true,
        description: 'Explain an unavailable runtime administration command',
      },
      unsupportedAdministrationHandler,
    );
  }

  for (const command of [
    { name: 'rsr', aliases: [] },
    { name: 'ek', aliases: [] },
    { name: 'ekgen', aliases: [] },
    { name: 'dx', aliases: ['dxh'] },
    { name: 'ww', aliases: ['w', 'wh', 'wwh'] },
    { name: 'jsr', aliases: [] },
    { name: 'drl', aliases: ['drlh'] },
  ]) {
    registry.register(
      {
        name: command.name,
        aliases: command.aliases,
        permission: 'all',
        allowedWhenDisabled: false,
        description: 'Explain a ruleset extension that is not enabled',
      },
      unsupportedRulesetHandler,
    );
  }

  return registry;
}
