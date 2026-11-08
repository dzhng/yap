import Foundation
import YapAudio
import YapCapture
import YapFrames
import YapMedia

public enum NativeWire {
    /// One registered operation. `unexpected` states what a failure this boundary does not
    /// recognise means for that operation; the service assigns retryability from the code.
    private struct Operation: Sendable {
        let run: @Sendable ([String: Any]) async throws -> Any
        let unexpected: @Sendable (Error) -> NativeFailure
        var details: @Sendable () -> [String: Any] = { [:] }
    }

    private static let operations: [String: Operation] = {
        func media(_ run: @escaping @Sendable ([String: Any]) async throws -> Any) -> Operation {
            Operation(run: run, unexpected: { .decodeFailed($0.localizedDescription) })
        }
        func deletion(_ run: @escaping @Sendable ([String: Any]) throws -> Any) -> Operation {
            Operation(
                run: run,
                unexpected: { NativeFailure(
                    "DELETE_FAILED", $0.localizedDescription) })
        }
        var table: [String: Operation] = [
            "system.ping": Operation(
                run: { params in
                    try WireRequest.requireEmpty(params)
                    return ["platform": "macos"]
                }, unexpected: { NativeFailure("INVALID_REQUEST", $0.localizedDescription) }),
            "media.audioCapabilities": media { params in
                try WireRequest.requireEmpty(params)
                return ["rnnoise": CompositionAudio.rnnoiseImplementation, "retime": CompositionAudio.retimeImplementation, "statePreparation": CompositionAudio.statePreparationImplementation]
            },
            "media.sourceChannelCapabilities": media { params in
                try WireRequest.requireEmpty(params)
                return ["recipe": SourceChannelPCM.recipe, "providerVersion": SourceChannelPCM.providerVersion]
            },
            "media.pictureCapabilities": media { params in
                try WireRequest.requireEmpty(params)
                var capabilities: [String: String] = [:]
                capabilities["sdrCorrection"] = SDRCorrection.implementationId
                capabilities["lut"] = LUTColor.implementationId
                return capabilities
            },
            "media.outputCapabilities": media { params in
                try WireRequest.requireEmpty(params)
                return try OutputSettings.inventory()
            },
            "media.probe": media { try json(await ProbeOperation.execute($0)) },
            "media.presentationEvidence": media {
                try json(await PresentationEvidenceOperation.execute($0))
            },
            "media.renderCompositionFrame": media { try json(await CompositionFrameOperation.execute($0)) },
            "media.renderCompositionVideo": media { try json(await CompositionVideoOperation.execute($0)) },
            "media.renderCompositionMovie": media { try json(await CompositionMovieOperation.execute($0)) },
            "media.validateCompositionAudio": media { try await CompositionAudioOperation.validate($0) },
            "media.prepareCompositionAudioDomain": media { try json(await CompositionAudioOperation.prepare($0)) },
            "media.mixCompositionAudio": media { try json(await CompositionAudioOperation.execute($0)) },
            "media.validateAudioOutput": media { try json(AudioFileOperation.validate($0)) },
            "media.encodeAudioFile": media { try json(await AudioFileOperation.execute($0)) },
            "media.sourceVisualSamples": media { try json(await SourceVisualSamplesOperation.execute($0)) },
            "media.acousticImage": media { try json(AcousticImageOperation.execute($0)) },
            "media.sourceImage": media { try json(SourceImageOperation.execute($0)) },
            "media.sourceFrame": media { try json(await SourceFrameOperation.execute($0)) },
            "media.convertSelectedAudio": media { try json(await SelectedAudioConversionOperation.execute($0)) },
            "media.sourceChannelPCM": media { try json(await SourceChannelPCMOperation.execute($0)) },
            "speech.correspond": media { try json(CorrespondenceOperation.execute($0)) },
            "media.sourceAudio": media { try json(await SourceAudioOperation.execute($0)) },
            "media.recover": media { params in
                let request = try WireRequest.decode(RecoveryRequest.self, from: params)
                guard !request.directory.isEmpty else {
                    throw NativeFailure(
                        "INVALID_REQUEST", "media.recover requires a source directory.")
                }
                do {
                    return try json(RecoveryReceipt(await MediaRecovery.recover(directory: request.directory, sourceAuthority: request.sourceAuthority)))
                } catch is CancellationError { throw CancellationError() }
                catch {
                    // Preserve the specific cause; the ledger owns its retry verdict.
                    let failure = CaptureFinalizationError(error)
                    throw NativeFailure(failure.code,
                        failure.message)
                }
            },
            "media.cleanupCapture": Operation(
                run: { params in
                    let request = try WireRequest.decode(CaptureCleanupRequest.self, from: params)
                    try WireRequest.requireAbsolute(request.directory)
                    do {
                        return try json(await CaptureAudioPublication.cleanupPublished(
                            directory: request.directory, sourceID: request.sourceId))
                    } catch is CancellationError { throw CancellationError() }
                    catch let error as NativeFailure { throw error }
                    catch let error as CaptureFailure {
                        throw NativeFailure(error.code, error.message)
                    } catch {
                        if CaptureFinalizationError.isOperationalRead(error) {
                            throw NativeFailure("CLEANUP_UNAVAILABLE", error.localizedDescription)
                        }
                        throw error
                    }
                }, unexpected: { _ in NativeFailure("CLEANUP_FAILED", "Cannot verify publication cleanup.") }),
            "media.sourceEvidence": Operation(
                run: { params in
                    let request = try WireRequest.decode(SourceEvidenceRequest.self, from: params)
                    try WireRequest.requireAbsolute(request.directory, request.output)
                    do {
                        return try json(
                            await SourceEvidenceExport.write(directory: request.directory, output: request.output, canonical: request.canonical, sourceAuthority: request.sourceAuthority))
                    } catch let failure as NativeFailure { throw failure }
                    catch let failure as CaptureFailure {
                        throw NativeFailure(failure.code, failure.message)
                    } catch {
                        if CaptureFinalizationError.isOperationalRead(error) {
                            throw NativeFailure("MEDIA_UNAVAILABLE", error.localizedDescription)
                        }
                        throw error
                    }
                },
                unexpected: { _ in NativeFailure(
                    "EVIDENCE_FAILED", "Cannot export source evidence.") }),
            "speech.transcribe": Operation(
                run: { try json(await SpeechOperation.transcribe($0)) },
                unexpected: { NativeFailure(
                    "TRANSCRIPTION_FAILED", $0.localizedDescription) }),
            "storage.recordingDirectory": deletion { try ManagedFiles.recordingDirectory($0) },
            "storage.externalDirectory": deletion { try ManagedFiles.externalDirectory($0) },
            "storage.clearRenderWorkspace": deletion {
                try RenderWorkspace.clear($0)
                return ["removed": true]
            },
        ]
        for name in ["storage.removeRecordingDirectory", "storage.removeCacheFiles"] {
            table[name] = deletion {
                try ManagedFiles.execute(name, $0)
                return ["removed": true]
            }
        }
        for name in PublicationOperation.operations {
            table[name] = Operation(
                run: { try PublicationOperation.execute(name, $0) },
                unexpected: { NativeFailure("INVALID_STORAGE", $0.localizedDescription) })
        }
        for name in PackageWorkspace.operations {
            table[name] = Operation(
                run: { try PackageWorkspace.execute(name, $0) },
                unexpected: { NativeFailure("INVALID_STORAGE", $0.localizedDescription) })
        }
        for name in ArchiveOperation.operations {
            table[name] = Operation(
                run: { try ArchiveOperation.execute(name, $0) },
                unexpected: { NativeFailure("INVALID_PACKAGE", $0.localizedDescription) },
                details: { ["peakResidentBytes": ProcessResources.peakResidentBytes()] })
        }
        return table
    }()

    public static func respond(to line: String) async -> Data {
        let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
        let id = request?["id"] as? String
        let response: [String: Any]
        if let request, let id, !id.isEmpty,
            Set(request.keys) == ["id", "operation", "params"],
            let name = request["operation"] as? String, !name.isEmpty,
            let params = request["params"] as? [String: Any]
        {
            if let operation = operations[name] {
                do {
                    response = ["id": id, "ok": true, "data": try await operation.run(params)]
                } catch is CancellationError {
                    response = failed(id: id, NativeFailure("CANCELED", "Operation canceled."),
                        details: operation.details())
                } catch {
                    // Unclassified capture failures are final. Operation owners translate
                    // their known operational errors before reaching this fallback.
                    let failure =
                        error as? NativeFailure
                        ?? (error as? CaptureFailure).map { NativeFailure($0.code, $0.message) }
                        ?? operation.unexpected(error)
                    response = failed(id: id, failure, details: operation.details())
                }
            } else {
                response = failed(
                    id: id, NativeFailure("UNKNOWN_OPERATION", "Unknown native operation: \(name)"))
            }
        } else {
            response = failed(
                id: id, NativeFailure(
                    "INVALID_REQUEST", "Expected id, operation, and object params."))
        }
        // Every response is composed only of JSON primitives.
        return try! JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    }

    private static func failed(id: String?, _ failure: NativeFailure, details: [String: Any] = [:])
        -> [String: Any]
    {
        [
            "id": id as Any? ?? NSNull(), "ok": false,
            "error": [
                "code": failure.code, "message": failure.message,
                "details": details.merging(failure.details) { current, _ in current },
            ],
        ]
    }

    private static func json(_ value: some Encodable) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private struct RecoveryRequest: Codable {
        let directory: String
        let sourceAuthority: CaptureRecoveryAuthority?
    }

    private struct CaptureCleanupRequest: Codable {
        let directory: String
        let sourceId: String
    }
    private struct SourceEvidenceRequest: Codable {
        let directory: String
        let output: String
        let canonical: [String: String]?
        let sourceAuthority: CaptureSourceAuthorityExpectation?
    }
}
