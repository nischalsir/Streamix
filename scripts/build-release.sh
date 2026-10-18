#!/usr/bin/env bash
# Builds a signed Streamix release APK.
#
# Usage: scripts/build-release.sh /path/to/keystore.properties
#
# keystore.properties (keep it, and the .jks it points to, OUT of the repo):
#   keystore.file=/absolute/path/to/streamix-release.jks
#   keystore.password=...
#   signing.key.alias=streamix
#   signing.key.password=...
#
# Updates must be signed with the same key, or the TV refuses to install them over the old version.
set -euo pipefail

props="${1:?Pass the path to keystore.properties}"
prop() { grep "^$1=" "$props" | cut -d= -f2-; }

cd "$(dirname "$0")/.."
./gradlew assembleLibreRelease \
    -Pkeystore.file="$(prop keystore.file)" \
    -Pkeystore.password="$(prop keystore.password)" \
    -Psigning.key.alias="$(prop signing.key.alias)" \
    -Psigning.key.password="$(prop signing.key.password)"

ls -1 app/build/outputs/apk/libre/release/*.apk
