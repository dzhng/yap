import CLibArchive
import CryptoKit
import Darwin
import Foundation
import YapMedia

/// Writing a stored ZIP from admitted members, and copying selected source members, without ever
/// reading a byte that differs from what the service admitted.
extension ArchiveOperation {
    static func copyMembers(_ request: Copy) throws -> [String: Any] {
        try request.identity.check(root)
        try ManagedFiles.lockPrivateDirectory(root)
        let limits = request.limits
        try limits.check()
        try request.inputIdentity.check(4)
        try ManagedFiles.lockPrivateDirectory(4)
        guard (1...6).contains(request.members.count) else {
            throw error("INVALID_REQUEST", "Source copy requires one to six selected members.")
        }
        func parts(_ path: String) throws -> [String] {
            guard case .safe(let components) = memberPath(path, limits) else {
                throw error("INVALID_REQUEST", "Unsafe source copy path.")
            }
            return components
        }
        var selected: [(member: Copy.Member, parts: [String])] = []
        var names = Set<String>()
        for member in request.members {
            guard member.bytes >= 0, names.insert(member.target.lowercased()).inserted else {
                throw error("INVALID_REQUEST", "Invalid source copy selection.")
            }
            _ = try parts(member.source)
            selected.append((member, try parts(member.target)))
        }
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: chunkBytes, alignment: 8)
        defer { buffer.deallocate() }
        var receipts: [[String: Any]] = [], total = 0
        for (member, parts) in selected {
            let input = try openWriteInput(member.source)
            defer { close(input) }
            var info = stat()
            guard fstat(input, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                info.st_size >= 0 else {
                throw error("INVALID_STORAGE", "Source copy requires a bounded regular file.")
            }
            let before = try FileVersion(of: input)
            guard info.st_size == member.bytes, before == member.identity else {
                throw error("ARCHIVE_CHANGED", "Selected source differs from admission.")
            }
            let output = try createMember(root, parts, false)
            defer { close(output) }
            var copied = 0, hash = SHA256()
            while copied < info.st_size {
                let n = pread(input, buffer, min(chunkBytes, Int(info.st_size) - copied), off_t(copied))
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { throw error("ARCHIVE_CHANGED", "Source changed during copy.") }
                try charge(n, &total)
                let bytes = Data(bytes: buffer, count: n)
                try writeAll(output, bytes)
                hash.update(data: bytes)
                copied += n
            }
            guard try FileVersion(of: input) == before else { throw error("ARCHIVE_CHANGED", "Source changed during copy.") }
            guard fsync(output) == 0 else { throw io("Flush selected source") }
            receipts.append(["path": member.target, "bytes": copied, "sha256": hex(hash.finalize()), "identity": try FileVersion(of: output).json])
        }
        return ["members": receipts, "bytes": total]
    }

    struct WriteMember: Decodable {
        let path: String
        let bytes: Int
        let sha256: String
        let identity: FileVersion
    }
    final class Output {
        let fd: Int32
        var bytes = 0
        var hash = SHA256()
        var failed = false
        init(_ fd: Int32) { self.fd = fd }
    }

    static func writeArchive(_ request: Write) throws -> [String: Any] {
        try request.identity.check(root)
        try ManagedFiles.lockPrivateDirectory(root)
        let limits = request.limits
        try limits.check()
        try requireEmpty()
        try request.inputIdentity.check(4)
        try ManagedFiles.lockPrivateDirectory(4)
        var sourceRoot = stat(), outputRoot = stat(), planInfo = stat()
        guard fstat(4, &sourceRoot) == 0, fstat(root, &outputRoot) == 0,
            sourceRoot.st_dev != outputRoot.st_dev || sourceRoot.st_ino != outputRoot.st_ino else {
            throw error("INVALID_STORAGE", "ZIP input and output must be separate directories.")
        }
        guard fstat(5, &planInfo) == 0, planInfo.st_mode & S_IFMT == S_IFREG,
            planInfo.st_size > 0 else {
            throw error("LIMIT_EXCEEDED", "ZIP member plan must be a bounded regular file.")
        }
        let planIdentity = try FileVersion(of: 5)
        guard request.plan.bytes == planInfo.st_size, request.plan.identity == planIdentity else {
            throw error("ARCHIVE_CHANGED", "ZIP plan differs from admission.")
        }
        // The descriptor inventory grows with take evidence. Foundation reads it in
        // chunks; decode each fixed-shape member independently rather than copying the
        // whole plan into a Data buffer and a second Codable array.
        guard let stream = InputStream(fileAtPath: "/dev/fd/5") else { throw io("Read ZIP member plan") }
        stream.open()
        defer { stream.close() }
        guard let members = try JSONSerialization.jsonObject(with: stream) as? [[String: Any]], !members.isEmpty else {
            throw error("INVALID_PACKAGE", "ZIP member plan must be a nonempty inventory.")
        }
        guard try FileVersion(of: 5) == planIdentity else { throw error("ARCHIVE_CHANGED", "ZIP plan changed during read.") }
        func member(_ value: [String: Any]) throws -> WriteMember {
            try JSONDecoder().decode(WriteMember.self, from: JSONSerialization.data(withJSONObject: value))
        }
        var names = Set<String>(), parents = Set<String>(), expectedTotal = 0
        for value in members {
            let member = try member(value)
            let folded = member.path.lowercased()
            guard case .safe(let parts) = memberPath(member.path, limits),
                !parents.contains(folded), names.insert(folded).inserted,
                member.bytes >= 0,
                member.sha256.count == 64, member.sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                throw error("INVALID_PACKAGE", "Invalid ZIP member plan.")
            }
            for count in 1..<parts.count {
                let parent = parts.prefix(count).joined(separator: "/").lowercased()
                guard !names.contains(parent) else { throw error("INVALID_PACKAGE", "ZIP file/directory collision.") }
                parents.insert(parent)
            }
            try charge(member.bytes, &expectedTotal)
        }
        guard request.inputBytes == expectedTotal else {
            throw error("ARCHIVE_CHANGED", "ZIP byte total differs from admission.")
        }
        let fd = openat(root, "payload.zip", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw io("Create ZIP output") }
        defer { close(fd) }
        let output = Output(fd)
        guard let writer = archive_write_new() else { throw error("INVALID_PACKAGE", "Cannot create ZIP writer.") }
        // Freeing an unclosed writer flushes through the write callback, which reads `output`
        // through an unretained pointer: without this, a failed write frees `output` first and the
        // flush corrupts the heap.
        defer { withExtendedLifetime(output) { _ = archive_write_free(writer) } }
        func checked(_ status: Int32) throws {
            guard status == ARCHIVE_OK else {
                if output.failed { throw error("LIMIT_EXCEEDED", "ZIP output limit or write failure.") }
                throw error("INVALID_PACKAGE", archive_error_string(writer).map { String(cString: $0) } ?? "ZIP write failed.")
            }
        }
        try checked(archive_write_set_format_zip(writer))
        try checked(archive_write_set_format_option(writer, "zip", "compression", "store"))
        try checked(archive_write_set_bytes_per_block(writer, 0))
        try checked(archive_write_open(writer, Unmanaged.passUnretained(output).toOpaque(), nil, { _, raw, buffer, count in
            let state = Unmanaged<Output>.fromOpaque(raw!).takeUnretainedValue()
            var offset = 0
            while offset < count {
                let n = write(state.fd, buffer!.advanced(by: offset), count - offset)
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { state.failed = true; return -1 }
                offset += n
            }
            state.hash.update(data: Data(bytes: buffer!, count: count))
            state.bytes += count
            return count
        }, nil))
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: chunkBytes, alignment: 8)
        defer { buffer.deallocate() }
        var total = 0
        for value in members {
            let member = try member(value)
            let input = try openWriteInput(member.path)
            defer { close(input) }
            var info = stat()
            guard fstat(input, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                info.st_size == member.bytes, try FileVersion(of: input) == member.identity else {
                throw error("ARCHIVE_CHANGED", "ZIP member differs from selected input.")
            }
            guard let entry = archive_entry_new() else { throw error("INVALID_PACKAGE", "Cannot create ZIP entry.") }
            defer { archive_entry_free(entry) }
            archive_entry_set_pathname(entry, member.path)
            archive_entry_set_filetype(entry, UInt32(S_IFREG))
            archive_entry_set_perm(entry, 0o600)
            archive_entry_set_size(entry, Int64(member.bytes))
            try checked(archive_write_header(writer, entry))
            var copied = 0, hash = SHA256()
            while copied < member.bytes {
                let n = pread(input, buffer, min(chunkBytes, member.bytes - copied), off_t(copied))
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { throw error("ARCHIVE_CHANGED", "ZIP member ended before expected size.") }
                hash.update(data: Data(bytes: buffer, count: n))
                guard archive_write_data(writer, buffer, n) == n else {
                    throw error(output.failed ? "LIMIT_EXCEEDED" : "INVALID_PACKAGE", "ZIP member write failed.")
                }
                copied += n
                try charge(n, &total)
            }
            guard try FileVersion(of: input) == member.identity, hex(hash.finalize()) == member.sha256 else {
                throw error("ARCHIVE_CHANGED", "ZIP member changed while copying.")
            }
            try checked(archive_write_finish_entry(writer))
        }
        try checked(archive_write_close(writer))
        guard fsync(fd) == 0 else { throw io("Flush ZIP output") }
        return ["path": "payload.zip", "bytes": output.bytes, "sha256": hex(output.hash.finalize()),
            "identity": try FileVersion(of: fd).json, "expandedBytes": total, "entries": members.count,
            "peakResidentBytes": ProcessResources.peakResidentBytes(), "writer": String(cString: archive_version_string())]
    }
    static func openWriteInput(_ path: String) throws -> Int32 {
        var fd = dup(4)
        guard fd >= 0 else { throw io("Retain ZIP input root") }
        do {
            let parts = path.split(separator: "/").map(String.init)
            for (index, part) in parts.enumerated() {
                let flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (index + 1 < parts.count ? O_DIRECTORY : 0)
                let next = openat(fd, part, flags)
                guard next >= 0 else { throw io("Open ZIP input member") }
                close(fd); fd = next
            }
            return fd
        } catch { close(fd); throw error }
    }
}
