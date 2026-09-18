import { Command } from 'commander';

export const previewReply = new Command()
  .name('preview')
  .description('Preview reply template rendering')
  .command('coc-check-failed', 'Preview COC check failed template')
  .option('--flavor <name>', 'Flavor name', 'classic')
  .option('--scenario <name>', 'Scenario type', 'standard')
  .action((options) => {
    console.log(`Previewing template for: coc.check.failed`);
    console.log(`Flavor: ${options.flavor}`);
    console.log(`Scenario: ${options.scenario}\n`);
    
    // Sample data for template rendering
    const sampleData = {
      actor: {
        name: '调查员'
      },
      skill: {
        name: '侦查'
      },
      target: {
        value: 60
      },
      roll: {
        total: 75,
        individualRolls: [12, 23, 40]
      },
      reason: '超出目标值'
    };
    
    console.log('模板变量示例:');
    console.log(JSON.stringify(sampleData, null, 2));
    
    console.log('\n预期输出 (经典风格 - 标准失败):');
    console.log('================================');
    console.log('调查员的侦查检定失败。');
    console.log('出目：75 / 目标值：60，失败。');
    console.log('================================');
    
    console.log('\n预期输出 (古典怪谈风格 - 低语失败):');
    console.log('================================');
    console.log('调查员凝视着阴影，阴影没有回答。');
    console.log('侦查检定：75 / 60，失败。');
    console.log('================================');
  });
