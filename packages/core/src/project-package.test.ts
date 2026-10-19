import { createHash } from "node:crypto";
import { archiveLimits, projectJsonBytes } from "./package-archive.js";
import {
  projectPackageManifest,
  validateProjectPackage,
  resourceMetadataMember,
  parseProjectPackageManifest,
} from "./project-package.js";
import type { ProjectSnapshot } from "./projects.js";

import { test, expect } from "vitest";
import {
  collectPortableResources,
  resourceIdentity,
  resourceMembers,
  staleTranscriptIssues,
  type PortableResource,
} from "./project-package.js";

test("portable inventory follows generated reference chains and rejects missing dependencies within a bound", () => {
  const records = new Map([
    ["speech", { asset: { id: "speech" }, dependencies: ["reference"] }],
    ["reference", { asset: { id: "reference" }, dependencies: ["original"] }],
    ["original", { asset: { id: "original" }, dependencies: [] }],
  ]);
  const read = ({ id }: { id: string }): PortableResource => {
    const value = records.get(id);
    if (!value) throw new Error("missing reference");
    return {
      kind: "asset",
      asset: {
        ...value.asset,
        bytes: 0,
        fileName: id,
        createdAt: "fixture",
        originUs: 0,
        streams: [],
      },
      origins: [],
      dependencies: value.dependencies.map((id) => ({ kind: "asset", id })),
    };
  };
  const roots = (...ids: string[]) => ids.map((id) => ({ kind: "asset" as const, id }));
  expect(
    collectPortableResources(roots("speech", "original"), read).map(
      (item) => resourceIdentity(item).id,
    ),
  ).toEqual(["original", "reference", "speech"]);
  expect(() => collectPortableResources(roots("speech"), read, 2)).toThrow(/limit/);
  records.delete("reference");
  expect(() => collectPortableResources(roots("speech"), read)).toThrow("missing reference");
});

function snapshotFixture(): ProjectSnapshot {
  return {
    project: { id: "donor", title: "Editable", createdAt: "now", currentRevisionId: "r0" },
    revisions: [
      {
        id: "r0",
        projectId: "donor",
        ordinal: 0,
        createdAt: "now",
        operation: "create",
        document: {
          canvas: {
            width: 160,
            height: 96,
            fps: { numerator: 30, denominator: 1 },
            background: "#000000ff",
          },
          tracks: [],
          groups: [],
          clips: [],
          syncGroups: [],
          processing: [],
        },
      },
    ],
    undo: [],
    references: [],
  };
}

test("portable manifest validates complete history bytes, undo targets, paths and declared media closure", () => {
  const snapshot = snapshotFixture();
  const text = JSON.stringify(snapshot.revisions[0]);
  const path = "revisions/0.json";
  const revisions = new Map([[path, text]]);
  const manifest = projectPackageManifest(
    snapshot,
    [],
    [
      {
        path,
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  );
  const validate = (value: unknown, entries = revisions) =>
    validateProjectPackage(JSON.stringify(value), entries, archiveLimits);
  expect(validate(manifest).snapshot).toEqual(snapshot);
  const second = {
    ...snapshot.revisions[0]!,
    id: "r1",
    ordinal: 1,
    operation: "apply" as const,
  };
  const secondText = JSON.stringify(second);
  const two = {
    ...snapshot,
    project: { ...snapshot.project, currentRevisionId: "r1" },
    revisions: [...snapshot.revisions, second],
  };
  const twoInventory = [
    ...manifest.inventory,
    {
      path: "revisions/1.json",
      bytes: Buffer.byteLength(secondText),
      sha256: createHash("sha256").update(secondText).digest("hex"),
    },
  ];
  expect(
    validateProjectPackage(
      JSON.stringify(projectPackageManifest(two, [], twoInventory)),
      new Map([...revisions, ["revisions/1.json", secondText]]),
      { ...archiveLimits, revisionBytes: 1 },
    ).snapshot,
  ).toEqual(two);
  expect(() =>
    validate(manifest, new Map([[path, text.replace("Editable", "Changed") + " "]])),
  ).toThrow(/hash or size/);
  expect(() => validate({ ...manifest, undo: ["missing"] })).toThrow(/undo target/);
  expect(() =>
    validate({
      ...manifest,
      inventory: [...manifest.inventory, { ...manifest.inventory[0], path: "../outside" }],
    }),
  ).toThrow(/inventory member/);
  expect(() =>
    validate({
      ...manifest,
      inventory: [...manifest.inventory, { ...manifest.inventory[0], path: "unreferenced.json" }],
    }),
  ).toThrow(/Unreferenced/);
  expect(() =>
    validateProjectPackage(JSON.stringify(manifest), revisions, {
      ...archiveLimits,
      expandedBytes: 1,
    }),
  ).toThrow(/byte limit/);
});

test("inventory-bound asset metadata is mandatory, exact and validated before closure", () => {
  const snapshot = snapshotFixture();
  const resource: Extract<PortableResource, { kind: "asset" }> = {
    kind: "asset",
    asset: {
      id: "a".repeat(64),
      bytes: 1,
      fileName: "a".repeat(64) + ".mov",
      createdAt: "now",
      originUs: 100001,
      streams: [
        {
          id: "audio:0",
          kind: "audio",
          codec: "pcm",
          decodable: true,
          startUs: 0,
          endUs: 30,
          channels: 1,
          sampleRate: 48000,
          segments: [
            { startUs: 0, endUs: 10, empty: true },
            { startUs: 10, endUs: 30, empty: false, mediaStartUs: 0, mediaDurationUs: 20 },
          ],
        },
      ],
    },
    origins: [],
    dependencies: [],
  };
  snapshot.references = [
    { revisionId: "r0", resources: [{ kind: "asset", id: resource.asset.id }] },
  ];
  const revision = JSON.stringify(snapshot.revisions[0]);
  const revisions = new Map([["revisions/0.json", revision]]);
  const member = resourceMetadataMember(resource);
  const manifest = projectPackageManifest(
    snapshot,
    [resource],
    [
      {
        path: "revisions/0.json",
        bytes: Buffer.byteLength(revision),
        sha256: createHash("sha256").update(revision).digest("hex"),
      },
      {
        path: `assets/${resource.asset.fileName}`,
        bytes: resource.asset.bytes,
        sha256: resource.asset.id,
      },
      member.reference.metadata,
    ],
  );
  const read = (
    metadata = new Map([[member.reference.metadata.path, member.body]]),
    value = manifest,
  ) => validateProjectPackage(JSON.stringify(value), revisions, archiveLimits, metadata);
  expect(read().resources).toEqual([resource]);
  expect(() => read(new Map())).toThrow(/metadata member hash or size/);
  expect(() => read(new Map([[member.reference.metadata.path, member.body + " "]]))).toThrow(
    /metadata member hash or size/,
  );
  expect(() =>
    read(
      new Map([
        [member.reference.metadata.path, member.body],
        ["extra", "{}"],
      ]),
    ),
  ).toThrow(/Unexpected resource metadata/);
  for (const version of [1, 2, 3])
    expect(() => read(undefined, { ...manifest, version } as never)).toThrow(/project.*version/);
  const duplicate = structuredClone(resource);
  duplicate.asset.streams.push({ ...duplicate.asset.streams[0]!, segments: [] });
  const duplicateMember = resourceMetadataMember(duplicate);
  const duplicateManifest = {
    ...manifest,
    resources: [duplicateMember.reference],
    inventory: manifest.inventory.map((entry) =>
      entry.path === member.reference.metadata.path ? duplicateMember.reference.metadata : entry,
    ),
  };
  expect(() =>
    read(new Map([[member.reference.metadata.path, duplicateMember.body]]), duplicateManifest),
  ).toThrow(/schema/);
  const substituted = JSON.stringify({
    ...resource,
    asset: { ...resource.asset, id: "b".repeat(64), fileName: `${"b".repeat(64)}.wav` },
  });
  const substitutedRef = {
    ...member.reference.metadata,
    bytes: Buffer.byteLength(substituted),
    sha256: createHash("sha256").update(substituted).digest("hex"),
  };
  expect(() =>
    read(new Map([[substitutedRef.path, substituted]]), {
      ...manifest,
      resources: [{ ...member.reference, metadata: substitutedRef }],
      inventory: manifest.inventory.map((entry) =>
        entry.path === substitutedRef.path ? substitutedRef : entry,
      ),
    }),
  ).toThrow(/identity/);
  const oversized = { ...member.reference.metadata, bytes: projectJsonBytes + 1 };
  const tooLarge = {
    ...manifest,
    resources: [{ ...member.reference, metadata: oversized }],
    inventory: manifest.inventory.map((entry) =>
      entry.path === oversized.path ? oversized : entry,
    ),
  };
  expect(() => parseProjectPackageManifest(JSON.stringify(tooLarge), archiveLimits)).toThrow(
    expect.objectContaining({
      code: "LIMIT_EXCEEDED",
      details: {
        aggregateJsonBytes: projectJsonBytes + 1 + Buffer.byteLength(revision),
        maximumJsonBytes: projectJsonBytes,
      },
    }),
  );
});

test("HDR package receipts bind the selected source to the retained original metadata", () => {
  const sourceId = "a".repeat(64),
    outputId = "b".repeat(64),
    digest = "c".repeat(64);
  const asset = (id: string, codec: string) => ({
    id,
    bytes: 1,
    fileName: id + ".mov",
    createdAt: "controlled",
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "video" as const,
        codec,
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        width: 160,
        height: 96,
        orientedWidth: 160,
        orientedHeight: 96,
        hasAlpha: false,
        segments: [
          { startUs: 0, endUs: 1000000, empty: false, mediaStartUs: 0, mediaDurationUs: 1000000 },
        ],
        samples: {
          count: 24,
          firstPtsUs: 0,
          lastPtsUs: 958333,
          minDurationUs: 41667,
          maxDurationUs: 41667,
        },
      },
      {
        id: "track:2",
        kind: "audio" as const,
        codec: "aac ",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        sampleRate: 48000,
        channels: 2,
        segments: [
          {
            startUs: 0,
            endUs: 1000000,
            empty: false,
            mediaStartUs: { numerator: 64000, denominator: 3 },
            mediaDurationUs: 1000000,
          },
        ],
      },
    ],
  });
  const snapshot = snapshotFixture();
  snapshot.references = [{ revisionId: "r0", resources: [{ kind: "asset", id: outputId }] }];
  const revision = JSON.stringify(snapshot.revisions[0]);
  const read = (sourceStreamId = "track:1", changedAsset?: 0 | 1, changedStream: 0 | 1 = 0) => {
    const records: PortableResource[] = [
      {
        kind: "asset",
        asset: asset(sourceId, "hvc1"),
        origins: [{ kind: "import" }],
        dependencies: [],
      },
      {
        kind: "asset",
        asset: asset(outputId, "ap4h"),
        dependencies: [{ kind: "asset", id: sourceId }],
        origins: [
          {
            kind: "hdr-conversion",
            recipe: "hdr-to-sdr-hable-1000nit-v1",
            family: "hlg",
            implementation: {
              implementationId: "controlled-hdr-v1",
              receiptSha256: digest,
              nativeExecutableSha256: digest,
              ffmpegSha256: digest,
              ffprobeSha256: digest,
            },
            source: {
              assetId: sourceId,
              originUs: 0,
              factsSha256: digest,
              video: {
                streamId: sourceStreamId,
                startUs: 0,
                endUs: 1000000,
                mediaStartUs: 0,
                mediaDurationUs: 1000000,
                samples: 24,
                presentedTimingSha256: digest,
              },
              audio: {
                streamId: "track:2",
                startUs: 0,
                endUs: 1000000,
                mediaStartUs: { numerator: 64000, denominator: 3 },
                mediaDurationUs: 1000000,
                frames: 48000,
                sampleRate: 48000,
                channels: 2,
                pcmSha256: digest,
              },
            },
            output: {
              originUs: 0,
              factsSha256: digest,
              video: {
                streamId: "track:1",
                startUs: 0,
                endUs: 1000000,
                mediaStartUs: 0,
                mediaDurationUs: 1000000,
                samples: 24,
                presentedTimingSha256: digest,
              },
              audio: {
                streamId: "track:2",
                startUs: 0,
                endUs: 1000000,
                mediaStartUs: { numerator: 64000, denominator: 3 },
                mediaDurationUs: 1000000,
                frames: 48000,
                sampleRate: 48000,
                channels: 2,
                pcmSha256: digest,
              },
            },
            clock: {
              sourceClockAtDerivativeZeroUs: 0,
              movieTimescale: 48000,
              sourceSupport: { startUs: 0, endUs: 1000000 },
            },
          },
        ],
      },
    ];
    if (changedAsset !== undefined) {
      const record = records[changedAsset]!;
      if (record.kind !== "asset") throw Error("controlled asset required");
      record.asset.streams[changedStream]!.segments![0]!.endUs = 500000;
      record.asset.streams[changedStream]!.segments![0]!.mediaDurationUs = 500000;
    }
    const members = records.map(resourceMetadataMember);
    const manifest = projectPackageManifest(snapshot, records, [
      {
        path: "revisions/0.json",
        bytes: Buffer.byteLength(revision),
        sha256: createHash("sha256").update(revision).digest("hex"),
      },
      ...records.flatMap((record) =>
        record.kind === "asset"
          ? [
              {
                path: `assets/${record.asset.fileName}`,
                bytes: record.asset.bytes,
                sha256: record.asset.id,
              },
            ]
          : [],
      ),
      ...members.map((member) => member.reference.metadata),
    ]);
    return validateProjectPackage(
      JSON.stringify(manifest),
      new Map([["revisions/0.json", revision]]),
      archiveLimits,
      new Map(members.map((member) => [member.reference.metadata.path, member.body])),
    );
  };
  expect(read().resources.map((resource) => resourceIdentity(resource).id)).toEqual([
    sourceId,
    outputId,
  ]);
  expect(() => read("track:9")).toThrowError(expect.objectContaining({ code: "INVALID_PACKAGE" }));
  for (const changedAsset of [0, 1] as const)
    for (const changedStream of [0, 1] as const)
      expect(() => read("track:1", changedAsset, changedStream)).toThrowError(
        expect.objectContaining({ code: "INVALID_PACKAGE" }),
      );
});

test("an imported package drops a stale transcript no revision pins and keeps one a revision pins", () => {
  const assetId = "a".repeat(64);
  const asset: Extract<PortableResource, { kind: "asset" }> = {
    kind: "asset",
    asset: {
      id: assetId,
      bytes: 1,
      fileName: assetId + ".wav",
      createdAt: "now",
      originUs: 0,
      streams: [
        {
          id: "audio",
          kind: "audio",
          codec: "pcm",
          decodable: true,
          startUs: 0,
          endUs: 1000,
          channels: 1,
          sampleRate: 48000,
          segments: [
            { startUs: 0, endUs: 1000, empty: false, mediaStartUs: 0, mediaDurationUs: 1000 },
          ],
        },
      ],
    },
    origins: [],
    dependencies: [],
  };
  const transcript = (
    generation: string,
    recipe: string,
  ): Extract<PortableResource, { kind: "transcript-generation" }> => ({
    kind: "transcript-generation",
    metadata: {
      owner: { kind: "asset", id: assetId },
      sourceId: assetId,
      generation,
      source: { kind: "asset", streamId: "audio", supportDigest: "d".repeat(64), durationUs: 1000 },
      engine: {
        runtime: "FluidAudio",
        runtimeVersion: "0.15.7",
        runtimeRevision: "r",
        decoder: "parakeet-tdt-batch",
        model: "m",
        modelRevision: "r",
        modelDigest: "e".repeat(64),
        encoderPrecision: "int8",
        computeUnits: "cpu",
        policy: "transcript-v3",
        kindPolicy: "word-kind-v1",
      },
      execution: { executionRange: null, context: { beforeUs: 0, afterUs: 0 }, recipe },
      available: [],
      track: { streamId: "audio", sourceOffsetUs: 0 },
      segmentCount: 0,
      wordCount: 0,
      gapCount: 0,
      maxWordUs: 0,
      raw: { bytes: 1, sha256: "f".repeat(64) },
    },
    available: [],
    publication: null,
    receipt: { bytes: 1, sha256: "f".repeat(64) },
  });
  const foreign = "source-windows-foreign-v0";
  const dropped = transcript("00000000-0000-4000-8000-000000000001", foreign),
    pinned = transcript("00000000-0000-4000-8000-000000000002", foreign);
  asset.dependencies = [dropped, pinned].map((value) => resourceIdentity(value));
  const snapshot = snapshotFixture();
  snapshot.references = [
    {
      revisionId: "r0",
      resources: [{ kind: "asset", id: assetId }, resourceIdentity(pinned)],
    },
  ];
  const revision = JSON.stringify(snapshot.revisions[0]);
  const resources = [asset, dropped, pinned];
  const members = resources.map(resourceMetadataMember);
  const manifest = projectPackageManifest(snapshot, resources, [
    {
      path: "revisions/0.json",
      bytes: Buffer.byteLength(revision),
      sha256: createHash("sha256").update(revision).digest("hex"),
    },
    ...resources.flatMap(resourceMembers),
    ...members.map((member) => member.reference.metadata),
  ] as ReturnType<typeof projectPackageManifest>["inventory"]);
  const validated = validateProjectPackage(
    JSON.stringify(manifest),
    new Map([["revisions/0.json", revision]]),
    archiveLimits,
    new Map(members.map((member) => [member.reference.metadata.path, member.body])),
  );
  expect(validated.resources.map((resource) => resourceIdentity(resource).id).sort()).toEqual(
    [assetId, resourceIdentity(pinned).id].sort(),
  );
  expect(validated.resources.find((resource) => resource.kind === "asset")).toMatchObject({
    dependencies: [resourceIdentity(pinned)],
  });
  expect(validated.stale).toEqual([resourceIdentity(dropped)]);
  // The recipient is told what was left out, so it knows to regenerate it.
  expect(staleTranscriptIssues(validated.stale)).toEqual([
    {
      code: "derived-stale-skipped",
      message: "A transcript from an older recipe was left out; the recipient regenerates it",
      evidence: { kind: "transcript-generation", id: resourceIdentity(dropped).id },
    },
  ]);
});
