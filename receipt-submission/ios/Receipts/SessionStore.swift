import AuthenticationServices
import Foundation
import Observation
import UIKit

@Observable
final class SessionStore: NSObject, ASWebAuthenticationPresentationContextProviding {
  /// Background retries read this without a SessionStore instance.
  static let tokenKey = "receipts.sessionToken"
  private let tokenKey = SessionStore.tokenKey
  var token: String?
  var status: String = ""
  var isUploading = false
  private var authSession: ASWebAuthenticationSession?

  var isSignedIn: Bool { token != nil && !(token ?? "").isEmpty }

  override init() {
    token = UserDefaults.standard.string(forKey: tokenKey)
    super.init()
  }

  func handleAuthCallback(_ url: URL) {
    guard url.scheme == "receipts" else { return }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
          !token.isEmpty
    else {
      status = "Sign-in did not return a session."
      return
    }
    self.token = token
    UserDefaults.standard.set(token, forKey: tokenKey)
    status = "Signed in."
  }

  func signIn() {
    guard let signInURL = APIClient.signInURL() else {
      status = "Set up a server first."
      return
    }
    let session = ASWebAuthenticationSession(
      url: signInURL,
      callbackURLScheme: "receipts"
    ) { [weak self] url, error in
      DispatchQueue.main.async {
        if let error {
          self?.status = error.localizedDescription
          return
        }
        if let url {
          self?.handleAuthCallback(url)
        }
      }
    }
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    authSession = session
    _ = session.start()
  }

  func signOut() {
    token = nil
    UserDefaults.standard.removeObject(forKey: tokenKey)
    status = ""
  }

  /// The server rejected the stored token (401). Clears it exactly like
  /// `signOut()` so the UI falls straight through to the sign-in button —
  /// the user should never have to tap Sign Out themselves just to be
  /// allowed to sign back in.
  func expireSession(message: String = "Sign-in expired. Sign in to continue.") {
    token = nil
    UserDefaults.standard.removeObject(forKey: tokenKey)
    status = message
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first?.windows.first { $0.isKeyWindow } ?? UIWindow()
  }
}
