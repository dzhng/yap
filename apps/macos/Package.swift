// swift-tools-version: 6.0
import PackageDescription
import Foundation

let sparkle = ProcessInfo.processInfo.environment["YAP_SPARKLE_FRAMEWORK"] ?? "../../dist/sparkle/Sparkle.framework"
let sparkleDirectory = URL(fileURLWithPath: sparkle, relativeTo: URL(fileURLWithPath: #filePath).deletingLastPathComponent()).standardizedFileURL.deletingLastPathComponent().path

let package = Package(
    name: "Yap",
    platforms: [.macOS("26.0")],
    products: [.executable(name: "Yap", targets: ["Yap"])],
    dependencies: [.package(path: "../../helpers/mac")],
    targets: [
        .target(name: "YapControls", dependencies: [.product(name: "YapProtocol", package: "mac")]),
        .executableTarget(
            name: "Yap",
            dependencies: [
                "YapControls",
                .product(name: "YapCapture", package: "mac"),
                .product(name: "YapProtocol", package: "mac"),
            ],
            swiftSettings: [.unsafeFlags(["-F", sparkleDirectory])],
            linkerSettings: [.unsafeFlags(["-F", sparkleDirectory, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .executableTarget(
            name: "YapControlsTests", dependencies: ["YapControls"],
            path: "tests/YapControlsTests"),
    ]
)
