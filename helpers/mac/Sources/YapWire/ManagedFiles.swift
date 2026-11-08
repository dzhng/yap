import Darwin
import Foundation
import YapMedia

/// Core selects owned identities; this boundary resolves and removes only beneath pinned directories.
enum ManagedFiles {
    /// Reject a selected directory whose ancestry includes a managed storage owner.
    static func requireOutsideDirectory(_ fd: Int32, ancestor: InodeIdentity) throws {
        var current = dup(fd)
        guard current >= 0 else { throw DirectoryContents.failure("Retain destination ancestry") }
        defer { close(current) }
        for _ in 0..<256 {
            var here = stat()
            guard fstat(current, &here) == 0, here.st_mode & S_IFMT == S_IFDIR else {
                throw NativeFailure(
                    "INVALID_STORAGE", "Destination must be a directory.")
            }
            guard InodeIdentity(here) != ancestor else {
                throw NativeFailure(
                    "INVALID_STORAGE", "Destination must be outside managed storage.")
            }
            let parent = openat(current, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parent >= 0 else { throw DirectoryContents.failure("Inspect destination ancestry") }
            var above = stat()
            guard fstat(parent, &above) == 0 else { close(parent); throw DirectoryContents.failure("Inspect destination ancestor") }
            if above.st_dev == here.st_dev && above.st_ino == here.st_ino { close(parent); return }
            close(current)
            current = parent
        }
        throw NativeFailure(
            "LIMIT_EXCEEDED", "Destination ancestry exceeds 256 directories.")
    }

    static func externalDirectory(_ params: [String: Any]) throws -> [String: String] {
        guard Set(params.keys) == ["home", "expectedHome"], let home = params["home"] as? String,
            home.hasPrefix("/"), !home.contains("\0") else { throw invalidRequest("Invalid external destination check.") }
        let expected = try InodeIdentity(params["expectedHome"])
        let owned = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard owned >= 0 else { throw DirectoryContents.failure("Open managed home") }
        defer { close(owned) }
        try expected.check(owned)
        try requireOutsideDirectory(3, ancestor: expected)
        var destination = stat()
        guard fstat(3, &destination) == 0 else { throw DirectoryContents.failure("Inspect selected destination") }
        let identity = InodeIdentity(destination)
        return ["dev": identity.dev, "ino": identity.ino]
    }

    static func recordingDirectory(_ params: [String: Any]) throws -> [String: String] {
        guard Set(params.keys) == ["home", "expectedHome", "recordingId"],
            let home = params["home"] as? String, home.hasPrefix("/"), !home.contains("\0"),
            let id = params["recordingId"] as? String, validID(id) else {
            throw invalidRequest("Invalid recording directory request.")
        }
        let owned = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard owned >= 0 else { throw DirectoryContents.failure("Open managed home") }
        defer { close(owned) }
        try InodeIdentity(params["expectedHome"]).check(owned)
        let recordings = openat(owned, "recordings", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard recordings >= 0 else { throw DirectoryContents.failure("Open recording parent") }
        defer { close(recordings) }
        let selected = openat(recordings, id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard selected >= 0 else { throw DirectoryContents.failure("Open recording directory") }
        defer { close(selected) }
        var info = stat()
        guard fstat(selected, &info) == 0 else { throw DirectoryContents.failure("Inspect recording directory") }
        let identity = InodeIdentity(info)
        try identity.check(3)
        try lockPrivateDirectory(3)
        return ["dev": identity.dev, "ino": identity.ino]
    }

    static func execute(_ operation: String, _ params: [String: Any]) throws {
        let recording = operation == "storage.removeRecordingDirectory"
        let fields: Set<String> =
            recording
            ? ["home", "expectedHome", "recordingId"]
            : ["home", "expectedHome", "expectedCacheRoot", "ids"]
        guard Set(params.keys) == fields, let home = params["home"] as? String,
            home.hasPrefix("/"), !home.contains("\0")
        else { throw invalidRequest("Invalid managed file removal parameters.") }
        let expectedHome = try InodeIdentity(params["expectedHome"])
        let names: [String]
        let expectedCache: InodeIdentity?
        if recording {
            guard let id = params["recordingId"] as? String, validID(id) else {
                throw invalidRequest("Recording identity must be a UUID.")
            }
            names = [id]
            expectedCache = nil
        } else {
            guard let ids = params["ids"] as? [String], (1...64).contains(ids.count),
                ids.allSatisfy(validID)
            else { throw invalidRequest("Cache removal requires one to 64 UUIDs.") }
            names = ids
            expectedCache = try InodeIdentity(params["expectedCacheRoot"])
        }
        // Darwin rejects symlinks in every component, including ancestors of the supplied home.
        let homeFD = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard homeFD >= 0 else { throw DirectoryContents.failure("Open managed home") }
        defer { close(homeFD) }
        try expectedHome.check(homeFD)
        if recording {
            guard let parent = try directory(homeFD, "recordings") else { return }
            defer { close(parent) }
            guard let selected = try directory(parent, names[0]) else { return }
            defer { close(selected) }
            var info = stat()
            guard fstat(selected, &info) == 0 else { throw DirectoryContents.failure("Inspect recording directory") }
            let identity = InodeIdentity(info)
            try identity.check(3)
            try lockPrivateDirectory(3, busyCode: "RECORDING_BUSY")
            try removeOwnedDirectory(parent, names[0], 3, identity)
        } else {
            guard let cache = try directory(homeFD, "cache") else { return }
            defer { close(cache) }
            guard let derived = try directory(cache, "derived") else { return }
            defer { close(derived) }
            try expectedCache!.check(derived)
            for id in names {
                if unlinkat(derived, "\(id).cache", 0) != 0 && errno != ENOENT {
                    throw DirectoryContents.failure("Remove owned cache file")
                }
            }
        }
    }

    private static func validID(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value) != nil
    }

    private static func directory(_ parent: Int32, _ name: String) throws -> Int32? {
        let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd >= 0 { return fd }
        if errno == ENOENT { return nil }
        throw DirectoryContents.failure("Open managed directory")
    }

    /// The caller owns this entry and retains its locked descriptor throughout removal.
    static func checkDirectoryEntry(
        _ parent: Int32, _ name: String, _ expected: InodeIdentity,
        failing: (String) -> NativeFailure = DirectoryContents.failure
    ) throws {
        var entry = stat()
        guard fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) == 0,
            InodeIdentity(entry) == expected, entry.st_mode & S_IFMT == S_IFDIR
        else { throw failing("Workspace entry ownership lost") }
    }

    static func removeOwnedDirectory(
        _ parent: Int32, _ name: String, _ fd: Int32, _ expected: InodeIdentity,
        failing: (String) -> NativeFailure = DirectoryContents.failure
    ) throws {
        try checkDirectoryEntry(parent, name, expected, failing: failing)
        try DirectoryContents.removeContents(fd)
        try checkDirectoryEntry(parent, name, expected, failing: failing)
        guard unlinkat(parent, name, AT_REMOVEDIR) == 0 else { throw failing("Remove workspace") }
    }

    /// The lock follows the shared open-file description while the parent retains its FD.
    static func lockPrivateDirectory(_ fd: Int32, busyCode: String? = nil, shared: Bool = false) throws {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
            info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw NativeFailure("INVALID_STORAGE",
                "Workspace must be a private directory owned by this user.")
        }
        guard flock(fd, (shared ? LOCK_SH : LOCK_EX) | LOCK_NB) == 0 else {
            let number = errno
            if let busyCode, number == EWOULDBLOCK || number == EAGAIN {
                throw NativeFailure(busyCode, "Workspace is still held by a live owner.")
            }
            throw NativeFailure("INVALID_STORAGE",
                "Required workspace lock could not be acquired.")
        }
    }

    private static func invalidRequest(_ message: String) -> NativeFailure {
        NativeFailure("INVALID_REQUEST", message)
    }

}
