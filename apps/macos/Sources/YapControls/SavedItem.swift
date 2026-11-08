import Foundation

/// One explicit action beside observed saved-media facts. It carries the same dispatch identity
/// and admission result wherever those facts appear.
public struct PresentedControlsAction: Equatable, Sendable {
    public init(_ action: ControlsAction, _ title: String, enabled: Bool) {
        self.action = action
        self.title = title
        self.enabled = enabled
    }
    public let action: ControlsAction
    public let title: String
    public let enabled: Bool
}

/// Read-only saved-media presentation shared by Library and native semantic probes.
public struct SavedItem: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case recording, imported, project, export, message }
    public let id: String
    public let kind: Kind
    public let title: String
    /// A short label beside the title naming where the item came from, such as "Imported".
    public let badge: String?
    public let status: String?
    public let details: [String]
    /// Explanation beneath the metadata, separate from the short state label.
    public let message: String?
    public let actions: [PresentedControlsAction]
    /// Something about this item needs the person: a failure, an unconfirmed request, a retry.
    public let attention: Bool
    /// The action clicking the row performs (playing a recording, previewing a project), if any.
    private let opens: ControlsAction?
    /// The row's open action while it is offered and enabled; the row is clickable only then.
    public var open: ControlsAction? {
        guard let opens, actions.contains(where: { $0.action == opens && $0.enabled }) else { return nil }
        return opens
    }
    public init(id: String, kind: Kind, title: String, badge: String? = nil, status: String? = nil,
                details: [String] = [], message: String? = nil, actions: [PresentedControlsAction] = [],
                opens: ControlsAction? = nil, attention: Bool = false) {
        self.id = id
        self.kind = kind
        self.title = title
        self.badge = badge
        self.status = status
        self.details = details
        self.message = message
        self.actions = actions
        self.opens = opens
        self.attention = attention
    }
}

public struct SavedPage: Equatable, Sendable {
    public let items: [SavedItem]
    public let actions: [PresentedControlsAction]
    public init(items: [SavedItem], actions: [PresentedControlsAction] = []) {
        self.items = items
        self.actions = actions
    }
}
