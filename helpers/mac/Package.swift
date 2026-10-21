// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "YapNative",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "YapCapture", targets: ["YapCapture"]),
        .library(name: "YapProtocol", targets: ["YapProtocol"]),
        .library(name: "YapInk", targets: ["YapInk"]),
        .executable(name: "yap-native", targets: ["YapNative"]),
    ],
    dependencies: [
        .package(path: "../denoise"),
        .package(path: "../stretch"),
        // Traits disabled so the NeMo text-normalization binary is never linked. Only the worker's
        // speech target uses it; the app's capture library never reaches it.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.7", traits: []),
    ],
    targets: [
        .target(
            name: "YapWire",
            dependencies: [
                "YapAudio", "YapCapture", "YapFrames",
                "YapMedia", "YapSpeech", "CLibArchive",
            ],
            linkerSettings: [.linkedLibrary("archive.2")]),
        .systemLibrary(name: "CLibArchive"),
        .target(name: "YapCapture", dependencies: ["YapMedia", "YapProtocol"], exclude: ["README.md"]),
        .target(name: "YapFrames", dependencies: ["YapMedia", "YapInk"], exclude: ["README.md"]),
        .target(name: "YapInk", exclude: ["README.md"]),
        .target(name: "YapAudio", dependencies: ["YapMedia", .product(name: "YapDenoise", package: "denoise"), .product(name: "YapStretch", package: "stretch")], exclude: ["README.md"]),
        .target(
            name: "YapSpeech",
            dependencies: [
                "YapAudio", "YapMedia",
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            exclude: ["README.md"]),
        .target(name: "YapProtocol"),
        .target(name: "YapMedia", exclude: ["README.md"]),
        .executableTarget(name: "CameraReproduction", dependencies: ["YapCapture", "YapMedia", "YapWire", "YapAudio"], path: "Tests/CameraReproduction"),
        .executableTarget(
            name: "YapCaptureTests",
            dependencies: ["YapCapture", "YapMedia", "YapWire", "YapAudio"],
            path: "Tests/YapCaptureTests", exclude: ["fixtures"]),
        .executableTarget(
            name: "YapFrameTests", dependencies: ["YapFrames", "YapMedia"],
            path: "Tests/YapFrameTests"),
        .executableTarget(
            name: "YapSpeechTests",
            dependencies: ["YapSpeech", "YapMedia", .product(name: "FluidAudio", package: "FluidAudio")],
            path: "Tests/YapSpeechTests"),
        .executableTarget(name: "YapCorrespondenceTests", dependencies: ["YapMedia"],
            path: "Tests/YapCorrespondenceTests"),
        .executableTarget(name: "YapSelectedAudioTests", dependencies: ["YapAudio", "YapMedia"], path: "Tests/SelectedAudio"),
        .executableTarget(name: "YapSourceAudioTests", dependencies: ["YapAudio", "YapMedia"], path: "Tests/SourceAudio"),
        .executableTarget(name: "YapCompositionAudioTests", dependencies: ["YapAudio", "YapMedia"], path: "Tests/CompositionAudio"),
        .executableTarget(name: "YapCompositionVideoTests", dependencies: ["YapWire"], path: "Tests/CompositionVideo"),
        .executableTarget(name: "YapAudioFileTests", dependencies: ["YapWire"], path: "Tests/AudioFile"),
        .executableTarget(name: "YapScalarTests", dependencies: ["YapMedia"], path: "Tests/ScalarProgram"),
        .executableTarget(name: "YapNative", dependencies: ["YapWire", "YapMedia"]),
    ]
)
