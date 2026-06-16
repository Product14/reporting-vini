-- Persisted rooftop timezone map.
--
-- WHY: store-local day/hour bucketing (so a Pacific rooftop's "Today" is a Pacific day, not a UTC day)
-- used to depend on a LIVE call to the Spyne working-hours API on every sync — gated on a short-lived
-- admin JWT. When that token was absent (e.g. the GH Actions cron had no SPYNE_API_TOKEN), the sync
-- silently fell back to UTC bucketing and "Today" bled the prior Pacific evening (the Honda DTLA bug).
--
-- A rooftop's timezone effectively never changes, so we persist it here. Any sync run that DOES have a
-- token seeds/refreshes this table; every later run (and /api/reports) reads it as a fallback, so
-- bucketing stays store-local even across token outages. Decouples tz-correctness from the live token.

create table if not exists team_tz (
  team_id    text primary key,
  timezone   text not null,
  updated_at timestamptz not null default now()
);
