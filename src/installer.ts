import { exec } from 'child_process';
import { promisify } from 'util';
import ora from 'ora';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';

const execAsync = promisify(exec);

async function isCommandAvailable(cmd: string): Promise<boolean> {
    try {
        await execAsync(`command -v ${cmd}`);
        return true;
    } catch {
        return false;
    }
}

export async function checkAndInstallDependencies(): Promise<void> {
    const missing: { name: string; installCmd: string; msg: string }[] = [];

    if (!(await isCommandAvailable('anvil'))) {
        missing.push({
            name: 'Foundry (Anvil)',
            installCmd: 'curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup',
            msg: 'Required for local EVM execution and state forks.'
        });
    }

    if (!(await isCommandAvailable('ollama'))) {
        missing.push({
            name: 'Ollama',
            installCmd: 'curl -fsSL https://ollama.com/install.sh | sh',
            msg: 'Required for local on-device AI threat analysis.'
        });
    }

    if (missing.length === 0) return;

    console.log(chalk.yellow('\n⚠️  Missing Required System Dependencies!'));
    missing.forEach(m => {
        console.log(chalk.gray(`  - `) + chalk.cyan.bold(m.name) + chalk.gray(`: ${m.msg}`));
    });
    console.log('');

    const proceed = await confirm({
        message: 'Would you like Skep3 to install these dependencies automatically now?',
        default: true
    });

    if (!proceed) {
        console.log(chalk.red('\n✖ Skipping installation. Some features may not work or will crash.\n'));
        return;
    }

    for (const dep of missing) {
        const spinner = ora({ text: `Installing ${dep.name}... (this may take a minute or two)`, color: 'blue' }).start();
        try {
            await execAsync(dep.installCmd);
            spinner.succeed(chalk.green(`Successfully installed ${dep.name}.`));
            
            // For Anvil, update path for just this session so Node can find it immediately or alias it
            if (dep.name === 'Foundry (Anvil)') {
                 // Add to process path temporarily
                 process.env.PATH = `${process.env.HOME}/.foundry/bin:${process.env.PATH}`;
            }
        } catch (err: any) {
            spinner.fail(chalk.red(`Failed to install ${dep.name}.`));
            console.log(chalk.gray(`  Try running it manually: ${dep.installCmd}\n`));
            console.error(chalk.red(err.message));
        }
    }
}
