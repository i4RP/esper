import CoreGraphics
import Foundation
import IOKit

/// Polls the Caps Lock toggle state (and the clamshell/lid state) and emits a
/// `capsLockStateChanged` helper event whenever either changes. Drives the
/// sleep-guard feature on the Electron side: while Caps Lock is on, the app
/// keeps the Mac awake even with the lid closed (Capsomnia-style).
final class CapsLockMonitor {
    private var timer: Timer?
    private var lastCapsLockOn: Bool?
    private var lastClamshellClosed: Bool??

    private struct CapsLockPayload: Codable {
        let capsLockOn: Bool
        let clamshellClosed: Bool?
    }

    private struct CapsLockEvent: Codable {
        let type: String
        let payload: CapsLockPayload
        let timestamp: String?
    }

    func start() {
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.poll()
        }
        timer.tolerance = 0.05
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        HelperLogger.logRawToStderr("[CapsLockMonitor] polling started (250ms)\n")
        // Emit the initial state right away so the app can sync on startup.
        poll()
    }

    private func poll() {
        let capsLockOn = CGEventSource.flagsState(.hidSystemState).contains(.maskAlphaShift)
        let clamshellClosed = Self.readClamshellClosed()

        if lastCapsLockOn == capsLockOn, lastClamshellClosed == clamshellClosed {
            return
        }
        lastCapsLockOn = capsLockOn
        lastClamshellClosed = clamshellClosed

        let event = CapsLockEvent(
            type: "capsLockStateChanged",
            payload: CapsLockPayload(capsLockOn: capsLockOn, clamshellClosed: clamshellClosed),
            timestamp: ISO8601DateFormatter().string(from: Date())
        )
        do {
            let data = try JSONEncoder().encode(event)
            if let json = String(data: data, encoding: .utf8) {
                StdoutWriter.writeLine(json)
            }
        } catch {
            HelperLogger.logRawToStderr("[CapsLockMonitor] encode error: \(error)\n")
        }
    }

    /// Reads AppleClamshellState from IOPMrootDomain. nil when unavailable
    /// (e.g. desktop Macs).
    static func readClamshellClosed() -> Bool? {
        // Port 0 = default master port (works on all macOS versions; the
        // kIOMainPortDefault constant needs macOS 12+ at compile time).
        let service = IOServiceGetMatchingService(
            0, IOServiceMatching("IOPMrootDomain"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        guard
            let value = IORegistryEntryCreateCFProperty(
                service,
                "AppleClamshellState" as CFString,
                kCFAllocatorDefault,
                0
            )?.takeRetainedValue()
        else {
            return nil
        }

        if let boolValue = value as? Bool {
            return boolValue
        }
        return (value as? NSNumber)?.boolValue
    }
}
