import Foundation

/// Everything this app installs into the account's home: the `yap` command with its PATH block
/// (`CommandArtifact`) and the consumer skill (`SkillArtifact`). One owner answers every `cli.*`
/// and `skill.*` operation, reconciles both at launch, and turns both on or off together.
@MainActor
final class HomeLifecycle: AgentSetup {
    private let skill: SkillArtifact
    private let command: CommandArtifact

    init(home: URL = accountHome(), resources: AppResources = .main, inApplications: Bool) {
        skill = SkillArtifact(home: home, resources: resources)
        command = CommandArtifact(home: home, launcher: resources.launcher, inApplications: inApplications)
    }

    func handle(_ operation: String) -> Result<Data, ServiceFailure> {
        switch operation {
        case "cli.status": return .success(command.status().json)
        case "cli.install": return .success(command.install().json)
        case "cli.uninstall": return .success(command.uninstall().json)
        case _ where operation.hasPrefix("skill."): return skill.handle(operation)
        default:
            return .failure(ServiceFailure(code: "UNKNOWN_OPERATION", message: "Unknown home operation \(operation)"))
        }
    }

    /// Called on the main thread once a background skill install or removal settles, so the
    /// Settings status line can stop reading the running state.
    var settled: (() -> Void)?

    /// Install or remove both: at launch and from Settings. The command is synchronous; the skill
    /// settles later.
    func setEnabled(_ enabled: Bool) {
        _ = enabled ? command.install() : command.uninstall()
        skill.setEnabled(enabled) { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.settled?() } }
        }
    }

    /// One line for Settings, from what is on disk now; it runs no installer.
    func summary() -> String {
        let cli = command.status()
        if cli.state == .installed, cli.onPath, skill.summaryState == "ready" {
            return "yap command + skill, kept current. All good ✓"
        }
        let commandText: String
        switch cli.state {
        case .installed: commandText = cli.onPath ? "Command installed" : "Command installed, not on PATH"
        case .missing: commandText = "Command not installed"
        case .different: commandText = "A different command is at \(cli.path)"
        case .unavailable: commandText = "Command unavailable in this build"
        case .needs_attention: commandText = "Command needs attention"
        }
        let skillText: String
        switch skill.summaryState {
        case "installed": skillText = "skill installed"
        case "running": skillText = "skill updating"
        case "failed": skillText = "skill needs attention"
        default: skillText = "skill not installed"
        }
        return "\(commandText); \(skillText)."
    }
}
