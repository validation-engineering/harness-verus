import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

// Use the installed npm CLI directly: .cmd files cannot be spawned without a
// shell on Windows, and adding a shell breaks reliable quoting of project paths.
export function npmCommand(env = process.env) {
  const directories = [dirname(process.execPath), ...(env.PATH ?? env.Path ?? '').split(delimiter)];
  for (const directory of directories) {
    if (!directory) continue;
    const candidates = [join(directory, 'node_modules/npm/bin/npm-cli.js'),
      join(directory, '../lib/node_modules/npm/bin/npm-cli.js')];
    if (process.platform !== 'win32' && existsSync(join(directory, 'npm'))) candidates.push(realpathSync(join(directory, 'npm')));
    for (const cli of candidates) if (cli.endsWith('npm-cli.js') && existsSync(cli)) return [process.execPath, cli];
  }
  throw new Error('npm was not found. Install Node.js with its bundled npm.');
}
