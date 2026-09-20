import { type CustomReplyRule, matchCustomReply } from '../domain/reply/custom-reply.js';
import type { VerifiedEvent } from '../ports/state-store.js';
import {
  type CommandContext,
  type CommandDecision,
  type CommandInput,
  type CommandRegistry,
  type RegisteredCommand,
  createDefaultCommandRegistry,
} from './commands.js';

export type {
  CommandBudget,
  CommandContext,
  CommandDecision,
  CommandHandler,
  CommandInput,
  CommandMetadata,
  CommandPermission,
  CommandRegistry,
} from './commands.js';

export class CommandExecutor {
  private readonly registry: CommandRegistry;
  private readonly customRules: readonly CustomReplyRule[];

  constructor(registry?: CommandRegistry, customRules: readonly CustomReplyRule[] = []) {
    this.registry = registry ?? createDefaultCommandRegistry();
    this.customRules = customRules;
  }

  async execute(event: VerifiedEvent, context: CommandContext): Promise<CommandDecision> {
    let raw = event.text.trim();
    if (!raw) {
      return { results: [], updates: [], replies: [], logItems: [] };
    }

    let repeatCount = 1;
    const repeatMatch = raw.match(/^(\d+)[#＃]\s*(.*)$/);
    if (repeatMatch?.[1] && repeatMatch[2]) {
      repeatCount = Math.min(10, Math.max(1, Number.parseInt(repeatMatch[1], 10)));
      raw = repeatMatch[2].trim();
    }

    if (repeatCount > 1) {
      const singleEvent: VerifiedEvent = { ...event, text: raw };
      const decisions: CommandDecision[] = [];
      for (let i = 0; i < repeatCount; i++) {
        const d = await this.execute(singleEvent, context);
        decisions.push(d);
      }
      const combinedReplies = decisions.flatMap((d) => d.replies).filter((r) => Boolean(r.text));
      if (combinedReplies.length === 0) {
        return { results: [], updates: [], replies: [], logItems: [] };
      }
      const firstReply = combinedReplies[0];
      if (!firstReply) {
        return { results: [], updates: [], replies: [], logItems: [] };
      }
      const combinedText = combinedReplies.map((r) => r.text).join('\n');
      return {
        results: decisions.flatMap((d) => d.results),
        updates: decisions.flatMap((d) => d.updates),
        replies: [
          {
            ...firstReply,
            text: combinedText,
          },
        ],
        logItems: decisions.flatMap((d) => d.logItems),
      };
    }

    let textToParse = raw;
    let explicitPrefix = false;

    if (
      textToParse.startsWith('.') ||
      textToParse.startsWith('。') ||
      textToParse.startsWith('!') ||
      textToParse.startsWith('！') ||
      textToParse.startsWith('/')
    ) {
      textToParse = textToParse.slice(1).trim();
      explicitPrefix = true;
    }

    const parts = textToParse.split(/\s+/);
    let cmdName = parts[0];
    if (!cmdName) {
      return { results: [], updates: [], replies: [], logItems: [] };
    }

    let registered: RegisteredCommand | undefined = this.registry.find(cmdName);
    let args = parts.slice(1);

    if (!registered) {
      const allCommands = this.registry.list();
      const candidates: Array<{ name: string; cmd: RegisteredCommand }> = [];
      for (const cmd of allCommands) {
        candidates.push({ name: cmd.metadata.name, cmd });
        for (const alias of cmd.metadata.aliases ?? []) {
          candidates.push({ name: alias, cmd });
        }
      }
      candidates.sort((a, b) => b.name.length - a.name.length);

      const lowerCmdName = cmdName.toLowerCase();
      for (const candidate of candidates) {
        if (
          lowerCmdName.startsWith(candidate.name.toLowerCase()) &&
          lowerCmdName.length > candidate.name.length
        ) {
          const rest = cmdName.slice(candidate.name.length);
          registered = candidate.cmd;
          cmdName = candidate.name;
          args = [rest, ...parts.slice(1)];
          break;
        }
      }
    }

    if (!registered) {
      if (!explicitPrefix) {
        const matched = matchCustomReply(raw, event.scene, this.customRules);
        if (matched) {
          const deadline = new Date(event.timestamp.getTime() + 300_000);
          return {
            results: [
              {
                executionId: `exec_${event.eventId}`,
                kind: 'custom.reply',
                ruleVersion: '1.0.0',
                data: { ruleId: matched.id },
              },
            ],
            updates: [],
            replies: [
              {
                executionId: `exec_${event.eventId}`,
                part: 1,
                msgSeq: 1,
                scene: event.scene,
                targetId: event.externalId,
                originMessageId: event.messageId,
                templateKey: matched.action.template ?? 'custom.reply',
                text: matched.action.text ?? '',
                deadline,
              },
            ],
            logItems: [],
          };
        }
        return { results: [], updates: [], replies: [], logItems: [] };
      }
      const deadline = new Date(event.timestamp.getTime() + 300_000);
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: `exec_${event.eventId}`,
            part: 1,
            msgSeq: 1,
            scene: event.scene,
            targetId: event.externalId,
            originMessageId: event.messageId,
            templateKey: 'command.not_found',
            text: `Command not found: ${cmdName}`,
            deadline,
          },
        ],
        logItems: [],
      };
    }

    const conversation = context.snapshot.conversation;
    if (!conversation.enabled && !registered.metadata.allowedWhenDisabled) {
      return { results: [], updates: [], replies: [], logItems: [] };
    }

    if (context.permissions.denied) {
      const deadline = new Date(event.timestamp.getTime() + 300_000);
      return {
        results: [],
        updates: [],
        replies: [
          {
            executionId: `exec_${event.eventId}`,
            part: 1,
            msgSeq: 1,
            scene: event.scene,
            targetId: event.externalId,
            originMessageId: event.messageId,
            templateKey: 'permission.denied',
            text: 'Permission denied.',
            deadline,
          },
        ],
        logItems: [],
      };
    }

    if (registered.metadata.permission === 'diceMaster') {
      if (!context.permissions.isDiceMaster) {
        const deadline = new Date(event.timestamp.getTime() + 300_000);
        return {
          results: [],
          updates: [],
          replies: [
            {
              executionId: `exec_${event.eventId}`,
              part: 1,
              msgSeq: 1,
              scene: event.scene,
              targetId: event.externalId,
              originMessageId: event.messageId,
              templateKey: 'permission.dice_master_required',
              text: 'This command requires Dice Master permission.',
              deadline,
            },
          ],
          logItems: [],
        };
      }
    } else if (registered.metadata.permission === 'groupHost') {
      if (!context.permissions.isGroupHost && !context.permissions.isDiceMaster) {
        const deadline = new Date(event.timestamp.getTime() + 300_000);
        return {
          results: [],
          updates: [],
          replies: [
            {
              executionId: `exec_${event.eventId}`,
              part: 1,
              msgSeq: 1,
              scene: event.scene,
              targetId: event.externalId,
              originMessageId: event.messageId,
              templateKey: 'permission.group_host_required',
              text: 'This command requires Group Host permission.',
              deadline,
            },
          ],
          logItems: [],
        };
      }
    }

    const executionId = `exec_${event.eventId}`;
    const input: CommandInput = {
      executionId,
      rawText: raw,
      commandName: cmdName,
      args,
      eventId: event.eventId,
      messageId: event.messageId,
      timestamp: event.timestamp,
      sender: event.sender,
    };

    return registered.handler(input, context);
  }
}
