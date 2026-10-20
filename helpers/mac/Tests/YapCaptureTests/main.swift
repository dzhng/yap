import Foundation

if let output = ProcessInfo.processInfo.environment["YAP_CURSOR_HOLD_FIXTURES"] {
    try writeCursorHoldFixtures(to: URL(fileURLWithPath: output))
} else if ProcessInfo.processInfo.environment["YAP_CHANGE_ONLY_TESTS"] != nil {
    try runChangeOnlyCursorTests()
} else if ProcessInfo.processInfo.environment["YAP_CURSOR_TESTS"] != nil {
    try runCursorGeometryTests()
    try runSchema4HeaderTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_LONG_STROKE_FIXTURE"] {
    try writeLongStrokeFixture(to: URL(fileURLWithPath: output),
        strokeCount: Int(ProcessInfo.processInfo.environment["YAP_LONG_STROKE_COUNT"] ?? "1")!,
        sourceID: ProcessInfo.processInfo.environment["YAP_LONG_STROKE_SOURCE_ID"] ?? "schema3-long-stroke")
    if let video = ProcessInfo.processInfo.environment["YAP_LONG_STROKE_VIDEO"] {
        try await RecoveryFixture.writeVariableDurationVideo(
            to: URL(fileURLWithPath: video), timesUs: [0, 10_000_000], endUs: 11_000_000)
    }
} else if ProcessInfo.processInfo.environment["YAP_MARK_RECOGNIZER_TESTS"] != nil {
    runMarkRecognizerTests()
} else if ProcessInfo.processInfo.environment["YAP_SCHEMA4_SUMMARY"] != nil {
    try await runSchema4SummaryTests()
} else if ProcessInfo.processInfo.environment["YAP_SCHEMA4_TESTS"] != nil {
    runMarkRecognizerTests()
    try runSchema4HeaderTests()
    try await runSchema4StrokeTests()
    try await runSchema4SummaryTests()
} else if ProcessInfo.processInfo.environment["YAP_REQUIREMENTS"] != nil {
    try runRequirementsTests()
} else if ProcessInfo.processInfo.environment["YAP_CAPTURE_CLOCK"] != nil {
    runCaptureClockTests()
} else if ProcessInfo.processInfo.environment["YAP_LIVE_PCM_TIMING"] != nil {
    try await runLivePCMTimingTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_PRIMARY_CAMERA_INPUT_OUTPUT"] {
    try await runPrimaryCameraInputTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_PRIMARY_CAMERA_PUBLICATION_OUTPUT"] {
    try await runPrimaryCameraPublicationTests(output: output)
} else if ProcessInfo.processInfo.environment["YAP_CAPTURE_INPUT_AUTHORITY"] != nil {
    try await runCaptureInputAuthorityTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_RETAINED_CAMERA_PUBLICATION_OUTPUT"] {
    try await runRetainedCameraPublicationCost(output: output,
        donorPath: ProcessInfo.processInfo.environment["YAP_RETAINED_CAMERA_PUBLICATION_SOURCE"] ?? "")
} else if let output = ProcessInfo.processInfo.environment["YAP_CANCELED_CAMERA_CONTINUATION_OUTPUT"] {
    try await runCanceledCameraContinuationTest(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_CONTINUATION_CLOSURE_OUTPUT"] {
    try await runCameraContinuationClosureTest(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_SOURCE_PUBLICATION_OVERLAP_OUTPUT"] {
    try await runSourcePublicationOverlapTest(output: output)
} else if ProcessInfo.processInfo.environment["YAP_CAMERA_PUBLICATION_OVERLAP"] != nil {
    try await runProbeCameraPixelPublicationTests(widths: [32])
    try await runCameraPublicationClippedSupportTest()
    try await runCameraPublicationPrefixTests()
    try await runCameraPublicationErrorOrderTest()
    try runCameraPublicationDecisionTests()
    try await runCameraPublicationReplayTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_EMPTY_CAPTURE_RECOVERY_OUTPUT"] {
    try await runEmptyCaptureRecoveryTests(output: output)
} else if ProcessInfo.processInfo.environment["YAP_SOURCE_RECOVERY_CHILD"] != nil {
    try await runSourcePublicationCrashChild()
} else if let output = ProcessInfo.processInfo.environment["YAP_SOURCE_RECOVERY_OUTPUT"] {
    try await runSourcePublicationRecoveryTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_SHARED_INTERRUPTION_OUTPUT"] {
    try await runSharedInterruptionDuringFinishTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_AVAILABILITY_OUTPUT"] {
    try await runCameraAvailabilityTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_CLOCK_OUTPUT"] {
    try await runIndependentCameraClockTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_WITHOUT_PRIMARY_OUTPUT"] {
    try await runCameraWithoutPrimaryTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_INDEPENDENT_PUBLICATION_OUTPUT"] {
    try await runIndependentPublicationTests(output: output)
    try await runNativeCaptureInputTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_PROJECT_OUTPUT"] {
    try await runCameraProjectFixture(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_SOURCE_ADMISSION_OUTPUT"] {
  try await runCameraSourceAdmissionTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_SELECTED_CAMERA_INPUT_OUTPUT"] {
  try await runSelectedCameraInputTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_LIVE_PUBLICATION_OUTPUT"] {
  try await runCameraLivePublicationTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_CAMERA_SOURCE_PUBLICATION_OUTPUT"] {
  try await runCameraSourcePublicationTests(output: output)
} else if ProcessInfo.processInfo.environment["YAP_CAMERA_PIXELS"] != nil {
  try await runProbeCameraPixelPublicationTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_SELECTED_STOP_SCALE_OUTPUT"] {
  try await runSelectedCaptureStopScale(output: output, sourcePath: ProcessInfo.processInfo.environment["YAP_SELECTED_STOP_SCALE_SOURCE"] ?? "")
} else if let output = ProcessInfo.processInfo.environment["YAP_SELECTED_STOP_OUTPUT"] {
  try await runSelectedCaptureStopTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_PROBE_REPLAY_OUTPUT"] {
  try await runProbeCameraReplayTests(source: ProcessInfo.processInfo.environment["YAP_PROBE_REPLAY_INPUT"] ?? "", output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_SELECTED_FRAME_OUTPUT"] {
  try await runProbeFrameBoundary(output: output, sourcePath: ProcessInfo.processInfo.environment["YAP_SELECTED_ADMITTED_SOURCE"])
} else if let output = ProcessInfo.processInfo.environment["YAP_SELECTED_PROBE_OUTPUT"] {
  try runSelectedCaptureRequestTests()
  try await runSelectedCaptureMediaTests(output: output,
    corpus: ProcessInfo.processInfo.environment["YAP_CAPTURE_GAP_CORPUS"] ?? "")
} else if ProcessInfo.processInfo.environment["YAP_JOURNAL_LEASE_CHILD"] != nil {
  runCaptureJournalLeaseChild(directory: CommandLine.arguments[1])
} else if let output = ProcessInfo.processInfo.environment["YAP_NATIVE_PUBLICATION_OUTPUT"] {
  try await runNativeCapturePublicationProbe(output: output,
    corpus: ProcessInfo.processInfo.environment["YAP_CAPTURE_GAP_CORPUS"] ?? "")
} else if ProcessInfo.processInfo.environment["YAP_MATERIALIZER_TESTS"] != nil {
  try await runCaptureAudioMaterializerTests()
} else if let output = ProcessInfo.processInfo.environment["YAP_MATERIALIZER_DESCRIPTOR_OUTPUT"] {
  try await runCaptureAudioMaterializerDescriptorProbe(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_MATERIALIZER_OUTPUT"] {
  try await runCaptureAudioMaterializerScaleProbe(output: output, runs: Int(ProcessInfo.processInfo.environment["YAP_MATERIALIZER_RUNS"] ?? "128")!)
} else if let output = ProcessInfo.processInfo.environment["YAP_PUBLICATION_OUTPUT"] {
  try await runCaptureAudioPublicationTests(output: output)
} else if let output = ProcessInfo.processInfo.environment["YAP_AUDIO_FORMAT_OUTPUT"] {
  try await runCaptureAudioFormatProbe(
    output: output,
    corpus: ProcessInfo.processInfo.environment["YAP_CAPTURE_GAP_CORPUS"] ?? "",
    stereoFixture: ProcessInfo.processInfo.environment["YAP_CAPTURE_FORMAT_STEREO"] ?? "")
} else if let output = ProcessInfo.processInfo.environment["YAP_JOURNAL_FAILURE_OUTPUT"] {
  try await runCaptureJournalFailureProbe(
    output: output,
    corpus: ProcessInfo.processInfo.environment["YAP_CAPTURE_GAP_CORPUS"] ?? "")
} else if let output = ProcessInfo.processInfo.environment["YAP_PCM_WINDOWS_OUTPUT"] {
  try await runPCMAdmissionWindows(
    output: output,
    canonical: ProcessInfo.processInfo.environment["YAP_PCM_WINDOWS_CANONICAL"] ?? "")
} else if let output = ProcessInfo.processInfo.environment["YAP_PCM_ADMISSION_OUTPUT"] {
  try await runPCMAdmissionProbe(
    output: output,
    canonical: ProcessInfo.processInfo.environment["YAP_PCM_ADMISSION_CANONICAL"] ?? "")
} else if let output = ProcessInfo.processInfo.environment["YAP_CAPTURE_GAP_OUTPUT"],
  let corpus = ProcessInfo.processInfo.environment["YAP_CAPTURE_GAP_CORPUS"]
{
  try await runCaptureAudioGapProbe(output: output, corpus: corpus)
} else if ProcessInfo.processInfo.environment["YAP_JOURNAL_TESTS"] != nil {
  try await runCaptureJournalTests()
  try runCaptureJournalLeaseTests()
  try runPCMJournalTests()
} else if ProcessInfo.processInfo.environment["YAP_RECOVERY_TESTS"] != nil {
  try await runFractionalRecoveryDurationTest()
  try await runSourcePublicationRecoveryTests()
  try await runEmptyCaptureRecoveryTests()
  try await runCanonicalRecoveryTests()
  try await runMediaRecoveryTests()
} else {
  try runRequirementsTests()
  try runSchema4HeaderTests()
  try await runSchema4StrokeTests()
  try await runSchema4SummaryTests()
  runMarkRecognizerTests()
  try await runLivePCMTimingTests()
  try await runCaptureInputAuthorityTests()
  try await runPrimaryCameraInputTests()
  try await runPrimaryCameraPublicationTests()
  try await runCameraSourceAdmissionTests()
  try await runProbeCameraPixelPublicationTests()
  try runSelectedCaptureRequestTests()
  try await runFractionalRecoveryDurationTest()
  try await runCaptureDurationTests()
  try await runNativeCaptureInputTests()
  try await runSelectedCameraInputTests()
  try await runCameraLivePublicationTests()
  try await runCameraSourcePublicationTests()
  try await runCameraContinuationClosureTest()
  try await runCanceledCameraContinuationTest()
  try await runSourcePublicationOverlapTest()
  try await runIndependentPublicationTests()
  try await runSharedInterruptionDuringFinishTests()
  try await runSourcePublicationRecoveryTests()
  try await runEmptyCaptureRecoveryTests()
  try await runCanonicalRecoveryTests()
  try await runCaptureTerminationTests()
  try await runCaptureWriterTests()
  try await runIdleScreenFragmentTest()
  try await runLateScreenFrameTest()
  runCaptureClockTests()
  try await runIndependentCameraClockTests()
  try await runCameraAvailabilityTests()
  try await runCameraWithoutPrimaryTests()
  await runHeldTailFrameTests()
  try await runCaptureJournalTests()
  try runCaptureJournalLeaseTests()
  try runPCMJournalTests()
  try await runCaptureAudioMaterializerTests()
  try await runCaptureAudioPublicationTests()
  try await runDeferredPauseTests()
  try runCursorGeometryTests()
  try await runMediaRecoveryTests()
  runCaptureExclusionTests()
}
