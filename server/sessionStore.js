import { randomUUID } from 'node:crypto';

/**
 * Minimal in-memory session registry.
 * Swap this module for Redis/a database when multi-instance support is needed.
 */
const sessions = new Map();

export function createSession({
  id,
  apkPath,
  originalName,
  adbPort,
  streamPort,
  durationMinutes,
  dockerEnabled,
  commands = [],
  streamUrl = null,
}) {
  const now = Date.now();
  const session = {
    id: id ?? randomUUID(),
    apkPath,
    originalName,
    adbPort,
    streamPort,
    status: dockerEnabled ? 'starting' : 'mock',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMinutes * 60_000).toISOString(),
    durationMinutes,
    dockerEnabled,
    streamUrl,
    commands,
    containerIds: [],
  };

  sessions.set(session.id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

export function deleteSession(id) {
  const session = sessions.get(id) ?? null;
  sessions.delete(id);
  return session;
}

export function isExpired(session) {
  return Date.parse(session.expiresAt) <= Date.now();
}

export function findExpiredSessions() {
  return Array.from(sessions.values()).filter(isExpired);
}
