/**
 * The per-file cap on `fs_entries.content`, in ONE place.
 *
 * It is enforced twice — a DB CHECK (0037, widened by 0060) and the store's own
 * EFBIG guard — and those two must never disagree: a store cap above the DB's
 * turns a teaching error into a raw constraint violation surfacing as a 500,
 * and a store cap below the DB's makes the database's cap dead code. Both sides
 * import THIS constant, so they cannot drift.
 */
export const MAX_FILE_BYTES = 104_857_600; // 100 MB
