import SwiftUI

/// SwiftUI Canvas renderer for the 5-layer Reticle tray icon.
///
/// Ported from `tray/icons.js` (24×24 SVG viewBox). Layers:
/// 1. Outer ring with 4 cardinal gap masks
/// 2. Status fill circle (optional — nil means healthy/green)
/// 3. Inner arcs (rotatable for spin animation)
/// 4. Center 4-point star
struct ReticleIcon: View {
    /// Status color for the inner fill. `nil` = healthy (no fill shown).
    let statusColor: Color?
    /// Degrees to rotate the inner arcs (for spin animation).
    let arcRotation: Double

    private let vb: CGFloat = 24
    private let center: CGFloat = 12

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / vb
            context.scaleBy(x: scale, y: scale)

            // Layer 1: Outer ring with gap masks
            drawOuterRing(context: &context)

            // Layer 2: Status fill circle (only when non-nil)
            if let color = statusColor {
                let circle = Path(ellipseIn: CGRect(
                    x: center - 7.6, y: center - 7.6,
                    width: 15.2, height: 15.2
                ))
                context.fill(circle, with: .color(color))
            }

            // Layer 3: Inner arcs (rotatable)
            drawInnerArcs(context: &context, rotation: arcRotation)

            // Layer 4: Center star
            drawStar(context: &context)
        }
        .frame(width: 22, height: 22)
    }

    // MARK: - Layer 1: Outer ring with gap masks

    private func drawOuterRing(context: inout GraphicsContext) {
        // Build the annulus using even-odd fill rule:
        // outer circle (r=10.4) + inner circle (r=7.6)
        var annulus = Path()
        annulus.addEllipse(in: CGRect(
            x: center - 10.4, y: center - 10.4,
            width: 20.8, height: 20.8
        ))
        annulus.addEllipse(in: CGRect(
            x: center - 7.6, y: center - 7.6,
            width: 15.2, height: 15.2
        ))

        // Draw ring into a sublayer so we can punch gaps with .clear blend
        let ringLayer = context
        ringLayer.fill(annulus, with: .color(.white), style: FillStyle(eoFill: true))

        // Punch out the 4 cardinal gap rectangles
        let gaps: [CGRect] = [
            CGRect(x: 19.2, y: 11.27, width: 3.6, height: 1.46),  // Right
            CGRect(x: 11.27, y: 1.2, width: 1.46, height: 3.6),   // Top
            CGRect(x: 1.2, y: 11.27, width: 3.6, height: 1.46),   // Left
            CGRect(x: 11.27, y: 19.2, width: 1.46, height: 3.6),  // Bottom
        ]

        var clearCtx = context
        clearCtx.blendMode = .clear
        for gap in gaps {
            clearCtx.fill(Path(gap), with: .color(.white))
        }
    }

    // MARK: - Layer 3: Inner arcs

    private func drawInnerArcs(context: inout GraphicsContext, rotation: Double) {
        var arcPath = Path()

        // Arc 1: 9 o'clock (180°) to 12 o'clock (270°) — counter-clockwise in SwiftUI coords
        // SVG: "M 5.4 12 A 6.6 6.6 0 0 1 12 5.4"
        arcPath.addArc(
            center: CGPoint(x: center, y: center),
            radius: 6.6,
            startAngle: .degrees(180),
            endAngle: .degrees(270),
            clockwise: false
        )

        // Arc 2: 3 o'clock (0°) to 6 o'clock (90°) — counter-clockwise in SwiftUI coords
        // SVG: "M 18.6 12 A 6.6 6.6 0 0 1 12 18.6"
        arcPath.move(to: CGPoint(x: center + 6.6, y: center))
        arcPath.addArc(
            center: CGPoint(x: center, y: center),
            radius: 6.6,
            startAngle: .degrees(0),
            endAngle: .degrees(90),
            clockwise: false
        )

        var arcCtx = context
        if rotation != 0 {
            arcCtx.translateBy(x: center, y: center)
            arcCtx.rotate(by: .degrees(rotation))
            arcCtx.translateBy(x: -center, y: -center)
        }
        arcCtx.stroke(
            arcPath,
            with: .color(.white),
            style: StrokeStyle(lineWidth: 0.6, lineCap: .round)
        )
    }

    // MARK: - Layer 4: Center star

    private func drawStar(context: inout GraphicsContext) {
        var star = Path()
        // 4-point star via cubic beziers — matches icons.js exactly
        star.move(to: CGPoint(x: 12, y: 9.7))
        star.addCurve(
            to: CGPoint(x: 14.3, y: 12),
            control1: CGPoint(x: 12.2, y: 11.1),
            control2: CGPoint(x: 12.9, y: 11.8)
        )
        star.addCurve(
            to: CGPoint(x: 12, y: 14.3),
            control1: CGPoint(x: 12.9, y: 12.2),
            control2: CGPoint(x: 12.2, y: 12.9)
        )
        star.addCurve(
            to: CGPoint(x: 9.7, y: 12),
            control1: CGPoint(x: 11.8, y: 12.9),
            control2: CGPoint(x: 11.1, y: 12.2)
        )
        star.addCurve(
            to: CGPoint(x: 12, y: 9.7),
            control1: CGPoint(x: 11.1, y: 11.8),
            control2: CGPoint(x: 11.8, y: 11.1)
        )
        star.closeSubpath()

        context.fill(star, with: .color(.white))
    }
}

// MARK: - NSImage generation for MenuBarExtra

extension ReticleIcon {
    /// Render the icon to an NSImage suitable for menu bar display (22×22pt @2x).
    @MainActor
    static func menuBarImage(statusColor: Color?, arcRotation: Double = 0) -> NSImage {
        let renderer = ImageRenderer(
            content: ReticleIcon(statusColor: statusColor, arcRotation: arcRotation)
        )
        renderer.scale = 2.0
        guard let cgImage = renderer.cgImage else {
            return NSImage(
                systemSymbolName: "circle",
                accessibilityDescription: "Reticle"
            ) ?? NSImage()
        }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: 22, height: 22))
        image.isTemplate = false
        return image
    }
}
