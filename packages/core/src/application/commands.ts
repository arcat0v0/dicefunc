import { CommandContext, CommandDecision, CommandResult, CommandError } from './execute-command';
import { DiceParser, ParsedDiceExpression } from '../domain/dice/parser';
import { RandomSource } from '../ports/random-source';

export interface CommandRegistry {
  register(command: string, handler: CommandHandler): void;
  get(command: string): CommandHandler | undefined;
  list(): string[];
}

export interface CommandHandler {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  execute(args: string[], context: CommandContext): Promise<CommandDecision>;
}

export class DefaultCommandRegistry implements CommandRegistry {
  private commands = new Map<string, CommandHandler>();
  
  register(command: string, handler: CommandHandler): void {
    this.commands.set(command.toLowerCase(), handler);
    
    // Register aliases
    if (handler.aliases) {
      for (const alias of handler.aliases) {
        this.commands.set(alias.toLowerCase(), handler);
      }
    }
  }
  
  get(command: string): CommandHandler | undefined {
    return this.commands.get(command.toLowerCase());
  }
  
  list(): string[] {
    return Array.from(this.commands.keys());
  }
}

// Roll command handler
class RollCommandHandler implements CommandHandler {
  readonly name = 'roll';
  readonly description = 'Roll dice';
  readonly usage = '.r [count]d[faces] [options] [reason]';
  readonly aliases = ['r', 'roll', 'rd'];
  
  async execute(args: string[], context: CommandContext): Promise<CommandDecision> {
    const expression = args.join(' ').trim();
    
    if (!expression) {
      return {
        success: false,
        executionId: this.generateExecutionId(),
        results: [],
        errors: [{
          code: 'MISSING_EXPRESSION',
          message: 'Please provide a dice expression (e.g., .r 1d100)'
        }]
      };
    }
    
    const parser = new DiceParser();
    const parseResult = parser.parse(expression);
    
    if (!parseResult.success || !parseResult.expression) {
      return {
        success: false,
        executionId: this.generateExecutionId(),
        results: [],
        errors: [{
          code: 'PARSE_ERROR',
          message: parseResult.error || 'Failed to parse expression'
        }]
      };
    }
    
    const rolls = parser.evaluate(parseResult.expression, context.randomSource);
    const total = rolls.reduce((sum, n) => sum + n, 0);
    
    const result: CommandResult = {
      type: 'dice_roll',
      data: {
        expression: `${parseResult.expression.count}d${parseResult.expression.faces}`,
        faces: parseResult.expression.faces,
        count: parseResult.expression.count,
        rolls,
        total,
        reason: parseResult.expression.reason,
        keepDrop: parseResult.expression.keepDrop,
        keepCount: parseResult.expression.keepCount
      }
    };
    
    return {
      success: true,
      executionId: this.generateExecutionId(),
      results: [result]
    };
  }
  
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

// Help command handler
class HelpCommandHandler implements CommandHandler {
  readonly name = 'help';
  readonly description = 'Show help information';
  readonly usage = '.help [command]';
  readonly aliases = ['help', 'h', '?'];
  
  async execute(args: string[], context: CommandContext): Promise<CommandDecision> {
    if (args.length === 0) {
      return {
        success: true,
        executionId: this.generateExecutionId(),
        results: [{
          type: 'info',
          data: {
            message: 'Available commands:\n' +
              '  .r <expr>     - Roll dice\n' +
              '  .set <key>    - Set session variable\n' +
              '  .st           - Save character\n' +
              '  .pc           - View/change character\n' +
              '  .log <cmd>    - Manage story log\n' +
              '  .help         - Show this help'
          }
        }]
      };
    }
    
    const commandName = args[0].toLowerCase();
    const handler = context.commandRegistry?.get(commandName);
    
    if (handler) {
      return {
        success: true,
        executionId: this.generateExecutionId(),
        results: [{
          type: 'info',
          data: {
            name: handler.name,
            description: handler.description,
            usage: handler.usage,
            aliases: handler.aliases ? handler.aliases.join(', ') : undefined
          }
        }]
      };
    }
    
    return {
      success: false,
      executionId: this.generateExecutionId(),
      results: [],
      errors: [{
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command: ${commandName}`
      }]
    };
  }
  
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

// Set command handler
class SetCommandHandler implements CommandHandler {
  readonly name = 'set';
  readonly description = 'Set session variable';
  readonly usage = '.set <key> <value>';
  readonly aliases = ['set', 's'];
  
  async execute(args: string[], context: CommandContext): Promise<CommandDecision> {
    if (args.length < 2) {
      return {
        success: false,
        executionId: this.generateExecutionId(),
        results: [],
        errors: [{
          code: 'MISSING_ARGS',
          message: 'Usage: .set <key> <value>'
        }]
      };
    }
    
    const key = args[0];
    const value = args.slice(1).join(' ');
    
    // In production, this would update the conversation settings in D1
    console.log(`Setting ${key} = ${value}`);
    
    return {
      success: true,
      executionId: this.generateExecutionId(),
      results: [{
        type: 'info',
        data: {
          message: `Set ${key} = ${value}`
        }
      }]
    };
  }
  
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

// Initialize default command registry
export function createDefaultCommandRegistry(): CommandRegistry {
  const registry = new DefaultCommandRegistry();
  
  registry.register('r', new RollCommandHandler());
  registry.register('roll', new RollCommandHandler());
  registry.register('rd', new RollCommandHandler());
  registry.register('help', new HelpCommandHandler());
  registry.register('h', new HelpCommandHandler());
  registry.register('?', new HelpCommandHandler());
  registry.register('set', new SetCommandHandler());
  registry.register('s', new SetCommandHandler());
  
  return registry;
}

declare global {
  interface CommandContext {
    commandRegistry?: CommandRegistry;
  }
}
