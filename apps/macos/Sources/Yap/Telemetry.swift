import Foundation
import YapControls

/// Handles anonymous install telemetry. Sends one ping on first launch to count unique installs.
///
/// Privacy guarantees:
/// - The install ID is a random UUID with no connection to personal data
/// - Only the install ID, app version, and platform are sent
/// - The ping is sent exactly once, on first launch
/// - Telemetry is disabled when YAP_NO_TELEMETRY=1 is set in the environment
/// - No IP addresses are logged server-side
///
/// See TELEMETRY.md in the repository root for full documentation.
@MainActor
final class Telemetry {
    private let preferences: Preferences
    private let endpoint = "https://justyap.io/api/install"
    private let version: String

    init(preferences: Preferences) {
        self.preferences = preferences
        self.version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    }

    /// Whether telemetry is disabled via environment variable.
    private var isDisabled: Bool {
        ProcessInfo.processInfo.environment["YAP_NO_TELEMETRY"] == "1"
    }

    /// Sends the first-launch ping if not already sent and not disabled.
    /// Called once during app startup; failures are silently ignored.
    func sendFirstLaunchPingIfNeeded() {
        guard !isDisabled else {
            diagnostic("telemetry disabled via YAP_NO_TELEMETRY")
            return
        }
        guard !preferences.telemetryPingSent else { return }

        let installId = preferences.telemetryInstallId
        let body: [String: Any] = [
            "installId": installId,
            "version": version,
            "platform": "macos",
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body),
              let url = URL(string: endpoint) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData
        request.timeoutInterval = 10

        Task.detached(priority: .utility) { [preferences] in
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      httpResponse.statusCode == 200 else { return }

                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   json["ok"] as? Bool == true {
                    await MainActor.run { preferences.telemetryPingSent = true }
                    diagnostic("telemetry: first-launch ping sent")
                }
            } catch {
                // Silently ignore network failures; will retry on next launch
            }
        }
    }
}
