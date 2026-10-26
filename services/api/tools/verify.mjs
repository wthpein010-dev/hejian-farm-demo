import { verifyBackup } from './sqlite-backup.mjs';
import { runCli } from './cli.mjs';

await runCli('verify', ['--backup'], values => verifyBackup({ backupDirectory: values['--backup'] }));
