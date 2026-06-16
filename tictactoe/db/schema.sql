-- Tic-Tac-Toe platform schema. All tables use CREATE TABLE IF NOT EXISTS for idempotent boot.

CREATE TABLE IF NOT EXISTS ttt_rooms (
  id                  UUID         PRIMARY KEY,
  name                TEXT         NOT NULL DEFAULT '',
  visibility          TEXT         NOT NULL DEFAULT 'public',
  password_hash       TEXT,
  password_salt       TEXT,
  whitelist           TEXT[],
  opponent_type       TEXT         NOT NULL DEFAULT 'human',
  spectators_allowed  BOOLEAN      NOT NULL DEFAULT true,
  chat_enabled        BOOLEAN      NOT NULL DEFAULT true,
  turn_timer_seconds  INT          NOT NULL DEFAULT 30,
  status              TEXT         NOT NULL DEFAULT 'waiting',
  player_x_id         TEXT,
  player_o_id         TEXT,
  player_x_username   TEXT,
  player_o_username   TEXT,
  created_by          TEXT         NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ttt_rooms_status_visibility_idx ON ttt_rooms (status, visibility);

CREATE TABLE IF NOT EXISTS ttt_games (
  id                BIGSERIAL    PRIMARY KEY,
  room_id           UUID         NOT NULL REFERENCES ttt_rooms(id),
  player_x_id       TEXT         NOT NULL,
  player_o_id       TEXT         NOT NULL,
  player_x_username TEXT         NOT NULL,
  player_o_username TEXT         NOT NULL,
  moves             JSONB        NOT NULL DEFAULT '[]',
  board             TEXT[]       NOT NULL DEFAULT ARRAY[NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL]::TEXT[],
  result            TEXT,
  winner_id         TEXT,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ttt_games_room_id_idx        ON ttt_games (room_id);
CREATE INDEX IF NOT EXISTS ttt_games_player_x_id_idx    ON ttt_games (player_x_id);
CREATE INDEX IF NOT EXISTS ttt_games_player_o_id_idx    ON ttt_games (player_o_id);
CREATE INDEX IF NOT EXISTS ttt_games_ended_at_desc_idx  ON ttt_games (ended_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS ttt_stats (
  user_id        TEXT         PRIMARY KEY,
  username       TEXT         NOT NULL,
  games_played   INT          NOT NULL DEFAULT 0,
  wins           INT          NOT NULL DEFAULT 0,
  losses         INT          NOT NULL DEFAULT 0,
  draws          INT          NOT NULL DEFAULT 0,
  current_streak INT          NOT NULL DEFAULT 0,
  best_streak    INT          NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ttt_stats_wins_desc_idx ON ttt_stats (wins DESC);

-- Public data: achievements shown on player profiles. Not staging:private.
CREATE TABLE IF NOT EXISTS ttt_achievements (
  user_id        TEXT         NOT NULL,
  achievement_id TEXT         NOT NULL,
  unlocked_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS ttt_achievements_user_id_idx ON ttt_achievements (user_id);

CREATE TABLE IF NOT EXISTS ttt_chat (
  id          BIGSERIAL    PRIMARY KEY,
  room_id     UUID         NOT NULL,
  game_id     BIGINT       REFERENCES ttt_games(id),
  user_id     TEXT         NOT NULL,
  username    TEXT         NOT NULL,
  message     TEXT         NOT NULL CHECK (length(message) <= 200),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ttt_chat_room_id_id_desc_idx ON ttt_chat (room_id, id DESC);
