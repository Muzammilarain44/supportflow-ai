-- ============================================================================
-- SupportFlow AI — Phase 2.1, Issue 3: customer last_activity_at
-- File: 0007_phase2_1_last_activity.sql
-- Apply AFTER 0005_phase2_widget_message_idempotency.sql, in order, in
-- Supabase Dashboard > SQL Editor.
--
-- PROBLEM: customers.last_activity_at (added in 0003) was never written by
-- anything, so the Customers list could only ever show "—". The PATCH
-- customer endpoint deliberately does NOT bump it (profile edits are not
-- activity), so the value must come from messages.
--
-- FIX: one AFTER INSERT trigger on public.messages. Both message paths
-- insert into the SAME messages table, so one trigger covers both:
--   * visitor messages — post_widget_visitor_message() RPC (0003/0005)
--     inserts sender_type 'customer' into messages;
--   * agent replies — POST /api/workspaces/:id/conversations/:id/messages
--     (apps/api/src/routes/conversations.ts) inserts sender_type 'agent'
--     into messages.
-- The trigger resolves the owning customer from NEW.customer_id, falling
-- back to the conversation's customer_id, and sets last_activity_at to
-- GREATEST(current, NEW.created_at) — guarded so an older timestamp can
-- never overwrite a newer one (e.g. a late-arriving / backfilled row).
-- All timestamps are timestamptz, as in the schema.
--
-- NOTES:
-- - The trigger function is SECURITY DEFINER with `set search_path =
--   public`, following the 0004/0005 RPC pattern. (Trigger functions run
--   as the table owner and bypass RLS anyway; the setting keeps the
--   function safe against search_path manipulation.)
-- - Updating customers fires the existing customers_updated_at trigger,
--   so updated_at moves with last_activity_at. That is accepted: the row
--   genuinely changed.
-- - Profile edits still do NOT bump last_activity_at: PATCH /customers
--   updates only full_name/email/phone/tags/notes and never touches the
--   column, and no trigger fires on customers UPDATE.
-- - Idempotent: safe to re-run (CREATE OR REPLACE + DROP TRIGGER IF
--   EXISTS). 0001–0005 are not edited.
--
-- NOT TESTED HERE: the trigger only runs in real Postgres. The mocked API
-- tests cannot execute it; live behaviour (visitor message bumps the
-- value, agent reply bumps it, older timestamps never regress it, PATCH
-- does not bump it) must be verified live by the coordinator.
-- ============================================================================

create or replace function public.bump_customer_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
begin
  v_customer_id := coalesce(
    new.customer_id,
    (select c.customer_id from public.conversations c where c.id = new.conversation_id)
  );
  if v_customer_id is null then
    return new;
  end if;

  -- Guarded: only move last_activity_at forward, never backwards.
  update public.customers
  set last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
  where customers.id = v_customer_id
    and (customers.last_activity_at is null or new.created_at > customers.last_activity_at);

  return new;
end;
$$;

drop trigger if exists messages_bump_customer_last_activity on public.messages;
create trigger messages_bump_customer_last_activity
  after insert on public.messages
  for each row execute function public.bump_customer_last_activity();
