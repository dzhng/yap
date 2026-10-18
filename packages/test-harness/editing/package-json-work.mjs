import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { fileIdentity, IdentifiedFiles, fileSubdirectory } from "../../core/dist/files.js";
import { archiveLimits, projectJsonBytes } from "../../core/dist/package-archive.js";
import {
  projectPackageManifest,
  resourceMetadataMember,
  resourceMembers,
  resourceIdentity,
  parseProjectPackageManifest,
} from "../../core/dist/project-package.js";
import { resolveProjectPackageMetadata } from "../../../apps/service/dist/project-package-metadata.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    read: { type: "boolean" },
    history: { type: "string" },
    project: { type: "string" },
    resources: { type: "string" },
    export: { type: "string" },
  },
});
assert.ok(values.out);
const out = values.read ? await realpath(resolve(values.out)) : resolve(values.out);
if (!values.read) {
  assert.ok(values.history && values.project && values.resources && values.export);
  await mkdir(out);
  await mkdir(join(out, "content"));
  const history = new DatabaseSync(join(resolve(values.history), "library/catalog.sqlite"), {
    readOnly: true,
  });
  const source = new DatabaseSync(join(resolve(values.resources), "library/catalog.sqlite"), {
    readOnly: true,
  });
  let snapshot, resources;
  try {
    const project = history
      .prepare("SELECT projectId,title,createdAt,currentRevisionId FROM projects WHERE projectId=?")
      .get(values.project);
    const revisions = history
      .prepare("SELECT content FROM project_revisions WHERE projectId=? ORDER BY ordinal")
      .all(values.project)
      .map((row) => JSON.parse(row.content));
    const undo = history
      .prepare("SELECT targetId FROM project_undo WHERE projectId=? ORDER BY position")
      .all(values.project)
      .map((row) => row.targetId);
    const references = revisions.map((revision) => ({
      revisionId: revision.revisionId,
      resources: history
        .prepare(
          "SELECT resourceKind AS kind,resourceId AS id FROM resource_references WHERE ownerKind='revision' AND ownerId=?",
        )
        .all(revision.revisionId),
    }));
    snapshot = { project, revisions, undo, references };
    const asset = JSON.parse(history.prepare("SELECT metadata FROM assets LIMIT 1").get().metadata);
    resources = [
      { kind: "asset", asset, origins: [], dependencies: [] },
      ...JSON.parse(
        source.prepare("SELECT snapshot FROM export_intents WHERE exportId=?").get(values.export)
          .snapshot,
      ).resources,
    ];
  } finally {
    history.close();
    source.close();
  }
  const inventory = [],
    admitted = [],
    memberPaths = new Set();
  let total = 0;
  async function text(path, body) {
    await mkdir(dirname(join(out, "content", path)), { recursive: true });
    const bytes = Buffer.byteLength(body);
    await writeFile(join(out, "content", path), body);
    inventory.push({ path, bytes, sha256: hash(body) });
    memberPaths.add(path);
    total += bytes;
    admitted.push({
      path: `content/${path}`,
      bytes,
      identity: fileIdentity(await stat(join(out, "content", path), { bigint: true })),
    });
  }
  for (const revision of snapshot.revisions)
    await text(`revisions/${revision.ordinal}.json`, JSON.stringify(revision));
  const template = resources.find(
    (resource) =>
      resource.kind === "asset" &&
      resource.asset.streams.some((stream) => (stream.segments?.length ?? 0) > 100000),
  );
  assert.ok(template);
  for (const resource of resources) {
    const member = resourceMetadataMember(resource);
    await text(member.reference.metadata.path, member.body);
  }
  const target = Math.floor(projectJsonBytes * 0.99);
  let index = 0;
  while (total < target - 2000) {
    const id = hash(`working-set-only-${index++}`);
    const make = (count) => ({
      kind: "asset",
      asset: {
        ...template.asset,
        id,
        fileName: `${id}.mov`,
        bytes: 1,
        streams: template.asset.streams.map((stream) => ({
          ...stream,
          segments: stream.segments?.slice(0, count),
        })),
      },
      origins: [],
      dependencies: [],
    });
    let low = 0,
      high = template.asset.streams[0].segments.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (resourceMetadataMember(make(mid)).reference.metadata.bytes <= target - total) low = mid;
      else high = mid - 1;
    }
    assert.ok(low > 0);
    const resource = make(low),
      member = resourceMetadataMember(resource);
    resources.push(resource);
    await text(member.reference.metadata.path, member.body);
  }
  for (const resource of resources)
    for (const member of resourceMembers(resource))
      if (!memberPaths.has(member.path)) {
        inventory.push({
          ...member,
          sha256: member.sha256 ?? hash(`working-set-only/${member.path}`),
        });
        memberPaths.add(member.path);
      }
  const roots = snapshot.references.at(-1).resources;
  for (const resource of resources) {
    const identity = resourceIdentity(resource);
    if (!roots.some((root) => root.kind === identity.kind && root.id === identity.id))
      roots.push(identity);
  }
  const manifest = projectPackageManifest(snapshot, resources, inventory);
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(out, "admitted.json"), JSON.stringify(admitted));
  await writeFile(
    join(out, "fixture.json"),
    JSON.stringify(
      {
        aggregateJsonBytes: total,
        maximumJsonBytes: projectJsonBytes,
        fraction: total / projectJsonBytes,
        historyRevisions: snapshot.revisions.length,
        currentClipCount: snapshot.revisions.at(-1).document.clips.length,
        scope:
          "Working-memory fixture: actual public history plus actual canonical resource metadata and repeated typed physical-row resources with synthetic identities. Not a native archive/media/publication proof.",
      },
      null,
      2,
    ),
  );
} else {
  const started = performance.now(),
    phases = [];
  const mark = (name) =>
    phases.push({
      name,
      seconds: (performance.now() - started) / 1000,
      rss: process.memoryUsage().rss,
      maxRSSKiB: process.resourceUsage().maxRSS,
    });
  const manifest = parseProjectPackageManifest(
    await readFile(join(out, "manifest.json"), "utf8"),
    archiveLimits,
  );
  const admitted = JSON.parse(await readFile(join(out, "admitted.json")));
  const files = new IdentifiedFiles(out, admitted);
  try {
    mark("compact envelope");
    const resolved = await resolveProjectPackageMetadata(
      { manifest, revisions: new Map(), files: fileSubdirectory(files, "content") },
      new AbortController().signal,
    );
    mark("complete descriptor hydration/schema/closure/history validation");
    assert.equal(resolved.snapshot.revisions.at(-1).document.clips.length, 10000);
    const report = {
      passed: true,
      phases,
      resources: resolved.resources.length,
      revisions: resolved.snapshot.revisions.length,
      maxRSSKiB: process.resourceUsage().maxRSS,
      within4GiB: process.resourceUsage().maxRSS < 4 * 1024 ** 2,
      scope:
        "Metadata hydration worker only; native canonical verification remains a separate public gate.",
    };
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    assert.equal(report.within4GiB, true);
  } finally {
    files.close();
  }
}
