const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const ora = require('ora');
const chalk = require('chalk');
const shell = require('shelljs'); // Added shelljs for rclone execution

async function browsePath(remote = null) {
    let currentPath = remote ? '' : process.env.HOME; // Local starts at HOME, remote at root
    
    while (true) {
        console.clear();
        const os = require('os');
const displayRemote = remote ? `${remote}:` : `[Local - ${os.type()}]`;
        console.log(chalk.cyan(`📂 Browsing [${displayRemote}]: ${currentPath || '/'}`));
        
        const spinner = ora('Fetching directory listing...').start();
        let items = [];
        
        if (remote) {
            // Rclone LSF
            const res = shell.exec(`rclone lsf "${remote}:${currentPath}" --dirs-only`, { silent: true });
            if (res.code === 0) {
                items = res.stdout.split('\n').filter(Boolean).map(l => l.replace(/\/$/, ''));
            }
        } else {
            // Local FS
            try {
                const dirents = fs.readdirSync(currentPath, { withFileTypes: true });
                items = dirents.filter(d => d.isDirectory()).map(d => d.name);
            } catch (e) {
                // Permission denied or path error
            }
        }
        spinner.stop();
        
        const choices = [
            { name: '✅ Select Current Directory', value: 'select_current' },
            { name: '➕ Create New Folder', value: 'create_new' },
            { name: '⬆️  Go Up', value: 'go_up' },
            new inquirer.Separator(),
            ...items.map(d => ({ name: `📁 ${d}`, value: `dir_${d}` }))
        ];

        const { action } = await inquirer.prompt([{
            type: 'list', name: 'action', message: 'Navigate:', choices: choices, pageSize: 15
        }]);

        if (action === 'select_current') {
            return currentPath || '/';
        } else if (action === 'go_up') {
            if (remote && !currentPath) continue; 
            const parts = currentPath.split(path.sep).filter(Boolean);
            parts.pop();
            currentPath = remote ? parts.join('/') : ('/' + parts.join('/')); // Local needs leading /
            if (!remote && currentPath === '') currentPath = '/';
        } else if (action === 'create_new') {
            const { folderName } = await inquirer.prompt([{type:'input', name:'folderName', message:'New Folder Name:'}]);
            if (folderName) {
                const newDir = remote ? path.posix.join(currentPath, folderName) : path.join(currentPath, folderName);
                let success = false;
                if (remote) {
                    success = shell.exec(`rclone mkdir "${remote}:${newDir}"`, {silent:true}).code === 0;
                } else {
                    try { fs.ensureDirSync(newDir); success = true; } catch(e){}
                }
                
                if (success) currentPath = newDir;
                else { console.log(chalk.red('Failed to create folder.')); await new Promise(r => setTimeout(r, 1000)); }
            }
        } else if (action.startsWith('dir_')) {
            const dirName = action.replace('dir_', '');
            currentPath = remote ? path.posix.join(currentPath, dirName) : path.join(currentPath, dirName);
        }
    }
}

module.exports = { browsePath };