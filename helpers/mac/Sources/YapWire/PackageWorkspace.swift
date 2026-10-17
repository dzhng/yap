import Darwin
import Foundation
import YapMedia

/// All mutation is relative to the caller's retained parent, never its locator.
enum PackageWorkspace {
    static let operations = [
        "packageWorkspace.create", "packageWorkspace.admit", "packageWorkspace.remove",
        "packageWorkspace.recover", "packageWorkspace.recoverUnconfirmed",
    ]

    static func execute(_ operation: String, _ params: [String: Any]) throws -> [String: Any] {
        if operation == "packageWorkspace.recover"
            || operation == "packageWorkspace.recoverUnconfirmed"
        {
            let selected = operation == "packageWorkspace.recoverUnconfirmed"
            let name = params["name"] as? String
            guard Set(params.keys) == (selected ? ["parent", "name"] : ["parent"]),
                !selected
                    || (name.map { UUID(uuidString: $0) != nil && $0.utf8.count == 36 } ?? false)
            else {
                throw NativeFailure(
                    "INVALID_REQUEST", "Invalid recovery request.")
            }
            try InodeIdentity(params["parent"]).check(3)
            try ManagedFiles.lockPrivateDirectory(3, busyCode: "RECOVERY_BUSY")
            return try recover(name)
        }
        let creating = operation == "packageWorkspace.create"
        guard
            ["packageWorkspace.create", "packageWorkspace.admit", "packageWorkspace.remove"]
                .contains(operation),
            Set(params.keys) == (creating ? ["parent", "name"] : ["parent", "name", "identity"]),
            let name = params["name"] as? String, UUID(uuidString: name) != nil,
            name.utf8.count == 36
        else {
            throw NativeFailure(
                "INVALID_REQUEST", "Invalid package workspace request.")
        }
        try InodeIdentity(params["parent"]).check(3)
        try ManagedFiles.lockPrivateDirectory(3)
        if creating {
            guard mkdirat(3, name, 0o700) == 0 else { throw failure("Create workspace") }
            // A created entry is identified before any path-based admission is attempted.
            var info = stat()
            guard fstatat(3, name, &info, AT_SYMLINK_NOFOLLOW) == 0,
                info.st_mode & S_IFMT == S_IFDIR
            else { throw failure("Inspect created workspace") }
            let identity = InodeIdentity(info)
            return ["name": name, "identity": ["dev": identity.dev, "ino": identity.ino]]
        }
        let expected = try InodeIdentity(params["identity"])
        let child = openat(3, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        // The exclusively owned parent never relocates child entries. Absence therefore also
        // covers a completed removal whose worker reply was lost; existing replacements still fail.
        if child < 0 && errno == ENOENT && operation == "packageWorkspace.remove" {
            return ["removed": true]
        }
        guard child >= 0 else { throw failure("Open owned workspace; ownership may be lost") }
        defer { close(child) }
        try expected.check(child)
        if operation == "packageWorkspace.admit" {
            try expected.check(4)
            try ManagedFiles.lockPrivateDirectory(4)
            return ["admitted": true]
        }
        // Independent open-file description: surviving inherited workers still hold the old lock.
        try ManagedFiles.lockPrivateDirectory(child)
        try ManagedFiles.removeOwnedDirectory(3, name, child, expected, failing: failure)
        return ["removed": true]
    }

    private static func namesInDirectory(_ fd: Int32, maximum: Int) throws -> [String] {
        var names: [String] = []
        try DirectoryContents.forEachName(in: fd, failing: failure) { entry in
            let name = String(cString: entry)
            guard UUID(uuidString: name) != nil, name.utf8.count == 36, names.count < maximum else {
                throw NativeFailure(
                    "INVALID_STORAGE", "Workspace root contains unexpected or too many entries.")
            }
            names.append(name)
            return true
        }
        return names
    }

    private static func recover(_ unconfirmed: String?) throws -> [String: Any] {
        let names = try unconfirmed.map { [$0] } ?? namesInDirectory(3, maximum: 4)
        var children: [(name: String, fd: Int32, identity: InodeIdentity)] = []
        defer { for child in children { close(child.fd) } }
        // Keep every independently acquired lock until the entire pass has completed.
        for name in names {
            let fd = openat(3, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if fd < 0 && errno == ENOENT && unconfirmed != nil { continue }
            guard fd >= 0 else { throw failure("Open orphan workspace") }
            do {
                var info = stat()
                guard fstat(fd, &info) == 0 else { throw failure("Inspect orphan workspace") }
                let identity = InodeIdentity(info)
                try ManagedFiles.checkDirectoryEntry(3, name, identity, failing: failure)
                try ManagedFiles.lockPrivateDirectory(fd, busyCode: "RECOVERY_BUSY")
                // No payload writer may run before a creation receipt: unknown identity admits only empty children.
                if unconfirmed != nil { _ = try namesInDirectory(fd, maximum: 0) }
                children.append((name, fd, identity))
            } catch {
                close(fd)
                throw error
            }
        }
        for child in children { try ManagedFiles.checkDirectoryEntry(3, child.name, child.identity, failing: failure) }
        for child in children { try ManagedFiles.removeOwnedDirectory(3, child.name, child.fd, child.identity, failing: failure) }
        return ["recovered": children.count]
    }

    private static func failure(_ action: String) -> NativeFailure {
        let code = errno == ELOOP || errno == ENOTDIR ? "INVALID_STORAGE" : "PACKAGE_STORAGE_UNAVAILABLE"
        return NativeFailure(code, "\(action): \(String(cString: strerror(errno)))")
    }
}
