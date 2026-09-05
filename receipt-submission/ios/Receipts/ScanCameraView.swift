import AVFoundation
import SwiftUI
import UIKit
import Vision

/// One shot per presentation. VisionKit's document camera keeps returning to
/// the viewfinder for extra pages, which is why capture never handed control
/// back to the app's own review screen.
struct ScanCameraView: UIViewControllerRepresentable {
  var onCapture: (UIImage) -> Void
  var onCancel: () -> Void

  func makeUIViewController(context: Context) -> ScanCameraController {
    let controller = ScanCameraController()
    controller.onCapture = onCapture
    controller.onCancel = onCancel
    return controller
  }

  func updateUIViewController(_ controller: ScanCameraController, context: Context) {
    controller.onCapture = onCapture
    controller.onCancel = onCancel
  }
}

/// Corners in Vision's normalised space (origin bottom-left).
private struct Quad {
  var topLeft: CGPoint
  var topRight: CGPoint
  var bottomLeft: CGPoint
  var bottomRight: CGPoint

  init(_ observation: VNRectangleObservation) {
    topLeft = observation.topLeft
    topRight = observation.topRight
    bottomLeft = observation.bottomLeft
    bottomRight = observation.bottomRight
  }

  init(topLeft: CGPoint, topRight: CGPoint, bottomLeft: CGPoint, bottomRight: CGPoint) {
    self.topLeft = topLeft
    self.topRight = topRight
    self.bottomLeft = bottomLeft
    self.bottomRight = bottomRight
  }

  var corners: [CGPoint] { [topLeft, topRight, bottomRight, bottomLeft] }

  var area: CGFloat {
    let points = corners
    var sum: CGFloat = 0
    for index in points.indices {
      let current = points[index]
      let next = points[(index + 1) % points.count]
      sum += current.x * next.y - next.x * current.y
    }
    return abs(sum) / 2
  }

  func blended(towards other: Quad, factor: CGFloat) -> Quad {
    func mix(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
      CGPoint(x: a.x + (b.x - a.x) * factor, y: a.y + (b.y - a.y) * factor)
    }
    return Quad(
      topLeft: mix(topLeft, other.topLeft),
      topRight: mix(topRight, other.topRight),
      bottomLeft: mix(bottomLeft, other.bottomLeft),
      bottomRight: mix(bottomRight, other.bottomRight)
    )
  }

  func drift(from other: Quad) -> CGFloat {
    zip(corners, other.corners)
      .map { hypot($0.x - $1.x, $0.y - $1.y) }
      .max() ?? 0
  }
}

final class ScanCameraController: UIViewController {
  var onCapture: (UIImage) -> Void = { _ in }
  var onCancel: () -> Void = {}

  private let session = AVCaptureSession()
  private let photoOutput = AVCapturePhotoOutput()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let sessionQueue = DispatchQueue(label: "receipts.session")
  private let visionQueue = DispatchQueue(label: "receipts.vision")

  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let guideLayer = CAShapeLayer()
  private let steadyRing = CAShapeLayer()
  private let flashView = UIView()
  private let hintPill = UIView()
  private let hintLabel = UILabel()
  private let shutterButton = UIButton(type: .custom)
  private let cancelButton = UIButton(type: .system)
  private let torchButton = UIButton(type: .system)
  private let autoButton = UIButton(type: .system)
  private let spinner = UIActivityIndicatorView(style: .large)

  private var camera: AVCaptureDevice?
  private var isCapturing = false
  private var isAnalysing = false
  private var lastAnalysis: CFTimeInterval = 0

  private var smoothedQuad: Quad?
  private var missedFrames = 0
  private var steadyFrames = 0
  private var autoCapture = true

  /// Roughly half a second of a steady outline at the detection rate below.
  private let steadyFramesNeeded = 6
  private let detectionInterval: CFTimeInterval = 1.0 / 12.0

  override var prefersStatusBarHidden: Bool { true }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    buildInterface()
    requestAccessThenStart()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
    guideLayer.frame = view.bounds
    applyPortraitRotation(previewLayer?.connection)

    let ring = shutterButton.frame.insetBy(dx: -7, dy: -7)
    steadyRing.frame = ring
    steadyRing.path = UIBezierPath(
      ovalIn: CGRect(origin: .zero, size: ring.size).insetBy(dx: 2, dy: 2)
    ).cgPath
    // Wind from the top rather than from three o'clock.
    steadyRing.transform = CATransform3DMakeRotation(-.pi / 2, 0, 0, 1)
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    setTorch(on: false)
    sessionQueue.async { [session] in
      if session.isRunning { session.stopRunning() }
    }
  }

  // MARK: - Interface

  private func buildInterface() {
    // Highlighting the sheet reads better than dimming everything else, which
    // muddied the whole frame and made the outline look like a stray box.
    guideLayer.fillColor = UIColor.systemTeal.withAlphaComponent(0.28).cgColor
    guideLayer.strokeColor = UIColor.systemTeal.cgColor
    guideLayer.lineWidth = 5
    guideLayer.lineJoin = .round
    view.layer.addSublayer(guideLayer)

    flashView.backgroundColor = .white
    flashView.alpha = 0
    flashView.isUserInteractionEnabled = false
    flashView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(flashView)

    // A pill keeps the hint readable over both the letterbox bar and the frame.
    hintPill.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    hintPill.layer.cornerRadius = 14
    hintPill.layer.cornerCurve = .continuous
    hintPill.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hintPill)

    hintLabel.text = "Line up the receipt"
    hintLabel.textColor = .white
    hintLabel.font = .preferredFont(forTextStyle: .subheadline)
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 2
    hintLabel.translatesAutoresizingMaskIntoConstraints = false
    hintPill.addSubview(hintLabel)

    shutterButton.backgroundColor = .white
    shutterButton.layer.cornerRadius = 36
    shutterButton.accessibilityLabel = "Capture"
    shutterButton.addTarget(self, action: #selector(shutterTapped), for: .touchUpInside)
    shutterButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(shutterButton)

    // Winds around the shutter as the outline holds still, so the auto capture
    // is something you can see coming rather than a surprise.
    steadyRing.fillColor = UIColor.clear.cgColor
    steadyRing.strokeColor = UIColor.systemTeal.cgColor
    steadyRing.lineWidth = 4
    steadyRing.lineCap = .round
    steadyRing.strokeEnd = 0
    steadyRing.opacity = 0
    view.layer.addSublayer(steadyRing)

    cancelButton.setImage(UIImage(systemName: "xmark"), for: .normal)
    cancelButton.tintColor = .white
    cancelButton.accessibilityLabel = "Cancel"
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    cancelButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(cancelButton)

    torchButton.setImage(UIImage(systemName: "bolt.slash.fill"), for: .normal)
    torchButton.tintColor = .white
    torchButton.addTarget(self, action: #selector(toggleTorch), for: .touchUpInside)
    torchButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(torchButton)

    autoButton.configuration = modeConfiguration()
    autoButton.addTarget(self, action: #selector(toggleAuto), for: .touchUpInside)
    autoButton.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(autoButton)

    spinner.color = .white
    spinner.hidesWhenStopped = true
    spinner.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(spinner)

    NSLayoutConstraint.activate([
      flashView.topAnchor.constraint(equalTo: view.topAnchor),
      flashView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      flashView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      flashView.trailingAnchor.constraint(equalTo: view.trailingAnchor),

      shutterButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      shutterButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
      shutterButton.widthAnchor.constraint(equalToConstant: 72),
      shutterButton.heightAnchor.constraint(equalToConstant: 72),

      cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 22),
      cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),

      torchButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 30),
      torchButton.centerYAnchor.constraint(equalTo: shutterButton.centerYAnchor),

      autoButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
      autoButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),

      hintPill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      hintPill.bottomAnchor.constraint(equalTo: shutterButton.topAnchor, constant: -24),
      hintPill.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),

      hintLabel.topAnchor.constraint(equalTo: hintPill.topAnchor, constant: 8),
      hintLabel.bottomAnchor.constraint(equalTo: hintPill.bottomAnchor, constant: -8),
      hintLabel.leadingAnchor.constraint(equalTo: hintPill.leadingAnchor, constant: 16),
      hintLabel.trailingAnchor.constraint(equalTo: hintPill.trailingAnchor, constant: -16),

      spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  // MARK: - Session

  private func requestAccessThenStart() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configureAndRun()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          guard let self else { return }
          if granted {
            self.configureAndRun()
          } else {
            self.hintLabel.text = "Camera access denied"
          }
        }
      }
    default:
      hintLabel.text = "Enable camera access in Settings"
    }
  }

  private func configureAndRun() {
    let preview = AVCaptureVideoPreviewLayer(session: session)
    // Aspect, not aspect-fill: filling a tall screen crops the sides of the 4:3
    // frame, so you would be framing against a view narrower than what the
    // still actually captures.
    preview.videoGravity = .resizeAspect
    preview.frame = view.bounds
    view.layer.insertSublayer(preview, at: 0)
    previewLayer = preview
    applyPortraitRotation(preview.connection)

    sessionQueue.async { [weak self] in
      guard let self else { return }
      self.configureSession()
      if !self.session.isRunning { self.session.startRunning() }
    }
  }

  private func configureSession() {
    session.beginConfiguration()
    session.sessionPreset = .photo

    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      session.commitConfiguration()
      return
    }
    session.addInput(input)
    camera = device

    if session.canAddOutput(photoOutput) {
      photoOutput.maxPhotoQualityPrioritization = .quality
      session.addOutput(photoOutput)
    }

    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ]
    videoOutput.setSampleBufferDelegate(self, queue: visionQueue)
    if session.canAddOutput(videoOutput) {
      session.addOutput(videoOutput)
      // The photo preset hands out full-resolution frames, which is far more
      // than edge detection needs and stutters the preview on every frame.
      videoOutput.automaticallyConfiguresOutputBufferDimensions = false
      videoOutput.deliversPreviewSizedOutputBuffers = true
    }

    // Portrait everywhere: preview, live frames, and stills share one upright
    // space. Vision then runs with `.up`, and the overlay maps those corners
    // straight into the letterboxed video rect — without
    // `layerPointConverted`, which expects sensor-space points and skews the
    // box when Vision has already been oriented.
    applyPortraitRotation(photoOutput.connection(with: .video))
    applyPortraitRotation(videoOutput.connection(with: .video))

    if (try? device.lockForConfiguration()) != nil {
      if device.isFocusModeSupported(.continuousAutoFocus) {
        device.focusMode = .continuousAutoFocus
      }
      if device.isExposureModeSupported(.continuousAutoExposure) {
        device.exposureMode = .continuousAutoExposure
      }
      device.unlockForConfiguration()
    }

    session.commitConfiguration()
  }

  private func applyPortraitRotation(_ connection: AVCaptureConnection?) {
    guard let connection, connection.isVideoRotationAngleSupported(90) else { return }
    connection.videoRotationAngle = 90
  }

  // MARK: - Actions

  @objc private func cancelTapped() {
    onCancel()
  }

  @objc private func toggleAuto() {
    autoCapture.toggle()
    steadyFrames = 0
    autoButton.configuration = modeConfiguration()
    renderSteadyRing()
  }

  private func modeConfiguration() -> UIButton.Configuration {
    var configuration = UIButton.Configuration.filled()
    configuration.title = autoCapture ? "Auto" : "Manual"
    configuration.baseBackgroundColor = autoCapture
      ? UIColor.systemTeal.withAlphaComponent(0.9)
      : UIColor.white.withAlphaComponent(0.25)
    configuration.baseForegroundColor = autoCapture ? .black : .white
    configuration.cornerStyle = .capsule
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
    return configuration
  }

  @objc private func toggleTorch() {
    guard let camera, camera.hasTorch else { return }
    setTorch(on: !camera.isTorchActive)
  }

  private func setTorch(on: Bool) {
    guard let camera, camera.hasTorch, (try? camera.lockForConfiguration()) != nil else { return }
    camera.torchMode = on ? .on : .off
    camera.unlockForConfiguration()
    torchButton.setImage(UIImage(systemName: on ? "bolt.fill" : "bolt.slash.fill"), for: .normal)
  }

  @objc private func shutterTapped() {
    capturePhoto()
  }

  private func capturePhoto() {
    guard !isCapturing, session.isRunning else { return }
    isCapturing = true
    shutterButton.isEnabled = false
    spinner.startAnimating()
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()

    flashView.alpha = 0.85
    UIView.animate(withDuration: 0.25) { self.flashView.alpha = 0 }

    let settings = AVCapturePhotoSettings()
    settings.photoQualityPrioritization = .quality
    photoOutput.capturePhoto(with: settings, delegate: self)
  }

  private func finish(with image: UIImage) {
    setTorch(on: false)
    spinner.stopAnimating()
    onCapture(image)
  }

  private func recoverFromFailedCapture() {
    isCapturing = false
    steadyFrames = 0
    shutterButton.isEnabled = true
    spinner.stopAnimating()
    hintLabel.text = "Capture failed — try again"
  }

  // MARK: - Live guide

  fileprivate func handleDetection(_ observation: VNRectangleObservation?) {
    guard !isCapturing else { return }

    guard let observation, observation.confidence > 0.3 else {
      missedFrames += 1
      if missedFrames > 4 {
        smoothedQuad = nil
        steadyFrames = 0
        renderGuide(nil)
        renderSteadyRing()
        hintLabel.text = autoCapture
          ? "Line up the receipt"
          : "Line up the receipt, then tap"
      }
      return
    }

    missedFrames = 0
    let incoming = Quad(observation)

    if let current = smoothedQuad, current.drift(from: incoming) < 0.2 {
      // Same sheet, still moving: ease towards it so the outline doesn't jitter.
      let blended = current.blended(towards: incoming, factor: 0.4)
      steadyFrames = current.drift(from: incoming) < 0.012 ? steadyFrames + 1 : 0
      smoothedQuad = blended
    } else {
      smoothedQuad = incoming
      steadyFrames = 0
    }

    guard let quad = smoothedQuad else { return }
    renderGuide(quad)

    let usable = quad.area > 0.12 && quad.area < 0.92
    if !usable {
      steadyFrames = 0
      renderSteadyRing()
      hintLabel.text = quad.area <= 0.12 ? "Move closer" : "Move back"
      return
    }

    renderSteadyRing()

    if autoCapture {
      if steadyFrames >= steadyFramesNeeded {
        capturePhoto()
      } else {
        hintLabel.text = "Receipt found — hold steady"
      }
    } else {
      hintLabel.text = "Tap to capture"
    }
  }

  private func renderSteadyRing() {
    let progress = autoCapture
      ? min(1, CGFloat(steadyFrames) / CGFloat(steadyFramesNeeded))
      : 0
    CATransaction.begin()
    CATransaction.setAnimationDuration(detectionInterval)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .linear))
    steadyRing.strokeEnd = progress
    steadyRing.opacity = progress > 0 ? 1 : 0
    CATransaction.commit()
  }

  private func renderGuide(_ quad: Quad?) {
    guard let quad, let preview = previewLayer else {
      fade(to: 0)
      return
    }

    // Vision corners are normalised in the upright frame (origin bottom-left).
    // Map them into the letterboxed video rect so letterboxing and portrait
    // rotation stay consistent — do not use `layerPointConverted`, which speaks
    // sensor-space and was skewing the overlay.
    let videoRect = preview.layerRectConverted(
      fromMetadataOutputRect: CGRect(x: 0, y: 0, width: 1, height: 1)
    )
    let points = quad.corners.map { corner in
      CGPoint(
        x: videoRect.minX + corner.x * videoRect.width,
        y: videoRect.minY + (1 - corner.y) * videoRect.height
      )
    }

    let outline = UIBezierPath()
    outline.move(to: points[0])
    for point in points.dropFirst() {
      outline.addLine(to: point)
    }
    outline.close()

    // A shape layer snaps straight to a new path, which at the detection rate
    // reads as stepping. Interpolating across one interval makes the outline
    // track the sheet continuously instead.
    let appearing = guideLayer.path == nil
    CATransaction.begin()
    CATransaction.setDisableActions(appearing)
    CATransaction.setAnimationDuration(detectionInterval)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .linear))
    guideLayer.path = outline.cgPath
    CATransaction.commit()

    if appearing { fade(to: 1) }
  }

  private func fade(to opacity: Float) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.18)
    guideLayer.opacity = opacity
    CATransaction.commit()
    if opacity == 0 {
      // Cleared only after the fade so the outline doesn't vanish mid-animation.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
        guard let self, self.guideLayer.opacity == 0 else { return }
        self.guideLayer.path = nil
      }
    }
  }
}

// MARK: - Photo capture

extension ScanCameraController: AVCapturePhotoCaptureDelegate {
  func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    guard
      error == nil,
      let data = photo.fileDataRepresentation(),
      let image = UIImage(data: data)
    else {
      DispatchQueue.main.async { [weak self] in self?.recoverFromFailedCapture() }
      return
    }

    visionQueue.async { [weak self] in
      let processed = ReceiptImage.process(image)
      DispatchQueue.main.async {
        self?.finish(with: processed)
      }
    }
  }
}

// MARK: - Live document detection

extension ScanCameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    let now = CACurrentMediaTime()
    guard
      !isAnalysing,
      !isCapturing,
      now - lastAnalysis >= detectionInterval,
      let buffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else {
      return
    }
    isAnalysing = true
    lastAnalysis = now

    let request = VNDetectDocumentSegmentationRequest()
    // Preview + video output are already rotated to portrait, so `.up` keeps
    // Vision's corners in the same upright space the overlay paints into.
    let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
    try? handler.perform([request])
    let observation = request.results?.first

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.handleDetection(observation)
      self.isAnalysing = false
    }
  }
}
