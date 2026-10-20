/// Product requirements mirrored from protocol requirements.json and checked by RequirementsTests.
public enum Requirements {
    public static let strokeBytesPerSecond: Int64 = 6180
    public static let maximumTakeUs: Int64 = 43_200 * 1_000_000
    public static let maximumStrokeUs: Int64 = 300 * 1_000_000
}
