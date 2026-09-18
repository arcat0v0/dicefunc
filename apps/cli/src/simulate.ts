import { Command } from 'commander';

export const simulateCommand = new Command()
  .name('simulate')
  .description('Simulate dice command execution')
  .option('-s, --scene <type>', 'Scene type', 'groupAt')
  .option('-m, --message <text>', 'Message to simulate', '.r 1d100')
  .action((options) => {
    console.log(`Simulating command: ${options.message}`);
    console.log(`Scene: ${options.scene}\n`);
    
    // Parse the command
    const parsed = parseDiceCommand(options.message);
    
    if (!parsed) {
      console.error('无法解析命令');
      process.exit(1);
    }
    
    console.log('解析结果:');
    console.log(JSON.stringify(parsed, null, 2));
    
    // Simulate dice roll
    console.log('\n模拟掷骰结果:');
    const result = simulateRoll(parsed);
    console.log(`表达式：${result.expression}`);
    console.log(`出目：[${result.individualRolls.join(', ')}]`);
    console.log(`总和：${result.total}`);
  });

interface ParsedCommand {
  type: 'roll' | 'check' | 'other';
  expression: string;
  faces?: number;
  count?: number;
}

function parseDiceCommand(message: string): ParsedCommand | null {
  const rollMatch = message.match(/\.?r(?:oll)?\s+(\d+)d(\d+)/i);
  
  if (rollMatch) {
    return {
      type: 'roll',
      expression: `${rollMatch[1]}d${rollMatch[2]}`,
      faces: parseInt(rollMatch[2]),
      count: parseInt(rollMatch[1])
    };
  }
  
  return null;
}

function simulateRoll(parsed: ParsedCommand): any {
  if (parsed.type !== 'roll' || !parsed.faces || !parsed.count) {
    throw new Error('Invalid parsed command');
  }
  
  const rolls: number[] = [];
  for (let i = 0; i < parsed.count; i++) {
    rolls.push(Math.floor(Math.random() * parsed.faces) + 1);
  }
  rolls.sort((a, b) => a - b);
  
  return {
    expression: parsed.expression,
    individualRolls: rolls,
    total: rolls.reduce((sum, n) => sum + n, 0)
  };
}
