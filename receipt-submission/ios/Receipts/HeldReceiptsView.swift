import SwiftUI

/// Browse and delete receipts waiting in local retry storage.
struct HeldReceiptsView: View {
  @Environment(\.dismiss) private var dismiss
  private var queue: ReceiptQueue { ReceiptQueue.shared }
  @State private var preview: HeldReceipt?
  @State private var confirmClearAll = false

  private static let stamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return formatter
  }()

  var body: some View {
    NavigationStack {
      Group {
        if queue.held.isEmpty {
          ContentUnavailableView(
            "Nothing waiting",
            systemImage: "checkmark.circle",
            description: Text("Held receipts appear here when an upload fails.")
          )
        } else {
          list
        }
      }
      .navigationTitle("Waiting to upload")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if !queue.held.isEmpty {
            Button("Clear all", role: .destructive) {
              confirmClearAll = true
            }
          }
        }
      }
      .confirmationDialog(
        "Remove all waiting receipts from this phone?",
        isPresented: $confirmClearAll,
        titleVisibility: .visible
      ) {
        Button("Clear all", role: .destructive) {
          queue.removeAll()
          dismiss()
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("They will not be uploaded. This cannot be undone.")
      }
      .sheet(item: $preview) { record in
        previewSheet(record)
      }
    }
  }

  private var list: some View {
    List {
      ForEach(queue.held) { record in
        Button {
          preview = record
        } label: {
          HStack(spacing: 12) {
            thumbnail(record)
            VStack(alignment: .leading, spacing: 4) {
              Text(Self.stamp.string(from: record.capturedAt))
                .font(.body.weight(.medium))
                .foregroundStyle(.primary)
              Text(subtitle(record))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.tertiary)
          }
        }
      }
      .onDelete(perform: delete)
    }
  }

  private func thumbnail(_ record: HeldReceipt) -> some View {
    Group {
      if let image = queue.image(for: record.id) {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      } else {
        Image(systemName: "doc")
          .foregroundStyle(.secondary)
      }
    }
    .frame(width: 56, height: 72)
    .background(Color(.secondarySystemFill))
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private func subtitle(_ record: HeldReceipt) -> String {
    var parts = ["Attempt \(record.attempts)"]
    if let error = record.lastError, !error.isEmpty {
      parts.append(error)
    }
    return parts.joined(separator: " · ")
  }

  private func delete(at offsets: IndexSet) {
    let ids = offsets.map { queue.held[$0].id }
    for id in ids {
      queue.remove(id)
    }
  }

  private func previewSheet(_ record: HeldReceipt) -> some View {
    NavigationStack {
      Group {
        if let image = queue.image(for: record.id) {
          ScrollView {
            Image(uiImage: image)
              .resizable()
              .scaledToFit()
              .padding()
          }
        } else {
          ContentUnavailableView(
            "Image missing",
            systemImage: "exclamationmark.triangle",
            description: Text("The file is no longer on this phone.")
          )
        }
      }
      .navigationTitle(Self.stamp.string(from: record.capturedAt))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { preview = nil }
        }
        ToolbarItem(placement: .bottomBar) {
          Button("Remove from phone", role: .destructive) {
            queue.remove(record.id)
            preview = nil
            if queue.held.isEmpty {
              dismiss()
            }
          }
        }
      }
    }
  }
}
