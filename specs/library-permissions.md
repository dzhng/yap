# Library permissions: only as strict as needed

**Decision (2026-10-17, from the library-deletion planning walk).** Library
permissions protect what actually needs protecting, and never stop Yap from
starting.

- **Imported and recorded media files are published as `0o444`,** read-only for
  everyone, instead of `0o400` (`packages/core/src/files.ts:346`,
  `acquisitions.ts:1155`). Removing the write bit protects content-addressed
  integrity; removing everyone else's read access bought nothing on a single-user
  Mac, and made `rm` prompt.
- **Library folders are still created private (`0o700`),** because screen
  recordings often capture secrets. But startup no longer **refuses** when a folder
  is looser (`packages/core/src/assets.ts:210-216`, "Managed asset directories must
  be private directories owned by this user"). It tightens the folder and logs it.
  A backup restore or a `chmod -R` must never leave Yap unable to start.
- **Ownership checks that guard against symlink and other-user attacks stay.**
  Those include `uid`, `O_NOFOLLOW` and the native fd-anchored removal.

**Verify.**
1. Write a red test first: a library folder at `0o755` starts the service and comes
   back as `0o700`.
2. A newly imported file is `0o444`.
3. Existing `0o400` files keep working, with no migration.

This is a single slice and independent of [library-deletion](library-deletion/README.md).
