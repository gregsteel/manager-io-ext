import Foundation

/// Capture-time stamps shared by the upload filename and the `capturedAt` field,
/// so a receipt held offline still files under when it was taken.
enum ReceiptStamp {
  private static func formatter(_ format: String) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = format
    return formatter
  }

  static func filename(_ date: Date) -> String {
    "receipt_\(formatter("yyyy-MM-dd_HH-mm-ss").string(from: date)).jpg"
  }

  static func wire(_ date: Date) -> String {
    formatter("yyyy-MM-dd'T'HH:mm:ssXXXXX").string(from: date)
  }
}

enum APIClient {
  /// `status` is nil when the request never got a reply, which is the "server is
  /// offline" case the local hold-and-retry queue exists for.
  struct UploadError: LocalizedError {
    let status: Int?
    let message: String

    var reachedServer: Bool { status != nil }
    var errorDescription: String? { message }
  }

  private static let serverURLKey = "receipts.serverURL"
  private static let bootstrappedKey = "receipts.serverURLBootstrapped"

  /// There is no built-in server — the user enters one on first launch.
  static var baseURL: URL? {
    guard let raw = UserDefaults.standard.string(forKey: serverURLKey), !raw.isEmpty else {
      return nil
    }
    return URL(string: raw)
  }

  /// Pass nil to clear it, dropping the app back into first-run setup.
  static func setBaseURL(_ url: URL?) {
    if let url {
      UserDefaults.standard.set(url.absoluteString, forKey: serverURLKey)
    } else {
      UserDefaults.standard.removeObject(forKey: serverURLKey)
    }
  }

  /// Only present when `ci_scripts/ci_post_clone.sh` injected one via the
  /// Xcode Cloud `RECEIPTS_DEFAULT_SERVER_URL` variable — absent for local
  /// builds and other forks, which fall back to the ordinary setup screen.
  private static var ciDefaultBaseURL: URL? {
    guard
      let raw = Bundle.main.object(forInfoDictionaryKey: "RECEIPTS_DEFAULT_SERVER_URL") as? String,
      !raw.isEmpty
    else {
      return nil
    }
    return URL(string: raw)
  }

  /// Call once at launch, before anything reads `baseURL`. Seeds the
  /// CI-provided default exactly once per install so a build made with
  /// `RECEIPTS_DEFAULT_SERVER_URL` skips first-run setup entirely. After that
  /// first run, removing the server via Settings sticks — it is never
  /// re-seeded, so this only ever fires once.
  static func bootstrapDefaultServerIfNeeded() {
    let defaults = UserDefaults.standard
    guard !defaults.bool(forKey: bootstrappedKey) else { return }
    defaults.set(true, forKey: bootstrappedKey)
    if baseURL == nil, let ciDefaultBaseURL {
      setBaseURL(ciDefaultBaseURL)
    }
  }

  static func signInURL() -> URL? {
    guard let baseURL else { return nil }
    var components = URLComponents(url: baseURL.appending(path: "/auth/google"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "native", value: "1")]
    return components.url!
  }

  static func upload(imageData: Data, capturedAt: Date, token: String) async throws {
    guard let baseURL else {
      throw UploadError(status: nil, message: "No server configured.")
    }
    var request = URLRequest(url: baseURL.appending(path: "/api/send"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 30

    let boundary = "receipt-\(UUID().uuidString)"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

    // A held receipt can upload days after it was taken, so the capture time
    // travels with it rather than being inferred from the request.
    let filename = ReceiptStamp.filename(capturedAt)
    var body = Data()
    body.append("--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"capturedAt\"\r\n\r\n".data(using: .utf8)!)
    body.append(ReceiptStamp.wire(capturedAt).data(using: .utf8)!)
    body.append("\r\n--\(boundary)\r\n".data(using: .utf8)!)
    body.append("Content-Disposition: form-data; name=\"receipt\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
    body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
    body.append(imageData)
    body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
    request.httpBody = body

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw UploadError(status: nil, message: error.localizedDescription)
    }

    guard let http = response as? HTTPURLResponse else {
      throw UploadError(status: nil, message: "The server sent an unreadable reply.")
    }
    guard (200 ..< 300).contains(http.statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw UploadError(status: http.statusCode, message: Self.friendlyMessage(status: http.statusCode, body: body))
    }
  }

  private static func friendlyMessage(status: Int, body: String) -> String {
    switch status {
    case 401:
      return "Sign-in expired."
    case 413:
      return "The scan is too large for the server."
    default:
      break
    }
    if let json = jsonError(in: body) {
      return json
    }
    if body.localizedCaseInsensitiveContains("<html") || body.isEmpty {
      return "Server refused the upload (HTTP \(status))."
    }
    return body
  }

  private static func jsonError(in body: String) -> String? {
    guard
      let data = body.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let error = object["error"] as? String,
      !error.isEmpty
    else {
      return nil
    }
    return error
  }
}
