PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS snapshot (
  id            INTEGER PRIMARY KEY,
  taken_at      INTEGER,
  ingested_at   INTEGER NOT NULL,
  source        TEXT NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,
  archive_path  TEXT,
  owner         TEXT,
  manifest_json TEXT
);

CREATE TABLE IF NOT EXISTS account (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  -- Instagram derives a DM thread's folder name from the display name, not the
  -- username, so without this 85% of threads cannot be joined to the graph.
  display_name TEXT,
  first_seen  INTEGER,
  last_seen   INTEGER,
  merged_into INTEGER REFERENCES account(id)
);

CREATE TABLE IF NOT EXISTS follow_edge (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  direction   TEXT NOT NULL CHECK (direction IN ('follows_me','i_follow')),
  since       INTEGER,
  PRIMARY KEY (snapshot_id, account_id, direction)
);

CREATE TABLE IF NOT EXISTS graph_event (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  kind        TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  occurred_at INTEGER,
  confidence  REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS interaction (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  kind        TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('out','in')),
  occurred_at INTEGER,
  permalink   TEXT,
  text        TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS impression (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  kind        TEXT NOT NULL,
  occurred_at INTEGER,
  dedupe_key  TEXT NOT NULL UNIQUE
);

-- Things I did that the export no longer attributes to anyone. Meta's newer
-- format records a liked post only as /p/<shortcode> with no author, so 33k
-- likes cannot reach the interaction table — but their timestamps still drive
-- the activity heatmap and volume-over-time.
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  occurred_at INTEGER,
  permalink   TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS list_membership (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  list        TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, account_id, list)
);

CREATE TABLE IF NOT EXISTS my_post (
  id         INTEGER PRIMARY KEY,
  posted_at  INTEGER,
  caption    TEXT,
  media_type TEXT,
  permalink  TEXT,
  dedupe_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS topic (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, value)
);

CREATE TABLE IF NOT EXISTS search_event (
  id          INTEGER PRIMARY KEY,
  term        TEXT NOT NULL,
  occurred_at INTEGER,
  dedupe_key  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS inbound_capture (
  id          INTEGER PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  permalink   TEXT,
  raw_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_edge_snap  ON follow_edge(snapshot_id, direction);
CREATE INDEX IF NOT EXISTS ix_inter_acct ON interaction(account_id, kind);
CREATE INDEX IF NOT EXISTS ix_inter_time ON interaction(occurred_at);
CREATE INDEX IF NOT EXISTS ix_impr_acct  ON impression(account_id);
CREATE INDEX IF NOT EXISTS ix_event_acct ON graph_event(account_id, kind);
CREATE INDEX IF NOT EXISTS ix_activity_time ON activity(occurred_at);
