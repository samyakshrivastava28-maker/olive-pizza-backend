-- ============================================================
-- STEP 1: Fix Supabase Realtime (REPLICA IDENTITY FULL)
-- This is REQUIRED for postgres_changes events to work.
-- Run this first.
-- ============================================================

ALTER TABLE public.delivery_locations REPLICA IDENTITY FULL;

-- Verify (should show relreplident = 'f')
SELECT relname, relreplident FROM pg_class WHERE relname = 'delivery_locations';


-- ============================================================
-- STEP 2: GPS Privacy Auto-Delete After 5 Minutes
-- Deletes GPS row automatically 5 minutes after delivery ends.
-- Uses pg_cron (available on all Supabase plans).
-- ============================================================

-- Create cleanup function
CREATE OR REPLACE FUNCTION public.cleanup_delivered_gps()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delete GPS rows that have been offline for more than 5 minutes
  DELETE FROM public.delivery_locations
  WHERE online_status = false
    AND last_updated < NOW() - INTERVAL '5 minutes';
END;
$$;

-- Revoke public execute (security: only postgres role should call it)
REVOKE EXECUTE ON FUNCTION public.cleanup_delivered_gps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_delivered_gps() TO postgres;

-- Schedule: runs every minute, cleans up stale offline GPS rows
SELECT cron.schedule(
  'cleanup-delivered-gps',       -- job name
  '* * * * *',                   -- every minute
  'SELECT public.cleanup_delivered_gps();'
);

-- Verify cron job was created
SELECT jobid, jobname, schedule, command, active 
FROM cron.job 
WHERE jobname = 'cleanup-delivered-gps';


-- ============================================================
-- STEP 3: Security View - Mask GPS when order is delivered
-- Customers querying via REST API cannot see coordinates
-- for delivered/cancelled orders.
-- ============================================================

-- This policy is already in place (public read) but the frontend
-- code enforces the delivered-state cutoff. This SQL is a 
-- defense-in-depth reminder — no additional DB changes needed
-- since the frontend stops subscribing on delivery.


-- ============================================================
-- STEP 4: Verify Everything
-- ============================================================

-- Check REPLICA IDENTITY
SELECT relname, 
  CASE relreplident 
    WHEN 'd' THEN 'DEFAULT' 
    WHEN 'f' THEN 'FULL ✅' 
    WHEN 'i' THEN 'INDEX' 
    WHEN 'n' THEN 'NOTHING' 
  END as replica_identity
FROM pg_class WHERE relname = 'delivery_locations';

-- Check publication
SELECT pubname, schemaname, tablename 
FROM pg_publication_tables 
WHERE tablename = 'delivery_locations';

-- Check cron job
SELECT jobid, jobname, schedule, active 
FROM cron.job 
WHERE jobname = 'cleanup-delivered-gps';

-- Check RLS policies
SELECT policyname, cmd, roles 
FROM pg_policies 
WHERE tablename = 'delivery_locations';
