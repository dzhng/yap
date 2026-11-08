import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/preview-visual");
const parity = join(root, ".agents/skills/compare-screenshots/scripts/visual-parity-diff.mjs");

test(
  "the preview project fixture preserves the full canvas in a captured window",
  { timeout: 180_000 },
  () => {
    const project = JSON.parse(readFileSync(join(fixture, "project.json"), "utf8"));
    assert.equal(project.document.canvas.width, 1920);
    assert.equal(project.document.canvas.height, 1080);
    assert.equal(project.evidence.maxLongEdge, 1920);
    const projectFrame = join(fixture, project.evidence.frame);
    accessSync(projectFrame, constants.R_OK);
    const scratch = mkdtempSync(join("/tmp", "yap-preview-visual-"));
    try {
      const evidence = join(scratch, "evidence");
      mkdirSync(evidence);
      execFileSync(
        "swift",
        [
          "run",
          "--build-system",
          "native",
          "--package-path",
          join(root, "helpers/mac"),
          "YapFrameTests",
          "--composition-project-downscale",
        ],
        {
          cwd: root,
          timeout: 120_000,
          stdio: "pipe",
          env: {
            ...process.env,
            YAP_COMPOSITION_SOURCE: projectFrame,
            YAP_FRAME_EVIDENCE: evidence,
          },
        },
      );
      const movie = join(scratch, "preview.mp4");
      const source = join(evidence, "preview-candidate.png");
      accessSync(source, constants.R_OK);
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-loop",
          "1",
          "-i",
          source,
          "-t",
          "1",
          "-r",
          "30",
          "-pix_fmt",
          "yuv420p",
          movie,
        ],
        { timeout: 30_000 },
      );

      const shot = join(scratch, "window.png");
      const executable = compileControlsCheck(
        scratch,
        ["PreviewController", "PreviewWindow"],
        String.raw`
import AppKit
import AVKit
@main struct Check {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let preview = PreviewWindow()
        preview.playLocalFile(title: "Fixture preview", file: CommandLine.arguments[1], mediaType: "video/mp4")
        guard let window = NSApp.windows.first(where: { $0.title == "Fixture preview" }),
              let player = window.contentView?.subviews.compactMap({ $0 as? AVPlayerView }).first else {
            preconditionFailure("The fixture preview window did not open")
        }
        window.orderFrontRegardless()
        NSApp.updateWindows()
        let deadline = Date().addingTimeInterval(2)
        while player.player?.currentItem?.status != .readyToPlay && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        guard player.player?.currentItem?.status == .readyToPlay else {
            preconditionFailure("The fixture preview did not become playable")
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        player.player?.pause()
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        guard let asset = player.player?.currentItem?.asset else {
            preconditionFailure("The fixture preview has no asset")
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        let image = try! generator.copyCGImage(at: .zero, actualTime: nil)
        let rendered = NSImageView(frame: player.frame)
        rendered.image = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        rendered.imageScaling = .scaleProportionallyUpOrDown
        window.contentView!.addSubview(rendered)
        window.contentView!.displayIfNeeded()
        // Capture at a fixed 2x backing scale, as the reference was, so the comparison does not
        // depend on whether this machine's display is Retina.
        let bounds = window.contentView!.bounds
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(bounds.width * 2),
            pixelsHigh: Int(bounds.height * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            preconditionFailure("Could not allocate the preview window capture")
        }
        bitmap.size = bounds.size
        window.contentView!.cacheDisplay(in: window.contentView!.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            preconditionFailure("Could not encode the preview window capture")
        }
        try! data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        preview.close()
        print("ok")
    }
}
`,
      );
      const output = execFileSync(executable, [movie, shot], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, YAP_FIXTURE_CONTROLS: "1" },
      });
      assert.equal(output.trim(), "ok");
      if (process.env.YAP_VISUAL_EVIDENCE) {
        mkdirSync(process.env.YAP_VISUAL_EVIDENCE, { recursive: true });
        copyFileSync(shot, join(process.env.YAP_VISUAL_EVIDENCE, "preview-window.png"));
      }

      const baseline = join(fixture, "window.png");
      if (process.env.UPDATE_VISUAL_BASELINE === "1") {
        copyFileSync(shot, baseline);
        return;
      }
      accessSync(baseline, constants.R_OK);
      const reference = join(scratch, "reference");
      const candidate = join(scratch, "candidate");
      const comparison = join(scratch, "comparison");
      mkdirSync(reference);
      mkdirSync(candidate);
      mkdirSync(comparison);
      copyFileSync(baseline, join(reference, "preview-window.png"));
      copyFileSync(shot, join(candidate, "preview-window.png"));
      execFileSync(process.execPath, [parity], {
        cwd: root,
        timeout: 30_000,
        stdio: "pipe",
        env: {
          ...process.env,
          REFERENCE_DIR: reference,
          CANDIDATE_DIR: candidate,
          OUT_DIR: comparison,
        },
      });
      const report = JSON.parse(readFileSync(join(comparison, "visual-parity-diff.json"), "utf8"));
      const result = report.results[0];
      assert.equal(result.dimensions.width, 1600);
      assert.equal(result.dimensions.height, 900);
      assert.ok(
        result.grayscale.pixelmatchRatio < 0.01,
        `preview window changed: ${JSON.stringify(result.grayscale)}`,
      );
      assert.ok(
        result.contentProxies.edgeDiffRatio32 < 0.02,
        `preview window edges changed: ${JSON.stringify(result.contentProxies)}`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
