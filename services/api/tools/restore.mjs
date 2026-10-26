import { restoreBackup } from './sqlite-backup.mjs';
import { runCli } from './cli.mjs';

await runCli('restore', ['--backup', '--output'], values => restoreBackup({
  backupDirectory: values['--backup'], outputDirectory: values['--output'],
}));
