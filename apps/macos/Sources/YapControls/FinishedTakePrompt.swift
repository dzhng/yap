/// Which finished take's prompt goes to the person on its own, and when: the take they stopped
/// from these controls, once it settles complete, so the prompt describes the whole take. A take
/// stopped from anywhere else, or one that ends interrupted or discarded, hands nothing over.
public struct FinishedTakePrompt: Sendable, Equatable {
    private var stopped: String?

    public init() {}

    /// The person stopped this take from the menu, the floating controls or the shortcut.
    public mutating func stopped(_ recordingId: String) {
        stopped = recordingId
    }

    /// The take whose prompt to hand over now, answered once.
    public mutating func observe(_ take: ControlsState.TakeStatus?) -> String? {
        guard let take, take.id == stopped,
            ["complete", "interrupted", "canceled"].contains(take.state)
        else { return nil }
        stopped = nil
        return take.state == "complete" ? take.id : nil
    }
}
