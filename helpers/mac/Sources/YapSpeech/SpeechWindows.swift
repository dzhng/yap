import Foundation
import YapMedia

public struct SpeechExecution: Codable, Sendable, Equatable {
    public static let recipeIdentifier = "source-windows-20s-context4s-guard1s-v3"
    public let executionRange: ExactRange?
    public let context: SpeechContext
    public let recipe: String
    enum CodingKeys: String, CodingKey { case executionRange, context, recipe }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(executionRange, forKey: .executionRange)
        try container.encode(context, forKey: .context)
        try container.encode(recipe, forKey: .recipe)
    }
    public init(executionRange: ExactRange? = nil, context: SpeechContext = SpeechContext(), recipe: String = SpeechExecution.recipeIdentifier) {
        self.executionRange = executionRange; self.context = context; self.recipe = recipe
    }
}

public struct SpeechContext: Codable, Sendable, Equatable {
    public let beforeUs: Int64
    public let afterUs: Int64
    public init(beforeUs: Int64 = 0, afterUs: Int64 = 0) { self.beforeUs = beforeUs; self.afterUs = afterUs }
}

package struct SpeechWindow: Codable, Sendable {
    package let owned: ExactRange
    package let decoded: ExactRange
}

package enum SpeechWindows {
    static let windowUs: Int64 = 20_000_000

    package static func plan(available: [ExactRange], execution: SpeechExecution) throws -> [SpeechWindow] {
        guard execution.recipe == SpeechExecution.recipeIdentifier, execution.context.beforeUs >= 0, execution.context.afterUs >= 0,
              execution.context.beforeUs <= 4_000_000, execution.context.afterUs <= 4_000_000,
              execution.executionRange != nil || execution.context.beforeUs == 0 && execution.context.afterUs == 0 else {
            throw NativeFailure("INVALID_REQUEST", "Invalid speech execution recipe or context.")
        }
        var decodeRequest: ExactRange?
        if let range = execution.executionRange {
            let start = try range.startUs.subtract(ExactTime(Int128(execution.context.beforeUs)))
            decodeRequest = ExactRange(startUs: try start.compare(ExactTime(0)) == .orderedAscending ? ExactTime(0) : start,
                endUs: try range.endUs.adding(ExactTime(Int128(execution.context.afterUs))))
        }
        var windows: [SpeechWindow] = []
        for support in available {
            let admitted: ExactRange
            if let range = execution.executionRange {
                guard let intersection = try support.intersection(range) else { continue }
                admitted = intersection
            } else { admitted = support }
            let decodeSupport = try decodeRequest.flatMap({ try support.intersection($0) }) ?? support
            var at = admitted.startUs
            while try at.compare(admitted.endUs) == .orderedAscending {
                let next = try at.adding(ExactTime(Int128(windowUs)))
                let end = try next.compare(admitted.endUs) == .orderedDescending ? admitted.endUs : next
                let lower = try at.subtract(ExactTime(Int128(SpeechBoundaryMerge.contextUs)))
                let upper = try end.adding(ExactTime(Int128(SpeechBoundaryMerge.contextUs)))
                windows.append(SpeechWindow(owned: ExactRange(startUs: at, endUs: end), decoded: ExactRange(
                    startUs: try at == admitted.startUs ? decodeSupport.startUs : lower.compare(decodeSupport.startUs) == .orderedAscending ? decodeSupport.startUs : lower,
                    endUs: try end == admitted.endUs ? decodeSupport.endUs : upper.compare(decodeSupport.endUs) == .orderedDescending ? decodeSupport.endUs : upper)))
                at = end
            }
        }
        return windows
    }
}

/// Comparison operands are independent observations, never replacement text or timestamps.
package struct SpeechObservation: Sendable {
    let text: String
    let source: TimeSpan
    package init(text: String, source: TimeSpan) { self.text = text; self.source = source }
}

package struct SpeechBoundaryPair: Codable, Equatable, Sendable {
    package enum Side: String, Codable, Sendable { case left, right }
    let left: Int
    let right: Int
    let selected: Side
    package init(left: Int, right: Int, selected: Side) { self.left = left; self.right = right; self.selected = selected }
}

package struct SpeechBoundaryResolution: Codable, Sendable {
    let boundaryUs: ExactTime
    let shared: ExactRange
    package let pairs: [SpeechBoundaryPair]
    /// Guarded observations with no unique, order-consistent peer. Each keeps its provisional owner:
    /// the window whose core holds its start.
    package let unresolved: [SpeechBoundaryObservation]
}

package struct SpeechBoundaryObservation: Codable, Equatable, Sendable {
    let side: SpeechBoundaryPair.Side
    let index: Int
    package init(_ side: SpeechBoundaryPair.Side, _ index: Int) { self.side = side; self.index = index }
}

/// Correspondence is unique order within exact shared decoded support. Estimated intervals are
/// not physical truth, so lexical matching never clamps or shifts them. Points require exact peers.
/// A guarded observation without a unique peer is reported unresolved, never refused or dropped.
package enum SpeechBoundaryMerge {
    static let contextUs: Int64 = 4_000_000
    static let guardUs: Int64 = 1_000_000

    package static func resolve(left: [SpeechObservation], right: [SpeechObservation],
        boundaryUs: ExactTime, shared: ExactRange) throws -> SpeechBoundaryResolution
    {
        let guardStart = try boundaryUs.subtract(ExactTime(Int128(guardUs)))
        let guardEnd = try boundaryUs.adding(ExactTime(Int128(guardUs)))
        func intersects(_ word: SpeechObservation, _ startUs: ExactTime, _ endUs: ExactTime) throws -> Bool {
            let start = ExactTime(Int128(word.source.startUs)), end = ExactTime(Int128(word.source.endUs))
            if start == end { return try start.compare(startUs) != .orderedAscending && start.compare(endUs) == .orderedAscending }
            return try start.compare(endUs) == .orderedAscending && end.compare(startUs) == .orderedDescending
        }
        func key(_ word: SpeechObservation) -> String {
            let trimmed = word.text.trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines)).lowercased()
            return trimmed.isEmpty ? word.text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() : trimmed
        }
        let a = try left.indices.filter { try intersects(left[$0], shared.startUs, shared.endUs) }
        let b = try right.indices.filter { try intersects(right[$0], shared.startUs, shared.endUs) }
        func equal(_ i: Int, _ j: Int) -> Bool {
            let lhs = left[a[i]], rhs = right[b[j]]
            let point = lhs.source.startUs == lhs.source.endUs || rhs.source.startUs == rhs.source.endUs
            return key(lhs) == key(rhs) && (!point || lhs.source == rhs.source)
        }
        let correspondence = OrderedCorrespondence.resolve(leftCount: a.count, rightCount: b.count, equal: equal)
        var matches: [Int: Int] = [:]
        var openLeft = Set<Int>(), openRight = Set<Int>()
        for (position, index) in a.enumerated() where try intersects(left[index], guardStart, guardEnd) {
            let row = correspondence.left[position]
            if row.indices.count == 1 && !row.omissionPossible { matches[index] = b[row.indices[0]] } else { openLeft.insert(index) }
        }
        for (position, index) in b.enumerated() where try intersects(right[index], guardStart, guardEnd) {
            let row = correspondence.right[position]
            guard row.indices.count == 1 && !row.omissionPossible else { openRight.insert(index); continue }
            let leftIndex = a[row.indices[0]]
            if openLeft.contains(leftIndex) { openRight.insert(index); continue }
            if let existing = matches[leftIndex], existing != index {
                openLeft.insert(leftIndex); openRight.formUnion([existing, index]); matches[leftIndex] = nil; continue
            }
            matches[leftIndex] = index
        }
        // An observation guarded by the seam but outside shared decoded support cannot have a peer.
        for index in left.indices where try intersects(left[index], guardStart, guardEnd) && !a.contains(index) { openLeft.insert(index) }
        for index in right.indices where try intersects(right[index], guardStart, guardEnd) && !b.contains(index) { openRight.insert(index) }
        var previousRight = -1
        var pairs: [SpeechBoundaryPair] = []
        for leftIndex in matches.keys.sorted() {
            let rightIndex = matches[leftIndex]!
            // A pair with an ambiguous member, or one that crosses an accepted pair, is not unique.
            guard !openRight.contains(rightIndex), rightIndex > previousRight else {
                openLeft.insert(leftIndex); openRight.insert(rightIndex); continue
            }
            previousRight = rightIndex
            let leftOwns = try ExactTime(Int128(left[leftIndex].source.startUs)).compare(boundaryUs) == .orderedAscending
            let rightOwns = try ExactTime(Int128(right[rightIndex].source.startUs)).compare(boundaryUs) != .orderedAscending
            pairs.append(SpeechBoundaryPair(left: leftIndex, right: rightIndex,
                selected: !leftOwns && rightOwns ? .right : .left))
        }
        return SpeechBoundaryResolution(boundaryUs: boundaryUs, shared: shared, pairs: pairs,
            unresolved: openLeft.sorted().map { SpeechBoundaryObservation(.left, $0) }
                + openRight.sorted().map { SpeechBoundaryObservation(.right, $0) })
    }
}
