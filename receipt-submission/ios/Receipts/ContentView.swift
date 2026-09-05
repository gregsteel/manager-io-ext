import SwiftUI

private let accent = Color(red: 13 / 255, green: 110 / 255, blue: 110 / 255)

private struct CapturedPage: Identifiable {
  let id = UUID()
  let capturedAt: Date
  let image: UIImage
}

struct ContentView: View {
  @Environment(SessionStore.self) private var session
  @State private var showCamera = false
  @State private var showHeldReceipts = false
  @State private var showServerSettings = false
  @State private var hasServer = APIClient.baseURL != nil
  @State private var pages: [CapturedPage] = []
  @State private var selectedPage = 0
  @State private var retakeIndex: Int?

  private var queue: ReceiptQueue { ReceiptQueue.shared }

  var body: some View {
    Group {
      if !hasServer {
        ServerSettingsView(isInitialSetup: true) {
          hasServer = APIClient.baseURL != nil
        }
      } else if pages.isEmpty {
        home
      } else {
        review
      }
    }
    .tint(accent)
    .fullScreenCover(isPresented: $showCamera) {
      ScanCameraView(
        onCapture: { image in
          apply(image)
          showCamera = false
        },
        onCancel: {
          retakeIndex = nil
          showCamera = false
        }
      )
      .ignoresSafeArea()
    }
    .sheet(isPresented: $showHeldReceipts) {
      HeldReceiptsView()
    }
    .sheet(isPresented: $showServerSettings) {
      ServerSettingsView {
        hasServer = APIClient.baseURL != nil
      }
    }
  }

  // MARK: - Home

  private var home: some View {
    VStack(spacing: 28) {
      HStack {
        Text("Receipts")
          .font(.largeTitle.weight(.semibold))
        Spacer()
        Button {
          showServerSettings = true
        } label: {
          Image(systemName: "gearshape")
        }
        if session.isSignedIn {
          Button("Sign out", role: .destructive, action: session.signOut)
        }
      }

      Spacer()

      if session.isSignedIn {
        Button {
          session.status = ""
          retakeIndex = nil
          showCamera = true
        } label: {
          ZStack {
            Circle()
              .fill(accent)
              .frame(width: 184, height: 184)
              .shadow(color: accent.opacity(0.45), radius: 18, y: 8)
            VStack(spacing: 8) {
              Image(systemName: "camera.viewfinder")
                .font(.system(size: 40, weight: .regular))
              Text("Capture\nReceipt")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            }
            .foregroundStyle(.white)
          }
        }
        .buttonStyle(.plain)
        .disabled(session.isUploading)
      } else {
        Button("Sign in with Google") {
          session.signIn()
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(accent)
      }

      if session.isUploading {
        ProgressView("Saving…")
      }

      if !session.status.isEmpty {
        Text(session.status)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }

      Spacer()

      heldSummary
    }
    .padding()
    .onChange(of: queue.held.count) { previous, count in
      // Background / foreground auto-retry drains the queue without touching
      // session.status — drop the stale hold banner once nothing is waiting.
      guard count == 0, previous > 0 else { return }
      if Self.isHoldStatus(session.status) {
        session.status = ""
      }
    }
  }

  @ViewBuilder
  private var heldSummary: some View {
    let waiting = queue.held.count
    if waiting > 0 {
      VStack(spacing: 12) {
        Label(
          waiting == 1
            ? "1 receipt couldn't be submitted and will be retried"
            : "\(waiting) receipts couldn't be submitted and will be retried",
          systemImage: "clock.arrow.circlepath"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)

        if let detail = queue.lastError {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .lineLimit(3)
        }

        VStack(spacing: 10) {
          heldActionButton(
            title: queue.isRetrying ? "Retrying…" : "Retry now",
            disabled: queue.isRetrying
          ) {
            Task { await retryHeldFromHome() }
          }

          heldActionButton(title: "View waiting receipts") {
            showHeldReceipts = true
          }
        }
        .padding(.top, 4)
      }
    }
  }

  private func heldActionButton(
    title: String,
    disabled: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: accent.opacity(0.35), radius: 10, y: 4)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.55 : 1)
  }

  private func retryHeldFromHome() async {
    switch await queue.retryHeld(token: session.token) {
    case .idle:
      break
    case .needsSignIn:
      session.expireSession(message: "Sign-in expired. Sign in, then tap Retry now.")
    case .uploaded(let count):
      session.status = count == 1 ? "Saved." : "Saved \(count) receipts."
    case .pending(let remaining, let message):
      session.status = "\(message) \(remaining) still waiting."
    }
  }

  /// Status lines written when a receipt is held or a retry leaves items waiting.
  private static func isHoldStatus(_ status: String) -> Bool {
    status.contains("couldn't be submitted")
      || status.contains("still waiting")
      || status.contains("Couldn't reach the server")
      || status.contains("Sign-in expired")
      || status.contains("Server refused")
      || status.contains("The scan is too large")
  }

  // MARK: - Review

  private var review: some View {
    VStack(spacing: 16) {
      HStack {
        Button("Discard", role: .destructive) {
          pages = []
          selectedPage = 0
          session.status = ""
        }
        .disabled(session.isUploading)
        Spacer()
        Text(pages.count == 1 ? "1 page" : "\(pages.count) pages")
          .font(.headline)
        Spacer()
        Color.clear.frame(width: 64, height: 1)
      }

      TabView(selection: $selectedPage) {
        ForEach(Array(pages.enumerated()), id: \.element.id) { index, page in
          Image(uiImage: page.image)
            .resizable()
            .scaledToFit()
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 8)
            .tag(index)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: pages.count > 1 ? .always : .never))

      HStack(spacing: 12) {
        Button {
          retakeIndex = selectedPage
          showCamera = true
        } label: {
          Text("Retake").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(session.isUploading)

        Button {
          retakeIndex = nil
          showCamera = true
        } label: {
          Text("Add page").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(session.isUploading)
      }

      Button {
        Task { await save() }
      } label: {
        Text(session.isUploading ? "Saving…" : "Save")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .tint(accent)
      .disabled(session.isUploading)
    }
    .padding()
  }

  // MARK: - Actions

  private func apply(_ image: UIImage) {
    let page = CapturedPage(capturedAt: Date(), image: image)
    if let index = retakeIndex, pages.indices.contains(index) {
      pages[index] = page
      selectedPage = index
    } else {
      pages.append(page)
      selectedPage = pages.count - 1
    }
    retakeIndex = nil
  }

  private func save() async {
    guard let token = session.token else { return }
    let batch = pages
    session.isUploading = true
    defer { session.isUploading = false }

    var saved = 0
    var held = 0
    var stuckReason = "Couldn't reach the server"
    var failures: [String] = []

    for page in batch {
      switch await queue.submit(image: page.image, capturedAt: page.capturedAt, token: token) {
      case .saved:
        saved += 1
      case .held(let reason):
        held += 1
        stuckReason = reason
      case .failed(let reason):
        failures.append(reason)
      }
    }

    if failures.isEmpty {
      pages = []
      selectedPage = 0
    }
    let text = statusText(saved: saved, held: held, stuckReason: stuckReason, failures: failures)
    if held > 0, stuckReason == "Sign-in expired" {
      // The stored token is no longer valid — clear it now rather than
      // leaving the app looking signed in until the user notices and taps
      // Sign Out themselves.
      session.expireSession(message: text)
    } else {
      session.status = text
    }
  }

  private func statusText(saved: Int, held: Int, stuckReason: String, failures: [String]) -> String {
    var lines: [String] = []

    if saved > 0 {
      lines.append(saved == 1 ? "Saved." : "Saved \(saved) pages.")
    }

    if held > 0 {
      let count = held == 1 ? "1 receipt" : "\(held) receipts"
      lines.append("\(stuckReason). \(count) couldn't be submitted and will be retried.")
    }

    if let first = failures.first {
      lines.append(first)
    }

    return lines.joined(separator: "\n")
  }
}
