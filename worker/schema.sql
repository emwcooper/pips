CREATE TABLE IF NOT EXISTS solves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  elapsed_ms INTEGER NOT NULL,
  client_id TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diff_elapsed ON solves(difficulty, elapsed_ms);
CREATE INDEX IF NOT EXISTS idx_diff_ts ON solves(difficulty, ts);
