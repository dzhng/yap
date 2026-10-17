# 06 One async vocabulary

**Contract.**
- **One vocabulary.** `WorkState` replaces `JobState`, `ArtifactState` and the
  ad-hoc words (`not_ready`, `preparing`, `absent`, `updating`) at the protocol
  edge (`jobs.ts:11-26`, `project-service.ts:2206-2210`, `source-events.ts:178`,
  model status, skill status). Catalog columns keep their existing strings, and
  the mapping happens at the edge, so the catalog stays at format 29.
- **Every async result** carries `WorkState` plus `jobId`.
- **`job.get`, `job.retry` and `job.cancel`** own polling and recovery. Probe P3 found every per-item
  `*.retry` caller receives a `jobId`, so all ten are removed (index, transcript,
  transcript.render, cursor.render, preview, audio, frame, waveform, spectrogram,
  export).
- **Cancels** return the item's status record.

**Seam.** `packages/protocol/src/work.ts` (`WorkState`) plus one mapping function
per stored vocabulary.

**Run or see.** `yap transcript.transcribe ... --wait`, then `yap job.get`: the same
state words appear everywhere.

**Verify.**
- A schema scan finds no state enum outside `WorkState`.
- For each deleted `*.retry`, a test shows the same recovery working through
  `job.retry`.
- Update the CLI's `--wait` logic, the app decoders, and the `skills/yap` text that
  names states or retry operations.

**Firewall.** No catalog column changes.

**Delegated.** The exact state words. They must cover every current state, with
no synonyms.

