import Darwin
import Foundation
import YapMedia

/// Package archive work inside an inherited, exclusively owned workspace on fd 3. The parent
/// retains fd 3's original across worker death and invokes cleanup only after the worker is reaped.
enum ArchiveOperation {
    static let operations = [
        "archive.createOutput", "archive.removeOutput", "archive.cleanup", "archive.prepare",
        "archive.extract", "archive.write", "archive.copy",
    ]
    static let root: Int32 = 3
    static let chunkBytes = 65_536
    struct Limits: Codable {
        let compressedBytes, expandedBytes, memberBytes, entries, pathBytes: Int
        let componentBytes, depth, manifestBytes, revisionBytes, history: Int
        let initialReadBytes, receiptBytes: Int

        func check() throws {
            let values = [
                compressedBytes, expandedBytes, memberBytes, entries, pathBytes, componentBytes,
                depth, manifestBytes, revisionBytes, history, initialReadBytes, receiptBytes,
            ]
            guard values.allSatisfy({ (1...Int.max / 2).contains($0) }), depth <= 32,
                receiptBytes <= 7 * 1024 * 1024
            else { throw error("INVALID_REQUEST", "Unsupported archive limits.") }
        }
    }
    /// A file pinned by content version, not only by inode: a rewrite in place changes it.
    struct FileVersion: Codable, Equatable {
        let device: String
        let inode: String
        let modifiedNs: String
        let changedNs: String

        init(of fd: Int32) throws {
            var info = stat()
            guard fstat(fd, &info) == 0 else { throw io("Inspect package member") }
            device = String(UInt64(truncatingIfNeeded: info.st_dev))
            inode = String(info.st_ino)
            modifiedNs = String(
                Int64(info.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(info.st_mtimespec.tv_nsec))
            changedNs = String(
                Int64(info.st_ctimespec.tv_sec) * 1_000_000_000 + Int64(info.st_ctimespec.tv_nsec))
        }

        var json: [String: String] {
            ["device": device, "inode": inode, "modifiedNs": modifiedNs, "changedNs": changedNs]
        }
    }
    struct Workspace: Codable {
        let identity: InodeIdentity
    }
    struct NewOutput: Codable {
        let identity: InodeIdentity
        let name: String
    }
    struct ReleasedOutput: Codable {
        let identity: InodeIdentity
        let name: String
        let fileIdentity: FileVersion
    }
    struct Extraction: Codable {
        /// The archive the service admitted, before its change time is part of the pin.
        struct Admitted: Codable {
            struct Version: Codable {
                let device: String
                let inode: String
                let modifiedNs: String
            }
            let bytes: Int64
            let identity: Version
        }
        let identity: InodeIdentity
        let limits: Limits
        let input: Admitted
        let inlineRevisions: Bool?
    }
    struct Copy: Codable {
        struct Member: Codable {
            let source: String
            let target: String
            let bytes: Int
            let identity: FileVersion
        }
        let identity: InodeIdentity
        let inputIdentity: InodeIdentity
        let members: [Member]
        let limits: Limits
    }
    struct Write: Codable {
        struct Plan: Codable {
            let bytes: Int
            let identity: FileVersion
        }
        let identity: InodeIdentity
        let inputIdentity: InodeIdentity
        let inputBytes: Int
        let plan: Plan
        let limits: Limits
    }
    static func execute(_ operation: String, _ params: [String: Any]) throws -> [String: Any] {
        switch operation {
        case "archive.copy": return try copyMembers(WireRequest.decode(Copy.self, from: params))
        case "archive.write": return try writeArchive(WireRequest.decode(Write.self, from: params))
        case "archive.extract": return try extract(WireRequest.decode(Extraction.self, from: params))
        case "archive.createOutput":
            let request = try WireRequest.decode(NewOutput.self, from: params)
            try outputWorkspace(request.identity, name: request.name)
            let fd = openat(
                root, request.name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw io("Create context output") }
            defer { close(fd) }
            return ["path": request.name, "bytes": 0, "identity": try FileVersion(of: fd).json]
        case "archive.removeOutput":
            let request = try WireRequest.decode(ReleasedOutput.self, from: params)
            try outputWorkspace(request.identity, name: request.name)
            let fd = openat(root, request.name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw io("Open released output") }
            defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                try FileVersion(of: fd) == request.fileIdentity
            else { throw error("INVALID_STORAGE", "Output changed before release.") }
            guard unlinkat(root, request.name, 0) == 0 else { throw io("Remove released output") }
            return ["removed": true]
        default:
            let request = try WireRequest.decode(Workspace.self, from: params)
            try request.identity.check(root)
            try ManagedFiles.lockPrivateDirectory(root)
            if operation == "archive.cleanup" {
                try DirectoryContents.removeContents(root)
                return ["removed": true]
            }
            try requireEmpty()
            return ["empty": true]
        }
    }

    /// Pins the context workspace and admits only a unique media leaf inside it.
    static func outputWorkspace(_ identity: InodeIdentity, name: String) throws {
        try identity.check(root)
        try ManagedFiles.lockPrivateDirectory(root)
        guard name.count == 40, [".png", ".wav"].contains(String(name.suffix(4))),
            UUID(uuidString: String(name.prefix(36))) != nil
        else { throw error("INVALID_REQUEST", "Output name must be a unique media leaf.") }
    }

    enum MemberPath {
        case safe([String])
        case exceedsLimits
        case unsafe
    }

    /// A relative member path of plain ASCII components, none empty or a dot segment, within the
    /// request's path, depth and component limits.
    static func memberPath(_ path: String, _ limits: Limits) -> MemberPath {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard path.utf8.count <= limits.pathBytes, parts.count <= limits.depth,
            parts.allSatisfy({ $0.utf8.count <= limits.componentBytes })
        else { return .exceedsLimits }
        guard !path.isEmpty,
            path.utf8.allSatisfy({
                (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
                    || [45, 46, 47, 95].contains($0)
            }),
            parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
        else { return .unsafe }
        return .safe(parts)
    }

    static func requireEmpty() throws {
        guard try Descriptors.isEmpty(root, failing: io) else {
            throw error("INVALID_STORAGE", "Archive workspace is not empty.")
        }
    }
    static func createMember(_ base: Int32, _ parts: [String], _ directory: Bool) throws
        -> Int32
    {
        var fd = dup(base)
        guard fd >= 0 else { throw io("Duplicate extraction directory") }
        do {
            for (i, part) in parts.enumerated() {
                let isDirectory = i < parts.count - 1 || directory
                if isDirectory && mkdirat(fd, part, 0o700) != 0 && errno != EEXIST {
                    throw io("Create member directory")
                }
                let next =
                    isDirectory
                    ? openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    : openat(fd, part, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
                guard next >= 0 else { throw io("Create archive member") }
                close(fd)
                fd = next
            }
            return fd
        } catch {
            close(fd)
            throw error
        }
    }
    static func writeAll(_ fd: Int32, _ bytes: Data) throws {
        guard Descriptors.writeAll(fd, bytes) else { throw io("Write archive member") }
    }
    static func charge(_ value: Int, _ total: inout Int, _ limit: Int) throws {
        guard value <= limit - total else {
            throw error("LIMIT_EXCEEDED", "Archive byte limit exceeded.")
        }
        total += value
    }
    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
    static func error(_ code: String, _ message: String) -> NativeFailure {
        NativeFailure(code, message)
    }
    static func io(_ action: String) -> NativeFailure {
        error("INVALID_STORAGE", "\(action): \(String(cString: strerror(errno)))")
    }
}
