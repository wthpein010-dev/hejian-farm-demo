import { createHash } from 'node:crypto';

// Explicit successful-session fixture. Labels are synthetic; hash them into the
// same 32-byte/base64url shape as Store tokens without touching real accounts.
export function syntheticSession({ token = 'synthetic-session', expiresAt = 1793046600000,
  environment = 'development', profile }) {
  return { token: createHash('sha256').update(token).digest('base64url'), expiresAt, environment,
    profile: { displayName: '合成测试账户', ...profile } };
}
