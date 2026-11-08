import CryptoKit
import Darwin
import Foundation
import YapMedia

/// A completed staging hard link survives until its caller durably acknowledges the outcome.
/// Mutations inherit locked staging on fd 3 and destination on fd 4; usage only observes fd 3.
enum PublicationOperation {
    static let operations = [
        "publication.inspect", "publication.usage", "publication.absent", "publication.allocate", "publication.prepare",
        "publication.retire", "publication.discard", "publication.acknowledge",
        "publication.reconcile", "publication.commit",
    ]
    private static let privateFiles = ["swap", "payload", "receipt.pending", "prepared.json", "committed.json"]
    private struct FileEvidence: Codable, Equatable {
        let file: InodeIdentity
        let bytes: Int64
        let sha256: String
    }
    private struct Receipt: Codable {
        let stage: InodeIdentity
        let destination: InodeIdentity
        let file: InodeIdentity
        let leaf: String
        let bytes: Int64
        let sha256: String
        let replacement: FileEvidence?

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(stage, forKey: .stage)
            try values.encode(destination, forKey: .destination)
            try values.encode(file, forKey: .file)
            try values.encode(leaf, forKey: .leaf)
            try values.encode(bytes, forKey: .bytes)
            try values.encode(sha256, forKey: .sha256)
            try values.encode(replacement, forKey: .replacement)
        }
    }
    private static func failure(_ code: String, _ message: String) -> NativeFailure {
        NativeFailure(code, message)
    }
    private static func io(_ action: String) -> NativeFailure {
        NativeFailure(
            "PUBLICATION_IO", "\(action): \(String(cString: strerror(errno)))")
    }
    private static func info(_ fd: Int32, directory: Bool = false) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0 else { throw io("Inspect publication descriptor") }
        guard value.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) else {
            throw failure("INVALID_STORAGE", "Publication descriptor has the wrong file type.")
        }
        return value
    }
    private static func leaf(_ value: String) -> Bool {
        !value.isEmpty && value != "." && value != ".." && !value.contains("/")
            && !value.contains("\0") && value.utf8.count <= 255
    }
    private static func digest(_ fd: Int32, bytes: Int64, copyTo: Int32? = nil) throws -> String {
        let initial = try info(fd)
        guard initial.st_size == bytes else { throw failure("PUBLICATION_CHANGED", "Publication size changed.") }
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: 65_536, alignment: 8)
        defer { buffer.deallocate() }
        var hash = SHA256()
        var offset: Int64 = 0
        while offset < bytes {
            let n = pread(fd, buffer, Int(min(65_536, bytes - offset)), off_t(offset))
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw io("Read publication bytes") }
            let data = Data(bytes: buffer, count: n)
            hash.update(data: data)
            if let copyTo, !Descriptors.writeAll(copyTo, data) { throw io("Write publication file") }
            offset += Int64(n)
        }
        let final = try info(fd)
        guard final.st_size == initial.st_size,
            final.st_mtimespec.tv_sec == initial.st_mtimespec.tv_sec,
            final.st_mtimespec.tv_nsec == initial.st_mtimespec.tv_nsec,
            final.st_ctimespec.tv_sec == initial.st_ctimespec.tv_sec,
            final.st_ctimespec.tv_nsec == initial.st_ctimespec.tv_nsec else {
            throw failure("PUBLICATION_CHANGED", "Publication bytes changed while reading.")
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private static func readReceipt(_ name: String = "prepared.json") throws -> Receipt {
        let fd = openat(3, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw io("Open prepared receipt") }
        defer { close(fd) }
        let size = try info(fd).st_size
        guard size > 0 && size <= 4096 else { throw failure("INVALID_STORAGE", "Invalid prepared receipt size.") }
        var data = Data(count: Int(size))
        let n = data.withUnsafeMutableBytes { pread(fd, $0.baseAddress, $0.count, 0) }
        guard n == size else { throw io("Read prepared receipt") }
        guard let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any], fields["replacement"] != nil else {
            throw failure("INVALID_STORAGE", "Prepared receipt lacks destination selection.")
        }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard leaf(receipt.leaf), receipt.bytes >= 0, receipt.bytes <= 9_007_199_254_740_991,
            receipt.sha256.count == 64, receipt.sha256.allSatisfy({ $0.isHexDigit }),
            receipt.stage == InodeIdentity(try info(3, directory: true)),
            receipt.destination == InodeIdentity(try info(4, directory: true)) else {
            throw failure("PUBLICATION_CHANGED", "Prepared publication ownership changed.")
        }
        return receipt
    }
    private static func payload(_ receipt: Receipt) throws -> Int32 {
        let fd = openat(3, "payload", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw io("Open publication payload") }
        do {
            guard InodeIdentity(try info(fd)) == receipt.file,
                try digest(fd, bytes: receipt.bytes) == receipt.sha256 else {
                throw failure("PUBLICATION_CHANGED", "Prepared publication bytes changed.")
            }
            return fd
        } catch { close(fd); throw error }
    }
    private static func lockDestination(_ fd: Int32) throws {
        _ = try info(fd, directory: true)
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            throw NativeFailure("PUBLICATION_BUSY", "Another publisher holds this destination.")
        }
    }
    private static func evidence(_ parent: Int32, _ name: String) throws -> FileEvidence? {
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            if errno == ELOOP { throw failure("UNSUPPORTED_DESTINATION", "Publication never replaces a symlink.") }
            throw io("Open selected publication file")
        }
        defer { close(fd) }
        var value = stat()
        guard fstat(fd, &value) == 0 else { throw io("Inspect selected publication file") }
        guard value.st_mode & S_IFMT == S_IFREG, value.st_size >= 0, value.st_size <= 9_007_199_254_740_991 else {
            throw failure("UNSUPPORTED_DESTINATION", "Publication requires a regular destination file.")
        }
        return FileEvidence(file: InodeIdentity(value), bytes: value.st_size, sha256: try digest(fd, bytes: value.st_size))
    }
    private static func matches(_ parent: Int32, _ name: String, _ expected: FileEvidence) throws -> Bool {
        do { return try evidence(parent, name) == expected }
        catch let error as NativeFailure where error.code == "UNSUPPORTED_DESTINATION" || error.code == "PUBLICATION_CHANGED" { return false }
    }
    private static func exists(_ parent: Int32, _ name: String) throws -> Bool {
        var value = stat()
        if fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0 { return true }
        if errno == ENOENT { return false }
        throw io("Inspect publication evidence")
    }
    private static func confirm(_ receipt: Receipt) throws {
        if try receipt.replacement == nil || exists(3, "committed.json") { return }
        if linkat(3, "prepared.json", 3, "committed.json", 0) != 0 && errno != EEXIST {
            throw io("Retain confirmed replacement")
        }
    }
    private static func reconcile(_ receipt: Receipt) throws -> String {
        if let replacement = receipt.replacement {
            let new = FileEvidence(file: receipt.file, bytes: receipt.bytes, sha256: receipt.sha256)
            if try exists(3, "swap") {
                if try matches(3, "swap", new) { return try matches(4, receipt.leaf, replacement) ? "prepared" : "replaced" }
                guard try matches(3, "swap", replacement) else { return "conflicted" }
                return try matches(4, receipt.leaf, new) ? "committed" : "replaced"
            }
            if try exists(3, "committed.json") { return try matches(4, receipt.leaf, new) ? "committed" : "replaced" }
            if try matches(4, receipt.leaf, replacement) { return "prepared" }
            return try matches(4, receipt.leaf, new) ? "conflicted" : "replaced"
        }

        let fd = openat(4, receipt.leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return "missing" }
            if errno == ELOOP { return "replaced" }
            throw io("Open published destination")
        }
        defer { close(fd) }
        var value = stat()
        guard fstat(fd, &value) == 0 else { throw io("Inspect published destination") }
        guard value.st_mode & S_IFMT == S_IFREG, InodeIdentity(value) == receipt.file else { return "replaced" }
        guard value.st_size == receipt.bytes else { return "modified" }
        do { return try digest(fd, bytes: receipt.bytes) == receipt.sha256 ? "committed" : "modified" }
        catch let error as NativeFailure where error.code == "PUBLICATION_CHANGED" { return "modified" }
    }
    private static func requireEmpty(_ directory: Int32 = 3) throws {
        guard try Descriptors.isEmpty(directory, failing: io) else {
            throw failure("INVALID_STORAGE", "Publication preparation requires empty private staging.")
        }
    }
    private static func cleanup() throws {
        if try exists(3, "swap") {
            let receipt = try readReceipt(try exists(3, "prepared.json") ? "prepared.json" : "committed.json")
            let new = FileEvidence(file: receipt.file, bytes: receipt.bytes, sha256: receipt.sha256)
            guard try matches(3, "swap", new) || (receipt.replacement != nil && matches(3, "swap", receipt.replacement!)) else {
                throw failure("PUBLICATION_CONFLICT", "Unknown displaced bytes remain in private staging; cleanup cannot remove them.")
            }
        }
        // Only this owner's known leaves are disposable; never recurse into an unexpected entry.
        for name in privateFiles {
            if unlinkat(3, name, 0) != 0 && errno != ENOENT { throw io("Remove private publication evidence") }
        }
    }
    static func execute(_ operation: String, _ params: [String: Any]) throws -> [String: Any] {
        if operation == "publication.inspect" {
            guard Set(params.keys) == ["destination", "leaf"], let name = params["leaf"] as? String, leaf(name) else {
                throw failure("INVALID_REQUEST", "Invalid destination inspection.")
            }
            try InodeIdentity(params["destination"]).check(3)
            try lockDestination(3)
            let selected = try evidence(3, name)
            return ["file": try selected.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()]
        }
        if operation == "publication.usage" {
            guard Set(params.keys) == ["stage", "committed"],
                let committed = params["committed"] as? NSNumber, CFGetTypeID(committed) == CFBooleanGetTypeID() else {
                throw failure("INVALID_REQUEST", "Invalid staging measurement.")
            }
            try InodeIdentity(params["stage"]).check(3)
            let stage = try info(3, directory: true)
            guard stage.st_uid == getuid(), stage.st_mode & 0o777 == 0o700 else {
                throw failure("INVALID_STORAGE", "Publication staging must be private and owned.")
            }
            // Metadata-only observation can coexist with the inherited writer lock. No pathname
            // traversal or receipt parsing is needed to report an interrupted preparation.
            var bytes: Int64 = 0
            var measured = Set<String>()
            for name in privateFiles {
                var entry = stat()
                if fstatat(3, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 {
                    if errno == ENOENT { continue }
                    throw io("Measure private publication file")
                }
                let kind = entry.st_mode & S_IFMT
                // A raced swap can retain a symlink. Count only its no-follow metadata
                // length; never traverse its referent or treat it as an owned payload.
                guard kind == S_IFREG || (name == "swap" && kind == S_IFLNK), entry.st_size >= 0 else {
                    throw failure("INVALID_STORAGE", "Unexpected private publication file type.")
                }
                // A committed payload belongs to the external output. Before the swap,
                // its second private link owns its bytes; shared receipt links count once.
                if name == "payload" && (committed.boolValue || entry.st_nlink > 1) { continue }
                if !measured.insert("\(entry.st_dev):\(entry.st_ino)").inserted { continue }
                guard entry.st_size <= 9_007_199_254_740_991 - bytes else {
                    throw failure("LIMIT_EXCEEDED", "Publication storage exceeds safe byte range.")
                }
                bytes += entry.st_size
            }
            return ["bytes": bytes]
        }
        if operation == "publication.absent" {
            guard Set(params.keys) == ["destination", "name"], let name = params["name"] as? String,
                leaf(name), name.hasPrefix(".yap-export-") else { throw failure("INVALID_REQUEST", "Invalid staging lookup.") }
            try InodeIdentity(params["destination"]).check(3)
            _ = try info(3, directory: true)
            var entry = stat()
            if fstatat(3, name, &entry, AT_SYMLINK_NOFOLLOW) == 0 { return ["absent": false] }
            guard errno == ENOENT else { throw io("Inspect retired staging") }
            return ["absent": true]
        }
        if operation == "publication.allocate" {
            guard Set(params.keys) == ["destination", "name"], let name = params["name"] as? String,
                leaf(name), name.hasPrefix(".yap-export-") else {
                throw failure("INVALID_REQUEST", "Invalid publication staging allocation.")
            }
            try InodeIdentity(params["destination"]).check(3)
            _ = try info(3, directory: true)
            if mkdirat(3, name, 0o700) != 0 && errno != EEXIST { throw io("Allocate publication staging") }
            let fd = openat(3, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw io("Open allocated publication staging") }
            defer { close(fd) }
            try ManagedFiles.lockPrivateDirectory(fd)
            // Before identity registration, no writer may enter: crash recovery adopts only empty staging.
            try requireEmpty(fd)
            let data = try JSONEncoder().encode(InodeIdentity(try info(fd, directory: true)))
            return ["identity": try JSONSerialization.jsonObject(with: data)]
        }

        let preparing = operation == "publication.prepare"
        let retiring = operation == "publication.retire"
        guard Set(params.keys) == (preparing ? ["stage", "destination", "leaf", "maxBytes", "replacement"] : retiring ? ["stage", "destination", "name"] : ["stage", "destination"]) else {
            throw failure("INVALID_REQUEST", "Invalid publication parameters.")
        }
        try InodeIdentity(params["stage"]).check(3)
        try ManagedFiles.lockPrivateDirectory(3)
        try InodeIdentity(params["destination"]).check(4)
        try lockDestination(4)
        let stage = try info(3, directory: true), destination = try info(4, directory: true)
        guard stage.st_dev == destination.st_dev else {
            throw failure("CROSS_DEVICE_PUBLICATION", "Staging and destination must share a filesystem.")
        }
        try ManagedFiles.requireOutsideDirectory(4, ancestor: InodeIdentity(params["stage"]))
        if preparing {
            try requireEmpty()
            guard let name = params["leaf"] as? String, leaf(name),
                let limit = params["maxBytes"] as? NSNumber,
                CFGetTypeID(limit) != CFBooleanGetTypeID(), limit.doubleValue >= 1,
                limit.doubleValue <= 9_007_199_254_740_991,
                limit.doubleValue.rounded() == limit.doubleValue else {
                throw failure("INVALID_REQUEST", "Publication needs a destination leaf and byte budget.")
            }
            let replacement: FileEvidence?
            if params["replacement"] is NSNull { replacement = nil }
            else if let selected = params["replacement"] as? [String: Any] { replacement = try WireRequest.decode(FileEvidence.self, from: selected) }
            else { throw failure("INVALID_REQUEST", "Publication needs an admitted destination selection.") }
            let source = try info(5)
            guard source.st_size <= limit.int64Value else {
                throw failure("LIMIT_EXCEEDED", "Publication exceeds its byte budget.")
            }
            let fd = openat(3, "payload", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw io("Create publication payload") }
            defer { close(fd) }
            let sha = try digest(5, bytes: source.st_size, copyTo: fd)
            guard fsync(fd) == 0 else { throw io("Synchronize publication payload") }
            let receipt = Receipt(stage: InodeIdentity(stage), destination: InodeIdentity(destination),
                file: InodeIdentity(try info(fd)), leaf: name, bytes: source.st_size, sha256: sha, replacement: replacement)
            let data = try JSONEncoder().encode(receipt)
            let record = openat(3, "receipt.pending", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard record >= 0 else { throw io("Create publication receipt") }
            defer { close(record) }
            guard Descriptors.writeAll(record, data) else { throw io("Write publication file") }
            guard fsync(record) == 0 else { throw io("Synchronize publication receipt") }
            // Only a complete synchronized receipt may authorize external publication after restart.
            guard linkat(3, "receipt.pending", 3, "prepared.json", 0) == 0 else { throw io("Publish prepared receipt") }
            guard unlinkat(3, "receipt.pending", 0) == 0 else { throw io("Remove pending receipt") }
            return ["receipt": try JSONSerialization.jsonObject(with: data)]
        }
        if retiring {
            guard let name = params["name"] as? String, leaf(name), name.hasPrefix(".yap-export-") else {
                throw failure("INVALID_REQUEST", "Invalid publication staging name.")
            }
            var entry = stat()
            guard fstatat(4, name, &entry, AT_SYMLINK_NOFOLLOW) == 0,
                entry.st_mode & S_IFMT == S_IFDIR, InodeIdentity(entry) == InodeIdentity(stage) else {
                throw failure("PUBLICATION_CHANGED", "Publication staging entry changed.")
            }
            try cleanup()
            try requireEmpty()
            guard unlinkat(4, name, AT_REMOVEDIR) == 0 else { throw io("Retire publication staging") }
            return ["removed": true]
        }
        if operation == "publication.discard" {
            // Explicit abandonment is private cleanup only, including an interrupted prepare.
            try cleanup()
            return ["removed": true]
        }
        if operation == "publication.acknowledge" {
            var entry = stat()
            if try !exists(3, "prepared.json") && !exists(3, "committed.json") {
                if fstatat(3, "payload", &entry, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT {
                    return ["removed": true]
                }
            }
        }
        if operation == "publication.reconcile" {
            if try !exists(3, "prepared.json") && !exists(3, "committed.json") {
                return ["state": "unprepared", "receipt": NSNull()]
            }
        }
        let receipt = try readReceipt(try exists(3, "prepared.json") ? "prepared.json" : "committed.json")
        if operation == "publication.reconcile" {
            return ["state": try reconcile(receipt), "receipt": try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt))]
        }
        if operation == "publication.acknowledge" {
            guard try reconcile(receipt) == "committed" else {
                throw failure("PUBLICATION_CHANGED", "Only an observed committed publication can be acknowledged.")
            }
            try confirm(receipt)
            try cleanup()
            return ["removed": true]
        }
        guard operation == "publication.commit" else { throw failure("INVALID_REQUEST", "Unknown publication operation.") }
        let existing = try reconcile(receipt)
        if existing == "committed" { try confirm(receipt); return ["state": existing] }
        if existing != "missing" && existing != "prepared" { return ["state": existing] }
        let fd = try payload(receipt)
        defer { close(fd) }
        // Swap retains the displaced leaf. A pathname precheck is not an inode compare-and-swap.
        if receipt.replacement != nil {
            if linkat(3, "payload", 3, "swap", 0) != 0 && errno != EEXIST { throw io("Retain replacement link") }
            guard try matches(3, "swap", FileEvidence(file: receipt.file, bytes: receipt.bytes, sha256: receipt.sha256)) else {
                throw failure("PUBLICATION_CONFLICT", "Displaced bytes remain; replacement cannot be replayed.")
            }
            if renameatx_np(3, "swap", 4, receipt.leaf, UInt32(RENAME_SWAP | RENAME_NOFOLLOW_ANY)) != 0 {
                if errno == ENOENT || errno == ELOOP { return ["state": "replaced"] }
                throw io("Atomically replace selected destination")
            }
            let observed = try reconcile(receipt)
            if observed == "committed" { try confirm(receipt) }
            return ["state": observed]
        }
        // The private directory owner keeps this verified leaf stable while the syscall runs.
        if linkat(3, "payload", 4, receipt.leaf, 0) != 0 {
            if errno == EEXIST { return ["state": try reconcile(receipt)] }
            throw io("Publish completed file")
        }
        return ["state": try reconcile(receipt)]
    }
}
