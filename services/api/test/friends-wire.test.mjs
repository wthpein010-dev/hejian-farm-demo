import test from 'node:test';
import assert from 'node:assert/strict';
import { isFriendCommand, isFriendCode, isFriendPeerId, isFriendsView, isFriendCommandReceipt } from '../../../shared/friends.mjs';
const OWNER = 'synthetic-account-1', NOW = 1793073600000, ID = 'a'.repeat(32);
const empty = () => ({ friendsFormat: 1, ownerId: OWNER, environment: 'development', serverTime: NOW, version: 0,
  available: true, enabled: false, profile: null, friends: [], incoming: [], outgoing: [], blocked: [] });
const receipt = () => ({ friendsFormat: 1, ownerId: OWNER, environment: 'development', operationKey: 'friend-wire-key',
  action: 'enable', outcome: 'applied', code: 'OK', completedAt: NOW });

test('friend command boundaries reject extra data, accessors, invalid versions and enumerable contact guesses', () => {
  assert.equal(isFriendCode(ID), true); assert.equal(isFriendPeerId(ID), true);
  for (const value of ['', 'a'.repeat(31), 'A'.repeat(32), ID + '\n', '12345', null]) assert.equal(isFriendCode(value), false);
  assert.equal(isFriendCommand({ action: 'enable', expectedVersion: 0 }), true);
  assert.equal(isFriendCommand({ action: 'request', expectedVersion: 1, code: ID }), true);
  assert.equal(isFriendCommand({ action: 'block', expectedVersion: 2, peerId: ID }), true);
  for (const value of [{ action: 'enable' }, { action: 'enable', expectedVersion: -1 }, { action: 'enable', expectedVersion: 1.5 },
    { action: 'enable', expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { action: 'enable', expectedVersion: 0, code: ID },
    { action: 'request', expectedVersion: 0, peerId: ID }, { action: 'remove', expectedVersion: 0, peerId: ID, ownerId: OWNER },
    Object.assign(Object.create({ inherited: true }), { action: 'enable', expectedVersion: 0 })]) assert.equal(isFriendCommand(value), false);
  let read = false; const accessor = { expectedVersion: 0 }; Object.defineProperty(accessor, 'action', { enumerable: true, get() { read = true; return 'enable'; } });
  assert.equal(isFriendCommand(accessor), false); assert.equal(read, false);
});

test('friends view validation rejects cross-account, duplicate or stale unsafe projections', () => {
  assert.equal(isFriendsView(empty(), OWNER, 'development'), true);
  const v = { ...empty(), enabled: true, version: 1, profile: { code: 'b'.repeat(32), alias: '农友bbbbbbbb' }, friends: [{ peerId: ID, alias: '农友aaaaaaaa', createdAt: NOW }] };
  assert.equal(isFriendsView(v, OWNER, 'development'), true);
  assert.equal(isFriendsView(v, 'other-account', 'development'), false);
  assert.equal(isFriendsView(v, OWNER, 'production'), false);
  for (const modified of [{ ...v, profile: { ...v.profile, realName: 'private' } }, { ...v, incoming: v.friends },
    { ...v, friends: [{ ...v.friends[0], alias: '农友bbbbbbbb' }] }, { ...v, friends: [{ ...v.friends[0], createdAt: NOW + 1 }] },
    { ...v, enabled: false }, { ...v, version: -1 }, { ...v, revision: 1 }, { ...v, friends: new Array(1) },
    { ...v, friends: Array.from({ length: 201 }, (_, i) => ({ peerId: i.toString(16).padStart(32, '0'), alias: '农友00000000', createdAt: NOW })) }]) {
    assert.equal(isFriendsView(modified, OWNER, 'development'), false);
  }
});

test('minimal receipts require the original account, environment, command key and action', () => {
  const v = receipt(); assert.equal(isFriendCommandReceipt(v, OWNER, 'development', 'friend-wire-key', 'enable'), true);
  for (const changed of [{ ...v, ownerId: 'other' }, { ...v, environment: 'production' }, { ...v, operationKey: 'friend-other-key' },
    { ...v, action: 'disable' }, { ...v, code: 'PEER_UNAVAILABLE' }, { ...v, peerId: ID }, { ...v, completedAt: -1 },
    { ...v, outcome: 'refused', code: 'made-up' }]) assert.equal(isFriendCommandReceipt(changed, OWNER, 'development', 'friend-wire-key', 'enable'), false);
  assert.equal(isFriendCommandReceipt({ ...v, outcome: 'refused', code: 'FRIENDS_CHANGED' }, OWNER, 'development', 'friend-wire-key', 'enable'), true);
});

test('wire validation cannot claim production access or an applied production command', () => {
  assert.equal(isFriendsView({ ...empty(), environment: 'production' }, OWNER, 'production'), false);
  assert.equal(isFriendsView({ ...empty(), environment: 'production', available: false }, OWNER, 'production'), true);
  assert.equal(isFriendCommandReceipt({ ...receipt(), environment: 'production' }, OWNER, 'production', 'friend-wire-key', 'enable'), false);
});
