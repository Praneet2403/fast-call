-- Fast Call schema. Idempotent: safe to run on every startup (see migrate.ts).

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-supplied key: retrying the same POST returns the same request instead of a duplicate.
  idempotency_key     TEXT NOT NULL UNIQUE,
  location            geography(Point, 4326) NOT NULL,
  priority            TEXT NOT NULL CHECK (priority IN ('P1', 'P2', 'P3')),
  required_capability TEXT NOT NULL CHECK (required_capability IN ('BLS', 'ALS')),
  state               TEXT NOT NULL CHECK (state IN
                        ('CREATED', 'MATCHING', 'OFFERED', 'ASSIGNED', 'EN_ROUTE',
                         'ARRIVED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  assigned_agent_id   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Requests near here" (analytics, Day 6 demand history).
CREATE INDEX IF NOT EXISTS requests_location_gix ON requests USING GIST (location);

-- The sweeper and dashboard only ever scan live requests; keep that index small.
CREATE INDEX IF NOT EXISTS requests_active_idx ON requests (state, updated_at)
  WHERE state NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED');

-- Last line of defence against double dispatch: a unit can be bound to at most one live call.
-- The dispatcher's Redis lock prevents it; this makes the database refuse it even if the lock fails.
CREATE UNIQUE INDEX IF NOT EXISTS requests_one_live_call_per_unit ON requests (assigned_agent_id)
  WHERE state IN ('ASSIGNED', 'EN_ROUTE', 'ARRIVED');

-- Read model with plain lat/lng, so application code never parses PostGIS types.
CREATE OR REPLACE VIEW request_view AS
  SELECT id, idempotency_key,
         ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
         priority, required_capability, state, assigned_agent_id, created_at, updated_at
  FROM requests;

-- Append-only audit trail: every state change, who/why, in the same transaction as the change.
CREATE TABLE IF NOT EXISTS request_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  UUID NOT NULL REFERENCES requests(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  agent_id    TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events (request_id, id);

CREATE TABLE IF NOT EXISTS offers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES requests(id),
  agent_id        TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  outcome         TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (outcome IN ('PENDING', 'ACKNOWLEDGED', 'UNABLE', 'TIMED_OUT', 'CANCELLED')),
  score           DOUBLE PRECISION,
  score_breakdown JSONB
);
-- At most one open offer per request.
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_pending_per_request ON offers (request_id)
  WHERE outcome = 'PENDING';
