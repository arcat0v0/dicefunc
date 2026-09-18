#!/usr/bin/env node

import { Command } from 'commander';
import { runConfigBuild } from './config-build.js';
import { runConfigCheck } from './config-check.js';
import { runConfigExplain } from './config-explain.js';
import { runReplyPreview } from './reply-preview.js';
import { runSimulate } from './simulate.js';

const program = new Command();

program
  .name('dice')
  .description('DiceFunc CLI - Configuration and simulation tools')
  .version('0.1.0');

const config = program.command('config').description('Configuration management');

config
  .command('check')
  .description('Check configuration files for errors')
  .option('-d, --dir <path>', 'Configuration directory', './config')
  .action(runConfigCheck);

config
  .command('build')
  .description('Build configuration into compiled format')
  .option('-d, --dir <path>', 'Configuration directory', './config')
  .option('-f, --file <path>', 'Single configuration file to build')
  .option('-o, --out <path>', 'Output path (default: stdout)')
  .action(runConfigBuild);

config
  .command('explain')
  .description('Explain configuration value and its source')
  .option('-g, --group <name>', 'Group name or configuration file', 'example')
  .option('-k, --key <path>', 'Configuration key to explain (dot notation)', 'defaults.ruleSet')
  .action(runConfigExplain);

const reply = program.command('reply').description('Reply template tools');

reply
  .command('preview <eventKey>')
  .description('Preview reply template rendering')
  .option('--flavor <name>', 'Flavor name', 'classic')
  .action(runReplyPreview);

program
  .command('simulate')
  .description('Simulate dice command execution')
  .option('-s, --scene <type>', 'Scene type', 'groupAt')
  .option('-m, --message <text>', 'Message to simulate', '.r 1d100')
  .option('-f, --fixture <path>', 'Fixture path')
  .action(runSimulate);

program.parse(process.argv);
