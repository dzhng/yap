import YapControls

func runFinishedTakePromptTests() {
    func take(_ id: String, _ state: String) -> ControlsState.TakeStatus {
        .init(id: id, state: state, interruptionReason: nil, sourceDurationUs: nil)
    }
    var prompt = FinishedTakePrompt()
    prompt.stopped("a")
    precondition(prompt.observe(take("a", "recording")) == nil, "A take still recording has no whole prompt yet")
    precondition(prompt.observe(take("a", "finalizing")) == nil, "A take still finishing has no whole prompt yet")
    precondition(prompt.observe(take("a", "complete")) == "a", "The take the person stopped hands its prompt over once complete")
    precondition(prompt.observe(take("a", "complete")) == nil, "A finished take hands its prompt over once")

    var elsewhere = FinishedTakePrompt()
    precondition(elsewhere.observe(take("b", "complete")) == nil, "A take stopped from anywhere else hands nothing over")

    var broken = FinishedTakePrompt()
    broken.stopped("c")
    precondition(broken.observe(take("c", "interrupted")) == nil, "An interrupted take hands nothing over")
    broken.stopped("d")
    precondition(broken.observe(take("d", "canceled")) == nil, "A discarded take hands nothing over")
    precondition(broken.observe(take("d", "complete")) == nil, "A take that settled once never hands over later")
    print("PASS the take a person stops hands its prompt over once it is complete")
}
