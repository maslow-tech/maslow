# Runbooks

Operational procedures for a maslow box. Each doc stands alone; start with
`install.md` for a fresh box.

| Runbook                                      | Covers                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [install.md](install.md)                     | Fresh-box install, installer guarantees, repair mode, owner-token break-glass, the updater   |
| [pitr.md](pitr.md)                           | Point-in-time recovery: pgBackRest setup, archiver health, restoring to a timestamp          |
| [restore-drill.md](restore-drill.md)         | The automated restore drill: proving backups restore, and its safety guards                  |
| [disaster-recovery.md](disaster-recovery.md) | Rebuild from a logical dump: globals-first ordering, auth reconciliation, privilege audit    |
| [export-import.md](export-import.md)         | Whole-brain JSON export and round-trip import into a fresh box                               |
| [pg-major-upgrade.md](pg-major-upgrade.md)   | Operator-gated, snapshot-fenced Postgres major-version upgrades                              |
| [disk-and-growth.md](disk-and-growth.md)     | Disk-growth budget, backup-repo budget, write-shed, optional volume auto-grow                |
| [google-oauth.md](google-oauth.md)           | Registering your own Google OAuth client for the Google connector                            |
| [microsoft-entra.md](microsoft-entra.md)     | Registering a single-tenant Entra app for the Microsoft 365 connector                        |
