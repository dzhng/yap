import Darwin
import Foundation
import YapAudio
import YapMedia
import YapSpeech

/// The core selects the source stream and resolves the pinned model files and the attempt's output
/// path before calling this worker. Everything the request names is checked before a model loads.
enum SpeechOperation {
    private struct Request: Codable {
        let models: SpeechModelFiles
        let track: AudioSourceSelection
        let output: String
        let execution: SpeechExecution
    }

    static func transcribe(_ params: [String: Any]) async throws -> SpeechTranscript {
        // A role is not a source selector, including an explicitly null role.
        guard (params["track"] as? [String: Any])?["role"] == nil else {
            throw NativeFailure("INVALID_REQUEST", "Speech source selection does not accept a role.")
        }
        let request = try WireRequest.decode(Request.self, from: params)
        try WireRequest.requireAbsolute(request.models.directory, request.track.source, request.output)
        return try await divertingStandardOutput {
            try await SourceTranscript.write(
                models: request.models, track: request.track, output: request.output, execution: request.execution)
        }
    }

    /// Standard output is this worker's response channel, but Core ML's runtime prints diagnostics
    /// to C `stdout`, buffered until exit, which would land beside the response. While the engine
    /// lives, descriptor 1 names standard error; buffered text is flushed there before the channel
    /// is restored. The operation takes no inherited descriptors, and the worker serves one request
    /// at a time, so the temporary duplicate cannot be mistaken for one.
    private static func divertingStandardOutput<Value>(_ work: () async throws -> Value)
        async throws -> Value
    {
        fflush(stdout)
        let channel = fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 0)
        guard channel >= 0, dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 else {
            if channel >= 0 { close(channel) }
            throw NativeFailure(
                "TRANSCRIPTION_FAILED", "Cannot protect the response channel.")
        }
        defer {
            fflush(stdout)
            dup2(channel, STDOUT_FILENO)
            close(channel)
        }
        return try await work()
    }
}
