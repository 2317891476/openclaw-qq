PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions_map (
  context_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  group_id TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_dedupe (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  text_norm TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_message_dedupe_scope_created
  ON message_dedupe(scope, created_at);

CREATE TABLE IF NOT EXISTS send_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_send_outbox_status_created
  ON send_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS pixiv_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_key TEXT NOT NULL,
  illust_id TEXT NOT NULL,
  source TEXT,
  sent_at INTEGER NOT NULL,
  UNIQUE(context_key, illust_id)
);

CREATE INDEX IF NOT EXISTS idx_pixiv_history_sent_at
  ON pixiv_history(sent_at);
