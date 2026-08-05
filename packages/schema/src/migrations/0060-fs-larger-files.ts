import type { Migration } from "./types.js";
import { MAX_FILE_BYTES } from "./fs-limits.js";

/**
 * Raise the per-file cap on `fs_entries` from 25 MB to 100 MB (2026-08-02).
 *
 * 0037 wrote the cap as an INLINE, unnamed CHECK, so this cannot address it by
 * name — Postgres generated one (`fs_entries_content_check`, but the suffix
 * depends on how many unnamed checks the table already had, which is not
 * something to guess about on a box we have never seen). The DO block finds the
 * constraint by its DEFINITION instead: the only one on this table mentioning
 * `octet_length(content)`. If it finds none — a box that already ran this, or
 * one whose constraint was renamed by hand — it says so and skips, per the
 * doctrine that a migration never throws on state it did not create.
 *
 * Widening a CHECK to a strict SUPERSET is always safe on a live box: no
 * existing row can violate the looser bound, so there is no validation scan
 * that can fail and no data to rewrite. (0044 learned the converse the hard
 * way — a variant added without widening its CHECK failed every INSERT.)
 *
 * ---------------------------------------------------------------- what this costs
 * The cap is not free, and the cost is NOT disk. Bytes live inline in the row,
 * so under MVCC every write of a file writes the WHOLE file again — a new row
 * version, new TOAST chunks, and all of it into WAL. `append` is the sharp
 * edge: `content = content || $2` avoids sending the old bytes over the wire,
 * but it still materialises and rewrites the entire value (twice, since the
 * sha256 recomputes over the concatenation). So one append to a 100 MB file is
 * ~100 MB of WAL, where before the ceiling was 25.
 *
 * That lands on the part of the fleet with the least headroom. Measured on a
 * live box: the database is tens of MB and WAL runs ~10 GB/day — WAL is the
 * ENTIRE backup cost, which is why fulls are 12-hourly and the pgBackRest repo
 * is budgeted at 20% of the volume, stepping retention down and then refusing
 * backups when it is crossed. Large-file churn is therefore spent directly out
 * of the PITR window.
 *
 * It is still the right raise: the whole filesystem on our own box is 1991
 * files / 71 MB logical, so this buys headroom for the occasional real document
 * without changing the steady state. What it does NOT do is make the design
 * good at large files. That needs chunked rows (append becomes one INSERT
 * instead of a full rewrite, and reads stream) — a change to the store, not to
 * a number. Do not raise this again without doing that first.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE v_name text;
BEGIN
  IF to_regclass('fs_entries') IS NULL THEN
    RAISE NOTICE 'fs_entries does not exist — nothing to widen';
    RETURN;
  END IF;
  SELECT c.conname INTO v_name
    FROM pg_constraint c
   WHERE c.conrelid = 'fs_entries'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%octet_length(content)%';
  IF v_name IS NULL THEN
    RAISE NOTICE 'no octet_length(content) CHECK on fs_entries — already widened or hand-edited; skipping';
  ELSE
    EXECUTE format('ALTER TABLE fs_entries DROP CONSTRAINT %I', v_name);
    RAISE NOTICE 'dropped the old per-file CHECK (%)', v_name;
  END IF;
  -- Added unconditionally so a box that skipped the drop (constraint already
  -- gone) still ends up WITH a cap. Named this time: the next change to this
  -- number gets to address it directly instead of pattern-matching a definition.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'fs_entries'::regclass AND conname = 'fs_entries_content_max_bytes'
  ) THEN
    -- Static SQL, not format(): the bound is a compile-time constant from
    -- ./fs-limits.js, never caller input, and the quoting lint is right that a
    -- bare %s in a format() string has no business being here.
    ALTER TABLE fs_entries ADD CONSTRAINT fs_entries_content_max_bytes
      CHECK (content IS NULL OR octet_length(content) <= ${MAX_FILE_BYTES});
  END IF;
END $$;
`;

export const migration0060: Migration = {
  version: "0060",
  name: "fs-larger-files",
  sql: SQL,
  allowDestructive: [
    {
      rule: "drop-constraint",
      match: "fs_entries",
      reason:
        "the CHECK is dropped only to re-add it in the same statement block with a LARGER bound — a strict superset, so no existing row can violate the replacement and there is no window in which the table is uncapped",
    },
  ],
  reason: `raise the fs per-file cap to ${MAX_FILE_BYTES} bytes (100 MB), replacing 0037's unnamed inline CHECK with a named one`,
};
