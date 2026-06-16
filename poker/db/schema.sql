-- Idempotent schema. Applied on every boot (CREATE TABLE IF NOT EXISTS).
-- Privacy markers follow the platform "Public vs private tables" rule: a
-- stranger seeing every row of the marked tables would break the game or leak
-- funds-relevant data, so they copy schema-only into staging.

CREATE TABLE IF NOT EXISTS tables (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  sb                    BIGINT NOT NULL,
  bb                    BIGINT NOT NULL,
  min_buyin             BIGINT NOT NULL,
  max_buyin             BIGINT NOT NULL,
  max_seats             INT NOT NULL DEFAULT 6,
  action_timer_seconds  INT NOT NULL DEFAULT 30,
  status                TEXT NOT NULL DEFAULT 'open',
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Per-table visibility (creator controls). 'public' tables are listed openly;
-- 'private' tables appear locked and require a password or a whitelisted wallet
-- to join. The access SECRET (password hash + whitelist) lives in the private
-- table_access table below, never on this public row.
ALTER TABLE tables ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';
-- Whether spectators may watch the table live. When false the stream endpoint
-- returns 403 to non-seated viewers and the lobby hides the Watch button.
ALTER TABLE tables ADD COLUMN IF NOT EXISTS allow_spectators BOOLEAN NOT NULL DEFAULT TRUE;
-- AI bot configuration. allow_bots fills empty seats with virtual opponents;
-- bot_difficulty controls their play style (easy | medium | hard).
ALTER TABLE tables ADD COLUMN IF NOT EXISTS allow_bots BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS bot_difficulty VARCHAR(10) NOT NULL DEFAULT 'medium';

-- Private access material for a table: salted password hash and/or an allowed
-- wallet whitelist. Marked staging:private — auth material must never leak from
-- a debug endpoint and must not propagate prod→staging. This PRIVATE table FKs
-- the PUBLIC tables row (child-private → parent-public is allowed by the linter;
-- the reverse is not).
CREATE TABLE IF NOT EXISTS table_access (
  table_id       TEXT PRIMARY KEY REFERENCES tables(id),
  password_hash  TEXT,            -- scrypt hash, hex (nullable = no password)
  password_salt  TEXT,            -- hex salt for the scrypt hash
  whitelist      JSONB,           -- array of allowed ut1… wallet addresses
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE table_access IS 'staging:private';

-- Seat occupancy + chip stacks. Public: chip counts at a table are visible to
-- everyone in-app, like a real table.
CREATE TABLE IF NOT EXISTS seats (
  table_id   TEXT NOT NULL REFERENCES tables(id),
  seat_no    INT NOT NULL,
  user_id    TEXT,
  username   TEXT,
  wallet     TEXT,
  stack      BIGINT NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'empty',  -- empty | active | sitting_out
  sit_out_count INT NOT NULL DEFAULT 0,
  joined_at  TIMESTAMPTZ,
  PRIMARY KEY (table_id, seat_no)
);

-- Finished hands. Public — holds the POST-REVEAL seed by value (NOT a FK to the
-- private hand_secrets table) so the Verify panel and history work without
-- exposing any pre-reveal secret.
CREATE TABLE IF NOT EXISTS hands (
  id           TEXT PRIMARY KEY,
  table_id     TEXT NOT NULL REFERENCES tables(id),
  hand_no      INT NOT NULL,
  button_seat  INT,
  board        TEXT[] NOT NULL DEFAULT '{}',
  commitment   TEXT,
  seed         TEXT,            -- revealed seed (after hand end)
  nonces       JSONB,           -- player entropy nonces
  deck         TEXT[],          -- full dealt deck order (revealed)
  result       JSONB,           -- winners, pots, named hands, revealed cards
  commit_tx    TEXT,            -- on-chain commit audit tx hash (nullable)
  reveal_tx    TEXT,            -- on-chain reveal audit tx hash (nullable)
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ
);

-- ── Private tables (staging:private) ─────────────────────────────────────────

-- Pending buy-in sessions binding a wallet+amount to a seat via a memo sid.
-- Financial; also the only thing tying a wallet to an in-progress deposit.
CREATE TABLE IF NOT EXISTS seat_sessions (
  id               TEXT PRIMARY KEY,
  table_id         TEXT NOT NULL,
  seat_no          INT NOT NULL,
  user_id          TEXT,
  wallet           TEXT,
  amount           BIGINT NOT NULL,
  memo             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'awaiting_payment', -- awaiting_payment | credited | expired
  payment_tx_hash  TEXT,
  paid_amount      BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ
);
COMMENT ON TABLE seat_sessions IS 'staging:private';

-- Per-seat hole cards for the in-progress hand. The whole point of redaction.
CREATE TABLE IF NOT EXISTS hole_cards (
  hand_id   TEXT NOT NULL,
  seat_no   INT NOT NULL,
  user_id   TEXT,
  cards     TEXT[] NOT NULL,
  PRIMARY KEY (hand_id, seat_no)
);
COMMENT ON TABLE hole_cards IS 'staging:private';

-- Per-hand secret seed + deck BEFORE reveal. Leaking S pre-reveal would break
-- the entire fairness guarantee.
CREATE TABLE IF NOT EXISTS hand_secrets (
  hand_id      TEXT PRIMARY KEY,
  seed         TEXT NOT NULL,
  shuffle_seed TEXT NOT NULL,
  commitment   TEXT NOT NULL,
  deck         TEXT[] NOT NULL,
  nonces       JSONB,
  anchored     BOOLEAN NOT NULL DEFAULT false, -- commit written on-chain
  revealed     BOOLEAN NOT NULL DEFAULT false, -- seed written on-chain
  commit_tx    TEXT,
  reveal_tx    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE hand_secrets IS 'staging:private';

-- Outbound payout queue (cash-outs and wins settled on leave). Financial.
CREATE TABLE IF NOT EXISTS treasury_ledger (
  id              TEXT PRIMARY KEY,
  table_id        TEXT,
  user_id         TEXT,
  wallet          TEXT NOT NULL,
  kind            TEXT NOT NULL,                 -- cashout
  amount          BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  payout_tx_hash  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
COMMENT ON TABLE treasury_ledger IS 'staging:private';
