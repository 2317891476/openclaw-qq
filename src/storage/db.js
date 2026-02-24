import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

function hash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

export async function createStorage({ workspaceDir, logger }) {
  const baseDir = path.join(workspaceDir, '.openclaw-qq');
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  const dbPath = path.join(baseDir, 'state.db');

  await fs.mkdir(baseDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');

  const migrationSql = await fs.readFile(path.join(migrationsDir, '001_init.sql'), 'utf8');
  db.exec(migrationSql);

  const insertDedup = db.prepare(
    'INSERT OR IGNORE INTO message_dedupe(scope, key_hash, text_norm, created_at) VALUES (?, ?, ?, ?)'
  );
  const existsDedup = db.prepare(
    'SELECT 1 FROM message_dedupe WHERE scope = ? AND key_hash = ? LIMIT 1'
  );
  const recentText = db.prepare(
    'SELECT 1 FROM message_dedupe WHERE scope = ? AND text_norm = ? AND created_at >= ? LIMIT 1'
  );
  const pruneDedup = db.prepare('DELETE FROM message_dedupe WHERE scope = ? AND created_at < ?');

  const upsertSessionMap = db.prepare(
    `INSERT INTO sessions_map(context_key, session_id, user_id, group_id, is_group, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(context_key) DO UPDATE SET
       session_id = excluded.session_id,
       user_id = excluded.user_id,
       group_id = excluded.group_id,
       is_group = excluded.is_group,
       updated_at = excluded.updated_at`
  );

  const countStmt = db.prepare('SELECT COUNT(1) AS c FROM message_dedupe WHERE scope = ?');

  function seenOrMark(scope, key, textNorm = null) {
    const h = hash(key);
    const existed = !!existsDedup.get(scope, h);
    if (!existed) insertDedup.run(scope, h, textNorm, Date.now());
    return existed;
  }

  function markRecentlySent(sessionKey, textNorm) {
    insertDedup.run('recent_reply', hash(`${sessionKey}:${textNorm}`), textNorm, Date.now());
  }

  function wasRecentlySent(sessionKey, textNorm, windowMs = 60000) {
    const cutoff = Date.now() - Number(windowMs || 60000);
    return !!recentText.get('recent_reply', textNorm, cutoff);
  }

  function rememberSession(contextKey, sessionId, userId, groupId, isGroup) {
    upsertSessionMap.run(contextKey, sessionId, userId || null, groupId || null, isGroup ? 1 : 0, Date.now());
  }

  function prune() {
    const now = Date.now();
    pruneDedup.run('inbound_msg_id', now - 24 * 60 * 60 * 1000);
    pruneDedup.run('forward_signature', now - 24 * 60 * 60 * 1000);
    pruneDedup.run('recent_reply', now - 5 * 60 * 1000);
  }

  function stats() {
    return {
      inbound: Number(countStmt.get('inbound_msg_id')?.c || 0),
      forward: Number(countStmt.get('forward_signature')?.c || 0),
      recentReply: Number(countStmt.get('recent_reply')?.c || 0),
      path: dbPath,
    };
  }

  logger?.info?.(`[Storage] SQLite ready: ${dbPath}`);

  return {
    seenInboundMessageId: (msgId) => seenOrMark('inbound_msg_id', String(msgId)),
    seenForwardSignature: (sig) => seenOrMark('forward_signature', String(sig)),
    markRecentlySent,
    wasRecentlySent,
    rememberSession,
    prune,
    stats,
    close: () => db.close(),
  };
}
