import Darwin
import Foundation

/// Scans and removes only beneath an already-owned directory descriptor.
public enum DirectoryContents {
    /// Calls `body` with each entry name other than `.` and `..`, stopping when it returns false.
    /// `failing` names what an enumeration error means to the calling operation.
    public static func forEachName(
        in fd: Int32, failing: (String) -> NativeFailure = failure,
        _ body: (UnsafePointer<CChar>) throws -> Bool
    ) throws {
        let scan = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard scan >= 0 else { throw failing("Open owned directory") }
        guard let stream = fdopendir(scan) else {
            close(scan)
            throw failing("Enumerate owned directory")
        }
        defer { closedir(stream) }
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw failing("Read owned directory") }
                return
            }
            let proceed = try withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                try pointer.withMemoryRebound(
                    to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)
                ) { name in
                    strcmp(name, ".") == 0 || strcmp(name, "..") == 0 ? true : try body(name)
                }
            }
            guard proceed else { return }
        }
    }

    private static func removeEntry(
        _ parent: Int32, _ name: UnsafePointer<CChar>, depth: Int
    ) throws {
        var info = stat()
        if fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return }
            throw failure("Inspect managed entry")
        }
        guard (info.st_mode & S_IFMT) == S_IFDIR else {
            if unlinkat(parent, name, 0) != 0 && errno != ENOENT {
                throw failure("Remove managed entry")
            }
            return
        }
        guard depth < 64 else {
            throw NativeFailure(
                "LIMIT_EXCEEDED", "Managed directory nesting exceeds 64 levels.")
        }
        let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return }
            throw failure("Open managed directory")
        }
        defer { close(fd) }
        var opened = stat()
        guard fstat(fd, &opened) == 0 else { throw failure("Inspect opened directory") }
        guard opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else {
            throw NativeFailure("STORAGE_CHANGED", "Managed directory changed while opening.")
        }
        try removeContents(fd, depth: depth)
        if unlinkat(parent, name, AT_REMOVEDIR) != 0 && errno != ENOENT {
            throw failure("Remove emptied managed directory")
        }
    }

    // The caller exclusively owns the directory; cleanup never re-resolves its path.
    public static func removeContents(_ fd: Int32, depth: Int = 0) throws {
        try forEachName(in: fd) { child in
            try removeEntry(fd, child, depth: depth + 1)
            return true
        }
    }

    /// A filesystem call that failed: a link or non-directory where a directory was pinned is a
    /// storage violation, anything else is an I/O failure that may succeed later.
    public static func failure(_ action: String) -> NativeFailure {
        let number = errno
        let code = number == ELOOP || number == ENOTDIR ? "INVALID_STORAGE" : "DELETE_FAILED"
        return NativeFailure(code, "\(action): \(String(cString: strerror(number))).")
    }
}
