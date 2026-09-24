// refluent overlay helper: a renderer only. Node decides what to show and sends one
// JSON object per line on stdin; this process reports drags and dismissals as JSON
// lines on stdout. It exits when stdin closes, so it never outlives its supervisor.
import AppKit

struct Position: Codable {
  let x: Double
  let y: Double
}

struct ShowMessage: Decodable {
  let rewrite: String
  let label: String
  let reason: String
  let original: String
  let durationMs: Double
  let position: Position?
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

/// Never key, never main: the panel must not take focus from whatever the user is typing in.
final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// Owns every pointer interaction so labels never swallow a click: hover holds the panel,
/// a click toggles the expanded view, a drag moves it. Only the close button is exempt.
final class InteractionView: NSView {
  var onHover: (Bool) -> Void = { _ in }
  var onClick: () -> Void = {}
  var onDragEnd: () -> Void = {}
  weak var closeButton: NSButton?
  private var downInWindow: NSPoint?
  private var dragged = false

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let hit = super.hitTest(point) else { return nil }
    if let button = closeButton, hit === button || hit.isDescendant(of: button) { return hit }
    return self
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(
      rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { onHover(true) }
  override func mouseExited(with event: NSEvent) { onHover(false) }

  override func mouseDown(with event: NSEvent) {
    downInWindow = event.locationInWindow
    dragged = false
  }

  override func mouseDragged(with event: NSEvent) {
    guard let window, let start = downInWindow else { return }
    let dx = event.locationInWindow.x - start.x
    let dy = event.locationInWindow.y - start.y
    if !dragged && abs(dx) < 3 && abs(dy) < 3 { return }
    dragged = true
    window.setFrameOrigin(NSPoint(x: window.frame.origin.x + dx, y: window.frame.origin.y + dy))
  }

  override func mouseUp(with event: NSEvent) {
    defer { downInWindow = nil }
    if dragged { onDragEnd() } else { onClick() }
  }
}

@MainActor
final class OverlayController: NSObject {
  static let width: CGFloat = 380
  static let margin: CGFloat = 16

  private let panel = OverlayPanel(
    contentRect: NSRect(x: 0, y: 0, width: OverlayController.width, height: 60),
    styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
  private let root = InteractionView()
  private let stack = NSStackView()
  private let rewriteLabel = OverlayController.label(size: 14, weight: .semibold, color: .labelColor)
  private let detailLabel = OverlayController.label(size: 12, weight: .regular, color: .secondaryLabelColor)
  private let originalLabel = OverlayController.label(size: 12, weight: .regular, color: .tertiaryLabelColor)
  private let closeButton = NSButton(title: "×", target: nil, action: nil)
  private var message: ShowMessage?
  private var position: Position?
  private var expanded = false
  private var hovering = false
  private var hideTimer: Timer?
  /// Bumped on every show, so a fade that finishes after a newer show never hides it.
  private var generation = 0

  override init() {
    super.init()
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true

    let effect = NSVisualEffectView()
    effect.material = .hudWindow
    effect.blendingMode = .behindWindow
    effect.state = .active
    effect.wantsLayer = true
    effect.layer?.cornerRadius = 10
    effect.layer?.masksToBounds = true
    effect.translatesAutoresizingMaskIntoConstraints = false

    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 4
    stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 28)
    stack.translatesAutoresizingMaskIntoConstraints = false
    for view in [rewriteLabel, detailLabel, originalLabel] { stack.addArrangedSubview(view) }

    closeButton.isBordered = false
    closeButton.font = .systemFont(ofSize: 13)
    closeButton.contentTintColor = .secondaryLabelColor
    closeButton.target = self
    closeButton.action = #selector(closeClicked)
    closeButton.translatesAutoresizingMaskIntoConstraints = false

    root.addSubview(effect)
    root.addSubview(stack)
    root.addSubview(closeButton)
    root.closeButton = closeButton
    NSLayoutConstraint.activate([
      effect.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      effect.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      effect.topAnchor.constraint(equalTo: root.topAnchor),
      effect.bottomAnchor.constraint(equalTo: root.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      stack.topAnchor.constraint(equalTo: root.topAnchor),
      stack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
      stack.widthAnchor.constraint(equalToConstant: OverlayController.width),
      closeButton.topAnchor.constraint(equalTo: root.topAnchor, constant: 6),
      closeButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -8),
    ])
    panel.contentView = root

    root.onHover = { [weak self] inside in
      self?.hovering = inside
      self?.restartTimer()
    }
    root.onClick = { [weak self] in
      guard let self else { return }
      self.expanded.toggle()
      self.render()
      self.restartTimer()
    }
    root.onDragEnd = { [weak self] in
      guard let self else { return }
      let frame = self.panel.frame
      self.position = Position(x: frame.minX, y: frame.maxY)
      emit(["type": "moved", "x": frame.minX, "y": frame.maxY])
      self.restartTimer()
    }
  }

  private static func label(size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: "")
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.isSelectable = false
    field.preferredMaxLayoutWidth = width - 40
    return field
  }

  func show(_ next: ShowMessage) {
    generation += 1
    message = next
    if let stored = next.position { position = stored }
    expanded = false
    render()
    panel.alphaValue = 1
    panel.orderFrontRegardless()
    restartTimer()
  }

  private func render() {
    guard let message else { return }
    rewriteLabel.stringValue = message.rewrite
    detailLabel.stringValue = [message.label, message.reason].filter { !$0.isEmpty }.joined(separator: ": ")
    detailLabel.isHidden = detailLabel.stringValue.isEmpty
    originalLabel.stringValue = message.original
    originalLabel.isHidden = !expanded || message.original.isEmpty
    let lines = expanded ? 0 : 2
    rewriteLabel.maximumNumberOfLines = lines
    detailLabel.maximumNumberOfLines = lines
    root.layoutSubtreeIfNeeded()
    let height = ceil(stack.fittingSize.height)
    let top = topLeft()
    panel.setFrame(
      NSRect(x: top.x, y: top.y - height, width: OverlayController.width, height: height), display: true)
  }

  /// The stored top-left corner while any part of it is on a connected screen; otherwise the
  /// top-right of the main screen (an unplugged display must not strand the panel off-screen).
  private func topLeft() -> NSPoint {
    if let stored = position {
      let probe = NSRect(x: stored.x, y: stored.y - 40, width: OverlayController.width, height: 40)
      if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(probe) }) {
        return NSPoint(x: stored.x, y: stored.y)
      }
    }
    let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
      ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    return NSPoint(
      x: screen.maxX - OverlayController.width - OverlayController.margin,
      y: screen.maxY - OverlayController.margin)
  }

  private func restartTimer() {
    hideTimer?.invalidate()
    hideTimer = nil
    guard !expanded, !hovering, panel.isVisible, let message else { return }
    hideTimer = Timer.scheduledTimer(withTimeInterval: max(1, message.durationMs / 1000), repeats: false) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.fadeOut(duration: 0.3) }
    }
  }

  private func fadeOut(duration: TimeInterval) {
    hideTimer?.invalidate()
    hideTimer = nil
    let current = generation
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = duration
      self.panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.generation == current else { return }
        self.panel.orderOut(nil)
      }
    })
  }

  @objc private func closeClicked() {
    emit(["type": "dismissed"])
    expanded = false
    hovering = false
    fadeOut(duration: 0.1)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Top-level code runs on the main thread; say so, since this file is not main.swift.
let controller = MainActor.assumeIsolated { OverlayController() }

Thread.detachNewThread {
  let decoder = JSONDecoder()
  while let line = readLine() {
    guard let message = try? decoder.decode(ShowMessage.self, from: Data(line.utf8)) else { continue }
    DispatchQueue.main.async { MainActor.assumeIsolated { controller.show(message) } }
  }
  DispatchQueue.main.async { NSApp.terminate(nil) }
}

app.run()
