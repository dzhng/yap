import AppKit
import YapControls

/**
 Puts a recording's prompt in the person's hands: the one owner of handing a prompt over, for
 every surface that offers one.

 A prompt is copied, pasted where the person is typing, or announced: copied with the notice
 that says to press ⌘V, which is how a take they finish arrives once it is complete. Pasting
 says the same when Accessibility does not let it type for them.
 */
@MainActor
final class PromptHandoff {
    enum Delivery: Equatable { case copy, paste, announce }

    /// A check driving this launch copies to a pasteboard of its own, never the person's.
    let paster = Paster(pasteboard: ControlsProbe.observed ? ControlsProbe.pasteboard : .general)
    private lazy var notice = PasteNotice()
    private var finished = FinishedTakePrompt()

    /// Asks the service for the prompt and hands it over as `delivery` says.
    func handOver(_ target: MediaTarget?, _ delivery: Delivery, from service: ServiceHost) async throws(ServiceFailure) {
        let text = try await service.call(
            "recording.prompt", target?.parameters ?? [:], as: PromptAnswer.self).text
        switch delivery {
        case .copy: paster.copy(text)
        case .announce:
            paster.copy(text)
            notice.show(Paster.Outcome.copied.notice!)
        case .paste:
            if let said = paster.paste(text).notice { notice.show(said) }
        }
    }

    /// The person stopped this take from these controls.
    func stopped(_ recordingId: String) { finished.stopped(recordingId) }

    /// The take whose prompt to announce now that it is complete, answered once.
    func finishedTake(_ take: ControlsState.TakeStatus?) -> String? { finished.observe(take) }

    private struct PromptAnswer: Decodable { let text: String }
}
