import Foundation
import Observation
import UIKit

struct HeldReceipt: Codable, Identifiable, Equatable {
  let id: UUID
  let capturedAt: Date
  var attempts: Int
  var lastError: String?
}

/// Receipts that failed to upload live on disk here until the server accepts
/// them. Nothing is ever dropped just because the server was down.
@MainActor
@Observable
final class ReceiptQueue {
  static let shared = ReceiptQueue()

  enum Outcome {
    case saved
    case held(reason: String)
    case failed(String)
  }

  enum RetryResult: Equatable {
    case idle
    case needsSignIn
    case uploaded(Int)
    /// Still sitting on the phone; `message` is the latest error to show.
    case pending(remaining: Int, message: String)
  }

  private(set) var held: [HeldReceipt] = []
  private(set) var isRetrying = false

  private let folder: URL

  private init() {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    folder = documents.appendingPathComponent("HeldReceipts", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    held = loadIndex()
  }

  /// Latest error across held receipts, for the home dashboard.
  var lastError: String? {
    held.reversed().compactMap(\.lastError).first
  }

  // MARK: - Submitting

  func submit(image: UIImage, capturedAt: Date, token: String) async -> Outcome {
    guard let data = ReceiptImage.jpegData(from: image) else {
      return .failed("Could not encode that photo.")
    }

    do {
      try await APIClient.upload(imageData: data, capturedAt: capturedAt, token: token)
      return .saved
    } catch {
      var record = HeldReceipt(
        id: UUID(),
        capturedAt: capturedAt,
        attempts: 1,
        lastError: Self.displayMessage(for: error)
      )
      guard write(&record, imageData: data) else {
        return .failed("Could not reach the server or save the photo on this phone.")
      }
      return .held(reason: Self.reason(for: error))
    }
  }

  private static func reason(for error: Error) -> String {
    guard let upload = error as? APIClient.UploadError, upload.reachedServer else {
      return "Couldn't reach the server"
    }
    if upload.status == 401 { return "Sign-in expired" }
    if upload.status == 413 { return "The scan is too large" }
    return "Server refused the upload"
  }

  private static func displayMessage(for error: Error) -> String {
    (error as? APIClient.UploadError)?.message ?? error.localizedDescription
  }

  // MARK: - Retrying

  @discardableResult
  func retryHeld(token: String? = nil) async -> RetryResult {
    guard !isRetrying else { return .idle }
    guard !held.isEmpty else { return .idle }

    let resolved =
      token
      ?? UserDefaults.standard.string(forKey: SessionStore.tokenKey)
    guard let resolved, !resolved.isEmpty else {
      return .needsSignIn
    }

    isRetrying = true
    defer { isRetrying = false }

    var uploaded = 0
    var lastMessage = "Upload failed."

    for record in held {
      guard var data = try? Data(contentsOf: imageURL(record.id)) else {
        discard(record.id)
        continue
      }

      // Receipts held before downscaling can still be several MB; shrink them
      // in place so a 413 doesn't keep failing forever.
      if data.count > ReceiptImage.maxUploadBytes, let smaller = ReceiptImage.jpegData(from: data) {
        data = smaller
        try? data.write(to: imageURL(record.id), options: .atomic)
      }

      do {
        try await APIClient.upload(imageData: data, capturedAt: record.capturedAt, token: resolved)
        discard(record.id)
        uploaded += 1
      } catch {
        let message = Self.displayMessage(for: error)
        lastMessage = message
        update(record.id) {
          $0.attempts += 1
          $0.lastError = message
        }
        if let upload = error as? APIClient.UploadError, upload.status == 401 {
          return .needsSignIn
        }
      }
    }

    if held.isEmpty {
      return .uploaded(uploaded)
    }
    return .pending(remaining: held.count, message: lastMessage)
  }

  // MARK: - Storage

  private var indexURL: URL { folder.appendingPathComponent("index.json") }

  private func imageURL(_ id: UUID) -> URL {
    folder.appendingPathComponent("\(id.uuidString).jpg")
  }

  private func loadIndex() -> [HeldReceipt] {
    guard let data = try? Data(contentsOf: indexURL) else { return [] }
    return (try? JSONDecoder().decode([HeldReceipt].self, from: data)) ?? []
  }

  private func saveIndex() {
    guard let data = try? JSONEncoder().encode(held) else { return }
    try? data.write(to: indexURL, options: .atomic)
  }

  private func write(_ record: inout HeldReceipt, imageData: Data) -> Bool {
    do {
      try imageData.write(to: imageURL(record.id), options: .atomic)
    } catch {
      return false
    }
    held.append(record)
    saveIndex()
    return true
  }

  private func update(_ id: UUID, _ change: (inout HeldReceipt) -> Void) {
    guard let index = held.firstIndex(where: { $0.id == id }) else { return }
    change(&held[index])
    saveIndex()
  }

  /// Loads the JPEG for a held receipt, if it is still on disk.
  func image(for id: UUID) -> UIImage? {
    guard let data = try? Data(contentsOf: imageURL(id)) else { return nil }
    return UIImage(data: data)
  }

  /// Removes one held receipt from local storage. It will not be retried.
  func remove(_ id: UUID) {
    discard(id)
  }

  /// Clears the entire local retry queue.
  func removeAll() {
    for record in held {
      try? FileManager.default.removeItem(at: imageURL(record.id))
    }
    held = []
    saveIndex()
  }

  private func discard(_ id: UUID) {
    try? FileManager.default.removeItem(at: imageURL(id))
    held.removeAll { $0.id == id }
    saveIndex()
  }
}
