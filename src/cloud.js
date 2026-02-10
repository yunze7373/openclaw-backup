const shell = require('shelljs');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const ora = require('ora');
const chalk = require('chalk');
const { browsePath } = require('./browsePath');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const CONFIG_DIR = path.join(process.env.HOME, '.claw-backup');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return fs.readJsonSync(CONFIG_FILE);
  }
  return {};
}

function saveConfig(config) {
  fs.ensureDirSync(CONFIG_DIR);
  fs.writeJsonSync(CONFIG_FILE, config, { spaces: 2 });
}

// === HELPER: GET REMOTES ===
function getRemotes() {
    const res = shell.exec('rclone listremotes', { silent: true });
    if (res.code !== 0) return [];
    return res.stdout.split('\n').filter(r => r.trim() !== '').map(r => r.replace(':', ''));
}

// === WIZARDS ===

async function wizardNAS() {
  console.log(chalk.cyan('\n🤖 Setup Synology/NAS (SFTP)'));
  const ans = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Name (e.g. synology):', default: 'synology', validate: i => i ? true : 'Required' },
    { type: 'input', name: 'host', message: 'IP:', validate: i => i ? true : 'Required' },
    { type: 'input', name: 'port', message: 'Port:', default: '22' },
    { type: 'input', name: 'user', message: 'User:', validate: i => i ? true : 'Required' },
    { type: 'password', name: 'pass', message: 'Password:', mask: '*' }
  ]);

  const spinner = ora('Configuring...').start();
  const obscured = shell.exec(`rclone obscure "${ans.pass}"`, { silent: true }).stdout.trim();
  const cmd = `rclone config create "${ans.name}" sftp host="${ans.host}" port="${ans.port}" user="${ans.user}" pass="${obscured}" --non-interactive`;
  
  if (shell.exec(cmd, { silent: true }).code === 0) {
      spinner.succeed(chalk.green(`Added: ${ans.name}`));
      const { setDef } = await inquirer.prompt([{type:'confirm', name:'setDef', message:'Set as Default Backup Target now?'}]);
      if (setDef) await setDefaultTarget(ans.name);
  } else {
      spinner.fail(chalk.red('Failed.'));
  }
}

async function wizardWebDAV() {
  console.log(chalk.cyan('\n🌐 Setup NAS via WebDAV'));
  const ans = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Name (e.g. nas_webdav):', default: 'nas_webdav', validate: i => i ? true : 'Required' },
    { type: 'list', name: 'proto', message: 'Protocol:', choices: ['https', 'http'], default: 'https' },
    { type: 'input', name: 'host', message: 'Host (IP or Domain):', validate: i => i ? true : 'Required' },
    { type: 'input', name: 'port', message: 'Port:', default: a => a.proto === 'https' ? '5006' : '5005' },
    { type: 'input', name: 'user', message: 'User:', validate: i => i ? true : 'Required' },
    { type: 'password', name: 'pass', message: 'Password:', mask: '*' }
  ]);
  
  const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ans.host);
  const { sslPolicy } = await inquirer.prompt([{
      type: 'list', name: 'sslPolicy', message: '🔐 SSL Certificate Check:',
      choices: [{ name: 'Strict (Domain)', value: 'strict' }, { name: 'Skip (IP/Self-signed)', value: 'skip' }],
      default: isIP ? 'skip' : 'strict'
  }]);

  const spinner = ora('Configuring...').start();
  const obscured = shell.exec(`rclone obscure "${ans.pass}"`, { silent: true }).stdout.trim();
  const url = `${ans.proto}://${ans.host}:${ans.port}`;
  
  let cmd = `rclone config create "${ans.name}" webdav url="${url}" vendor="synology" user="${ans.user}" pass="${obscured}" use_expect_continue="false" --non-interactive`;
  if (sslPolicy === 'skip') cmd += ' insecure="true"';
  
  if (shell.exec(cmd, { silent: true }).code === 0) {
      spinner.succeed(chalk.green(`Added: ${ans.name} (SSL: ${sslPolicy})`));
      const { setDef } = await inquirer.prompt([{type:'confirm', name:'setDef', message:'Set as Default Backup Target now?'}]);
      if (setDef) await setDefaultTarget(ans.name);
  } else {
      spinner.fail(chalk.red('Failed.'));
  }
}

async function wizardGDrive() {
  console.log(chalk.cyan('\n☁️  Setup Google Drive'));
  const { name } = await inquirer.prompt([{ type: 'input', name: 'name', message: 'Name (e.g. gdrive):', default: 'gdrive' }]);
  console.log(chalk.yellow('\n👉 INSTRUCTIONS: Copy URL -> Authorize -> Paste Code'));
  const { ready } = await inquirer.prompt([{type: 'confirm', name: 'ready', message: 'Start?'}]);
  if (!ready) return;
  spawnSync('rclone', ['config', 'create', name, 'drive', 'config_is_local=false'], { stdio: 'inherit' });
}

async function deleteRemote() {
    const remotes = getRemotes();
    if (remotes.length === 0) { console.log(chalk.yellow('No remotes to delete.')); return; }
    
    const { remote } = await inquirer.prompt([{
        type: 'list', name: 'remote', message: 'Select Remote to DELETE:', choices: remotes
    }]);

    const { confirm } = await inquirer.prompt([{type: 'confirm', name: 'confirm', message: `Permanently delete "${remote}"?`}]);
    if (!confirm) return;

    const spinner = ora('Deleting...').start();
    const cmd = `rclone config delete "${remote}"`;
    if (shell.exec(cmd, { silent: true }).code === 0) {
        spinner.succeed(chalk.green(`Deleted: ${remote}`));
        const config = loadConfig();
        if (config.default_target && config.default_target.remote === remote) {
            delete config.default_target;
            saveConfig(config);
            console.log(chalk.yellow('  (Removed from Default Target)'));
        }
    } else {
        spinner.fail(chalk.red('Failed to delete.'));
    }
}

async function testConnection() {
    const remotes = getRemotes();
    
    const choices = [
        { name: '📂 Local Path (Test Write)', value: 'local_test' },
        new inquirer.Separator(),
        ...remotes.map(r => ({ name: `☁️  ${r}`, value: r }))
    ];

    const { target } = await inquirer.prompt([{type:'list', name:'target', message:'Select Target to Test:', choices:choices}]);
    
    if (target === 'local_test') {
        const { testPath } = await inquirer.prompt([{type:'input', name:'testPath', message:'Enter Local Path to Test:', default: path.join(process.env.HOME, 'storage') }]);
        
        const spinner = ora('Testing Local Write...').start();
        const probeFile = path.join(testPath, 'openclaw_probe.txt');
        try {
            fs.writeFileSync('temp_probe.txt', 'Write Test OK');
            const cpRes = shell.exec(`cp temp_probe.txt "${probeFile}"`, {silent:true});
            fs.unlinkSync('temp_probe.txt');
            
            if (cpRes.code === 0 && fs.existsSync(probeFile)) {
                fs.unlinkSync(probeFile);
                spinner.succeed(chalk.green('✅ Local Write OK!'));
            } else {
                spinner.fail(chalk.red(`❌ Local Write Failed: ${cpRes.stderr}`));
            }
        } catch (e) {
            spinner.fail(chalk.red(`❌ Local Write Failed: ${e.message}`));
        }
        return;
    }

    const remote = target;
    const spinner = ora(`Pinging ${remote}...`).start();
    const res = shell.exec(`rclone about "${remote}:"`, { silent: true });
    
    if (res.code !== 0) {
        spinner.fail(chalk.red(`Ping Failed.`));
        console.log(chalk.yellow('\n--- Error Details ---'));
        console.log(chalk.gray(res.stderr));
        return;
    }
    spinner.succeed(chalk.green(`Ping OK`));

    // Write Test
    const probeFile = 'openclaw_probe.txt';
    const probeContent = `Probe test: ${new Date().toISOString()}`;
    const localProbe = path.join(require('os').tmpdir(), probeFile);
    fs.writeFileSync(localProbe, probeContent);

    const wSpinner = ora('Testing Write Permission...').start();
    const wRes = shell.exec(`rclone copyto "${localProbe}" "${remote}:${probeFile}"`, { silent: true });
    if (wRes.code !== 0) {
        wSpinner.fail(chalk.red('Write Failed (Permission Denied?)'));
        console.log(chalk.gray(wRes.stderr));
        fs.unlinkSync(localProbe);
        return;
    }
    wSpinner.succeed(chalk.green('Write OK'));

    // Cleanup
    shell.exec(`rclone delete "${remote}:${probeFile}"`, { silent: true });
    fs.unlinkSync(localProbe);
    console.log(chalk.green.bold('\n✅ Deep Probe Passed.'));
}

async function setDefaultTarget(preselectedRemote = null) {
    const remotes = getRemotes();
    
    let remote = preselectedRemote;
    if (!remote) {
        const choices = [
            { name: '📂 Local / Mounted Storage', value: 'local' },
            new inquirer.Separator(),
            ...remotes.map(r => ({ name: `☁️  ${r}`, value: r }))
        ];
        
        const ans = await inquirer.prompt([{
            type: 'list', name: 'remote', message: 'Select Default Cloud Target:', choices: choices
        }]);
        remote = ans.remote;
    }

    const { useBrowser } = await inquirer.prompt([{
        type: 'list', 
        name: 'useBrowser', 
        message: 'How to set path?',
        choices: [
            { name: `📂 Browse ${remote==='local'?'Local':'Remote'} Directory`, value: true },
            { name: '✏️  Manual Entry', value: false }
        ]
    }]);

    let destPath = '';
    
    if (useBrowser) {
        destPath = await browsePath(remote === 'local' ? null : remote);
        const { appendSub } = await inquirer.prompt([{type:'confirm', name:'appendSub', message:`Append '/OpenClaw_Backups' to selected path?`, default: true}]);
        if (appendSub) {
             destPath = remote === 'local' ? path.join(destPath, 'OpenClaw_Backups') : path.posix.join(destPath, 'OpenClaw_Backups');
        }
    } else {
        const defaultPath = remote === 'local' ? path.join(process.env.HOME, 'storage', 'nasdata') : `/OpenClaw_Backups/Termux`;
        const ans = await inquirer.prompt([{
            type: 'input', name: 'destPath', message: 'Path:', default: defaultPath
        }]);
        destPath = ans.destPath;
    }
    
    if (remote !== 'local' && !destPath.startsWith('/')) destPath = '/' + destPath;

    const config = loadConfig();
    config.default_target = { remote, path: destPath };
    saveConfig(config);
    console.log(chalk.green(`✅ Default target set to: ${remote}:${destPath}`));
}

// === AUTO-PILOT UPLOAD (V9.1 Async Stream) ===

async function performAutoUpload(filePath, options = { silent: false }) {
    const config = loadConfig();
    const target = config.default_target;

    if (!target) {
        if (!options.silent) {
            console.log(chalk.yellow('No default cloud target set.'));
            await performInteractiveUpload(filePath); 
        }
        return;
    }

    const remote = target.remote;
    const destPath = target.path;

    if (!options.silent) {
        console.log('');
        const targetDisplay = remote === 'local' ? destPath : `${remote}:${destPath}`;
        const spinner = ora(`🚀 Auto-uploading to [${targetDisplay}] in 3s... (Ctrl+C to cancel)`).start();
        await new Promise(r => setTimeout(r, 3000));
        
        let success = false;
        
        if (remote === 'local') {
            spinner.text = `Copying to local path...`;
            // Local Copy
            try {
                shell.mkdir('-p', destPath);
                const destFile = path.join(destPath, path.basename(filePath));
                const cpRes = shell.exec(`cp -f "${filePath}" "${destFile}"`, { silent: true });
                
                if (cpRes.code === 0 && fs.existsSync(destFile)) {
                    success = true;
                } else {
                    throw new Error(`cp failed: ${cpRes.stderr}`);
                }
            } catch (e) {
                spinner.fail(chalk.red(`❌ Local Copy Failed: ${e.message}`));
                return;
            }
        } else {
            // Rclone Copy with Spawn for Progress
            const rcloneArgs = [
                'copy', filePath, `${remote}:${destPath}`,
                '--progress',
                '--transfers', '4',
                '--timeout', '30s',
                '--contimeout', '30s',
                '--retries', '3',
                '--low-level-retries', '10'
            ];

            success = await new Promise((resolve) => {
                const child = spawn('rclone', rcloneArgs);
                const rl = readline.createInterface({ input: child.stdout });
                
                rl.on('line', (line) => {
                    // Rclone progress format varies, but usually:
                    // Transferred:   12.345 MiB / 100 MiB, 12%, 1.234 MiB/s, ETA 10s
                    // We just show the line if it looks like progress
                    if (line.includes('Transferred:') || line.includes('%')) {
                        spinner.text = line.trim();
                    }
                });

                let errorLog = '';
                child.stderr.on('data', (data) => { errorLog += data.toString(); });

                child.on('close', (code) => {
                    if (code === 0) resolve(true);
                    else {
                        spinner.fail(chalk.red('❌ Upload Failed.'));
                        console.log(chalk.gray(errorLog));
                        resolve(false);
                    }
                });
            });
        }
        
        if (success) {
            spinner.succeed(chalk.green(`✅ Sync Complete!`));
            const { delLocal } = await inquirer.prompt([{
                type:'confirm', name:'delLocal', message:'🗑️  Delete local copy?', default: true
            }]);
            if (delLocal) fs.removeSync(filePath);
        }
    } else {
        // Silent mode
        if (remote === 'local') {
             shell.mkdir('-p', destPath);
             shell.cp('-f', filePath, destPath);
        } else {
             shell.exec(`rclone copy "${filePath}" "${remote}:${destPath}" --retries 3`, { silent: true });
        }
    }
}

async function performInteractiveUpload(filePath) {
    console.log(chalk.cyan('\n☁️  Cloud Sync'));
    // Simplified: reuse auto logic if user selects rclone
    // For now just redirect to config
    console.log(chalk.yellow('Please configure a default target first in the menu.'));
}

async function configureCloud() {
    while (true) {
        console.clear();
        console.log(chalk.cyan('☁️  Cloud Sync Configuration Center\n'));
        const config = loadConfig();
        
        const remotes = getRemotes();
        if (remotes.length > 0) {
            console.log(chalk.white('Active Remotes:'));
            remotes.forEach(r => console.log(chalk.green(`  ✅ ${r}`)));
        }
        
        if (config.default_target) {
             const t = config.default_target;
             console.log(chalk.cyan(`\n🎯 Default Target: ${t.remote==='local' ? '📂 Local Path' : t.remote} -> ${t.path}`));
        }
        console.log('');

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Select Action:',
                choices: [
                    { name: '🎯 Set Default Cloud Target (Auto-Pilot)', value: 'set_default' },
                    new inquirer.Separator(),
                    { name: '🌐 Add NAS via WebDAV (Quick Wizard)', value: 'add_webdav' },
                    { name: '🤖 Add NAS via SFTP (Quick Wizard)', value: 'add_nas' },
                    { name: '☁️  Add Google Drive (Quick Wizard)', value: 'add_gdrive' },
                    new inquirer.Separator(),
                    { name: '⚡ Test Connection (Deep Probe)', value: 'test' },
                    { name: '🗑️  Delete Remote', value: 'delete_remote' },
                    new inquirer.Separator(),
                    { name: '↩️  Back', value: 'back' }
                ]
            }
        ]);

        if (action === 'back') break;
        
        switch (action) {
            case 'set_default': await setDefaultTarget(); break;
            case 'add_webdav': await wizardWebDAV(); break;
            case 'add_nas': await wizardNAS(); break;
            case 'add_gdrive': await wizardGDrive(); break;
            case 'test': await testConnection(); break;
            case 'delete_remote': await deleteRemote(); break;
        }
        if (action !== 'back') await inquirer.prompt([{type:'input', name:'p', message:'Press Enter...'}]);
    }
}

module.exports = { performAutoUpload, performInteractiveUpload, configureCloud };