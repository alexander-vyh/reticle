# SwiftUI Unification Design

**Date:** 2026-03-05
**Status:** Approved
**Goal:** Replace Electron tray app and meeting popup with native SwiftUI, unifying all UI into a single app bundle plus a standalone meeting popup executable.

## Problem

Three disconnected UI components exist today:

1. **Electron tray app** (`tray/`) — menu bar icon, service monitoring, notifications
2. **SwiftUI management app** (`reticle/Sources/Reticle/`) — People, Feedback, sidebar nav
3. **Electron meeting popup** (`meeting-popup.html`, `meeting-popup-window.js`) — transparent floating window with countdown, collapse-to-pill

These don't talk to each other. The SwiftUI app has no launcher, no tray integration, and no login item. The Electron tray has no way to open the SwiftUI app. The meeting popup is spawned by `meeting-alert-monitor.js` as a separate Electron process.

## Decision: All SwiftUI

After evaluating Electron, SwiftUI, and Tauri:

- **SwiftUI** wins on native feel, memory footprint, and macOS API access (MenuBarExtra, NSPanel, SMAppService, CoreAudio)
- **Electron** has cross-platform potential but adds ~200MB runtime per process, no native menu bar extra
- **Tauri** is lighter than Electron but still wraps a WebView; less native than SwiftUI for macOS-specific features

Reticle is a single-user macOS tool. Cross-platform is not a near-term need. SwiftUI is the right choice.

## Architecture

### Two Executables

```
reticle/
  Package.swift
  Sources/
    Reticle/           # Main app: tray + management window
      ReticleApp.swift
      AppState.swift
      ServiceStore.swift
      ContentView.swift
      TrayMenu.swift
      Views/
        PeopleView.swift
        FeedbackView.swift
      Services/
        GatewayClient.swift
        ServiceManager.swift
        ReticleIcon.swift
    MeetingPopup/      # Standalone popup executable
      MeetingPopupApp.swift
      PopupWindow.swift
      PillView.swift
      Models.swift
```

**Reticle.app** — The main app. Contains the MenuBarExtra (tray icon), the management window (People, Feedback, To-dos, Goals), service monitoring, and notification dispatch. Runs as an LSUIElement (no dock icon by default). Login item via SMAppService.

**MeetingPopup** — Standalone executable. Spawned by `meeting-alert-monitor.js` with meeting data passed as a base64-encoded CLI argument. Renders as a floating NSPanel. No dock icon. Exits when dismissed or meeting ends.

### Package.swift

```swift
let package = Package(
    name: "Reticle",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Reticle", path: "Sources/Reticle"),
        .executableTarget(name: "MeetingPopup", path: "Sources/MeetingPopup"),
    ]
)
```

## App Lifecycle

### Startup

1. `Reticle.app` launches at login via `SMAppService.mainApp.register()`
2. App starts as LSUIElement — no dock icon, no main window
3. MenuBarExtra appears in menu bar with reticle icon
4. ServiceStore begins polling launchctl and heartbeat files for service health

### Opening the Management Window

Three triggers:
- Click "Open Reticle" in tray menu
- Run `Reticle.app` again (second launch detected via `applicationShouldHandleReopen`)
- Keyboard shortcut (if configured)

When management window opens:
- `NSApp.setActivationPolicy(.regular)` — app appears in dock
- WindowGroup scene becomes visible
- `NSApp.activate()` brings window to front

When management window closes:
- Intercept close via NSWindowDelegate — hide instead of close
- `NSApp.setActivationPolicy(.accessory)` — remove from dock
- App continues running as tray-only

### Single Instance

`applicationShouldHandleReopen(_:hasVisibleWindows:)` handles second-launch:
- If management window is hidden, show it
- If already visible, bring to front
- Never create a second instance

## Tray Icon (MenuBarExtra)

### Icon Rendering

Port the 5-layer SVG rendering from `tray/icons.js` to SwiftUI `Canvas`:

1. **Outer ring** with 4 cardinal gap masks (12 o'clock, 3, 6, 9)
2. **Status fill circle** — ambient color indicating overall health
3. **Inner arcs** — two opposing 90-degree arcs (rotating during spin animation)
4. **Center star** — 4-point star rendered with bezier curves
5. **Spin animation** — 12-frame rotation at 80ms intervals during service transitions

The icon is 22x22 points (menu bar standard). Rendered via `Canvas` into an `Image` for the MenuBarExtra label.

### Tray Menu

```
Open Reticle              ⌘R
──────────────────────────
Services
  ● Gmail Monitor         Running
  ● Slack Monitor         Running
  ○ Meeting Alerts        Stopped
  ● Follow-up Checker     Running
──────────────────────────
Start All
Restart All
──────────────────────────
Feedback Stats
  This week: 3 delivered, 1 skipped
  This month: 12 delivered, 4 skipped
──────────────────────────
Start at Login            ✓
Quit Reticle
```

### Service Management

`ServiceManager.swift` replaces `tray/service-manager.js`:

```swift
class ServiceManager {
    func list() async -> [(label: String, pid: Int?, exitCode: Int?)]
    func start(label: String) async throws
    func stop(label: String) async throws
    func restart(label: String) async throws
}
```

Implementation uses `Process` to call `launchctl list`, `launchctl kickstart`, `launchctl kill SIGTERM`, `launchctl kickstart -k`. Heartbeat health read from `~/.reticle/logs/*-heartbeat.json`.

### Notifications

Use `UNUserNotificationCenter` for native macOS notifications. Replaces Electron's `new Notification()`. Same cooldown deduplication logic (one notification per service per 5 minutes).

## Management Window

The existing `ContentView.swift` transfers unchanged. NavigationSplitView with sidebar:

| Section | Status | View |
|---------|--------|------|
| People | Implemented | PeopleView — CRUD via GatewayClient |
| Feedback | Implemented | FeedbackView — candidates, deliver/skip, stats |
| Messages | Stub | Coming Soon |
| To-dos | Stub | Coming Soon |
| Goals | Stub | Coming Soon |

### Hide-Not-Close Behavior

A `WindowAccessor` background view attaches an NSWindowDelegate that intercepts `windowShouldClose` and calls `window.orderOut(nil)` instead. This keeps the app running as a tray agent when the user closes the management window.

```swift
struct WindowAccessor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.delegate = context.coordinator
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator: NSObject, NSWindowDelegate {
        func windowShouldClose(_ sender: NSWindow) -> Bool {
            sender.orderOut(nil)
            NSApp.setActivationPolicy(.accessory)
            return false
        }
    }
}
```

## Meeting Popup (Standalone Executable)

### Spawning

`meeting-alert-monitor.js` changes one line:

```javascript
// Before (Electron)
spawn(electronPath, [popupScript, dataB64])

// After (SwiftUI)
spawn(popupBinaryPath, [dataB64])
// popupBinaryPath = ~/.reticle/MeetingPopup.app/Contents/MacOS/MeetingPopup
```

### Window

`NSPanel` subclass with these properties:
- `level: .floating` — always on top
- `styleMask: [.borderless, .nonactivatingPanel]` — no title bar, doesn't steal focus
- `isMovableByWindowBackground: true`
- `backgroundColor: .clear` — transparent
- `hasShadow: false`

### Two Modes

**Expanded** (default on launch):
- 320x200 rounded rect with blur background
- Meeting title, countdown timer, attendee list
- Action buttons: Join Zoom, Snooze, Dismiss
- Auto-collapses after 30 seconds if no interaction

**Pill** (collapsed):
- 80x44 capsule anchored to screen edge
- Shows countdown only
- Click to expand
- Draggable via custom gesture handler

### Stdin IPC

Meeting alert monitor can send escalation commands via stdin:
- `{"type":"escalate","level":"urgent"}` — trigger shake animation + glow
- `{"type":"update","remaining":300}` — update countdown

Read via `FileHandle.standardInput` on a background thread.

### Auto-Close

Popup schedules auto-close at meeting start time + 5 minutes. Clean exit with fade animation.

## Build and Deploy

### Build Phase (added to `bin/deploy`)

```bash
# Build both targets
cd "$REPO_DIR/reticle"
swift build -c release

# Assemble Reticle.app bundle
RETICLE_APP="$RETICLE_HOME/Reticle.app"
mkdir -p "$RETICLE_APP/Contents/MacOS"
mkdir -p "$RETICLE_APP/Contents/Resources"
cp .build/release/Reticle "$RETICLE_APP/Contents/MacOS/"

cat > "$RETICLE_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>ai.reticle.app</string>
  <key>CFBundleName</key>
  <string>Reticle</string>
  <key>CFBundleExecutable</key>
  <string>Reticle</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
PLIST

codesign --sign - --force "$RETICLE_APP"

# Assemble MeetingPopup.app bundle
POPUP_APP="$RETICLE_HOME/MeetingPopup.app"
mkdir -p "$POPUP_APP/Contents/MacOS"
cp .build/release/MeetingPopup "$POPUP_APP/Contents/MacOS/"

cat > "$POPUP_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>ai.reticle.meeting-popup</string>
  <key>CFBundleName</key>
  <string>MeetingPopup</string>
  <key>CFBundleExecutable</key>
  <string>MeetingPopup</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
PLIST

codesign --sign - --force "$POPUP_APP"
```

### Deploy Sequence (updated)

1. Create `~/.reticle/` directory structure (existing)
2. Pull latest (existing)
3. Install npm dependencies (existing)
4. **NEW: Build Swift targets and assemble .app bundles**
5. Rsync Node.js code to `~/.reticle/app/` (existing)
6. Install production npm dependencies (existing)
7. Generate and load launchd plists (existing)
8. **NEW: Remove old Electron tray plists**
9. **NEW: Open Reticle.app (registers as login item on first run)**
10. Report status (existing)

### Login Item Registration

On first launch, `Reticle.app` calls:
```swift
try SMAppService.mainApp.register()
```

This registers the app as a login item in System Settings > General > Login Items. No launchd plist needed for the app itself — only the background Node.js services use launchd.

## Retirement of Electron

### What Gets Removed

- `tray/` directory (Electron tray app — all files)
- `meeting-popup.html` (Electron popup UI)
- `meeting-popup-window.js` (Electron popup window management)
- Electron-related npm dependencies from root package.json (if any)
- `tray/build/` artifacts

### What Gets Modified

- `meeting-alert-monitor.js` — spawn path changes from Electron to MeetingPopup.app binary
- `bin/deploy` — gains Swift build phase, drops `npm install --prefix tray`
- `CLAUDE.md` — architecture table updated

### What Stays

- All Node.js background services (gmail-monitor, slack-events, meeting-alerts, followup-checker, digests)
- `gateway.js` — REST API, unchanged
- `reticle-db.js` — database layer, unchanged
- All `lib/` modules — unchanged
- launchd plists for Node.js services — unchanged

## Migration Path

The Electron tray app and SwiftUI app can coexist during development. The migration is:

1. Build and test `Reticle.app` with MenuBarExtra + management window
2. Build and test `MeetingPopup` standalone executable
3. Update `meeting-alert-monitor.js` to spawn the new popup
4. Update `bin/deploy` with Swift build phase
5. Verify end-to-end: deploy, services start, tray works, popup works
6. Remove Electron files (`tray/`, `meeting-popup.html`, `meeting-popup-window.js`)

## Appendix: Icon Layer Reference

From `tray/icons.js`, the reticle icon is a 24x24 SVG with 5 layers:

1. **Outer ring** — 1.4px stroke circle (r=9) with 4 rectangular masks at cardinal points creating gaps
2. **Status fill** — filled circle (r=5.6) with ambient color (green/yellow/red/gray)
3. **Inner arcs** — two 90-degree arcs on a 6.6r circle, opposing quadrants, 0.6px stroke
4. **Center star** — 4-point star via bezier paths, 2.8px radius
5. **Spin animation** — rotate inner arcs group in 30-degree increments, 12 frames at 80ms

SwiftUI port uses `Canvas` with `CGContext`-equivalent drawing calls. The `Image` produced is set as the MenuBarExtra label at 22x22pt (matching macOS menu bar standard).
