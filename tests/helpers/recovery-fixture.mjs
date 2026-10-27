/** Explicit synthetic recovery service for legacy feature fixture transports. */
export function recoveryFixtureTransport(transport, { planting = false } = {}) {
  let ownerId = 'member-a', environment = 'development', slot = null, version = 0;
  const epoch = 'e'.repeat(32), id = 'a'.repeat(32), now = 1793044800000;
  const envelope = () => ({ recoveryFormat: 1, ownerId, environment, serverTime: now });
  const ok = data => ({ status: 200, data: { data } });
  return async request => {
    const path = request.url.split('/api/v1')[1];
    if (path === '/account/recovery') return ok({ ...envelope(), available: environment === 'development', epoch, version, intent: slot });
    if (planting && path === '/account/recovery/prepare') {
      slot = { id, audience: request.body.audience, command: request.body.command, operationKey: 'intent-' + id, prepareEpoch: epoch, prepareVersion: version, phase: 'prepared', version: 1, createdAt: now, updatedAt: now, closedAt: null, receipt: null }; version++;
      return ok({ ...envelope(), operation: 'prepare', code: 'OK', epoch, version, currentIntentId: id, intent: slot, attempt: request.body });
    }
    if (planting && path === '/account/recovery/ack') {
      const original = { ...slot, closedAt: now, version: 3 }; slot = null; version++;
      return ok({ ...envelope(), operation: 'ack', code: 'OK', epoch, version, currentIntentId: null, intent: original, attempt: null });
    }
    const response = await transport(request);
    if (path.startsWith('/auth/') && response?.data?.data?.token) {
      ownerId = response.data.data.profile.id; environment = response.data.data.environment;
    }
    if (planting && (path === '/account/recovery/execute' || path === '/account/recovery/intent/' + id) && response?.data?.data?.plantingFormat === 1) {
      slot = { ...slot, phase: 'settled', version: 2, receipt: { ...response.data.data, operationKey: slot.operationKey } }; version++;
      if (path.includes('/intent/')) return ok({ ...envelope(), intent: slot });
      return ok({ ...envelope(), operation: 'execute', code: 'OK', epoch, version, currentIntentId: id, intent: slot, attempt: null });
    }
    return response;
  };
}
