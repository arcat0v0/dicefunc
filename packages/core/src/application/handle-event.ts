import { TemplateRenderer, createClassicTemplates } from '../domain/template/renderer.js';
import { type Clock, systemClock } from '../ports/clock.js';
import { createSeededRandomSource } from '../ports/random-source.js';
import type {
  CommandCommit,
  CommandScope,
  CommitOutcome,
  EventClaim,
  PreparedReply,
  StateStore,
  StoryLogItem,
  VerifiedEvent,
} from '../ports/state-store.js';
import { type CommandBudget, type CommandContext, CommandExecutor } from './execute-command.js';

export interface EventHandleResult {
  readonly success: boolean;
  readonly eventId: string;
  readonly messageKey: string;
  readonly executionId?: string | undefined;
  readonly alreadyProcessed?: boolean | undefined;
  readonly commitOutcome?: CommitOutcome | undefined;
  readonly error?:
    | {
        readonly code: string;
        readonly message: string;
        readonly retryable?: boolean | undefined;
      }
    | undefined;
}

export interface EventHandler {
  handle(event: VerifiedEvent): Promise<EventHandleResult>;
}

export class DefaultEventHandler implements EventHandler {
  private readonly stateStore: StateStore;
  private readonly commandExecutor: CommandExecutor;
  private readonly clock: Clock;
  private readonly configDigest: string;
  private readonly templateRenderer: TemplateRenderer;
  private readonly publicBaseUrl: string | undefined;

  constructor(
    stateStore: StateStore,
    commandExecutor?: CommandExecutor,
    clock?: Clock,
    configDigest?: string,
    templateRenderer?: TemplateRenderer,
    publicBaseUrl?: string,
  ) {
    this.stateStore = stateStore;
    this.commandExecutor = commandExecutor ?? new CommandExecutor();
    this.clock = clock ?? systemClock;
    this.configDigest = configDigest ?? 'v1-default-config';
    this.templateRenderer = templateRenderer ?? new TemplateRenderer(createClassicTemplates());
    this.publicBaseUrl = publicBaseUrl;
  }

  async handle(event: VerifiedEvent): Promise<EventHandleResult> {
    const claim = await this.stateStore.claimEvent(event, this.configDigest);

    if (claim.alreadyProcessed) {
      return {
        success: true,
        eventId: event.eventId,
        messageKey: claim.messageKey,
        alreadyProcessed: true,
      };
    }

    return this.executeClaimed(event, claim);
  }

  async executeClaimed(event: VerifiedEvent, claim: EventClaim): Promise<EventHandleResult> {
    const scope: CommandScope = {
      botId: event.botId,
      scene: event.scene,
      externalId: event.externalId,
      principal: event.sender,
    };

    const deadline = new Date(event.timestamp.getTime() + 300_000);
    const executionId = `exec_${event.eventId}`;

    try {
      let snapshot = await this.stateStore.loadSnapshot(scope);
      let random = await createSeededRandomSource(claim.seed, 'command-execution');

      const runExecution = async (
        currentSnapshot: typeof snapshot,
        currentRandom: typeof random,
      ): Promise<CommandCommit> => {
        const budget: CommandBudget = {
          maxDiceRolls: 1000,
          maxRecursionDepth: 32,
          maxOutputBytes: 8192,
          consumed: {
            diceRolls: 0,
            recursionDepth: 0,
            outputBytes: 0,
          },
        };

        const context: CommandContext = {
          snapshot: currentSnapshot,
          random: currentRandom,
          clock: this.clock,
          permissions: currentSnapshot.permissions,
          budget,
          configVersion: this.configDigest,
          botId: event.botId,
          hiddenRollLinks: this.stateStore,
          ...(this.publicBaseUrl ? { publicBaseUrl: this.publicBaseUrl } : {}),
        };

        const decision = await this.commandExecutor.execute(event, context);
        const actorName =
          currentSnapshot.sheet?.name ??
          event.sender.name ??
          `用户_${event.sender.externalId.slice(-4) || '1'}`;
        const logUpdate = decision.updates.find((update) => update.type === 'story-log');
        const outboundLogId = logUpdate
          ? logUpdate.changes.status === 'recording'
            ? logUpdate.logId
            : undefined
          : currentSnapshot.activeStoryLog?.status === 'recording'
            ? currentSnapshot.activeStoryLog.id
            : undefined;

        const assembledReplies: PreparedReply[] = await Promise.all(
          decision.replies.map(async (rep, idx) => {
            let renderedText = rep.text;
            let variantId = rep.variantId;

            if (rep.templateKey && this.templateRenderer.has(rep.templateKey)) {
              const matchingResult =
                decision.results.find(
                  (r) =>
                    r.kind === rep.templateKey ||
                    (r.kind === 'dice_roll' && rep.templateKey === 'dice.roll'),
                ) ?? decision.results[0];
              const templateData = {
                actor: {
                  name: actorName,
                },
                ...(matchingResult?.data ?? {}),
              };
              const rendered = await this.templateRenderer.render(
                rep.templateKey,
                templateData,
                currentRandom,
              );
              if (rendered.text) {
                renderedText = rendered.text;
                variantId = rendered.variantId;
              }
            }

            const deliveryMode = rep.deliveryMode ?? 'passive';
            return {
              executionId,
              part: rep.part > 0 ? rep.part : 1,
              msgSeq: idx + 1,
              scene: rep.scene ?? event.scene,
              targetId: rep.targetId ?? event.externalId,
              originMessageId:
                deliveryMode === 'passive' ? (rep.originMessageId ?? event.messageId) : undefined,
              templateKey: rep.templateKey,
              variantId,
              text: renderedText,
              deadline,
              deliveryMode,
              condition: rep.condition,
              ...(outboundLogId
                ? {
                    storyLog: {
                      logId: outboundLogId,
                      sequence: claim.conversationSeq,
                      part: idx + 1,
                    },
                  }
                : {}),
            };
          }),
        );

        const activeLog = currentSnapshot.activeStoryLog;
        const logItems: StoryLogItem[] =
          activeLog?.status === 'recording'
            ? [
                {
                  logId: activeLog.id,
                  sourceId: event.sender.externalId,
                  seq: claim.conversationSeq,
                  part: 0,
                  direction: 'inbound',
                  nickname: actorName,
                  imUserId: event.sender.externalId,
                  uniformId: event.sender.externalId,
                  time: Math.floor(event.timestamp.getTime() / 1000),
                  text: event.text,
                  isDice: false,
                  commandId: 0,
                  rawMessageId: event.messageId,
                  channel: '',
                  deliveryStatus: 'sent',
                },
                ...decision.logItems,
              ]
            : [...decision.logItems];

        const transactionId = `txn_${event.eventId}_${this.clock.now().getTime()}`;

        return {
          transactionId,
          eventId: event.eventId,
          executionId,
          botId: event.botId,
          conversationId: claim.conversationId,
          conversationSeq: claim.conversationSeq,
          lease: null,
          updates: decision.updates,
          results: decision.results,
          replies: assembledReplies,
          logItems,
          completeEvent: true,
        };
      };

      let commitPlan = await runExecution(snapshot, random);
      let outcome = await this.stateStore.commit(commitPlan);

      if (!outcome.success && outcome.conflict) {
        snapshot = await this.stateStore.loadSnapshot(scope);
        random = await createSeededRandomSource(claim.seed, 'command-execution');
        commitPlan = await runExecution(snapshot, random);
        outcome = await this.stateStore.commit(commitPlan);
      }

      if (!outcome.success) {
        return {
          success: false,
          eventId: event.eventId,
          messageKey: claim.messageKey,
          executionId,
          commitOutcome: outcome,
          error: {
            code: 'COMMIT_FAILED',
            message: 'StateStore commit failed after attempt',
            retryable: outcome.conflict,
          },
        };
      }

      return {
        success: true,
        eventId: event.eventId,
        messageKey: claim.messageKey,
        executionId,
        commitOutcome: outcome,
      };
    } catch (err) {
      return {
        success: false,
        eventId: event.eventId,
        messageKey: claim.messageKey,
        executionId,
        error: {
          code: 'EXECUTION_FAILED',
          message: err instanceof Error ? err.message : 'Unknown error during event handling',
          retryable: true,
        },
      };
    }
  }
}
