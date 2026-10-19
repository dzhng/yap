# Persisted catalog references

Launch-era catalog compatibility starts at format 29, the format of Yap 0.1.33 (October 12,
2026 at 7:03 PM PDT). Format 30 names every stored record by `id`; a format-29 catalog
migrates to it once, on open (`src/record-identity-migration.ts`).

`format-29-editing.sqlite` and `format-29-deletion.sqlite` are catalogs Yap 0.1.61 wrote
while its own tests ran: project history with edit and undo replays, asset origins and job
inputs that embed owners, and stored delete results. They are the migration's contract.
Catalog tests build every other input in their scratch directory and never write a user
library or source media. Keep an older-format fixture only while it represents a supported
migration; do not retain one whose rows have no current owner.
