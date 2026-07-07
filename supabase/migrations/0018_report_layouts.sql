-- Per-account report LAYOUT customization (hide + reorder the cards/sections on a report page).
--
-- Stored server-side so a layout saved "for the whole account" is shared across every user AND every
-- rooftop of that enterprise. A "just me" layout stays CLIENT-side (localStorage) — the embedded app has
-- no per-user identity to key on (the Spyne session token carries enterprise_id + team_id only, never a
-- user id), so "just me" = this browser and cannot be a server row.
--
-- Keyed by (enterprise_id, page_key) — ONE shared layout per account per page, applied to all rooftops.
-- `layout` is the same shape the client persists: { "order": string[], "hidden": string[] }.
-- Accessed only by the server API route via the service role (like every other report_* table), so no
-- RLS policy is defined; the table holds no PII (section ids only). Idempotent (create if not exists).

create table if not exists public.report_layouts (
  enterprise_id text not null,
  page_key      text not null,   -- 'overview' | 'agents'
  layout        jsonb not null,  -- { order: string[], hidden: string[] }
  updated_at    timestamptz not null default now(),
  primary key (enterprise_id, page_key)
);
