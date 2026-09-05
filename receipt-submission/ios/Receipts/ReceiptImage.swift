import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit
import Vision

enum ReceiptImage {
  /// Working in sRGB rather than Core Image's default linear space keeps the
  /// level maths below in the same units the histogram was measured in.
  private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

  private static let context = CIContext(options: [
    .workingColorSpace: colorSpace,
    .outputColorSpace: colorSpace,
  ])

  /// Longest edge after processing. Plenty of pixels for a thermal receipt;
  /// a 12 MP still at 0.85 quality was blowing nginx's 1 MB body limit (413).
  private static let maxLongEdge: CGFloat = 1800
  /// Stay under typical reverse-proxy defaults (~1 MB) including multipart wrapping.
  static let maxUploadBytes = 700 * 1024

  static func jpegData(from image: UIImage) -> Data? {
    encode(scaledForUpload(image))
  }

  /// Re-encodes an already-held JPEG that was saved before downscaling existed.
  static func jpegData(from data: Data) -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    return jpegData(from: image)
  }

  private static func scaledForUpload(_ image: UIImage) -> UIImage {
    let pixelWidth = max(1, image.size.width * image.scale)
    let pixelHeight = max(1, image.size.height * image.scale)
    let longest = max(pixelWidth, pixelHeight)
    guard longest > maxLongEdge else { return image }

    let scale = maxLongEdge / longest
    let size = CGSize(width: (pixelWidth * scale).rounded(), height: (pixelHeight * scale).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.opaque = true
    format.scale = 1
    format.preferredRange = .standard
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private static func encode(_ image: UIImage) -> Data? {
    for quality in [0.72, 0.55, 0.4] as [CGFloat] {
      guard let data = image.jpegData(compressionQuality: quality) else { continue }
      if data.count <= maxUploadBytes || quality == 0.4 {
        return data
      }
    }
    return nil
  }

  /// Crop to the receipt, flatten to grayscale, and stretch the tones so the
  /// paper reads as white regardless of how dim the room was.
  static func process(_ image: UIImage) -> UIImage {
    guard let cgImage = normalisedCGImage(image) else { return image }
    var working = CIImage(cgImage: cgImage)

    if let quad = detectDocument(in: cgImage) {
      working = perspectiveCorrected(working, quad: quad) ?? working
    }

    working = grayscale(working)
    working = autoLevels(working)

    guard let output = context.createCGImage(working, from: working.extent, format: .RGBA8, colorSpace: colorSpace) else {
      return image
    }
    return UIImage(cgImage: output, scale: 1, orientation: .up)
  }

  // MARK: - Steps

  private static func normalisedCGImage(_ image: UIImage) -> CGImage? {
    if image.imageOrientation == .up, let cgImage = image.cgImage {
      return cgImage
    }
    let format = UIGraphicsImageRendererFormat()
    format.opaque = true
    format.scale = 1
    format.preferredRange = .standard

    let size = CGSize(
      width: max(1, image.size.width * image.scale),
      height: max(1, image.size.height * image.scale)
    )
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }.cgImage
  }

  private static func detectDocument(in cgImage: CGImage) -> VNRectangleObservation? {
    let request = VNDetectDocumentSegmentationRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
    guard (try? handler.perform([request])) != nil,
          let observation = request.results?.first
    else {
      return nil
    }

    // Reject slivers and near-full-frame boxes; a bad crop is worse than none.
    let width = hypot(
      observation.topRight.x - observation.topLeft.x,
      observation.topRight.y - observation.topLeft.y
    )
    let height = hypot(
      observation.topLeft.x - observation.bottomLeft.x,
      observation.topLeft.y - observation.bottomLeft.y
    )
    let area = width * height
    guard area > 0.12, area < 0.98, observation.confidence > 0.4 else { return nil }
    return observation
  }

  private static func perspectiveCorrected(_ image: CIImage, quad: VNRectangleObservation) -> CIImage? {
    let extent = image.extent
    func denormalise(_ point: CGPoint) -> CGPoint {
      CGPoint(x: extent.origin.x + point.x * extent.width, y: extent.origin.y + point.y * extent.height)
    }

    let filter = CIFilter.perspectiveCorrection()
    filter.inputImage = image
    filter.topLeft = denormalise(quad.topLeft)
    filter.topRight = denormalise(quad.topRight)
    filter.bottomLeft = denormalise(quad.bottomLeft)
    filter.bottomRight = denormalise(quad.bottomRight)
    filter.crop = true
    return filter.outputImage
  }

  private static func grayscale(_ image: CIImage) -> CIImage {
    let controls = CIFilter.colorControls()
    controls.inputImage = image
    controls.saturation = 0
    controls.brightness = 0
    controls.contrast = 1
    return controls.outputImage ?? image
  }

  private static func autoLevels(_ image: CIImage) -> CIImage {
    guard let (black, white) = tonalRange(of: image) else { return image }

    let scale = 255 / max(white - black, 1)
    let bias = -(black / 255) * scale

    let matrix = CIFilter.colorMatrix()
    matrix.inputImage = image
    matrix.rVector = CIVector(x: scale, y: 0, z: 0, w: 0)
    matrix.gVector = CIVector(x: 0, y: scale, z: 0, w: 0)
    matrix.bVector = CIVector(x: 0, y: 0, z: scale, w: 0)
    matrix.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
    matrix.biasVector = CIVector(x: bias, y: bias, z: bias, w: 0)
    guard let stretched = matrix.outputImage else { return image }

    let contrast = CIFilter.colorControls()
    contrast.inputImage = stretched
    contrast.saturation = 0
    contrast.contrast = 1.18
    contrast.brightness = 0.02
    return contrast.outputImage ?? stretched
  }

  /// Ink level and paper level, sampled from a thumbnail so it stays cheap.
  private static func tonalRange(of image: CIImage) -> (black: CGFloat, white: CGFloat)? {
    let extent = image.extent
    guard extent.width > 2, extent.height > 2 else { return nil }

    let scale = min(1, 120 / max(extent.width, extent.height))
    let thumbnail = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let width = Int(thumbnail.extent.width)
    let height = Int(thumbnail.extent.height)
    guard width > 1, height > 1 else { return nil }

    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    context.render(
      thumbnail,
      toBitmap: &pixels,
      rowBytes: width * 4,
      bounds: CGRect(x: thumbnail.extent.origin.x, y: thumbnail.extent.origin.y,
                     width: CGFloat(width), height: CGFloat(height)),
      format: .RGBA8,
      colorSpace: colorSpace
    )

    var histogram = [Int](repeating: 0, count: 256)
    for index in stride(from: 0, to: pixels.count, by: 4) {
      let luma = 0.2126 * Double(pixels[index])
        + 0.7152 * Double(pixels[index + 1])
        + 0.0722 * Double(pixels[index + 2])
      histogram[min(255, max(0, Int(luma)))] += 1
    }

    let total = width * height
    func percentile(_ fraction: Double) -> CGFloat {
      let target = Int(Double(total) * fraction)
      var running = 0
      for (value, count) in histogram.enumerated() {
        running += count
        if running >= target { return CGFloat(value) }
      }
      return 255
    }

    var black = percentile(0.05)
    var white = percentile(0.93)
    if white - black < 32 {
      // Flat frame (all paper, or all shadow) — don't amplify noise.
      black = max(0, white - 32)
    }
    white = min(255, max(white, black + 32))
    return (black, white)
  }
}
