import { BackupError } from './sqlite-backup.mjs';

export async function runCli(operation, allowed, execute) {
  try {
    const args = process.argv.slice(2), values = {};
    if (args.length !== allowed.length * 2) throw new BackupError('EXPLICIT_PATHS_REQUIRED');
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || Object.hasOwn(values, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new BackupError('INVALID_ARGUMENTS');
      values[args[i]] = args[i + 1];
    }
    const result = await execute(values);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const reason = error instanceof BackupError ? error.code : 'IO_OR_VALIDATION_ERROR';
    // Native SQLite/OS errors may contain SQL values or private paths. Never
    // serialize an error, its stack, or untrusted input into operational logs.
    process.stderr.write(JSON.stringify({ ok: false, code: `${operation.toUpperCase()}_FAILED`, reason }) + '\n');
    process.exitCode = 1;
  }
}
