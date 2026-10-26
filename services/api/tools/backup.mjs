import { createBackup } from './sqlite-backup.mjs';
import { runCli } from './cli.mjs';

await runCli('backup', ['--database', '--output'], values => createBackup({
  databasePath: values['--database'], outputDirectory: values['--output'],
}));
