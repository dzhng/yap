import Foundation
@preconcurrency import ScreenCaptureKit

/**
 What a display or region take leaves out of the content it records.

 A take of a whole display would otherwise record the recorder itself: the countdown that starts
 it, the floating controls that run it, and any window of this app that happens to be open. None
 of that belongs in the recording, so display and region capture exclude this application's own
 windows. Window capture already records the one window that was chosen and excludes nothing.
 */
public enum CaptureExclusion {
    /**
     This application's own entries among the applications sharing the screen, by bundle identity.

     A process with no bundle identity of its own — a bare helper executable rather than an app —
     excludes nothing, because a take that guessed at a name could silently leave somebody else's
     windows out of the recording.
     */
    public static func ownApplications<Application>(
        among applications: [Application], bundleIdentifier own: String?,
        identity: (Application) -> String
    ) -> [Application] {
        guard let own, !own.isEmpty else { return [] }
        return applications.filter { identity($0) == own }
    }

    /**
     A whole display, minus this application's own windows: what a take of that display records,
     and what the source chooser's picture of it shows.

     Shareable content only names applications that have something on screen, so an app showing
     nothing has nothing here to exclude; the panels a take floats over the screen keep themselves
     out of every capture instead, unless the take later confirms it leaves them out.
     */
    public static func displayFilter(_ display: SCDisplay, in content: SCShareableContent) -> SCContentFilter {
        ownExcludingFilter(display, in: content) ?? SCContentFilter(display: display, excludingWindows: [])
    }

    /// The same display minus this application, or nil while shareable content names nothing of
    /// this application's to leave out.
    public static func ownExcludingFilter(_ display: SCDisplay, in content: SCShareableContent) -> SCContentFilter? {
        let own = ownApplications(
            among: content.applications, bundleIdentifier: Bundle.main.bundleIdentifier,
            identity: \.bundleIdentifier)
        guard !own.isEmpty else { return nil }
        return SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
    }
}
