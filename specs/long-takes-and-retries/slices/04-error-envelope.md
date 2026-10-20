# 04 — Error envelope

Depends on: 01 reviewed (H1).

## Contract

Every error that leaves the service, CLI, MCP adapter or Swift app has the same shape:

```json
{"code":"NOT_READY","message":"Not ready: recording … is still importing. Retry in 15 seconds.",
 "retryable":true,"retryAfterMs":15000,
 "details":{"retry":{"operation":"job.retry","params":{"jobId":"…"}}}}
```

- `retryable` and `retryAfterMs` come only from the ledger entry for `code`.
- `details.retry` is a valid request for an existing operation, or absent.
- A self-retry directive requires a retryable refusal. Explicit owner-supplied directives
  are retained regardless of retryability.

## Seam

- `packages/protocol/src/index.ts`: `operationErrorSchema` gains optional `retryAfterMs`
  (positive integer); a `retryDirectiveSchema = {operation, params}`; one constructor (extend
  `operationError`) that fills `retryable`/`retryAfterMs` from the ledger. `CatalogError` gains
  an optional retry directive.
- `refusal-ledger.json` entries gain optional `retryAfterMs` and `cause`;
  `refusal-ledger.ts` gains `refusalRetryAfterMs(code)` and `refusalCause(code)`.
- The resolving call is one rule in the service adapter (`apps/service/src/operation-errors.ts`):
  a retryable refused request names itself only when resending is safe (a read, or a write carrying a
  `requestId`); otherwise no directive. Job failures get theirs in slice 06.
- `packages/client/src/transport.ts:79` parses through the shared schema, so the new field
  survives. Hand-built envelopes (`apps/service/src/main.ts:52-60`, `apps/cli/src/main.ts:426`,
  `apps/cli/src/wait.ts:173,474`) go through the constructor.
- Swift app: `ServiceFailure` (`ServiceBundle.swift`) gains `retryAfterMs` and keeps
  `details`; `ServiceHost.swift:378-414` and `AppSocket.swift:163` pass both through.
- Skill scripts: `skills/yap/scripts/yap-cli.mjs:80-87` keeps `retryAfterMs`.

## Run or see

`yap job.get --params '{"jobId":"missing"}'` against a dev service in a temporary `YAP_HOME`
prints the envelope.

## Verification

- A ledger test that fails on any `retryable:` object literal in product source outside the
  constructor.
- Every `details.retry` produced in tests parses with its operation's own parameter schema.
- `packages/client/src/transport.test.ts` round-trips `retryAfterMs` and `details.retry`.
- `apps/macos/tests/app-socket.test.mjs` (or the nearest Swift transport test) keeps both.

## Delegated

Constructor naming; where the adapter rule reads "is this a read" (`readOnlyOperations` in
`operations.ts:1666` is the existing list).

## Stays green

Protocol, client, CLI tests; MCP result path.

## Implementation notes

Completed 2026-10-20. Ledger verdicts are unchanged; the ledger JSON diff only refreshes
source counts. Slice 05 owns adding actual delay/cause values, and slice 06 owns job
failure directives and stored retry bits.

The constructor remains `operationError`. Retry directives are checked against the existing
operation schema and keep the supplied parameters for exact replay. Socket and inherited
control adapters share `refusedRequest`, using `readOnlyOperations` for the read verdict;
an explicit owner-supplied directive takes precedence over the refused request.

Swift reads the ledger JSON only from its bundle's service resources. Source-compiled test
fixtures stage that resource beside the executable; a missing or unreadable bundled ledger
is a packaging failure, never a source-checkout lookup or an empty policy. `ServiceFailure`
owns serialization for both native transports. The source guard concerns refusal literals; work-status projections
and job retry bits remain with their later slices.

Focused evidence: protocol envelope/ledger tests, client socket round-trips, service adapter
and native-worker tests, CLI wait failures and real CLI/MCP refusal delivery, Swift socket
and control-channel tests, and consumer-helper envelope tests. Delay plumbing was also
removed temporarily in the client schema and Swift host to confirm the regressions fail.
The full repository run remains deferred to slice 13.
