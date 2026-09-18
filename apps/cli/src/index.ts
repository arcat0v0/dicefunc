#!/usr/bin/env node

import { Command } from 'commander';
import { checkConfig } from './config-check';
import { buildConfig } from './config-build';
import { explainConfig } from './config-explain';
import { previewReply } from './reply-preview';
import { simulateCommand } from './simulate';

const program = new Command();

program
  .name('dice')
  .description('DiceFunc CLI - Configuration and simulation tools')
  .version('0.1.0');

// Config commands
program
  .command('config')
  .description('Configuration management')
  .addCommand(checkConfig)
  .addCommand(buildConfig)
  .addCommand(explainConfig);

// Reply preview
program
  .command('reply')
  .description('Reply template tools')
  .addCommand(previewReply);

// Simulation
program
  .command('simulate')
  .description('Simulate dice commands')
  .action(simulateCommand);

program.parse(process.argv);
