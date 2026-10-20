import CryptoKit
import Darwin
import Foundation
import YapMedia

/// One pinned bounded JSONL reader, checked against its receipt before and after consumption.
final class RetainedJSONLines {
    private let file: FileHandle
    private let initial: stat
    private let expectedBytes: Int
    private let expectedHash: String
    private let recordBytes: Int
    private var buffer = Data()
    private var offset = 0
    private var bytes = 0
    private var hash = SHA256()

    init(path: String, bytes: Int, sha256: String, recordBytes: Int) throws {
        guard path.hasPrefix("/"), !path.contains("\0"), bytes >= 0,
            sha256.count == 64, recordBytes > 0
        else { throw invalid("Invalid retained JSONL receipt.") }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw invalid("Cannot open retained JSONL file.") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size == bytes else {
            try? file.close()
            throw invalid("Retained JSONL size or file type changed.")
        }
        self.file = file
        self.initial = info
        self.expectedBytes = bytes
        self.expectedHash = sha256
        self.recordBytes = recordBytes
    }
    deinit { try? file.close() }
    func next() throws -> Data? {
        while true {
            try Task.checkCancellation()
            if let newline = buffer[offset...].firstIndex(of: 10) {
                let data = buffer.subdata(in: offset..<newline)
                offset = newline + 1
                guard !data.isEmpty, data.count < recordBytes else {
                    throw invalid("JSONL record exceeds its bound.")
                }
                return data
            }
            if offset > 0 {
                buffer.removeSubrange(0..<offset)
                offset = 0
            }
            guard buffer.count < recordBytes else {
                throw invalid("JSONL record exceeds its bound.")
            }
            let chunk = try file.read(upToCount: min(16_384, recordBytes - buffer.count)) ?? Data()
            if chunk.isEmpty {
                guard buffer.isEmpty else { throw invalid("Unterminated JSONL record.") }
                return nil
            }
            guard chunk.count <= expectedBytes - bytes else {
                throw invalid("JSONL file exceeds receipt.")
            }
            bytes += chunk.count
            hash.update(data: chunk)
            buffer.append(chunk)
        }
    }
    func finish() throws {
        guard bytes == expectedBytes,
            hash.finalize().map({ String(format: "%02x", $0) }).joined() == expectedHash
        else {
            throw invalid("Retained JSONL digest differs from receipt.")
        }
        var info = stat()
        guard fstat(file.fileDescriptor, &info) == 0, info.st_dev == initial.st_dev,
            info.st_ino == initial.st_ino, info.st_size == initial.st_size,
            info.st_mtimespec.tv_sec == initial.st_mtimespec.tv_sec,
            info.st_mtimespec.tv_nsec == initial.st_mtimespec.tv_nsec,
            info.st_ctimespec.tv_sec == initial.st_ctimespec.tv_sec,
            info.st_ctimespec.tv_nsec == initial.st_ctimespec.tv_nsec
        else {
            throw invalid("Retained JSONL changed while reading.")
        }
    }
    func rewind() throws {
        try file.seek(toOffset: 0)
        buffer.removeAll(keepingCapacity: true)
        offset = 0
        bytes = 0
        hash = SHA256()
    }
}
private func invalid(_ message: String) -> NativeFailure {
    NativeFailure("INVALID_REQUEST", message)
}
