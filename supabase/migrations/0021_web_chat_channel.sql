-- WEB CHAT — the third AI channel (canonical, 2026-08-21).
--
-- dealer_leads.conversations type='chat' was excluded from the conversation spine entirely, so web-chat
-- sessions, web-chat qualification and appointments the AI booked INSIDE a chat were missing from every
-- agent number. Chat now folds into the same agent it already belongs to (agentCallType='inbound',
-- agentType='Sales' → Sales Inbound), on each agent's own canonical rule:
--   • conversation  = the visitor actually exchanged messages (chat's "not voicemail and they spoke")
--   • qualified     = Sales Inbound → the AI's own verdict (chat summary `qualified`, the chat twin of
--                     report.qualified); Sales Outbound → campaign outcome AND engaged; Service → the
--                     intent rule (engaged AND a windowed buying-intent action item)
--   • appointment   = AI-booked, unchanged (meetings.source='spyne', warm_transfer excluded) — chat
--                     bookings were dropped two ways and both are now attributed. See agentBaseFact.sql
--                     chat_booking_link.
--
-- Measured on prod at cutover (30d): 65 spyne meetings across 12 teams were anchored to a chat
-- conversation the spine didn't contain, and 10 more carried no anchor at all — ~75 AI-booked
-- appointments (~1.1% of 6,605) that were counted nowhere, concentrated in the ~13 teams running chat.
-- Paragon Honda (5895de05b) Sales Inbound 30d went appointments 3 → 7, matching its Appointments
-- calendar exactly; leads 95 → 99, conversations 58 → 62, qualified 25 → 29.
--
-- Only new storage is needed: every funnel number (leads / conversations / qualified / appointments) is
-- already derived window-distinct from agent_lead_days, which chat rows now populate like any other
-- conversation. Historical rows keep chats = 0 until a --full re-aggregate.

alter table public.agent_daily
  add column if not exists chats integer not null default 0;

comment on column public.agent_daily.chats is
  'Σ is_chat — web-chat sessions (conversations.type=''chat''). Third channel beside calls and sms_threads; calls + sms_threads + chats = conv_count.';
