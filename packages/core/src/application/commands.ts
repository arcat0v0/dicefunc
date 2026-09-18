import { applyKeepDrop, rollDice } from '../domain/dice/expression.js';
import { parseDiceExpression } from '../domain/dice/parser.js';
import type { Clock } from '../ports/clock.js';
import type { RandomSource } from '../ports/random-source.js';
import type {
  CommandResult,
  InboundLogItem,
  Permissions,
  PreparedReply,
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

  return registry;
}
