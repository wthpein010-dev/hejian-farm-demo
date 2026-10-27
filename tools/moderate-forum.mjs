import { closeSync, readSync } from 'node:fs';
import { FORUM_MODERATION_STATES, isModerationBatch, isModerationQueue } from '../shared/forum.mjs';
import { FarmStore } from '../services/api/src/store.mjs';
import { normalizeConfig } from '../services/api/src/config.mjs';
import { ForumError } from '../services/api/src/forum.mjs';
import { inspectApplicationDatabase } from '../services/api/tools/sqlite-backup.mjs';
import { PrivateFileError, privateFileFailure as fail, absolutePrivatePath, holdPrivateFile, assertPrivateHeld,
  readPrivateJson, assertSafeSqliteCompanions, preparePrivateOutput, writeNewPrivateJson } from './private-file-guards.mjs';

function argumentsFor(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--input', '--output', '--environment', '--database', '--export', '--apply', '--state'].includes(option) || values.has(option)) fail('INVALID_ARGUMENTS');
    if (option === '--export' || option === '--apply') values.set(option, true);
    else { const value = args[++i]; if (typeof value !== 'string' || !value.length || value.startsWith('--')) fail('INVALID_ARGUMENTS'); values.set(option, value); }
  }
  if (!values.has('--database') || !['development', 'production'].includes(values.get('--environment')) ||
      values.has('--export') === values.has('--apply') || values.has('--output') !== values.has('--export') ||
      values.has('--input') !== values.has('--apply')) fail('INVALID_ARGUMENTS');
  const database = absolutePrivatePath(values.get('--database')), apply = values.has('--apply');
  const state = values.get('--state') ?? 'pending';
  if ((apply && values.has('--state')) || !FORUM_MODERATION_STATES.includes(state)) fail('INVALID_ARGUMENTS');
  const file = absolutePrivatePath(values.get(apply ? '--input' : '--output'));
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if ([database, ...['-wal', '-shm', '-journal'].map(suffix => database + suffix)].some(value => samePath(file, value))) fail('INVALID_ARGUMENTS');
  if (values.get('--environment') !== 'development' || process.env.NODE_ENV === 'production' || process.env.FARM_MODE === 'production') fail('FORUM_UNAVAILABLE');
  return { database, file, apply, state };
}

function verifyServiceDatabase(file, held) {
  const header = Buffer.alloc(16);
  if (readSync(held.fd, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0'))) fail('DATABASE_UNAVAILABLE');
  try {
    assertPrivateHeld(held); assertSafeSqliteCompanions(file);
    // Moderation does not upgrade an old running database. The service must
    // already have initialized schema7/8; the backup module owns the exact DDL,
    // indexes and relational/data integrity checks shared by all offline tools.
    const schema = inspectApplicationDatabase(file);
    if (![7, 8].includes(schema)) fail('DATABASE_UNAVAILABLE');
    assertPrivateHeld(held); assertSafeSqliteCompanions(file);
    return schema;
  } catch (error) { if (error instanceof PrivateFileError) throw error; fail('DATABASE_UNAVAILABLE'); }
}

export function runForumModeration(args) {
  const options = argumentsFor(args);
  let batch, output;
  if (options.apply) {
    batch = readPrivateJson(options.file, 'INVALID_MODERATION_BATCH');
    if (!isModerationBatch(batch)) fail('INVALID_MODERATION_BATCH');
  } else output = preparePrivateOutput(options.file);
  const held = holdPrivateFile(options.database, true); let store;
  const verifyHeld = () => { assertPrivateHeld(held); assertSafeSqliteCompanions(options.database); };
  try {
    const schema = verifyServiceDatabase(options.database, held); verifyHeld();
    store = new FarmStore(normalizeConfig({ mode: 'development', databasePath: options.database }),
      schema === 7 ? { preserveSchemaVersion: 7 } : undefined); verifyHeld();
    const now = store.serverNow(); verifyHeld();
    if (options.apply) {
      const result = store.applyForumModeration(batch, now); verifyHeld();
      if (result?.ok !== true || result.operation !== 'forum-moderation' || !Number.isSafeInteger(result.applied) || result.applied < 0 ||
          result.applied > 20 || typeof result.replayed !== 'boolean') fail('MODERATION_FAILED');
      return { ok: true, operation: 'forum-moderation', applied: result.applied, replayed: result.replayed };
    }
    const queue = store.forumModerationQueue(now, options.state); verifyHeld();
    if (!isModerationQueue(queue) || queue.contentState !== options.state) fail('MODERATION_FAILED');
    writeNewPrivateJson(output, queue); verifyHeld();
    return { ok: true, operation: 'forum-moderation-export', contents: queue.contents.length, reports: queue.reports.length };
  } catch (error) { if (error instanceof PrivateFileError || error instanceof ForumError) throw error; fail('MODERATION_FAILED'); }
  finally { store?.close(); closeSync(held.fd); }
}

if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(runForumModeration(process.argv.slice(2))) + '\n'); }
  catch (error) {
    const code = error instanceof PrivateFileError || error instanceof ForumError ? error.code : 'MODERATION_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, operation: 'forum-moderation', code }) + '\n'); process.exitCode = 1;
  }
}
