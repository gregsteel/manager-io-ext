import SwiftUI

/// There is no built-in server: this view is how one gets configured, either
/// as the mandatory first-run screen (`isInitialSetup`) or later via the
/// gear icon to change or remove it. The session token is only valid against
/// the server that issued it, so changing or removing it signs the user out.
struct ServerSettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(SessionStore.self) private var session

  var isInitialSetup = false
  var onChange: () -> Void = {}

  @State private var text = APIClient.baseURL?.absoluteString ?? ""
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("https://receipts.example.com", text: $text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
        } footer: {
          Text(
            isInitialSetup
              ? "Enter the address of your receipts server."
              : "Changing this signs you out — the session only works with the server that issued it."
          )
        }

        if let error {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.red)
        }

        if !isInitialSetup && APIClient.baseURL != nil {
          Section {
            Button("Remove server", role: .destructive, action: remove)
          }
        }
      }
      .navigationTitle(isInitialSetup ? "Set Up Server" : "Server")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if !isInitialSetup {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save", action: save)
        }
      }
    }
  }

  private func save() {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      let url = URL(string: trimmed),
      let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      url.host?.isEmpty == false
    else {
      error = "Enter a valid http(s):// URL."
      return
    }

    let changed = url.absoluteString != APIClient.baseURL?.absoluteString
    APIClient.setBaseURL(url)
    if changed {
      session.signOut()
    }
    onChange()
    if !isInitialSetup {
      dismiss()
    }
  }

  private func remove() {
    APIClient.setBaseURL(nil)
    session.signOut()
    text = ""
    onChange()
    dismiss()
  }
}
