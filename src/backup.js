const shell = require('shelljs');
const fs = require('fs-extra');
const path = require('path');
const dayjs = require('dayjs');
const utils = require('./utils');
const ora = require('ora');
const chalk = require('chalk');
const inquirer = require('inquirer');
const cloud = require('./cloud');

// === RETENTION POLICY ===
const RETENTION_COUNT = 5;

function enforceRetention() {
    const backupDir = path.join(process.env.HOME, 'claw-backups');
    if (!fs.existsSync(backupDir)) return;

    const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('openclaw-backup-') || f.startsWith('claw-backup-'))
        .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time); // Newest first

    if (files.length > RETENTION_COUNT) {
        console.log(chalk.gray(`\n🧹 Retention Policy: Keeping latest ${RETENTION_COUNT} backups...`));
        const toDelete = files.slice(RETENTION_COUNT);
        toDelete.forEach(f => {
            fs.removeSync(path.join(backupDir, f.name));
            console.log(chalk.gray(`   Deleted old backup: ${f.name}`));
        });
    }
}

async function cleanLocalBackups() {
    const backupDir = path.join(process.env.HOME, 'claw-backups');
    if (!fs.existsSync(backupDir)) {
        console.log(chalk.yellow('No backups found.'));
        return;
    }
    
    const files = fs.readdirSync(backupDir);
    console.log(chalk.cyan(`Found ${files.length} files in ${backupDir}`));
    
    const { confirm } = await inquirer.prompt([{
        type: 'confirm', name: 'confirm', message: 'Delete ALL local backups? (Cloud copies safe)', default: false
    }]);
    
    if (confirm) {
        fs.emptyDirSync(backupDir);
        console.log(chalk.green('✅ All local backups deleted.'));
    }
}

function scanForComponents() {
  const home = process.env.HOME;
  const candidates = [];

  // 0. PM2
  try {
    const pm2List = JSON.parse(shell.exec('pm2 jlist', { silent: true }).stdout);
    const targetNames = ['moltbot', 'openclaw', 'clawdbot', 'vertex-proxy'];
    pm2List.forEach(proc => {
      if (targetNames.some(t => proc.name.includes(t)) || (proc.pm2_env.pm_cwd && proc.pm2_env.pm_cwd.includes('claw'))) {
         const cwd = proc.pm2_env.pm_cwd;
         if (cwd && fs.existsSync(cwd)) {
           if (!candidates.find(c => c.path === cwd)) {
              candidates.push({
                id: `running_${proc.name}`,
                name: `Running Instance (${proc.name})`,
                path: cwd,
                type: 'dir',
                exists: true,
                checked: true
              });
           }
         }
      }
    });
  } catch (e) {}

  // 1. Custom Skills
  const skillsPaths = [
      path.join(home, 'claw', 'skills'),
      path.join(home, 'clawdbot', 'skills'),
      path.join(home, 'openclaw', 'skills')
  ];
  skillsPaths.forEach(p => {
      if (fs.existsSync(p)) {
          if (!candidates.find(c => c.path === p)) {
               candidates.push({
                  id: 'custom_skills',
                  name: `Custom Skills`,
                  path: p,
                  type: 'dir',
                  exists: true,
                  checked: true
               });
          }
      }
  });

  // 2. Key Markdown
  const keyMds = ['MEMORY.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
  const searchRoots = [home, path.join(home, 'clawdbot'), path.join(home, 'openclaw')];
  const validRoot = searchRoots.find(r => fs.existsSync(r));
  if (validRoot) {
      candidates.push({
          id: 'key_markdowns',
          name: 'Key Soul Files (MEMORY.md, USER.md...)',
          path: null,
          type: 'md_group',
          root: validRoot,
          files: keyMds,
          exists: true,
          checked: true
      });
  }

  // 3. User Config
  const userPath = path.join(home, 'claw');
  if (!candidates.find(c => c.path === userPath)) {
      candidates.push({ 
        id: 'user_config', 
        name: 'User Config (~/claw)', 
        path: userPath, 
        type: 'dir', 
        exists: fs.existsSync(userPath) 
      });
  }

  // 4. Secrets
  const secretNames = ['.openclaw', '.moltbot', '.clawdbot'];
  secretNames.forEach(name => {
    const fullPath = path.join(home, name);
    if (fs.existsSync(fullPath)) {
      candidates.push({ 
        id: `secret_${name}`, 
        name: `Secrets (${name})`, 
        path: fullPath, 
        type: 'dir', 
        exists: true 
      });
    }
  });

  // 5. System
  candidates.push({ id: 'pm2', name: 'PM2 Process List', path: null, type: 'process', exists: true });
  candidates.push({ id: 'env', name: 'Environment Variables', path: null, type: 'env', exists: true });

  return candidates;
}

// === CORE BACKUP LOGIC ===
async function runBackupProcess(selectedComponents, allComponents, options) {
    const spinner = ora('Initializing Backup...').start();
    if (options.silent) spinner.stop();

    try {
        const timestamp = dayjs().format('YYYYMMDD-HHmmss');
        const backupFileName = `openclaw-backup-${timestamp}.tar.gz`;
        const backupDir = path.join(process.env.HOME, 'claw-backups');

        const os = require('os');
const backupDir = path.join(os.homedir(), 'claw-backups');

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
        
        const stagingDir = path.join(process.env.HOME, '.claw-backup-staging');
        fs.ensureDirSync(stagingDir);
        fs.emptyDirSync(stagingDir);

        const pathsToTar = [];

        if (selectedComponents.includes('pm2')) {
           if (!options.silent && spinner.isSpinning) spinner.text = 'Snapshotting PM2...';
           shell.exec(`pm2 dump`, { silent: true });
           const pm2Dump = path.join(process.env.HOME, '.pm2', 'dump.pm2');
           if (fs.existsSync(pm2Dump)) {
             const dest = path.join(stagingDir, 'pm2-dump.json');
             fs.copySync(pm2Dump, dest);
             pathsToTar.push(dest);
           }
        }

        if (selectedComponents.includes('env')) {
           const envFile = path.join(stagingDir, 'env.backup');
           shell.exec(`printenv > ${envFile}`, { silent: true });
           pathsToTar.push(envFile);
        }
        
        const mdComp = allComponents.find(c => c.id === 'key_markdowns');
        if (mdComp && selectedComponents.includes('key_markdowns')) {
            const mdDest = path.join(stagingDir, 'soul_files');
            fs.ensureDirSync(mdDest);
            mdComp.files.forEach(f => {
                const src = path.join(mdComp.root, f);
                if (fs.existsSync(src)) fs.copySync(src, path.join(mdDest, f));
            });
            pathsToTar.push(mdDest);
        }

        const addedPaths = new Set();
        const addPathSafe = (p) => {
            if (!addedPaths.has(p)) {
                pathsToTar.push(p);
                addedPaths.add(p);
            }
        };

        allComponents.forEach(c => {
          if ((c.type === 'dir' || c.type === 'custom_skills') && selectedComponents.includes(c.id)) {
            addPathSafe(c.path);
          }
        });

        const backupPath = path.join(backupDir, backupFileName);
        
        if (!options.silent) spinner.text = 'Compressing... (This may take a while)';

        const excludes = [
          '--exclude=node_modules',
          '--exclude=.git',
          '--exclude=.cache',
          '--exclude=tmp',
          '--exclude=logs',
          '--exclude=*.log',
          '--exclude=claw-backups'
        ];

        const tarArgs = ['-czf', backupPath, ...excludes, ...pathsToTar];
        
        await new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const child = spawn('tar', tarArgs);
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Tar code ${code}`)));
            child.on('error', (err) => reject(err));
        });

        // Encrypt
        let encrypted = false;
        let finalPath = backupPath;
        
        if (!options.cli && !options.silent) {
          spinner.stop();
          const doEncrypt = await utils.confirm('Encrypt backup with password?');
          if (doEncrypt) {
            const password = await utils.promptPassword('Enter Password:');
            spinner.start('Encrypting...');
            shell.exec(`openssl enc -aes-256-cbc -salt -in ${backupPath} -out ${backupPath}.enc -pass pass:${password} -pbkdf2`);
            shell.rm(backupPath);
            finalPath = `${backupPath}.enc`;
            encrypted = true;
            spinner.succeed(chalk.green(`Encrypted Backup Created: ${path.basename(finalPath)}`));
          }
        }

        if (!encrypted && !options.silent) {
           if(spinner.isSpinning) spinner.succeed(chalk.green(`Backup Created: ${path.basename(finalPath)}`));
           else console.log(chalk.green(`✅ Backup Created: ${path.basename(finalPath)}`));
        }

        const os = require('os');
fs.removeSync(stagingDir);
        
        if (!options.silent) spinner.stop();
        enforceRetention();

        if (!options.cli) {
            await cloud.performAutoUpload(finalPath, { silent: false });
        } else {
            await cloud.performAutoUpload(finalPath, { silent: options.silent });
        }

    } catch (error) {
        if (!options.silent && spinner.isSpinning) spinner.fail('Backup Failed');
        console.error(chalk.red(error.message));
    }
}

// === NEW ENTRY POINTS ===

async function performFullBackup() {
    const allComponents = scanForComponents();
    // Select ALL existing
    const selected = allComponents.filter(c => c.exists).map(c => c.id);
    await runBackupProcess(selected, allComponents, { silent: false, cli: false });
}

async function performCustomBackup() {
    const allComponents = scanForComponents();
    const choices = allComponents.map(c => ({
      name: c.type === 'dir' ? `${c.name} ${chalk.gray(c.exists ? `(${c.path})` : '(Not Found)')}` : c.name,
      value: c.id,
      checked: c.checked !== false,
      disabled: !c.exists
    }));

    const { selection } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selection',
      message: 'Select components to backup:',
      choices: choices,
      pageSize: 12
    }]);
    
    if (selection.length === 0) return console.log(chalk.yellow('Aborted.'));
    
    await runBackupProcess(selection, allComponents, { silent: false, cli: false });
}

async function performCLIBackup(silent = false) {
    const allComponents = scanForComponents();
    const selected = allComponents.filter(c => c.exists && c.checked !== false).map(c => c.id);
    await runBackupProcess(selected, allComponents, { silent: silent, cli: true });
}

module.exports = { performFullBackup, performCustomBackup, performCLIBackup, cleanLocalBackups, performBackup: performCLIBackup };