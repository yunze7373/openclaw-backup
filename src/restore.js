const shell = require('shelljs');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const utils = require('./utils');
const ora = require('ora');
const chalk = require('chalk');

// Helper to load config for default target
function loadConfig() {
  const CONFIG_FILE = path.join(process.env.HOME, '.claw-backup', 'config.json');
  if (fs.existsSync(CONFIG_FILE)) return fs.readJsonSync(CONFIG_FILE);
  return {};
}

async function performRestore(source = 'local') {
  const backupDir = path.join(process.env.HOME, 'claw-backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

  let targetFile = '';

  if (source === 'cloud') {
      // 1. Pick Remote
      const config = loadConfig();
      let remote = config.default_target ? config.default_target.remote : null;
      let remotePath = config.default_target ? config.default_target.path : null;

      if (!remote) {
          const res = shell.exec('rclone listremotes', { silent: true });
          const remotes = res.stdout.split('\n').filter(r => r.trim()).map(r => r.replace(':', ''));
          if (remotes.length === 0) { console.log(chalk.red('No remotes.')); return; }
          
          const ans = await inquirer.prompt([{type:'list', name:'r', message:'Select Remote:', choices:remotes}]);
          remote = ans.r;
          
          // Ask for path? Default to root or browse
          // Simplified: assume root or ask
          const p = await inquirer.prompt([{type:'input', name:'p', message:'Remote Path (optional):', default:'/OpenClaw_Backups/Termux'}]);
          remotePath = p.p;
      }

      // 2. List Files
      const spinner = ora('Fetching file list...').start();
      const lsCmd = `rclone lsf "${remote}:${remotePath}" --files-only --format "pt"`; // path, time
      const lsRes = shell.exec(lsCmd, { silent: true });
      spinner.stop();

      if (lsRes.code !== 0) { console.log(chalk.red('Failed to list files.')); return; }
      
      const files = lsRes.stdout.split('\n').filter(Boolean).filter(f => f.endsWith('.tar.gz') || f.endsWith('.enc'));
      if (files.length === 0) { console.log(chalk.yellow('No backup files found in cloud.')); return; }

      const { fileToDl } = await inquirer.prompt([{
          type: 'list', name: 'fileToDl', message: 'Select Cloud Backup to Restore:', choices: files.reverse() // Newest first
      }]);

      // 3. Download
      const dlSpinner = ora(`Downloading ${fileToDl}...`).start();
      const localDest = path.join(backupDir, fileToDl);
      // rclone copyto remote:path/file local:path/file
      const dlCmd = `rclone copyto "${remote}:${remotePath}/${fileToDl}" "${localDest}" --progress`;
      
      // Use spawn to show progress if possible, or just wait
      if (shell.exec(dlCmd, {silent:true}).code !== 0) {
          dlSpinner.fail(chalk.red('Download failed.'));
          return;
      }
      dlSpinner.succeed(chalk.green('Download complete!'));
      targetFile = fileToDl;

  } else {
      // Local Source
      const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.tar.gz') || f.endsWith('.enc'));
      if (files.length === 0) {
        console.log(chalk.yellow('No local backup files found. Try "Restore from Cloud".'));
        return;
      }
      const ans = await inquirer.prompt([{
          type: 'list', name: 'f', message: 'Select Local Backup:', choices: files.sort().reverse()
      }]);
      targetFile = ans.f;
  }

  // === RESTORE LOGIC (Common) ===
  const backupPath = path.join(backupDir, targetFile);
  let finalTarPath = backupPath;
  let tempDecrypted = false;

  // Decrypt
  if (targetFile.endsWith('.enc')) {
    const password = await utils.promptPassword('Enter decryption password:');
    const decryptedPath = backupPath.replace('.enc', '');
    const spinner = ora('Decrypting...').start();
    const code = shell.exec(
      `openssl enc -d -aes-256-cbc -salt -in ${backupPath} -out ${decryptedPath} -pass pass:${password} -pbkdf2`,
      { silent: true }
    ).code;
    spinner.stop();
    if (code !== 0) { console.error(chalk.red('Decryption failed.')); return; }
    finalTarPath = decryptedPath;
    tempDecrypted = true;
  }

  // Analyze
  const spinner = ora('Analyzing backup contents...').start();
  const tarList = shell.exec(`tar -tf ${finalTarPath}`, { silent: true }).stdout.split('\n').filter(Boolean);
  spinner.stop();

  // Component Map
  const componentMap = {};
  tarList.forEach(f => {
      // Heuristic: identify top-level folders relative to HOME
      // Stored as absolute paths /data/data/...
      // We want to group by common prefixes like "clawdbot", "claw"
      const home = process.env.HOME.replace(/\/$/, '');
      if (f.startsWith(home)) {
          const rel = f.replace(home + '/', '');
          const topDir = rel.split('/')[0]; 
          if (!componentMap[topDir]) componentMap[topDir] = { name: topDir, path: path.join(home, topDir), count: 0 };
          componentMap[topDir].count++;
      }
  });

  const choices = Object.keys(componentMap).map(k => ({
      name: `${k} ${chalk.gray(`(${componentMap[k].count} files)`)}`,
      value: componentMap[k].path,
      checked: true
  }));

  const { targets } = await inquirer.prompt([{
      type: 'checkbox', name: 'targets', message: 'Select components to restore:', choices: choices
  }]);

  if (targets.length === 0) return console.log(chalk.yellow('Aborted.'));

  console.log(chalk.red.bold('\n⚠️  WARNING: Files will be overwritten!'));
  const confirm = await utils.confirm('Proceed with Restore?');
  if (!confirm) {
      if (tempDecrypted) fs.unlinkSync(finalTarPath);
      return;
  }

  const rSpinner = ora('Restoring...').start();
  // Tar extract specific paths
  // GNU Tar: -C / to extract absolute paths
  const extractPaths = targets.map(t => t.startsWith('/') ? t.substring(1) : t);
  const cmd = `tar -xzf ${finalTarPath} -C / ${extractPaths.join(' ')}`;
  
  const res = shell.exec(cmd, { silent: true });
  rSpinner.stop();

  if (res.code === 0) {
      console.log(chalk.green('\n✅ Restore Successful!'));
      console.log(chalk.white('  - You may need to run ') + chalk.yellow('npm install') + chalk.white(' or ') + chalk.yellow('pm2 resurrect'));
  } else {
      console.log(chalk.red(`Restore failed: ${res.stderr}`));
  }

  if (tempDecrypted) fs.unlinkSync(finalTarPath);
}

module.exports = { performRestore };