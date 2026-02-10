#!/usr/bin/env node

const inquirer = require('inquirer');
const figlet = require('figlet');
const chalk = require('chalk');
const boxen = require('boxen');
const backup = require('./backup');
const restore = require('./restore');
const cloud = require('./cloud');
const utils = require('./utils'); // Utils for system detection & cron

// CLI Argument Handling
const args = process.argv.slice(2);
if (args.includes('--backup') || args.includes('-b')) {
  (async () => {
    const silent = args.includes('--silent') || args.includes('-s');
    await backup.performCLIBackup(silent);
  })();
  return;
}

// Interactive Mode
async function mainMenu() {
  console.clear();
  console.log(
    chalk.blueBright(
      figlet.textSync('OpenClaw', { horizontalLayout: 'full' })
    )
  );
  console.log(boxen(chalk.cyan('System Backup & Recovery Utility'), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

  const options = [
    { name: '🚀 Quick Full Backup (Everything)', value: 'full_backup' },
    { name: '🛠️  Custom Backup (Select Components)', value: 'custom_backup' },
    new inquirer.Separator(),
    { name: '♻️  Restore from Local File', value: 'restore_local' },
    { name: '☁️  Restore from Cloud (GDrive/NAS)', value: 'restore_cloud' }, // NEW
    new inquirer.Separator(),
    { name: '☁️  Configure Cloud Sync', value: 'cloud_config' },
    { name: '🕒 Setup Auto-Backup (Cron)', value: 'setup_cron' }, // NEW
    { name: '🧹 Clean Local Backups', value: 'clean_local' },
    { name: '🚪 Exit', value: 'exit' },
  ];

  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'Main Menu:',
      choices: options,
    },
  ]);

  switch (choice) {
    case 'full_backup':
      await backup.performFullBackup();
      break;
    case 'custom_backup':
      await backup.performCustomBackup();
      break;
    case 'restore_local':
      await restore.performRestore('local');
      break;
    case 'restore_cloud':
      await restore.performRestore('cloud'); // NEW
      break;
    case 'cloud_config':
      await cloud.configureCloud();
      break;
    case 'setup_cron':
      await utils.setupCron(); // NEW
      break;
    case 'clean_local':
      await backup.cleanLocalBackups();
      break;
    case 'exit':
      console.log(chalk.gray('Goodbye!'));
      process.exit(0);
  }

  // Return to main menu
  await new Promise(r => setTimeout(r, 1000));
  await mainMenu();
}

mainMenu().catch((error) => {
  console.error(chalk.red('Fatal Error:'), error);
});