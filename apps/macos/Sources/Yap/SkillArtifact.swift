import Foundation

/// The account-level consumer skill, one part of `HomeLifecycle`. Installing replaces every global skill named `yap` with the bundled one through the
/// bundled `skills` installer run by the app's own Node, so it needs no host npm or network; a
/// failed install restores what it replaced. The receipt records ownership for later removal.
@MainActor
final class SkillArtifact {
    private struct InstalledSkill: Codable {
        let name: String
        let path: String
        let scope: String?
        let agents: [String]?
        let source: String?
        let sourceUrl: String?
        let sourceType: String?
    }

    private struct Receipt: Codable {
        let managed: Bool
        let source: String
        let installer: String
        let paths: [String]
        let entries: [InstalledSkill]
        let operationId: String?
        let installedAt: String
    }

    private struct LifecycleState: Codable {
        let state: String
        let operationId: String?
        let error: String?
        let backupPath: String?
    }

    private let home: URL
    private let resources: AppResources
    private nonisolated static let source = "https://github.com/dzhng/yap/tree/main/skills/yap"
    private nonisolated static let installer = "skills@1.7.0"
    private nonisolated static let knownPaths = [".agents/skills/yap", ".codex/skills/yap", ".claude/skills/yap"]
    private nonisolated static let operationLock = NSLock()

    init(home: URL, resources: AppResources) {
        self.home = home.standardizedFileURL
        self.resources = resources
    }

    /// Starts the install or removal in the background; `skill.status` reads `running` until it settles.
    @discardableResult
    func setEnabled(_ enabled: Bool, settled: @escaping @Sendable () -> Void = {}) -> String {
        let home = self.home
        let resources = self.resources
        let operationId = UUID().uuidString
        writeState(LifecycleState(state: "updating", operationId: operationId, error: nil, backupPath: nil))
        DispatchQueue.global(qos: .utility).async {
            if enabled { Self.install(home: home, resources: resources, operationId: operationId) }
            else { Self.uninstall(home: home, resources: resources, operationId: operationId) }
            settled()
        }
        return operationId
    }

    func handle(_ operation: String) -> Result<Data, ServiceFailure> {
        switch operation {
        case "skill.status":
            return .success(statusData())
        case "skill.install", "skill.update":
            return .success(statusData(state: "updating", operationId: setEnabled(true), discover: false))
        case "skill.uninstall":
            return .success(statusData(state: "updating", operationId: setEnabled(false), discover: false))
        default:
            return .failure(ServiceFailure(code: "UNKNOWN_OPERATION", message: "Unknown skill operation"))
        }
    }

    /// The last known state without running the installer: for a status line, not for agents.
    var summaryState: String {
        if let state = readState()?.state {
            switch state {
            case "updating": return "running"
            case "installed": return "ready"
            case "needs_attention": return "failed"
            case "missing", "disabled", "unmanaged": return "unavailable"
            default: preconditionFailure("Unknown stored skill state: \(state)")
            }
        }
        guard let receipt = readReceipt(), receipt.managed else { return "unavailable" }
        return receipt.paths.allSatisfy { FileManager.default.fileExists(atPath: $0) } ? "ready" : "failed"
    }

    private var receiptURL: URL { home.appendingPathComponent(".config/yap/skill-install.json") }
    private var stateURL: URL { home.appendingPathComponent(".config/yap/skill-state.json") }

    private func readReceipt() -> Receipt? {
        Self.decodeReceipt(at: receiptURL, home: home)
    }

    private func readState() -> LifecycleState? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(LifecycleState.self, from: data)
    }

    private func writeState(_ state: LifecycleState) { Self.writeState(state, home: home) }

    private func statusData(state explicitState: String? = nil, operationId: String? = nil, discover: Bool = true) -> Data {
        // State before receipt: an install writes its receipt before clearing its state, so this
        // order never sees neither while one is finishing.
        let state = readState()
        let receipt = readReceipt()
        let discovered = receipt.map { (entries: $0.entries, error: Optional<String>.none) }
            ?? (discover ? Self.discover(home: home, resources: resources) : (entries: Self.fallbackEntries(home: home), error: nil))
        let paths = (receipt?.paths ?? discovered.entries.filter { $0.name == "yap" }.map(\.path))
            .filter { Self.safePath($0, under: home) }.sorted()
        let existing = paths.filter { FileManager.default.fileExists(atPath: $0) }
        let effective = explicitState ?? state?.state ?? {
            if receipt?.managed == true { return existing.count == paths.count ? "installed" : "needs_attention" }
            return discovered.entries.contains(where: { $0.name == "yap" }) ? "unmanaged" : "missing"
        }()
        let details: [[String: Any]] = paths.map { path in
            ["path": path, "exists": FileManager.default.fileExists(atPath: path),
             "symlink": Self.isSymlink(URL(fileURLWithPath: path))]
        }
        let workState: String
        let installation: String
        switch effective {
        case "installed": workState = "ready"; installation = "installed"
        case "updating":
            workState = "running"
            installation = receipt?.managed == true ? "installed" : "missing"
        case "needs_attention": workState = "failed"; installation = "needs_attention"
        case "missing": workState = "unavailable"; installation = "missing"
        case "unmanaged": workState = "unavailable"; installation = "unmanaged"
        case "disabled": workState = "unavailable"; installation = "disabled"
        default: preconditionFailure("Unknown skill installation state: \(effective)")
        }
        var value: [String: Any] = [
            "state": workState,
            "jobId": (operationId ?? state?.operationId).map { $0 as Any } ?? NSNull(),
            "installation": installation,
            "managed": receipt?.managed == true,
            "paths": paths,
            "destinations": details,
            "source": receipt?.source ?? Self.source,
            "sourceRevision": receipt?.entries.first?.source ?? NSNull(),
            "installer": receipt?.installer ?? Self.installer,
        ]
        if let error = state?.error { value["error"] = error }
        if let backupPath = state?.backupPath { value["backupPath"] = backupPath }
        if let entries = receipt?.entries, let data = try? JSONEncoder().encode(entries),
           let json = try? JSONSerialization.jsonObject(with: data) { value["entries"] = json }
        if let discoveryError = discovered.error { value["discoveryError"] = discoveryError }
        return (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    private nonisolated static func install(home: URL, resources: AppResources, operationId: String) {
        operationLock.lock()
        defer { operationLock.unlock() }
        let stage = FileManager.default.temporaryDirectory.appendingPathComponent("yap-skill-\(operationId)", isDirectory: true)
        let backup = stage.appendingPathComponent("backup", isDirectory: true)
        var completed = false
        var backedUp: [String] = []
        defer { if completed { try? FileManager.default.removeItem(at: stage) } }
        do {
            try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
            let installer = try bundledInstaller(resources)
            guard let skillSource = resources.skillSource else { throw LifecycleError.missing("bundled skill") }
            let before = discoveredPaths(home: home, resources: resources)
            for path in Set(before + knownPaths.map { home.appendingPathComponent($0).path }) where FileManager.default.fileExists(atPath: path) || isSymlink(URL(fileURLWithPath: path)) {
                let saved = backup.appendingPathComponent(relativePath(path, home: home))
                try FileManager.default.createDirectory(at: saved.deletingLastPathComponent(), withIntermediateDirectories: true)
                try copyPreservingSymlink(from: URL(fileURLWithPath: path), to: saved)
                backedUp.append(relativePath(path, home: home))
                try FileManager.default.removeItem(atPath: path)
            }
            if FileManager.default.fileExists(atPath: receiptURL(home: home).path) {
                let savedReceipt = backup.appendingPathComponent(".config/yap/skill-install.json")
                try FileManager.default.createDirectory(at: savedReceipt.deletingLastPathComponent(), withIntermediateDirectories: true)
                try copyPreservingSymlink(from: receiptURL(home: home), to: savedReceipt)
                backedUp.append(".config/yap/skill-install.json")
                try FileManager.default.removeItem(at: receiptURL(home: home))
            }
            let status = try run(installer, ["add", skillSource.path, "--all", "--global", "--yes"], home: home)
            guard status.code == 0 else { throw LifecycleError.command(status.output) }
            let after = discover(home: home, resources: resources)
            let entries = after.entries.filter { $0.name == "yap" && $0.scope == "global" }
            let paths = entries.map(\.path).filter { safePath($0, under: home) }
            let canonical = home.appendingPathComponent(".agents/skills/yap").path
            guard paths.contains(canonical), paths.allSatisfy({ FileManager.default.fileExists(atPath: URL(fileURLWithPath: $0).appendingPathComponent("SKILL.md").path) }) else {
                throw LifecycleError.verification
            }
            let receipt = Receipt(managed: true, source: source, installer: Self.installer, paths: paths, entries: entries,
                                  operationId: operationId, installedAt: ISO8601DateFormatter().string(from: Date()))
            try FileManager.default.createDirectory(at: receiptURL(home: home).deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(receipt).write(to: receiptURL(home: home), options: .atomic)
            try? FileManager.default.removeItem(at: stateURL(home: home))
            completed = true
        } catch {
            restore(backup: backup, home: home, paths: backedUp)
            writeState(LifecycleState(state: "needs_attention", operationId: operationId, error: error.localizedDescription, backupPath: backup.path), home: home)
        }
    }

    private nonisolated static func uninstall(home: URL, resources: AppResources, operationId: String) {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard let receipt = decodeReceipt(at: receiptURL(home: home), home: home), receipt.managed else {
            writeState(LifecycleState(state: "disabled", operationId: operationId, error: nil, backupPath: nil), home: home)
            return
        }
        let paths = Set(receipt.paths + discoveredPaths(home: home, resources: resources))
        do {
            for path in paths where safePath(path, under: home) { try? FileManager.default.removeItem(atPath: path) }
            let remaining = paths.filter { FileManager.default.fileExists(atPath: $0) }
            guard remaining.isEmpty else { throw LifecycleError.verification }
            try? FileManager.default.removeItem(at: receiptURL(home: home))
            try? FileManager.default.removeItem(at: stateURL(home: home))
        } catch {
            writeState(LifecycleState(state: "needs_attention", operationId: operationId, error: error.localizedDescription, backupPath: nil), home: home)
        }
    }

    private enum LifecycleError: LocalizedError {
        case command(String), missing(String), verification
        var errorDescription: String? {
            switch self {
            case .command(let output): return output.isEmpty ? "The skills installer failed" : output
            case .missing(let resource): return "This build carries no \(resource)"
            case .verification: return "Installed skill verification failed"
            }
        }
    }

    private nonisolated static func discover(home: URL, resources: AppResources) -> (entries: [InstalledSkill], error: String?) {
        do {
            let result = try run(bundledInstaller(resources), ["ls", "--global", "--json"], home: home)
            guard result.code == 0 else { return (fallbackEntries(home: home), result.output) }
            return (try JSONDecoder().decode([InstalledSkill].self, from: Data(result.output.utf8)), nil)
        } catch { return (fallbackEntries(home: home), error.localizedDescription) }
    }

    private nonisolated static func discoveredPaths(home: URL, resources: AppResources) -> [String] {
        discover(home: home, resources: resources).entries.filter { $0.name == "yap" && $0.scope == "global" }.map(\.path)
    }

    /// The pinned installer and the interpreter that runs it, both from this build.
    private nonisolated static func bundledInstaller(_ resources: AppResources) throws -> (node: String, script: String) {
        guard let script = resources.skillsInstaller else { throw LifecycleError.missing("skills installer") }
        let node = try NodeRuntime.resolve(
            recorded: resources.node, environment: ProcessInfo.processInfo.environment,
            deadline: Date().addingTimeInterval(NodeRuntime.candidateBudget * 2)
        ).get()
        return (node, script.path)
    }

    private nonisolated static func fallbackEntries(home: URL) -> [InstalledSkill] {
        knownPaths.map { relative in
            let path = home.appendingPathComponent(relative).path
            return InstalledSkill(name: "yap", path: path, scope: "global", agents: nil, source: nil, sourceUrl: nil, sourceType: nil)
        }.filter { FileManager.default.fileExists(atPath: $0.path) || isSymlink(URL(fileURLWithPath: $0.path)) }
    }

    private nonisolated static func restore(backup: URL, home: URL, paths: [String]) {
        for item in paths.sorted(by: { $0.count < $1.count }) {
            let source = backup.appendingPathComponent(item)
            guard FileManager.default.fileExists(atPath: source.path) || isSymlink(source) else { continue }
            let destination = home.appendingPathComponent(item)
            if FileManager.default.fileExists(atPath: destination.path) || isSymlink(destination) { try? FileManager.default.removeItem(at: destination) }
            try? FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? copyPreservingSymlink(from: source, to: destination)
        }
    }

    private nonisolated static func copyPreservingSymlink(from source: URL, to destination: URL) throws {
        if isSymlink(source) {
            try FileManager.default.createSymbolicLink(atPath: destination.path, withDestinationPath: try FileManager.default.destinationOfSymbolicLink(atPath: source.path))
        } else { try FileManager.default.copyItem(at: source, to: destination) }
    }

    private nonisolated static func isSymlink(_ url: URL) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType) == .typeSymbolicLink
    }

    private nonisolated static func safePath(_ path: String, under home: URL) -> Bool {
        let candidate = URL(fileURLWithPath: path).standardizedFileURL.path
        let root = home.standardizedFileURL.path.hasSuffix("/") ? home.standardizedFileURL.path : home.standardizedFileURL.path + "/"
        return candidate.hasPrefix(root)
    }

    private nonisolated static func relativePath(_ path: String, home: URL) -> String { String(path.dropFirst(home.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    private nonisolated static func receiptURL(home: URL) -> URL { home.appendingPathComponent(".config/yap/skill-install.json") }
    private nonisolated static func stateURL(home: URL) -> URL { home.appendingPathComponent(".config/yap/skill-state.json") }

    private nonisolated static func decodeReceipt(at url: URL, home: URL) -> Receipt? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        if let receipt = try? JSONDecoder().decode(Receipt.self, from: data) { return receipt }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["managed"] as? Bool == true else { return nil }
        let paths = knownPaths.map { home.appendingPathComponent($0).path }
            .filter { FileManager.default.fileExists(atPath: $0) || isSymlink(URL(fileURLWithPath: $0)) }
        return Receipt(managed: true, source: object["source"] as? String ?? source, installer: installer,
                       paths: paths, entries: [], operationId: nil, installedAt: "")
    }

    private nonisolated static func writeState(_ state: LifecycleState, home: URL) {
        do { try FileManager.default.createDirectory(at: stateURL(home: home).deletingLastPathComponent(), withIntermediateDirectories: true); try JSONEncoder().encode(state).write(to: stateURL(home: home), options: .atomic) } catch { }
    }

    private nonisolated static func run(_ installer: (node: String, script: String), _ arguments: [String], home: URL) throws -> (code: Int32, output: String) {
        let executable = installer.node
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = [installer.script] + arguments
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("yap-skill-output-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        let output = try FileHandle(forWritingTo: outputURL)
        defer { try? output.close(); try? FileManager.default.removeItem(at: outputURL) }
        process.standardOutput = output; process.standardError = output
        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = home.path
        environment["USERPROFILE"] = home.path
        environment["DISABLE_TELEMETRY"] = "1"
        let executableDirectory = URL(fileURLWithPath: executable).deletingLastPathComponent().path
        environment["PATH"] = executableDirectory + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        process.environment = environment
        try process.run(); process.waitUntilExit()
        let data = (try? Data(contentsOf: outputURL)) ?? Data()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}
