const inquirer = require('inquirer');
const shell = require('shelljs');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

async function confirm(message) {
  const { confirmation } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmation',
      message: message,
      default: false,
    },
  ]);
  return confirmation;
}

async function promptPassword(message) {
  const { password } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message: message,
      mask: '*',
    },
  ]);
  return password;
}

// === NEW: Cron Setup ===
async function setupCron() {
    console.log(chalk.cyan('\n🕒 Setup Automatic Backup (Cron) for All OS environments'));
    console.log(chalk.gray('This will add a cron job to run "claw-backup" daily at 03:00 AM.'));
    console.log(chalk.gray('Requires the "crond" service or standard crontab to be active.'));

    const { proceed } = await inquirer.prompt([{type:'confirm', name:'proceed', message:'Proceed?'}]);
    if (!proceed) return;

    // Command to run: 
    // Need absolute path to node and script for cron reliability
    const nodeBin = shell.which('node').stdout;
    // Assume claw-backup is installed via install.sh to ~/.local/bin or we use the src direct
    // Best: use the symlink or direct src
    const scriptPath = path.join(process.env.HOME, '.claw-backup', 'src', 'index.js');
    const logFile = path.join(process.env.HOME, 'claw-backup.log');
    
    const cronCmd = `${nodeBin} "${scriptPath}" --backup --silent >> "${logFile}" 2>&1`;
    const cronEntry = `0 3 * * * ${cronCmd}`;

    // Read current crontab
    const res = const os = require('os');

const cronCmd = os.type() === 'Linux' ? 'crontab -l' : (os.type() === 'Darwin' ? 'launchctl print' : 'unsupported');
shell.exec(cronCmd, { silent: true });
    let currentCron = res.code === 0 ? res.stdout : '';
    
    if (currentCron.includes('claw-backup')) {
        console.log(chalk.yellow('Backup job already exists in crontab.'));
        const { update } = await inquirer.prompt([{type:'confirm', name:'update', message:'Update/Replace it?'}]);
        if (!update) return;
        // Remove old lines containing claw-backup
        currentCron = currentCron.split('\n').filter(l => !l.includes('claw-backup')).join('\n');
    }

    const newCron = currentCron + '\n' + cronEntry + '\n';
    
    // Write back
    // Need to handle stdin for crontab
    const tmpFile = path.join(require('os').tmpdir(), 'crontab_new');
    fs.writeFileSync(tmpFile, newCron);
    
    if (shell.exec(`crontab "${tmpFile}"`).code === 0) {
        console.log(chalk.green('✅ Crontab updated successfully!'));
        console.log(chalk.gray(`Job: ${cronEntry}`));
    } else {
        console.log(chalk.red('❌ Failed to update crontab.'));
    }
    fs.unlinkSync(tmpFile);
}

module.exports = { confirm, promptPassword, setupCron };