import { getBuiltinDeck, listBuiltinDecks } from '../domain/deck/builtin-decks.js';
import {
  type Card,
  type DeckSession,
  createDeckSession,
  drawFromDeck,
} from '../domain/deck/deck.js';
import { applyKeepDrop, rollDice } from '../domain/dice/expression.js';
import { parseDiceExpression } from '../domain/dice/parser.js';
import {
  type Coc7CardAttributes,
  formatCoc7CardBatch,
  formatCoc7CardSingle,
  generateCoc7Card,
} from '../domain/rules/coc7/character-gen.js';
import { performCocCheck } from '../domain/rules/coc7/check.js';
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
import type { Clock } from '../ports/clock.js';
import type { RandomSource } from '../ports/random-source.js';
import type {
  CommandResult,
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
  const exprText =
    input.args.length > 0
      ? input.args.join(' ').trim()
      : `d${context.snapshot.conversation.diceSides}`;

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
  const totalRollsNeeded = expr.count * expr.repeat;

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
  }[] = [];

  for (let r = 0; r < expr.repeat; r++) {
    const rolls = await rollDice(expr.faces, expr.count, context.random);
    let kept = rolls;
    if (expr.keepDrop && expr.keepCount !== undefined) {
      kept = applyKeepDrop(rolls, expr.keepDrop, expr.keepCount);
    }
    const sum = kept.reduce((a, b) => a + b, 0) + (expr.modifier ?? 0);
    repeatResults.push({ rolls, keptRolls: kept, total: sum });
  }

  const textLines: string[] = [];
  for (const [idx, row] of repeatResults.entries()) {
    const prefix = expr.repeat > 1 ? `#${idx + 1}: ` : '';
    const rollsStr = `[${row.rolls.join(', ')}]`;
    const modStr =
      expr.modifier !== undefined
        ? expr.modifier >= 0
          ? `+${expr.modifier}`
          : `${expr.modifier}`
        : '';
    const reasonStr = expr.reason ? ` ${expr.reason}` : '';
    textLines.push(
      `${prefix}${expr.count}d${expr.faces}${modStr} = ${rollsStr} = ${row.total}${reasonStr}`,
    );
  }

  const resultData: Record<string, unknown> = {
    expression: exprText,
    faces: expr.faces,
    count: expr.count,
    repeat: expr.repeat,
    repeats: repeatResults,
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

async function helpHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const text =
    'DiceFunc Commands:\n' +
    '.r [expr] [reason] - Roll dice (e.g. .r 1d100, .r 3d6+2)\n' +
    '.bot on/off - Enable or disable bot in this conversation\n' +
    '.set rule <coc7|dnd5e> - Set conversation rule set\n' +
    '.set sides <number> - Set default dice sides\n' +
    '.userid - View your user ID\n' +
    '.help - Show this message';

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

  if (input.args.length < 2) {
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: context.snapshot.conversation.scene,
      targetId: context.snapshot.conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'set.usage',
      text: 'Usage: .set rule <coc7|dnd5e> OR .set sides <number>',
      deadline,
    };
    return {
      results: [],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }

  const [subKeyRaw, subValue = ''] = input.args;
  const subKey = subKeyRaw?.toLowerCase();

  const conv = context.snapshot.conversation;
  const changes: {
    ruleSet?: string | undefined;
    diceSides?: number | undefined;
    enabled?: boolean | undefined;
  } = {};

  let confirmationText = '';

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
    if (requestedAttrs.length > 0) {
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
  const regex = /([\u4e00-\u9fa5a-zA-Z0-9_]+)\s*([:+=-]?)\s*(-?\d+)/g;
  const changes: Record<string, number> = {};
  const changeDescriptions: string[] = [];
  const currentAttrs = sheet ? { ...sheet.attributes } : {};

  let match: RegExpExecArray | null = regex.exec(rawText);
  while (match !== null) {
    const key = match[1];
    const op = match[2];
    const val = Number.parseInt(match[3] ?? '0', 10);
    if (key && !Number.isNaN(val)) {
      const prev = currentAttrs[key] ?? 0;
      let nextVal = val;
      if (op === '+') {
        nextVal = prev + val;
      } else if (op === '-') {
        nextVal = prev - val;
      }
      currentAttrs[key] = nextVal;
      changes[key] = nextVal;
      changeDescriptions.push(`${key}: ${nextVal}`);
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
      principalId: senderId,
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
        principalId: senderId,
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
        principalId: senderId,
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

async function logHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const activeLog = context.snapshot.activeStoryLog;
  const args = input.args;
  const sub = args[0]?.toLowerCase();

  if (sub === 'new') {
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
  const actorName = sheet?.name ?? `用户_${senderId.slice(-4) || '1'}`;
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

  const checkResult = await performCocCheck(
    {
      character: sheet,
      skillName,
      targetValue,
      bonusDice,
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
        data: { ...(checkResult as unknown as Record<string, unknown>) },
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
  const actorName = sheet?.name ?? `用户_${senderId.slice(-4) || '1'}`;
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
  const actorName = sheet?.name ?? `用户_${senderId.slice(-4) || '1'}`;
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
  const actorName = sheet?.name ?? `用户_${input.sender?.externalId.slice(-4) || '1'}`;
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
  const actorName = sheet?.name ?? `用户_${input.sender?.externalId.slice(-4) || '1'}`;
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
      name: 'help',
      aliases: ['h', '?'],
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
      permission: 'groupHost',
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
  return registry;
}
