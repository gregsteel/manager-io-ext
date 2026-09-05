#!/bin/bash
set -eu

# The tracked project.pbxproj commits a neutral placeholder bundle id
# (au.com.acme.receipts) so the public repo doesn't carry the real one.
# Xcode Cloud always builds exactly what's on the watched branch — there is
# no "local uncommitted override" for it the way there is for a dev machine —
# so this swaps in the real identifier right after clone, before Xcode reads
# the project's build settings.
#
# Requires a Plain environment variable named RECEIPTS_BUNDLE_ID on this
# Xcode Cloud workflow: App Store Connect > Xcode Cloud > (workflow) >
# Environment > Environment Variables > Add > name RECEIPTS_BUNDLE_ID,
# value <your real bundle id, e.g. <domain-reverse>.receipts>. Neither this
# nor RECEIPTS_DEFAULT_SERVER_URL below need Secret — a bundle id and a
# server hostname are both already public (App Store listing, DNS).

if [ -z "${RECEIPTS_BUNDLE_ID:-}" ]; then
  echo "error: RECEIPTS_BUNDLE_ID is not set on this Xcode Cloud workflow" >&2
  exit 1
fi

project_file="$CI_PRIMARY_REPOSITORY_PATH/ios/Receipts.xcodeproj/project.pbxproj"

sed -i '' \
  "s/PRODUCT_BUNDLE_IDENTIFIER = [^;]*;/PRODUCT_BUNDLE_IDENTIFIER = ${RECEIPTS_BUNDLE_ID};/g" \
  "$project_file"

# Optional: pre-fills the server URL so a TestFlight install from this
# workflow skips first-run setup entirely (APIClient.bootstrapDefaultServerIfNeeded,
# ReceiptsApp.swift init). Unset on other workflows/forks — the app just falls
# back to its normal manual setup screen. Add as a Plain variable named
# RECEIPTS_DEFAULT_SERVER_URL, value https://your-server.example, on the same
# Xcode Cloud workflow as RECEIPTS_BUNDLE_ID.
if [ -n "${RECEIPTS_DEFAULT_SERVER_URL:-}" ]; then
  info_plist="$CI_PRIMARY_REPOSITORY_PATH/ios/Receipts/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :RECEIPTS_DEFAULT_SERVER_URL string ${RECEIPTS_DEFAULT_SERVER_URL}" "$info_plist" \
    || /usr/libexec/PlistBuddy -c "Set :RECEIPTS_DEFAULT_SERVER_URL ${RECEIPTS_DEFAULT_SERVER_URL}" "$info_plist"
fi
