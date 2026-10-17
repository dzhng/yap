import Darwin
import Foundation
import YapMedia

/// Root cleanup is exclusive; one attempt is removed beneath its retained shared parent.
enum RenderWorkspace {
    static func clear(_ params: [String: Any]) throws {
        let removing = params["parent"] != nil
        guard Set(params.keys) == (removing ? ["expectedDirectory", "parent"] : ["expectedDirectory"]) else {
            throw NativeFailure(
                "INVALID_REQUEST", "Render cleanup requires its directory identity.")
        }
        let expected = try InodeIdentity(params["expectedDirectory"])
        try expected.check(3)
        try ManagedFiles.lockPrivateDirectory(3)
        if removing {
            guard let parent = params["parent"] as? [String: Any],
                Set(parent.keys) == ["expectedDirectory", "name"],
                let name = parent["name"] as? String, name.hasPrefix("render-"),
                name.utf8.count <= 255, !name.contains("/"), !name.contains("\0") else {
                throw NativeFailure("INVALID_REQUEST", "Render attempt requires one owned basename.")
            }
            try InodeIdentity(parent["expectedDirectory"]).check(4)
            try ManagedFiles.lockPrivateDirectory(4, shared: true)
            try ManagedFiles.removeOwnedDirectory(4, name, 3, expected)
        } else {
            try DirectoryContents.removeContents(3)
        }
    }
}
