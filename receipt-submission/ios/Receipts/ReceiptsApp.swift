import BackgroundTasks
import SwiftUI

/// Matches Info.plist's `BGTaskSchedulerPermittedIdentifiers` entry
/// (`$(PRODUCT_BUNDLE_IDENTIFIER).retry`) automatically, whatever the bundle
/// identifier is set to.
private let retryTaskIdentifier = (Bundle.main.bundleIdentifier ?? "receipts") + ".retry"
private let foregroundRetryInterval: Duration = .seconds(60)

private func scheduleBackgroundRetry() {
  let request = BGAppRefreshTaskRequest(identifier: retryTaskIdentifier)
  request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
  try? BGTaskScheduler.shared.submit(request)
}

@main
struct ReceiptsApp: App {
  @State private var session = SessionStore()
  @Environment(\.scenePhase) private var scenePhase

  init() {
    // Must run before ContentView's `hasServer` state is first read.
    APIClient.bootstrapDefaultServerIfNeeded()
  }

  /// Clears the stale token on a 401 so the app falls straight through to
  /// the sign-in button next time it's opened, instead of still looking
  /// signed in until the user notices and taps Sign Out themselves.
  private func handleRetryResult(_ result: ReceiptQueue.RetryResult) {
    if case .needsSignIn = result {
      session.expireSession()
    }
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environment(session)
        .onOpenURL { url in
          session.handleAuthCallback(url)
        }
        .task {
          handleRetryResult(await ReceiptQueue.shared.retryHeld())
          scheduleBackgroundRetry()
        }
        .task {
          while !Task.isCancelled {
            try? await Task.sleep(for: foregroundRetryInterval)
            handleRetryResult(await ReceiptQueue.shared.retryHeld())
          }
        }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active:
        Task { handleRetryResult(await ReceiptQueue.shared.retryHeld()) }
      case .background:
        scheduleBackgroundRetry()
      default:
        break
      }
    }
    .backgroundTask(.appRefresh(retryTaskIdentifier)) {
      handleRetryResult(await ReceiptQueue.shared.retryHeld())
      scheduleBackgroundRetry()
    }
  }
}
