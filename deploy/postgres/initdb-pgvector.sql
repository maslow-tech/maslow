-- Runs as superuser during initdb on a FRESH box (empty data volume) —
-- CREATE EXTENSION needs superuser, and the brain's migrations run as
-- brain_owner. Two installs, both needed:
--   1. the CURRENT database ($POSTGRES_DB): the entrypoint creates the brain
--      DB BEFORE running these scripts, so template1 changes never reach it;
--   2. template1: any database created later on this cluster inherits it.
-- Existing boxes (volume already initialized) skip initdb; there, install
-- the extension once by hand (docs/runbooks) — migration 0014 no-ops safely
-- and the box grows the table itself at next boot.
CREATE EXTENSION IF NOT EXISTS vector;
\c template1
CREATE EXTENSION IF NOT EXISTS vector;
