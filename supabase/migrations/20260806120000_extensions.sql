-- ---------------------------------------------------------------------------
-- Phase 1: extensions
-- ---------------------------------------------------------------------------
-- gen_random_uuid() for primary keys.
create extension if not exists "pgcrypto";
