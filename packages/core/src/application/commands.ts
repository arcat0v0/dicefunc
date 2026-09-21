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
import {
  type AstNode,
  UnresolvedVariableError,
  collectDiceBudget,
  evaluateAst,
  resolveAstVariables,
} from '../domain/dice/ast.js';
import { applyKeepDrop, rollDice } from '../domain/dice/expression.js';
import { parseDiceExpression } from '../domain/dice/parser.js';
import { getRandomGugu } from '../domain/fun/gugu.js';
import { computeJrrp } from '../domain/fun/jrrp.js';
import { fetchCnmodsDetail, fetchCnmodsSearch } from '../domain/fun/modu.js';
import { generateDndName, generateRandomName } from '../domain/fun/name.js';
import {
  createHiddenRollLinkToken,
  hashHiddenRollLinkToken,
  isHiddenRollLinkToken,
} from '../domain/hidden-roll/binding.js';
import {
  type Coc7CardAttributes,
  calculateCoc7DamageBonus,
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
import {
  COC_LEVEL_LABELS,
  HELP_BY_TOPIC,
  HELP_OVERVIEW,
  HELP_TOPIC_ALIASES,
  type MessageCatalog,
  type MessageKey,
  type MessageValue,
  STORY_LOG_STATUS_LABELS,
  defaultMessageCatalog,
  formatCnmodsDetail,
  formatCnmodsSearchResult,
  formatCoc7CardBatch,
  formatCoc7CardSingle,
  formatDnd5eFreeCard,
  formatDnd5ePresetCard,
} from '../messages/index.js';
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
  readonly messageCatalog?: MessageCatalog | undefined;
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
function formatMessage(
  context: CommandContext,
  key: MessageKey,
  values?: Readonly<Record<string, MessageValue>>,
): string {
  return (context.messageCatalog ?? defaultMessageCatalog).format(key, values);
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

function findCharacterAttribute(
  ruleSet: string,
  attributes: Readonly<Record<string, number>>,
  requestedName: string,
): number | undefined {
  const normalizedName = normalizeAttributeName(ruleSet, requestedName);
  const directValue = attributes[normalizedName] ?? attributes[requestedName];
  if (directValue !== undefined) {
    return directValue;
  }
  for (const [storedName, value] of Object.entries(attributes)) {
    if (normalizeAttributeName(ruleSet, storedName) === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function resolveRollVariable(name: string, context: CommandContext): AstNode | undefined {
  const conversation = context.snapshot.conversation;
  const attributes = context.snapshot.sheet?.attributes;
  if (!attributes) {
    return undefined;
  }

  const normalizedName = normalizeAttributeName(conversation.ruleSet, name);
  const explicitValue = findCharacterAttribute(conversation.ruleSet, attributes, normalizedName);
  if (explicitValue !== undefined) {
    return { kind: 'number', value: explicitValue };
  }

  if (conversation.ruleSet === 'coc7' && normalizedName === 'DB') {
    const strength = findCharacterAttribute(conversation.ruleSet, attributes, '力量');
    const size = findCharacterAttribute(conversation.ruleSet, attributes, '体型');
    if (strength === undefined || size === undefined) {
      return undefined;
    }
    const damageBonus = calculateCoc7DamageBonus(strength, size);
    return damageBonus.kind === 'constant'
      ? { kind: 'number', value: damageBonus.value }
      : { kind: 'dice', count: damageBonus.count, faces: damageBonus.faces };
  }

  return undefined;
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

  const parseResult = parseDiceExpression(exprText, context.snapshot.conversation.diceSides, {
    allowVariables: true,
  });

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
      text: formatMessage(context, 'dice.invalid_expression'),
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
  let resolvedAst: AstNode;
  try {
    resolvedAst = resolveAstVariables(expr.ast, (name) => resolveRollVariable(name, context));
  } catch (error) {
    if (!(error instanceof UnresolvedVariableError)) {
      throw error;
    }
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: context.snapshot.conversation.scene,
      targetId: context.snapshot.conversation.externalId,
      originMessageId: input.messageId,
      templateKey: 'dice.error',
      text: formatMessage(context, 'dice.unresolved_variable', {
        name: error.variableName,
      }),
      deadline,
    };
    return {
      results: [],
      updates: [],
      replies: [reply],
      logItems: [],
    };
  }
  const { totalDice } = collectDiceBudget(resolvedAst);
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
      text: formatMessage(context, 'dice.budget_exceeded', {
        required: totalRollsNeeded,
        limit: context.budget.maxDiceRolls,
      }),
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
    const evalResult = await evaluateAst(resolvedAst, context.random);
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
      textLines.push(
        formatMessage(context, 'dice.roll.compound', {
          prefix,
          expression: exprText,
          rendered: row.rendered ?? '',
          total: row.total,
          reason: reasonStr,
        }),
      );
    } else {
      const rollsStr = `[${row.rolls.join(', ')}]`;
      const modStr =
        expr.modifier !== undefined
          ? expr.modifier >= 0
            ? `+${expr.modifier}`
            : `${expr.modifier}`
          : '';
      textLines.push(
        formatMessage(context, 'dice.roll.simple', {
          prefix,
          count: expr.count,
          faces: expr.faces,
          modifier: modStr,
          rolls: row.rolls.join(', '),
          total: row.total,
          reason: reasonStr,
        }),
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
      text = formatMessage(context, 'dice.hidden.c2c_off');
    } else {
      const principalId = context.snapshot.principalId;
      if (!principalId) {
        text = formatMessage(context, 'dice.hidden.c2c_uninitialized');
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
        text = formatMessage(context, 'dice.hidden.token', { token });
      }
    }
  } else {
    const subcommand = input.args[0]?.trim() ?? '';
    const binding = context.snapshot.hiddenRollBinding;

    if (!subcommand || subcommand.toLowerCase() === 'help') {
      text = binding
        ? binding.activeMessagesEnabled
          ? formatMessage(context, 'dice.hidden.bound')
          : formatMessage(context, 'dice.hidden.bound_unsynced')
        : formatMessage(context, 'dice.hidden.bind_help');
    } else if (subcommand.toLowerCase() === 'off') {
      if (!binding) {
        text = formatMessage(context, 'dice.hidden.not_bound');
      } else {
        updates.push({
          type: 'hidden-roll-unbind',
          bindingId: binding.id,
          expectedVersion: binding.version,
          newVersion: binding.version + 1,
        });
        text = formatMessage(context, 'dice.hidden.unbound');
      }
    } else if (binding) {
      text = formatMessage(context, 'dice.hidden.already_bound');
    } else if (!isHiddenRollLinkToken(subcommand)) {
      text = formatMessage(context, 'dice.hidden.invalid_token_format');
      templateKey = 'dice.hidden.binding.error';
    } else if (!context.hiddenRollLinks || !context.snapshot.principalId) {
      text = formatMessage(context, 'dice.hidden.unavailable');
      templateKey = 'dice.hidden.binding.error';
    } else {
      const tokenHash = await hashHiddenRollLinkToken(subcommand);
      const challenge = await context.hiddenRollLinks.findHiddenRollLinkChallenge(
        context.botId,
        tokenHash,
        context.clock.now(),
      );
      if (!challenge) {
        text = formatMessage(context, 'dice.hidden.invalid_token');
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
        text = formatMessage(context, 'dice.hidden.bind_success');
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
      text: formatMessage(context, 'dice.hidden.binding_required'),
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
      text: formatMessage(context, 'dice.hidden.group_sent'),
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
      text: formatMessage(context, 'dice.hidden.group_failed'),
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
          ? formatMessage(context, 'system.help.search_results', {
              query: fullArg,
              results: matches
                .map((match) =>
                  formatMessage(context, 'system.help.result_item', {
                    title: match.title,
                    content: match.content,
                  }),
                )
                .join('\n\n'),
            })
          : formatMessage(context, 'system.help.not_found', { query: fullArg });
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
      text: formatMessage(context, 'set.usage'),
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
      confirmationText = formatMessage(context, 'set.reset_sides');
    } else if (firstArg === 'coc' || firstArg === 'coc7') {
      changes.ruleSet = 'coc7';
      confirmationText = formatMessage(context, 'set.rule', { ruleSet: 'COC7' });
    } else if (firstArg === 'dnd' || firstArg === 'dnd5e') {
      changes.ruleSet = 'dnd5e';
      confirmationText = formatMessage(context, 'set.rule', { ruleSet: 'DND5E' });
    } else {
      const sides = Number.parseInt(firstArg, 10);
      if (!Number.isNaN(sides) && sides > 0) {
        changes.diceSides = sides;
        confirmationText = formatMessage(context, 'set.sides', { sides });
      } else {
        const reply: PreparedReply = {
          executionId: input.executionId,
          part: 1,
          msgSeq: 1,
          scene: conv.scene,
          targetId: conv.externalId,
          originMessageId: input.messageId,
          templateKey: 'set.error',
          text: formatMessage(context, 'set.invalid_argument', { argument: firstArg }),
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
          formatMessage(context, 'set.unsupported_rule', { ruleSet: subValue }),
        );
      }
      changes.ruleSet = ruleSet;
      confirmationText = formatMessage(context, 'set.rule', {
        ruleSet: ruleSet === 'coc7' ? 'COC7' : 'DND5E',
      });
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
          text: formatMessage(context, 'set.invalid_sides', { value: subValue }),
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
      confirmationText = formatMessage(context, 'set.sides', { sides });
    } else {
      const reply: PreparedReply = {
        executionId: input.executionId,
        part: 1,
        msgSeq: 1,
        scene: conv.scene,
        targetId: conv.externalId,
        originMessageId: input.messageId,
        templateKey: 'set.unknown_key',
        text: formatMessage(context, 'set.unknown_key', { key: subKey ?? '' }),
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
      text: formatMessage(context, 'bot.usage'),
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

  const text = formatMessage(context, nextEnabled ? 'bot.enabled' : 'bot.disabled');

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
  const text = formatMessage(context, 'user.id', {
    userId: userExternalId,
    conversationId: conversationExternalId,
    scene: conv.scene,
  });

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
            text: formatMessage(context, 'character.sheet.unbound'),
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
      text = formatMessage(context, 'character.attributes.filtered', {
        name: sheet.name,
        threshold,
        attributes:
          filtered.length > 0
            ? filtered
                .map(([name, value]) =>
                  formatMessage(context, 'character.attributes.item', { name, value }),
                )
                .join(', ')
            : formatMessage(context, 'character.attributes.none_matching'),
      });
    } else if (requestedAttrs.length > 0) {
      const items = requestedAttrs.map((requestedName) => {
        const name = normalizeAttributeName(conv.ruleSet, requestedName);
        const calculated =
          conv.ruleSet === 'dnd5e' ? resolveDndCheckModifier(sheet.attributes, name) : undefined;
        const value =
          calculated?.modifier ??
          sheet.attributes[name] ??
          sheet.attributes[requestedName] ??
          formatMessage(context, 'character.attributes.unset');
        return formatMessage(context, 'character.attributes.item', { name, value });
      });
      text = formatMessage(context, 'character.attributes.selected', {
        name: sheet.name,
        attributes: items.join(', '),
      });
    } else {
      const entries = Object.entries(sheet.attributes);
      const attrsStr =
        entries.length > 0
          ? entries
              .map(([name, value]) =>
                formatMessage(context, 'character.attributes.item', { name, value }),
              )
              .join(', ')
          : formatMessage(context, 'character.attributes.none');
      text = formatMessage(context, 'character.attributes.all', {
        name: sheet.name,
        attributes: attrsStr,
      });
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
            text: formatMessage(context, 'character.sheet.unbound'),
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
          text: formatMessage(context, 'character.attributes.clear', { name: sheet.name }),
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
            text: formatMessage(context, 'character.sheet.unbound'),
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
          text: formatMessage(context, 'character.attributes.remove', {
            name: sheet.name,
            attributes: toRemove.join(', '),
          }),
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
          ? formatMessage(context, 'character.attributes.change_roll', {
              name: key,
              previous: prev,
              next: nextVal,
              operator: '+',
              expression: valStr,
              value: val,
            })
          : formatMessage(context, 'character.attributes.change', { name: key, value: nextVal }),
      );
    } else if (assignment.operator === '-') {
      nextVal = prev - val;
      modificationDescriptions.push(
        /[dD]/.test(valStr)
          ? formatMessage(context, 'character.attributes.change_roll', {
              name: key,
              previous: prev,
              next: nextVal,
              operator: '-',
              expression: valStr,
              value: val,
            })
          : formatMessage(context, 'character.attributes.change', { name: key, value: nextVal }),
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
          text: formatMessage(context, 'character.attributes.invalid'),
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const updates: StateUpdate[] = [];
  let sheetName = sheet?.name ?? formatMessage(context, 'character.default_name');

  if (!sheet) {
    const senderId = input.sender?.externalId ?? 'unknown';
    const sheetId = `sheet_${context.botId}_${senderId}_${Date.now()}`;
    sheetName = formatMessage(context, 'character.generated_name', {
      suffix: senderId.slice(-4) || '1',
    });
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
            ? formatMessage(context, 'character.attributes.changed', {
                name: sheetName,
                changes: modificationDescriptions.join('\n'),
              })
            : formatMessage(context, 'character.attributes.saved', {
                name: sheetName,
                ruleSet: conv.ruleSet.toUpperCase(),
                count: Object.keys(changes).length,
              }),
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
    const name =
      args.slice(1).join(' ').trim() || formatMessage(context, 'character.create.unnamed');
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
          text: formatMessage(context, 'character.create', { name, id: sheetId }),
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
          text: formatMessage(context, 'character.unbind'),
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'save') {
    if (!sheet) {
      return replyOnly(
        input,
        context,
        'character.sheet.unbound',
        formatMessage(context, 'character.save.unbound'),
      );
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
          text: formatMessage(context, 'character.save', {
            name: saveName,
            id: snapshotSheetId,
          }),
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
        formatMessage(context, 'character.load.help'),
      );
    }
    const targetSheet = resolveOwnedSheet(target);
    if (!targetSheet) {
      return replyOnly(
        input,
        context,
        'character.not_found',
        formatMessage(context, 'character.not_found'),
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
          text: formatMessage(context, 'character.load', {
            name: targetSheet.name,
            id: targetSheet.id,
          }),
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
        formatMessage(context, 'character.rename.help'),
      );
    }
    const targetSheet = args.length === 2 ? sheet : resolveOwnedSheet(args[1] ?? '');
    const newName = (args.length === 2 ? args[1] : args.slice(2).join(' '))?.trim() ?? '';
    if (!targetSheet || !ownedSheets.some((candidate) => candidate.id === targetSheet.id)) {
      return replyOnly(
        input,
        context,
        'character.not_found',
        formatMessage(context, 'character.rename.not_found'),
      );
    }
    if (!newName) {
      return replyOnly(
        input,
        context,
        'character.rename.help',
        formatMessage(context, 'character.rename.empty'),
      );
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
          text: formatMessage(context, 'character.rename', {
            oldName: targetSheet.name,
            newName,
          }),
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
      return replyOnly(
        input,
        context,
        'character.not_found',
        formatMessage(context, 'character.delete.not_found'),
      );
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
          text: formatMessage(context, 'character.delete', { name: targetSheet.name }),
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
        ? formatMessage(context, 'character.list', {
            items: sheets
              .map((candidate) =>
                formatMessage(context, 'character.list.item', {
                  marker: candidate.active ? '* ' : '- ',
                  name: candidate.name,
                  id: candidate.id,
                }),
              )
              .join('\n'),
          })
        : formatMessage(context, 'character.list.empty');
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

  return replyOnly(input, context, 'character.help', formatMessage(context, 'character.help'));
}

async function nnHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const deadline = new Date(input.timestamp.getTime() + 300_000);
  const conv = context.snapshot.conversation;
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const defaultName =
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });
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
          text: formatMessage(context, 'character.nn.current', { name: currentName }),
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub.toLowerCase() === 'help') {
    const helpText = formatMessage(context, 'character.nn.help');
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
    const text = formatMessage(context, 'character.nn.reset', {
      oldName: currentName,
      suffix: senderId.slice(-4),
      newName: defaultName,
    });
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
  const text = formatMessage(context, 'character.nn.set', {
    oldName: currentName,
    suffix: senderId.slice(-4),
    newName,
  });
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
                  .map((log) =>
                    formatMessage(context, 'story_log.list.item', {
                      id: log.id,
                      name: log.name,
                      status: log.status,
                      count: log.itemCount ?? 0,
                    }),
                  )
                  .join('\n')
              : formatMessage(context, 'story_log.list.empty'),
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
            text: formatMessage(context, 'story_log.already_active', {
              name: activeLog.name,
            }),
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
          text: formatMessage(context, 'story_log.new', { name: logName }),
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
            text: formatMessage(context, 'story_log.not_recording'),
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
          text: formatMessage(context, 'story_log.pause', { name: activeLog.name }),
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
            text: formatMessage(context, 'story_log.not_found'),
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
          text: formatMessage(context, 'story_log.resume', { name: activeLog.name }),
          deadline,
        },
      ],
      logItems: [],
    };
  }

  if (sub === 'halt') {
    if (!activeLog || activeLog.status === 'closed') {
      return replyOnly(
        input,
        context,
        'story_log.not_recording',
        formatMessage(context, 'story_log.not_recording'),
      );
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
          text: formatMessage(context, 'story_log.halt', { name: activeLog.name }),
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
        formatMessage(context, 'story_log.delete_forbidden'),
      );
    }
    if (!targetText || !latestLog) {
      return replyOnly(
        input,
        context,
        'story_log.not_found',
        formatMessage(context, 'story_log.delete_not_found'),
      );
    }
    if (activeLog?.id === latestLog.id || latestLog.status !== 'closed') {
      return replyOnly(
        input,
        context,
        'story_log.delete_active',
        formatMessage(context, 'story_log.delete_active'),
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
          text: formatMessage(context, 'story_log.delete', { name: latestLog.name }),
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
            text: formatMessage(context, 'story_log.not_recording'),
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
          text: formatMessage(context, 'story_log.end', { name: activeLog.name }),
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
            text: formatMessage(context, 'story_log.export_forbidden'),
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
            text: formatMessage(context, 'story_log.export_none'),
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
            text: formatMessage(context, 'story_log.export_active', {
              name: latestLog.name,
            }),
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
            text: formatMessage(context, 'story_log.export_requested', {
              name: latestLog.name,
            }),
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
            text: formatMessage(context, 'story_log.export_pending', {
              name: latestLog.name,
            }),
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
            text: formatMessage(context, 'story_log.export_unavailable', {
              name: latestLog.name,
            }),
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
            text: formatMessage(context, 'story_log.export_unconfigured'),
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
          text: formatMessage(context, 'story_log.export', {
            name: latestLog.name,
            url: downloadUrl,
          }),
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
            text: formatMessage(context, 'story_log.stat.none'),
            deadline,
          },
        ],
        logItems: [],
      };
    }

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
          text: formatMessage(context, 'story_log.stat', {
            status: STORY_LOG_STATUS_LABELS[latestLog.status] ?? latestLog.status,
            name: latestLog.name,
            itemCount: latestLog.itemCount ?? 0,
            rollCount: latestLog.rollCount ?? 0,
            archiveStatus:
              latestLog.archive?.status === 'ready'
                ? formatMessage(context, 'story_log.archive.ready')
                : latestLog.archive
                  ? latestLog.archive.status
                  : formatMessage(context, 'story_log.archive.none'),
          }),
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
        text: formatMessage(context, 'story_log.help'),
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
    formatMessage(context, 'system.check.unsupported'),
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
    formatMessage(context, 'character.rule_mismatch', {
      sheetRule: sheet.ruleSet,
      sessionRule: expectedRuleSet,
    }),
  );
}

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
      formatMessage(context, 'coc.check.delegate_missing'),
    );
  }
  const checkArgs = hasDelegateToken ? input.args.slice(1) : input.args;
  const sheet = delegateSheet ?? context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });

  if (checkArgs.length === 0) {
    return replyOnly(
      input,
      context,
      conv.ruleSet === 'dnd5e' ? 'dnd5e.check.help' : 'coc.check.help',
      conv.ruleSet === 'dnd5e'
        ? formatMessage(context, 'dnd5e.check.help')
        : formatMessage(context, 'coc.check.help'),
    );
  }

  if (conv.ruleSet === 'dnd5e') {
    const parsed = parseDndCheckArgs(checkArgs);
    if (!parsed.success) {
      return replyOnly(
        input,
        context,
        'dnd5e.check.invalid',
        formatMessage(context, 'dnd5e.check.invalid'),
      );
    }
    const skillName = normalizeAttributeName('dnd5e', parsed.value.name);
    const checkModifier = sheet ? resolveDndCheckModifier(sheet.attributes, skillName) : undefined;
    if (!checkModifier) {
      return replyOnly(
        input,
        context,
        'dnd5e.check.missing_attribute',
        formatMessage(context, 'dnd5e.check.missing_attribute', { skill: skillName }),
      );
    }
    let parsedExtra: NumericExpression | undefined;
    let extraSign = 1;
    if (parsed.value.extraModifier) {
      extraSign = parsed.value.extraModifier.startsWith('-') ? -1 : 1;
      parsedExtra = parseNumericExpression(parsed.value.extraModifier.slice(1), 20);
      if (!parsedExtra) {
        return replyOnly(
          input,
          context,
          'dnd5e.check.invalid',
          formatMessage(context, 'dnd5e.check.invalid_modifier'),
        );
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
      const diceText =
        rolls.length === 1
          ? formatMessage(context, 'dnd5e.check.roll', { roll: d20 })
          : formatMessage(context, 'dnd5e.check.advantage_roll', {
              rolls: rolls.join(','),
              roll: d20,
            });
      lines.push(
        formatMessage(context, 'dnd5e.check.result', {
          prefix: parsed.value.repeat > 1 ? `${index + 1}. ` : '',
          actor: actorName,
          skill: skillName,
          dice: diceText,
          modifier: checkModifier.modifier,
          extra:
            extraModifier === 0
              ? ''
              : ` ${extraModifier > 0 ? '+' : '-'} ${Math.abs(extraModifier)}`,
          total,
          dc:
            parsed.value.dc === undefined
              ? ''
              : formatMessage(context, 'dnd5e.check.dc', {
                  dc: parsed.value.dc,
                  result: success
                    ? formatMessage(context, 'dnd5e.check.passed')
                    : formatMessage(context, 'dnd5e.check.failed'),
                }),
        }),
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
          text: `${lines.join('\n')}${
            parsed.value.reason
              ? formatMessage(context, 'dnd5e.check.reason', { reason: parsed.value.reason })
              : ''
          }`,
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
    return replyOnly(
      input,
      context,
      'coc.check.invalid',
      formatMessage(context, 'coc.check.invalid'),
    );
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
      formatMessage(context, 'coc.check.missing_attribute', { skill: skillName }),
    );
  }

  const command = input.commandName.toLowerCase();
  const forceRulebook =
    command === 'rc' || command === 'crc' || command === 'rch' || command === 'crch';
  const ruleId = forceRulebook ? '0' : (conv.cocRule ?? '0');
  const ruleName =
    resolveCocHouseRule(ruleId)?.name ??
    formatMessage(context, 'coc.check.rule_fallback', { ruleId });
  const ruleText =
    ruleId === '0' ? '' : formatMessage(context, 'coc.check.rule', { rule: ruleName });
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
    const requirementLabel = COC_LEVEL_LABELS[parsed.value.difficulty] ?? parsed.value.difficulty;
    const outcomeLabel = COC_LEVEL_LABELS[check.level] ?? check.level;
    const resultDetail = success
      ? formatMessage(context, 'coc.check.result_pass', { outcome: outcomeLabel })
      : rank > 0
        ? formatMessage(context, 'coc.check.result_requirement_failed', {
            outcome: outcomeLabel,
            requirement: requirementLabel,
          })
        : formatMessage(context, 'coc.check.result_failed', { outcome: outcomeLabel });
    const rollDetail =
      parsed.value.bonusDice === 0
        ? formatMessage(context, 'coc.check.roll', { roll: check.rollTotal })
        : formatMessage(context, 'coc.check.roll_bonus', {
            kind: formatMessage(
              context,
              parsed.value.bonusDice > 0 ? 'coc.check.bonus' : 'coc.check.penalty',
            ),
            count: Math.abs(parsed.value.bonusDice),
            rolls: check.rolls.join('、'),
            roll: check.rollTotal,
          });
    const targetDetail =
      parsed.value.modifier === 0
        ? `${check.targetValue}`
        : formatMessage(context, 'coc.check.target_modified', {
            base: baseTarget,
            operator: parsed.value.modifier > 0 ? '+' : '-',
            modifier: Math.abs(parsed.value.modifier),
            target: check.targetValue,
          });
    lines.push(
      formatMessage(context, 'coc.check.block', {
        prefix: parsed.value.repeat > 1 ? `${index + 1}. ` : '',
        actor: actorName,
        skill: skillName,
        roll: rollDetail,
        target: targetDetail,
        requirement: requirementLabel,
        result: resultDetail,
        rule: ruleText,
      }),
    );
  }

  const firstItem = items[0] ?? {};
  const reasonText = parsed.value.reason
    ? formatMessage(context, 'coc.check.reason', { reason: parsed.value.reason })
    : '';
  const summary = `${lines.join('\n\n')}${reasonText}`;
  const data =
    items.length === 1
      ? { actor: actorName, ...firstItem, summary, items }
      : {
          actor: actorName,
          skill: { name: skillName },
          repeat: parsed.value.repeat,
          bonusDice: parsed.value.bonusDice,
          difficulty: parsed.value.difficulty,
          requiredLevel: parsed.value.requiredLevel,
          reason: parsed.value.reason,
          summary,
          items,
        };
  const allSucceeded = items.every((item) => item.success === true);

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
        text: summary,
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
      formatMessage(context, 'coc.hidden.binding_required'),
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
        text: formatMessage(context, 'coc.hidden.group_sent'),
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
        text: formatMessage(context, 'coc.hidden.group_failed'),
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
      formatMessage(context, 'coc.opposed.help'),
    );
  }

  const leftParsed = parseCocCheckArgs([input.args[0] ?? '']);
  const rightParsed = parseCocCheckArgs([input.args[1] ?? '']);
  if (!leftParsed.success || !rightParsed.success) {
    return replyOnly(
      input,
      context,
      'coc.opposed.invalid',
      formatMessage(context, 'coc.opposed.invalid'),
    );
  }
  const sheet = context.snapshot.sheet;
  const senderId = input.sender?.externalId ?? 'unknown';
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });
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
      formatMessage(context, 'coc.opposed.missing_attribute'),
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
  const leftPass = leftRank >= leftParsed.value.requiredLevel;
  const rightPass = rightRank >= rightParsed.value.requiredLevel;
  let winner: 'left' | 'right' | 'tie';
  let resolution: string;
  if (leftPass !== rightPass) {
    winner = leftPass ? 'left' : 'right';
    resolution = formatMessage(context, 'coc.opposed.one_passed', {
      skill: leftPass ? leftSkill : rightSkill,
    });
  } else if (leftRank !== rightRank) {
    winner = leftRank > rightRank ? 'left' : 'right';
    resolution = formatMessage(context, 'coc.opposed.higher_rank');
  } else if (leftTarget !== rightTarget) {
    winner = leftTarget > rightTarget ? 'left' : 'right';
    resolution = formatMessage(context, 'coc.opposed.higher_target');
  } else if (leftCheck.rollTotal !== rightCheck.rollTotal) {
    winner = leftCheck.rollTotal < rightCheck.rollTotal ? 'left' : 'right';
    resolution = formatMessage(context, 'coc.opposed.lower_roll');
  } else {
    winner = 'tie';
    resolution = formatMessage(context, 'coc.opposed.exact_tie');
  }

  const formatOutcome = (
    level: keyof typeof COC_LEVEL_LABELS,
    rank: number,
    requiredLevel: number,
    difficulty: string,
  ): string => {
    const label = COC_LEVEL_LABELS[level] ?? level;
    const requirement =
      difficulty in COC_LEVEL_LABELS
        ? COC_LEVEL_LABELS[difficulty as keyof typeof COC_LEVEL_LABELS]
        : difficulty;
    return rank >= requiredLevel
      ? label
      : rank > 0
        ? formatMessage(context, 'coc.opposed.requirement_failed', {
            outcome: label,
            requirement,
          })
        : label;
  };
  const left = {
    skill: leftSkill,
    target: leftCheck.targetValue,
    roll: leftCheck.rollTotal,
    level: leftCheck.level,
    rank: leftRank,
    passed: leftPass,
    requiredLevel: leftParsed.value.requiredLevel,
  };
  const right = {
    skill: rightSkill,
    target: rightCheck.targetValue,
    roll: rightCheck.rollTotal,
    level: rightCheck.level,
    rank: rightRank,
    passed: rightPass,
    requiredLevel: rightParsed.value.requiredLevel,
  };
  const winnerText =
    winner === 'tie'
      ? formatMessage(context, 'coc.opposed.tie')
      : formatMessage(context, 'coc.opposed.winner', {
          skill: winner === 'left' ? leftSkill : rightSkill,
        });
  const ruleName =
    resolveCocHouseRule(ruleId)?.name ??
    formatMessage(context, 'coc.check.rule_fallback', { ruleId });
  const ruleText =
    ruleId === '0' ? '' : formatMessage(context, 'coc.opposed.rule', { rule: ruleName });
  const text = formatMessage(context, 'coc.opposed.summary', {
    actor: actorName,
    leftSkill,
    leftRoll: left.roll,
    leftTarget: left.target,
    leftOutcome: formatOutcome(
      left.level,
      left.rank,
      left.requiredLevel,
      leftParsed.value.difficulty,
    ),
    rightSkill,
    rightRoll: right.roll,
    rightTarget: right.target,
    rightOutcome: formatOutcome(
      right.level,
      right.rank,
      right.requiredLevel,
      rightParsed.value.difficulty,
    ),
    winner: winnerText,
    resolution,
    rule: ruleText,
  });
  const decision = replyOnly(input, context, 'coc.opposed', text);
  return {
    ...decision,
    results: [
      {
        executionId: input.executionId,
        kind: 'coc.opposed',
        ruleVersion: '1.0.0',
        data: { actor: actorName, left, right, winner, resolution, ruleId },
      },
    ],
  };
}
async function initiativeRollHandler(
  input: CommandInput,
  context: CommandContext,
): Promise<CommandDecision> {
  if (context.snapshot.conversation.ruleSet !== 'dnd5e') {
    return replyOnly(
      input,
      context,
      'dnd5e.rule_required',
      formatMessage(context, 'dnd5e.rule_required'),
    );
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
    context.snapshot.sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });
  const raw = input.args.join(' ').trim();
  const segments = raw ? raw.split(/[,，]/u).map((value) => value.trim()) : [actorName];
  if (segments.some((value) => value.length === 0)) {
    return replyOnly(
      input,
      context,
      'dnd5e.initiative.invalid',
      formatMessage(context, 'dnd5e.initiative.empty'),
    );
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
          formatMessage(context, 'dnd5e.initiative.custom_help'),
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
          formatMessage(context, 'dnd5e.initiative.modifier_help'),
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
      return replyOnly(
        input,
        context,
        'dnd5e.initiative.invalid',
        formatMessage(context, 'dnd5e.initiative.invalid'),
      );
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
        text: formatMessage(context, 'dnd5e.initiative.result', {
          items: orderedItems
            .map((item, index) =>
              formatMessage(context, 'dnd5e.initiative.item', {
                index: index + 1,
                name: item.name,
                initiative: item.initiative,
                expression: item.expression,
              }),
            )
            .join('\n'),
        }),
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

    const text = formatMessage(context, 'dnd5e.init.next', {
      round: nextEnc.round,
      actor: currentCombatant
        ? formatMessage(context, 'dnd5e.init.actor', {
            name: currentCombatant.name,
            initiative: currentCombatant.initiative,
          })
        : formatMessage(context, 'dnd5e.init.no_actor'),
      nextRound: roundAdvanced ? formatMessage(context, 'dnd5e.init.next_round') : '',
    });

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
          text: formatMessage(context, 'dnd5e.init.clear'),
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
            text: formatMessage(context, 'dnd5e.init.empty'),
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const currentActor = currentEnc.combatants[currentEnc.turnIndex];
    const lines = currentEnc.combatants.map((combatant, index) =>
      formatMessage(context, 'dnd5e.init.item', {
        marker: formatMessage(
          context,
          index === currentEnc.turnIndex ? 'dnd5e.init.current_marker' : 'dnd5e.init.normal_marker',
        ),
        name: combatant.name,
        initiative: combatant.initiative,
      }),
    );
    const text = formatMessage(context, 'dnd5e.init.list', {
      round: currentEnc.round,
      items: lines.join('\n'),
      actor: currentActor?.name ?? formatMessage(context, 'dnd5e.init.no_current'),
    });

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
      return replyOnly(
        input,
        context,
        'dnd5e.init.invalid',
        formatMessage(context, 'dnd5e.init.delete_help'),
      );
    }
    const removed = currentEnc.combatants.filter((combatant) => names.includes(combatant.name));
    if (removed.length === 0) {
      return replyOnly(
        input,
        context,
        'dnd5e.init.not_found',
        formatMessage(context, 'dnd5e.init.not_found'),
      );
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
          text: formatMessage(context, 'dnd5e.init.remove', {
            names: removed.map((combatant) => combatant.name).join('、'),
          }),
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
        formatMessage(context, 'dnd5e.init.set_help'),
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
          text: formatMessage(context, 'dnd5e.init.set', {
            name: targetName,
            initiative: finalVal,
          }),
          deadline,
        },
      ],
      logItems: [],
    };
  }

  return replyOnly(input, context, 'dnd5e.init.help', formatMessage(context, 'dnd5e.init.help'));
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
          text: formatMessage(context, 'character.sheet.unbound'),
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
      formatMessage(context, 'dnd5e.hp.missing'),
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
    const text = formatMessage(context, 'dnd5e.hp.show', {
      name: sheet.name,
      currentHp: hpState.currentHp,
      maxHp: hpState.maxHp,
      tempHp:
        hpState.tempHp > 0
          ? formatMessage(context, 'dnd5e.hp.temp_suffix', { tempHp: hpState.tempHp })
          : '',
    });
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

      const text = formatMessage(context, 'dnd5e.hp.damage', {
        name: sheet.name,
        damage: dmg,
        absorbed:
          tempHpAbsorbed > 0
            ? formatMessage(context, 'dnd5e.hp.absorbed', { amount: tempHpAbsorbed })
            : '',
        currentHp: nextState.currentHp,
        maxHp: nextState.maxHp,
        tempHp:
          nextState.tempHp > 0
            ? formatMessage(context, 'dnd5e.hp.remaining_temp', { tempHp: nextState.tempHp })
            : '',
      });

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

      const text = formatMessage(context, 'dnd5e.hp.heal', {
        name: sheet.name,
        healing: effectiveHealing,
        currentHp: nextState.currentHp,
        maxHp: nextState.maxHp,
      });

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
            text: formatMessage(context, 'dnd5e.hp.temp', {
              name: sheet.name,
              tempHp: nextState.tempHp,
            }),
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
            text: formatMessage(context, 'dnd5e.hp.max', {
              name: sheet.name,
              maxHp: nextState.maxHp,
            }),
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
        text: formatMessage(context, 'dnd5e.hp.help'),
        deadline,
      },
    ],
    logItems: [],
  };
}

async function buffHandler(input: CommandInput, context: CommandContext): Promise<CommandDecision> {
  const sheet = context.snapshot.sheet;
  if (!sheet || sheet.ruleSet !== 'dnd5e') {
    return replyOnly(
      input,
      context,
      'dnd5e.buff.card_required',
      formatMessage(context, 'dnd5e.buff.card_required'),
    );
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
        ? formatMessage(context, 'dnd5e.buff.show', {
            name: sheet.name,
            items: currentBuffs
              .map(([name, value]) =>
                formatMessage(context, 'dnd5e.buff.item', {
                  name: name.slice(5),
                  value,
                }),
              )
              .join('，'),
          })
        : formatMessage(context, 'dnd5e.buff.empty', { name: sheet.name }),
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
      formatMessage(context, 'dnd5e.buff.invalid'),
    );
  }
  const update: StateUpdate = {
    type: 'character-sheet',
    sheetId: sheet.id,
    expectedVersion: sheet.version,
    changes: { attributes: nextAttrs },
    newVersion: sheet.version + 1,
  };
  const changedEntries = Object.entries(changed)
    .map(([name, value]) => [name.slice('Buff_'.length), value] as const)
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
  const assignedLines = changedEntries
    .filter((entry): entry is readonly [string, number] => entry[1] !== null)
    .map(([name, value]) => formatMessage(context, 'dnd5e.buff.assignment', { name, value }));
  const removedNames = changedEntries.filter(([, value]) => value === null).map(([name]) => name);
  const details = [
    ...assignedLines,
    ...(removedNames.length > 0
      ? [formatMessage(context, 'dnd5e.buff.removed', { names: removedNames.join('、') })]
      : []),
  ];
  const decision = replyOnly(
    input,
    context,
    'dnd5e.buff.update',
    formatMessage(context, 'dnd5e.buff.update', {
      name: sheet.name,
      details: details.join('\n'),
    }),
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
      formatMessage(context, 'character.sheet.unbound'),
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
    const lines = Object.values(slots).map((slot) =>
      formatMessage(context, 'dnd5e.spell.slot', {
        level: slot.level,
        remaining: slot.total - slot.used,
        total: slot.total,
      }),
    );
    const decision = replyOnly(
      input,
      context,
      'dnd5e.spell.show',
      lines.length > 0
        ? formatMessage(context, 'dnd5e.spell.show', {
            name: sheet.name,
            slots: lines.join('  '),
          })
        : formatMessage(context, 'dnd5e.spell.empty', { name: sheet.name }),
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
        formatMessage(context, 'dnd5e.spell.insufficient', {
          level: level || '?',
          remaining: slot ? slot.total - slot.used : 0,
        }),
      );
    }
    nextAttrs[`法术位_${level}_已用`] = slot.used + count;
    const remaining = slot.total - slot.used - count;
    kind = 'dnd5e.spell.use';
    data = { level, count, remaining };
    text = formatMessage(context, 'dnd5e.spell.use', {
      name: sheet.name,
      count,
      level,
      remaining,
      total: slot.total,
    });
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
        formatMessage(context, 'dnd5e.spell.init_help'),
      );
    }
    totals.forEach((total, index) => {
      nextAttrs[`法术位_${index + 1}`] = total;
      nextAttrs[`法术位_${index + 1}_已用`] = 0;
    });
    kind = 'dnd5e.spell.init';
    data = { totals };
    text = formatMessage(context, 'dnd5e.spell.init', {
      name: sheet.name,
      slots: totals
        .map((total, index) =>
          formatMessage(context, 'dnd5e.spell.full_slot', { level: index + 1, total }),
        )
        .join('，'),
    });
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
      return replyOnly(
        input,
        context,
        'dnd5e.spell.invalid',
        formatMessage(context, 'dnd5e.spell.set_help'),
      );
    }
    kind = 'dnd5e.spell.set';
    data = { updates };
    text = formatMessage(context, 'dnd5e.spell.set', {
      name: sheet.name,
      slots: updates
        .map((item) =>
          formatMessage(context, 'dnd5e.spell.set_slot', {
            level: item.level,
            total: item.total,
          }),
        )
        .join('，'),
    });
  } else if (sub === 'clr' || sub === 'clear') {
    for (let level = 1; level <= 9; level += 1) {
      delete nextAttrs[`法术位_${level}`];
      delete nextAttrs[`法术位_${level}_已用`];
    }
    kind = 'dnd5e.spell.clear';
    text = formatMessage(context, 'dnd5e.spell.clear', { name: sheet.name });
  } else if (sub === 'rest') {
    for (const slot of Object.values(slots)) {
      nextAttrs[`法术位_${slot.level}_已用`] = 0;
    }
    kind = 'dnd5e.spell.rest';
    data = { restoredLevels: Object.keys(slots).map(Number) };
    text = formatMessage(context, 'dnd5e.spell.rest', {
      name: sheet.name,
      slots: Object.values(slots)
        .map((slot) =>
          formatMessage(context, 'dnd5e.spell.full_slot', {
            level: slot.level,
            total: slot.total,
          }),
        )
        .join('，'),
    });
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
        return replyOnly(
          input,
          context,
          'dnd5e.spell.invalid',
          formatMessage(context, 'dnd5e.spell.invalid_change'),
        );
      }
      const used = operator === '-' ? slot.used + amount : Math.max(0, slot.used - amount);
      if (used > slot.total) {
        return replyOnly(
          input,
          context,
          'dnd5e.spell.insufficient',
          formatMessage(context, 'dnd5e.spell.level_insufficient', { level }),
        );
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
        formatMessage(context, 'dnd5e.spell.help'),
      );
    }
    data = { changes };
    text = formatMessage(context, 'dnd5e.spell.changed', {
      name: sheet.name,
      changes: changes
        .map((change) => {
          const total = slots[change.level]?.total ?? change.remaining;
          return formatMessage(context, 'dnd5e.spell.change', {
            level: change.level,
            delta: `${change.delta > 0 ? '+' : ''}${change.delta}`,
            remaining: change.remaining,
            total,
          });
        })
        .join('；'),
    });
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
          text: formatMessage(context, 'dnd5e.longrest.unbound'),
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
      formatMessage(context, 'dnd5e.longrest.missing_max_hp'),
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
        text: formatMessage(context, 'dnd5e.longrest', {
          name: sheet.name,
          maxHp,
        }),
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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });
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
          text: formatMessage(context, 'deck.not_found', { deck: deckId }),
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

  const drawnLines = drawn
    .map((card) => formatMessage(context, 'deck.draw.item', { card: card.text }))
    .join('\n');
  const text = formatMessage(context, 'deck.draw', {
    actor: actorName,
    deck: deck.name,
    cards: drawnLines,
    remaining: nextSession.remaining.length,
  });

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
    const lines = decks.map((deck) =>
      formatMessage(context, 'deck.list.item', {
        id: deck.id,
        name: deck.name,
        count: deck.cards.length,
      }),
    );
    const text = formatMessage(context, 'deck.list', { decks: lines.join('\n') });

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
      return replyOnly(
        input,
        context,
        'deck.search_invalid',
        formatMessage(context, 'deck.search_invalid'),
      );
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
                      ? formatMessage(context, 'deck.search.card', {
                          deckId: match.deckId,
                          cardId: match.cardId ?? '',
                          text: match.text,
                        })
                      : formatMessage(context, 'deck.search.deck', {
                          deckId: match.deckId,
                          deckName: match.deckName,
                        }),
                  )
                  .join('\n')
              : formatMessage(context, 'deck.search.empty', { query }),
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
      formatMessage(context, 'deck.reload_unsupported'),
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
            text: formatMessage(context, 'deck.not_found', { deck: deckId }),
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
          text: formatMessage(context, 'deck.reset', {
            deck: deck.name,
            count: deck.cards.length,
          }),
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
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', {
      suffix: input.sender?.externalId.slice(-4) || '1',
    });
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
            text: formatMessage(context, 'coc.card.help'),
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
      ? formatCoc7CardSingle(context.messageCatalog ?? defaultMessageCatalog, actorName, firstCard)
      : formatCoc7CardBatch(context.messageCatalog ?? defaultMessageCatalog, actorName, cards);

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
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', {
      suffix: input.sender?.externalId.slice(-4) || '1',
    });
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
            text: formatMessage(context, 'dnd.card.help'),
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
    text = formatDnd5ePresetCard(context.messageCatalog ?? defaultMessageCatalog, actorName, cards);
  } else {
    const cards: Dnd5eFreeAllocationCard[] = [];
    for (let i = 0; i < count; i++) {
      cards.push(await generateDnd5eFreeCard(context.random));
    }
    text = formatDnd5eFreeCard(context.messageCatalog ?? defaultMessageCatalog, actorName, cards);
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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });

  if (input.args.length === 0 || input.args[0]?.toLowerCase() === 'help') {
    return replyOnly(input, context, 'coc.sc.help', formatMessage(context, 'coc.sc.help'));
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
    return replyOnly(
      input,
      context,
      'coc.sc.invalid',
      formatMessage(context, 'coc.sc.missing_loss'),
    );
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
      formatMessage(context, 'coc.sc.missing_san'),
    );
  }

  const slash = lossExpression.indexOf('/');
  const successLossExpression = slash >= 0 ? lossExpression.slice(0, slash).trim() || '0' : '0';
  const failureLossExpression =
    slash >= 0 ? lossExpression.slice(slash + 1).trim() : lossExpression.trim();
  const parsedSuccessLoss = parseNumericExpression(successLossExpression, 6);
  const parsedFailureLoss = parseNumericExpression(failureLossExpression, 6);
  if (!parsedSuccessLoss || !parsedFailureLoss) {
    return replyOnly(
      input,
      context,
      'coc.sc.invalid',
      formatMessage(context, 'coc.sc.invalid_loss'),
    );
  }

  const ruleId = conv.cocRule ?? '0';
  let rollTotal: number;
  let rolls: readonly number[];
  let successRank: number;
  if (checkExpression) {
    const parsedCheck = parseNumericExpression(checkExpression, 100);
    if (!parsedCheck) {
      return replyOnly(
        input,
        context,
        'coc.sc.invalid',
        formatMessage(context, 'coc.sc.invalid_check'),
      );
    }
    rollTotal = await evaluateNumericExpression(parsedCheck, context.random);
    if (!Number.isInteger(rollTotal) || rollTotal < 1 || rollTotal > 100) {
      return replyOnly(
        input,
        context,
        'coc.sc.invalid',
        formatMessage(context, 'coc.sc.invalid_roll'),
      );
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
    madness = formatMessage(context, 'coc.sc.permanent_madness');
  } else if (indefiniteMadness) {
    madness = formatMessage(context, 'coc.sc.indefinite_madness', {
      loss: dailyLoss,
      threshold: dailyThreshold,
    });
  } else if (sanLoss >= 5) {
    madness = formatMessage(context, 'coc.sc.temporary_madness');
  }
  const chosenText = success ? successLossExpression : failureLossExpression;
  const outcomeLabel =
    successRank >= 4
      ? COC_LEVEL_LABELS.critical
      : successRank === 3
        ? COC_LEVEL_LABELS.extreme
        : successRank === 2
          ? COC_LEVEL_LABELS.hard
          : successRank === 1
            ? COC_LEVEL_LABELS.regular
            : successRank === -2
              ? COC_LEVEL_LABELS.fumble
              : COC_LEVEL_LABELS.failure;
  const rollDetail =
    bonusDice === 0
      ? checkExpression
        ? formatMessage(context, 'coc.sc.check_expression', {
            expression: checkExpression,
            roll: rollTotal,
          })
        : formatMessage(context, 'coc.check.roll', { roll: rollTotal })
      : formatMessage(context, 'coc.check.roll_bonus', {
          kind: formatMessage(context, bonusDice > 0 ? 'coc.check.bonus' : 'coc.check.penalty'),
          count: Math.abs(bonusDice),
          rolls: rolls.join('、'),
          roll: rollTotal,
        });
  const adjustments = [
    ...(half ? [formatMessage(context, 'coc.sc.adjustment.half')] : []),
    ...(cap !== undefined ? [formatMessage(context, 'coc.sc.adjustment.cap', { cap })] : []),
  ];
  const lossDetail =
    adjustments.length > 0
      ? formatMessage(context, 'coc.sc.loss_adjusted', {
          expression: chosenText,
          original: originalSanLoss,
          loss: sanLoss,
          adjustments: adjustments.join('、'),
        })
      : formatMessage(context, 'coc.sc.loss', {
          expression: chosenText,
          loss: originalSanLoss,
        });
  const ruleName =
    resolveCocHouseRule(ruleId)?.name ??
    formatMessage(context, 'coc.check.rule_fallback', { ruleId });
  const ruleText = ruleId === '0' ? '' : formatMessage(context, 'coc.sc.rule', { rule: ruleName });
  const text = formatMessage(context, 'coc.sc.summary', {
    actor: actorName,
    roll: rollDetail,
    target: currentSan,
    outcome: outcomeLabel,
    result: formatMessage(context, success ? 'coc.result.passed' : 'coc.result.failed'),
    loss: lossDetail,
    oldSan: currentSan,
    newSan: sanNew,
    persistence: sheet ? '' : formatMessage(context, 'coc.sc.not_persisted'),
    daily: sheet
      ? formatMessage(context, 'coc.sc.daily', {
          loss: dailyLoss,
          threshold: dailyThreshold,
        })
      : '',
    rule: ruleText,
    madness: madness ? formatMessage(context, 'coc.sc.madness', { message: madness }) : '',
  });

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
      outcome: outcomeLabel,
      ruleId,
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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });

  const res = await rollMadnessSymptom('temporal', context.random);
  const text = formatMessage(context, 'coc.ti', {
    actor: actorName,
    expression: res.expressionText,
    description: res.description,
  });

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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });

  const res = await rollMadnessSymptom('summary', context.random);
  const text = formatMessage(context, 'coc.li', {
    actor: actorName,
    expression: res.expressionText,
    description: res.description,
  });

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
    return replyOnly(input, context, 'coc.en.help', formatMessage(context, 'coc.en.help'));
  }
  if (!sheet) {
    return replyOnly(
      input,
      context,
      'coc.en.missing_sheet',
      formatMessage(context, 'coc.en.missing_sheet'),
    );
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
      formatMessage(context, parsedItems.length > 10 ? 'coc.en.too_many' : 'coc.en.invalid'),
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
        formatMessage(context, 'coc.en.missing_skill', { skill: item.skill }),
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
        formatMessage(context, 'coc.en.invalid_increment', { skill: item.skill }),
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
      formatMessage(context, 'coc.en.item', {
        skill: item.skill,
        roll,
        oldValue: item.oldValue,
        result: formatMessage(context, success ? 'coc.en.success' : 'coc.en.failed'),
        increment: incrementExpression
          ? formatMessage(context, 'coc.en.increment', {
              expression: incrementExpression.source,
              increment,
              newValue,
            })
          : '',
      }),
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
    formatMessage(context, 'coc.en.summary', {
      actor: sheet.name,
      items: lines.join('\n'),
    }),
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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });
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
      text: formatMessage(context, 'dnd5e.ds.nohp', { actor: actorName }),
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
      text: formatMessage(context, 'dnd5e.ds.alive', { actor: actorName, hp: currentHp }),
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
      text: formatMessage(context, 'dnd5e.ds.stat', {
        actor: actorName,
        successes: dss,
        failures: dsf,
        outcome: '',
      }),
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
      return replyOnly(
        input,
        context,
        'dnd5e.ds.invalid',
        formatMessage(context, 'dnd5e.ds.invalid_count'),
      );
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
      exText = formatMessage(context, 'dnd5e.ds.stable');
      dss = 0;
      dsf = 0;
    } else if (dead) {
      exText = formatMessage(context, 'dnd5e.ds.dead');
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
      text: formatMessage(context, 'dnd5e.ds.stat', {
        actor: actorName,
        successes: dss,
        failures: dsf,
        outcome: exText,
      }),
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
    return replyOnly(
      input,
      context,
      'dnd5e.ds.invalid',
      formatMessage(context, 'dnd5e.ds.invalid_modifier'),
    );
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
    outcomeText = formatMessage(context, 'dnd5e.ds.revive');
    nextAttrs.HP = 1;
    nextAttrs.hp = 1;
    dss = 0;
    dsf = 0;
  } else {
    dss = Math.max(0, dss + successPlus);
    dsf = Math.max(0, dsf + failurePlus);
    if (outcome === 'criticalFailure') {
      outcomeText = formatMessage(context, 'dnd5e.ds.critical_failure');
    } else if (outcome === 'success') {
      outcomeText = formatMessage(context, 'dnd5e.ds.success');
    } else {
      outcomeText = formatMessage(context, 'dnd5e.ds.failure');
    }
    const { stable, dead } = deathSaveResultText({ successes: dss, failures: dsf });
    if (stable) {
      exText = formatMessage(context, 'dnd5e.ds.stable');
      dss = 0;
      dsf = 0;
    } else if (dead) {
      exText = formatMessage(context, 'dnd5e.ds.dead');
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

  const statusText =
    outcome === 'revive'
      ? ''
      : formatMessage(context, 'dnd5e.ds.status', { successes: dss, failures: dsf });
  const text = formatMessage(context, 'dnd5e.ds.roll', {
    actor: actorName,
    roll: d20,
    modifier: modifier === 0 ? '' : formatMessage(context, 'dnd5e.ds.modifier', { modifier }),
    total,
    outcome: outcomeText,
    terminal: exText,
    status: statusText,
  });

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
    const text = formatMessage(context, 'coc.setcoc.current', {
      name: def ? def.name : currentRule,
      description: def ? def.desc : '',
    });
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
    const lines = COC_HOUSE_RULES.map((rule) =>
      formatMessage(context, 'coc.setcoc.item', {
        key: rule.key,
        name: rule.name,
        description: rule.desc.replaceAll('\n', ' '),
      }),
    );
    const reply: PreparedReply = {
      executionId: input.executionId,
      part: 1,
      msgSeq: 1,
      scene: conv.scene,
      targetId: conv.externalId,
      originMessageId: input.messageId,
      templateKey: 'coc.setcoc.details',
      text: formatMessage(context, 'coc.setcoc.details', { items: lines.join('\n') }),
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
      text: formatMessage(context, 'coc.setcoc.invalid', { rule: arg }),
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

  const text = formatMessage(context, 'coc.setcoc.set', {
    name: targetRule.name,
    key: targetRule.key,
    description: targetRule.desc,
  });

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
      text: formatMessage(context, 'find.help'),
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
        formatMessage(context, 'find.group_invalid'),
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
          text: formatMessage(context, 'find.list', {
            group: groupName,
            page,
            totalPages,
            entries: pageEntries
              .map((entry) =>
                formatMessage(context, 'find.list.item', {
                  id: entry.id,
                  title: entry.title,
                }),
              )
              .join('\n'),
          }),
          deadline,
        },
      ],
      logItems: [],
    };
  }

  const { matches } = searchRuleGlossary(query, 5);
  let text = '';
  if (matches.length === 0) {
    text = formatMessage(context, 'find.empty', { query });
  } else {
    const entries = matches.map((match) =>
      formatMessage(context, 'find.result.item', {
        id: match.id,
        ruleSet: match.ruleSet,
        title: match.title,
        content: match.content,
      }),
    );
    text = formatMessage(context, 'find.result', {
      query,
      entries: entries.join('\n\n'),
    });
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
        text: formatMessage(context, 'utility.ping'),
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
    return replyOnly(
      input,
      context,
      'utility.who.help',
      formatMessage(context, 'utility.who.help'),
    );
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
        text: formatMessage(context, 'utility.who', { choices: choices.join('、') }),
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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });

  const jrrp = computeJrrp(senderId, input.timestamp);
  const comment =
    jrrp > 95
      ? formatMessage(context, 'fun.jrrp.excellent')
      : jrrp > 80
        ? formatMessage(context, 'fun.jrrp.lucky')
        : jrrp > 50
          ? formatMessage(context, 'fun.jrrp.good')
          : jrrp > 10
            ? formatMessage(context, 'fun.jrrp.poor')
            : formatMessage(context, 'fun.jrrp.bad');
  const text = formatMessage(context, 'fun.jrrp', { actor: actorName, jrrp, comment });

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
  const actorName =
    sheet?.name ??
    input.sender?.name ??
    formatMessage(context, 'character.nn.default', { suffix: senderId.slice(-4) || '1' });
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
      text: formatMessage(context, 'fun.gugu.help'),
      deadline,
    };
    return { results: [], updates: [], replies: [reply], logItems: [] };
  }

  const showFrom =
    firstArg === 'from' || firstArg === 'showfrom' || firstArg === '来源' || firstArg === '作者';

  const entry = await getRandomGugu(context.random);
  const content = entry.template.replaceAll('{$t玩家}', actorName);
  const text = showFrom
    ? formatMessage(context, 'fun.gugu.with_author', { text: content, author: entry.author })
    : formatMessage(context, 'fun.gugu', { text: content });

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
      text: formatMessage(context, 'fun.name.help'),
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
  const text = formatMessage(context, 'fun.name', {
    type,
    names: names.join('\n'),
  });

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
      text: formatMessage(context, 'fun.namednd.help'),
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
      formatMessage(context, 'fun.namednd.unknown_race', {
        race: args[0],
        races: Object.keys(supportedRaces).join('、'),
      }),
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
  const text = formatMessage(context, 'fun.namednd', {
    race,
    names: names.join('\n'),
  });

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
      text: formatMessage(context, 'fun.modu.help'),
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
        text: formatMessage(context, 'fun.modu.missing_id'),
        deadline,
      };
      return { results: [], updates: [], replies: [reply], logItems: [] };
    }

    const detail = await fetchCnmodsDetail(keyId);
    const text = detail
      ? formatCnmodsDetail(context.messageCatalog ?? defaultMessageCatalog, detail)
      : formatMessage(context, 'fun.modu.error');

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
    let text = formatMessage(context, 'fun.modu.error');
    if (searchRes && searchRes.list.length > 0) {
      const idx = await context.random.integer(0, searchRes.list.length - 1);
      const chosen = searchRes.list[idx];
      if (chosen) {
        const detail = await fetchCnmodsDetail(String(chosen.keyId));
        text = detail
          ? formatCnmodsDetail(context.messageCatalog ?? defaultMessageCatalog, detail)
          : formatMessage(context, 'fun.modu.roll_fallback', {
              id: chosen.keyId,
              title: chosen.title,
              author: chosen.article,
            });
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
    const text = result
      ? formatCnmodsSearchResult(context.messageCatalog ?? defaultMessageCatalog, page, result)
      : formatMessage(context, 'fun.modu.error');

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
    text: formatMessage(context, 'fun.modu.unknown'),
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
    return replyOnly(
      input,
      context,
      'policy.target_ambiguous',
      formatMessage(context, 'policy.target_ambiguous'),
    );
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
            .map((entry) =>
              formatMessage(context, 'policy.item', {
                id: entry.id,
                effect: entry.effect,
                reason: entry.reason
                  ? formatMessage(context, 'policy.reason', { reason: entry.reason })
                  : '',
              }),
            )
            .join('\n')
        : formatMessage(context, 'policy.empty'),
    );
  }
  if (!target) {
    return replyOnly(
      input,
      context,
      'policy.target_required',
      formatMessage(context, 'policy.target_required'),
    );
  }
  const current = context.snapshot.delegatePolicyEntries?.[target.externalId];
  if (sub === 'rm' || sub === 'del' || sub === 'remove') {
    if (!current) {
      return replyOnly(
        input,
        context,
        'policy.not_found',
        formatMessage(context, 'policy.not_found'),
      );
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
          text: formatMessage(context, 'policy.remove', {
            target: target.name ?? target.externalId,
          }),
          deadline: new Date(input.timestamp.getTime() + 300_000),
        },
      ],
      logItems: [],
    };
  }
  const effect = sub === 'trust' ? 'trust' : sub === 'add' || sub === 'deny' ? 'deny' : undefined;
  if (!effect) {
    return replyOnly(input, context, 'policy.help', formatMessage(context, 'policy.help'));
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
        text: formatMessage(context, 'policy.set', {
          target: target.name ?? target.externalId,
          effect: formatMessage(context, effect === 'deny' ? 'policy.deny' : 'policy.trust'),
        }),
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
    formatMessage(context, 'system.unsupported', { command: input.commandName }),
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
    formatMessage(context, 'ruleset.unsupported', { command: input.commandName }),
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
    formatMessage(context, 'messaging.unsupported', { command: input.commandName }),
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
    formatMessage(context, 'extension.unsupported', { command: input.commandName }),
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
