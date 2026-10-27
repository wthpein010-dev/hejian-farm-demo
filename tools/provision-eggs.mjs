import { closeSync, readSync } from 'node:fs';
import { normalizeEggsProvision } from '../shared/eggs.mjs';
import { FarmStore } from '../services/api/src/store.mjs';
import { normalizeConfig } from '../services/api/src/config.mjs';
import { EggsError } from '../services/api/src/eggs.mjs';
import { inspectApplicationDatabase } from '../services/api/tools/sqlite-backup.mjs';
import { PrivateFileError, privateFileFailure as fail, absolutePrivatePath, holdPrivateFile, assertPrivateHeld, readPrivateJson, assertSafeSqliteCompanions } from './private-file-guards.mjs';

function argumentsFor(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--input', '--environment', '--database'].includes(option) || values.has(option)) fail('INVALID_ARGUMENTS');
    const value = args[++i]; if (typeof value !== 'string' || !value.length || value.startsWith('--')) fail('INVALID_ARGUMENTS'); values.set(option, value);
  }
  if (values.size !== 3 || !['development', 'production'].includes(values.get('--environment'))) fail('INVALID_ARGUMENTS');
  const database = absolutePrivatePath(values.get('--database')), input = absolutePrivatePath(values.get('--input'));
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if ([database, ...['-wal', '-shm', '-journal'].map(s => database + s)].some(p => same(p, input))) fail('INVALID_ARGUMENTS');
  if (values.get('--environment') !== 'development' || process.env.NODE_ENV === 'production' || process.env.FARM_MODE === 'production') fail('EGGS_UNAVAILABLE');
  return { database, input };
}
function verifyServiceDatabase(file, held) {
  const header = Buffer.alloc(16); if (readSync(held.fd, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0'))) fail('DATABASE_UNAVAILABLE');
  try {
    assertPrivateHeld(held); assertSafeSqliteCompanions(file);
    // Offline authority never creates or upgrades a database; content and exact DDL are verified read-only first.
    if (inspectApplicationDatabase(file) !== 10) fail('DATABASE_UNAVAILABLE');
    assertPrivateHeld(held); assertSafeSqliteCompanions(file);
  } catch (error) { if (error instanceof PrivateFileError) throw error; fail('DATABASE_UNAVAILABLE'); }
}
export function runEggsProvision(args) {
  const options = argumentsFor(args); let input, heldInput;
  try { heldInput = holdPrivateFile(options.input, true); input = normalizeEggsProvision(readPrivateJson(options.input, 'INVALID_EGGS_PROVISION')); assertPrivateHeld(heldInput, true); }
  catch (error) { if (error instanceof PrivateFileError) throw error; fail('INVALID_EGGS_PROVISION'); }
  finally { if (heldInput) closeSync(heldInput.fd); }
  const held = holdPrivateFile(options.database, true); let store;
  const verifyHeld = () => { assertPrivateHeld(held); assertSafeSqliteCompanions(options.database); };
  try {
    verifyServiceDatabase(options.database, held); verifyHeld();
    store = new FarmStore(normalizeConfig({ mode: 'development', databasePath: options.database })); verifyHeld();
    const now = store.serverNow(); verifyHeld(); const result = store.provisionEggs(input, now); verifyHeld();
    if (result?.ok !== true || result.operation !== 'eggs-provision' || !Number.isSafeInteger(result.version) || result.version < 1 || !Number.isSafeInteger(result.grants) || result.grants < 0 || result.grants > 40) fail('PROVISION_FAILED');
    return { ok: true, operation: 'eggs-provision', version: result.version, grants: result.grants };
  } catch (error) { if (error instanceof PrivateFileError || error instanceof EggsError) throw error; fail('PROVISION_FAILED'); }
  finally { store?.close(); closeSync(held.fd); }
}
if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(runEggsProvision(process.argv.slice(2))) + '\n'); }
  catch (error) { const code = error instanceof PrivateFileError || error instanceof EggsError ? error.code : 'PROVISION_FAILED'; process.stderr.write(JSON.stringify({ ok: false, operation: 'eggs-provision', code }) + '\n'); process.exitCode = 1; }
}
