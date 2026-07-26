#!/bin/bash
#
# Sign, notarize and staple the DMG itself.
#
# electron-builder notarizes the .app and then builds the DMG *around* it, so
# the container is left unsigned even on a fully successful `dist:release`. The
# app inside is stapled and launches fine once dragged out, but a downloaded DMG
# carries a quarantine flag and Gatekeeper rejects the image at mount:
#
#   spctl -a -t install Foreman.dmg  ->  rejected, source=no usable signature
#
# Nothing in the build output says so, which is why this is a script and not a
# line in the README.
set -euo pipefail

cd "$(dirname "$0")/.."
shopt -s nullglob
dmgs=(release/*.dmg)
if [ ${#dmgs[@]} -eq 0 ]; then
  echo "notarize-dmg: no DMG in release/ — run 'npm run dist' first" >&2
  exit 1
fi

# Prefix match: unique as long as the keychain holds one Developer ID
# Application identity. codesign errors out rather than guessing if not.
identity="Developer ID Application"

# Same credential precedence as electron-builder, so one set of env vars drives
# both halves of the release.
if [ -n "${APPLE_API_KEY:-}" ]; then
  creds=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  creds=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
elif [ -n "${APPLE_ID:-}" ]; then
  creds=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  echo "notarize-dmg: no notarization credentials in the environment — see README" >&2
  exit 1
fi

for dmg in "${dmgs[@]}"; do
  echo "==> $dmg"
  codesign --sign "$identity" --timestamp "$dmg"
  xcrun notarytool submit "$dmg" "${creds[@]}" --wait
  xcrun stapler staple "$dmg"
  # Proof, not hope: this is the check that would have caught the gap.
  spctl -a -vvv --type install "$dmg"
done
