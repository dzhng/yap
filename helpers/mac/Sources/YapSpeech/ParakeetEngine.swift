@preconcurrency import CoreML
import FluidAudio
import Foundation
import YapMedia

/// Which runtime and decoder produced a transcript. The worker runs exactly the configuration the
/// model gate evaluated: FluidAudio's batch TDT path for Parakeet v2 with the CLI's defaults.
public struct SpeechEngine: Codable, Sendable, Equatable {
    public let runtime: String
    public let runtimeVersion: String
    public let decoder: String
    public let encoderPrecision: String
    public let computeUnits: String
}

/// The evaluated Parakeet TDT 0.6B v2 engine, loaded only from verified local files.
final class ParakeetEngine {
    static let sampleRate = ASRConstants.sampleRate
    /// Samples below which FluidAudio refuses audio rather than transcribing it.
    static let minimumSamples = ASRConstants.minimumRequiredSamples(forSampleRate: sampleRate)
    static let identity = SpeechEngine(
        runtime: "FluidAudio", runtimeVersion: "0.15.7", decoder: "parakeet-tdt-batch",
        encoderPrecision: precision.rawValue,
        computeUnits: describe(AsrModels.defaultConfiguration().computeUnits))

    private static let version = AsrModelVersion.v2
    /// The CLI's default; for v2 it names the repository's only encoder.
    private static let precision = ParakeetEncoderPrecision.int8
    private let manager: AsrManager

    private init(manager: AsrManager) { self.manager = manager }

    /// Refuses a model list FluidAudio could not load entirely from: it resolves its repository
    /// folder by name beside the directory it is given, so a differently named directory would
    /// make it read files nobody verified.
    static func checkList(_ models: SpeechModelFiles) throws {
        try models.checkShape()
        guard URL(fileURLWithPath: models.directory).lastPathComponent == Repo.parakeetV2.folderName
        else {
            throw NativeFailure(
                "INVALID_REQUEST", "The model directory must be named \(Repo.parakeetV2.folderName).")
        }
        let listed = Set(models.files.map(\.path))
        let required =
            ModelNames.ASR.requiredModels.map { $0 + "/coremldata.bin" } + [ModelNames.ASR.vocabularyFile]
        if let absent = required.sorted().first(where: { !listed.contains($0) }) {
            throw NativeFailure("INVALID_REQUEST", "The model list does not pin \(absent).")
        }
    }

    /// Loads from a directory the caller has already verified. Offline mode is set first, so a file
    /// that fails to load is reported rather than purged and downloaded again.
    static func load(_ models: SpeechModelFiles) async throws -> ParakeetEngine {
        ModelHub.offlineMode = true
        do {
            let loaded = try await AsrModels.load(
                from: URL(fileURLWithPath: models.directory, isDirectory: true), version: version,
                encoderPrecision: precision)
            let manager = AsrManager(
                config: ASRConfig(
                    tdtConfig: TdtConfig(blankId: version.blankId),
                    encoderHiddenSize: version.encoderHiddenSize))
            try await manager.loadModels(loaded)
            return ParakeetEngine(manager: manager)
        } catch {
            throw NativeFailure(
                "TRANSCRIPTION_FAILED", "Cannot load the speech model: \(error.localizedDescription)")
        }
    }

    /// Transcribes one contiguous 16 kHz mono interval with a fresh decoder state.
    func transcribe(_ samples: [Float]) async throws -> ASRResult {
        var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        do {
            return try await manager.transcribe(samples, decoderState: &state, language: nil)
        } catch {
            throw NativeFailure(
                "TRANSCRIPTION_FAILED", "Speech transcription failed: \(error.localizedDescription)")
        }
    }

    private static func describe(_ units: MLComputeUnits) -> String {
        switch units {
        case .cpuOnly: "cpuOnly"
        case .cpuAndGPU: "cpuAndGPU"
        case .cpuAndNeuralEngine: "cpuAndNeuralEngine"
        case .all: "all"
        @unknown default: "unknown"
        }
    }
}
