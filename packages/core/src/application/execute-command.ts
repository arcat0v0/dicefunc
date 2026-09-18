import type { VerifiedEvent } from '../ports/state-store.js';
import {
  type CommandContext,
  type CommandDecision,
  type CommandInput,
  type CommandRegistry,
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

  constructor(registry?: CommandRegistry) {
    this.registry = registry ?? createDefaultCommandRegistry();
  }

  async execute(event: VerifiedEvent, context: CommandContext): Promise<CommandDecision> {
    const raw = event.text.trim();
    if (!raw) {
      return { results: [], updates: [], replies: [], logItems: [] };
    }

    let textToParse = raw;
    let explicitPrefix = false;

    if (
      textToParse.startsWith('.') ||
      textToParse.startsWith('。') ||
      textToParse.startsWith('/')
    ) {
      textToParse = textToParse.slice(1).trim();
      explicitPrefix = true;
    }

    const parts = textToParse.split(/\s+/);
    const cmdName = parts[0];
    if (!cmdName) {
      return { results: [], updates: [], replies: [], logItems: [] };
    }

    const registered = this.registry.find(cmdName);
    if (!registered) {
      if (!explicitPrefix) {
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
    const args = parts.slice(1);
    const input: CommandInput = {
      executionId,
      rawText: raw,
      commandName: cmdName,
      args,
      eventId: event.eventId,
      messageId: event.messageId,
      timestamp: event.timestamp,
    };

    return registered.handler(input, context);
  }
}
