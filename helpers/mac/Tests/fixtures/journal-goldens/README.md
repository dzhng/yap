# Normalized journal byte references

These production `media.sourceEvidence` outputs predate the linear journal readers
and remain byte-for-byte fixtures for them.
The [case registry](../journal-goldens.mjs) owns the input paths. Each input was
copied alone into a scratch source directory; no source media or user library was
opened. The launch journals are the repository's LFS fixtures.

Gzip preserves every normalized byte while keeping these references small.
Receipts omit only `file`, the invocation-owned output locator. The
[export test](../../source-evidence.test.mjs) decompresses and compares complete
bytes and receipts; these references must never be refreshed merely to make a
reader change pass.
