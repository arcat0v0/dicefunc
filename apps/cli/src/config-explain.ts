import { Command } from 'commander';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export const explainConfig = new Command()
  .name('explain')
  .description('Explain configuration value and its source')
  .option('-g, --group <path>', 'Group configuration file', './config/groups/example.yaml')
  .option('-k, --key <path>', 'Configuration key to explain', 'defaults.ruleSet')
  .action((options) => {
    console.log(`Explaining config: ${options.key}`);
    console.log(`From group: ${options.group}\n`);
    
    try {
      // Load base defaults
      const botConfig = loadYaml('./config/bot.yaml');
      const groupConfig = loadYaml(options.group);
      
      // Navigate to the requested key
      const keys = options.key.split('.');
      let value: unknown = botConfig;
      let source = 'bot.yaml (default)';
      
      for (const key of keys) {
        if (typeof value === 'object' && value !== null && key in value) {
          value = (value as Record<string, unknown>)[key];
          source = `merged from ${source}`;
        } else {
          console.error(`Key not found: ${key}`);
          process.exit(1);
        }
      }
      
      // Check group override
      let groupValue: unknown = undefined;
      let groupObj = groupConfig;
      const groupKeys = options.key.split('.');
      
      for (const key of groupKeys) {
        if (typeof groupObj === 'object' && groupObj !== null && key in groupObj) {
          groupValue = (groupObj as Record<string, unknown>)[key];
          groupObj = groupValue;
        } else {
          break;
        }
      }
      
      console.log(`最终值：${JSON.stringify(value)}`);
      console.log(`来源：${source}`);
      
      if (groupValue !== undefined) {
        console.log(`群配置覆盖：${JSON.stringify(groupValue)}`);
      }
      
    } catch (error) {
      console.error('配置解释失败:', error);
      process.exit(1);
    }
  });

function loadYaml(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(content, {
    schema: yaml.DEFAULT_SCHEMA,
    json: true
  }) as any;
}
