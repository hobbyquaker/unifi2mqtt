#!/usr/bin/env bash
set -euo pipefail

# Build and deploy the package to a remote host (global npm install location) and restart the
# unifi2mqtt@<name> services there. Same script as in lgtv2mqtt / lgsb2mqtt.
#
# Usage:
#   bash deploy.sh                 # deploys to host "mqtt-ifaces"
#   bash deploy.sh myuser@myhost
#   npm run deploy
#
# Optional env vars:
#   REMOTE_DIR   (default: /usr/local/lib/node_modules/unifi2mqtt)
#   REMOTE_TMP   (default: /tmp)
#   SERVICE      systemd unit(s) to restart after deploying; default: every active
#                unifi2mqtt@<name> instance plus a plain unifi2mqtt unit if present
#   SKIP_TESTS   set to 1 to skip `npm test` before packing
#
# Dependencies that package.json references as `file:../<dir>` (unreleased sibling checkouts of
# mqtt-interfaces-core or cul) are packed and shipped too; registry versions need nothing extra.
#
# The deploy does not create a service; install one once on the target with
#   sudo unifi2mqtt --install -n unifi -c https://192.168.1.1 --username admin --password ... -u mqtt://broker

PKG=unifi2mqtt
REMOTE_HOST="${1:-mqtt-ifaces}"
REMOTE_DIR="${REMOTE_DIR:-/usr/local/lib/node_modules/$PKG}"
REMOTE_TMP="${REMOTE_TMP:-/tmp}"
SERVICE="${SERVICE:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command '$1' not found." >&2
    exit 1
  fi
}

require_cmd npm
require_cmd scp
require_cmd ssh
require_cmd tar
require_cmd node

# load the ssh key into an agent if keychain is installed (non-interactive deploys from WSL)
if command -v keychain >/dev/null 2>&1 && [[ -f ~/.ssh/id_ed25519 ]]; then
  keychain -q --nogui ~/.ssh/id_ed25519
  # shellcheck disable=SC1090
  source ~/.keychain/"$(hostname)-sh"
fi

cd "$(dirname "$0")"

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  echo "Running tests..."
  npm test --silent
fi

TGZ_FILES=()
cleanup() {
  if (( ${#TGZ_FILES[@]} )); then
    rm -f "${TGZ_FILES[@]}"
  fi
}
trap cleanup EXIT

# sibling checkouts referenced as file: dependencies are packed and installed from their tarballs
DEP_TGZS=()
while IFS= read -r dep_dir; do
  [[ -n "$dep_dir" ]] || continue
  if [[ ! -f "$dep_dir/package.json" ]]; then
    echo "Error: package.json depends on file:$dep_dir but it is missing." >&2
    exit 1
  fi
  echo "Packing $dep_dir..."
  dep_tgz="$(npm pack --silent "$dep_dir" | tail -n 1)"
  TGZ_FILES+=("$dep_tgz")
  DEP_TGZS+=("$dep_tgz")
  echo "Created tarball: $dep_tgz"
done < <(node -p 'Object.values(require("./package.json").dependencies).filter(v => v.startsWith("file:")).map(v => v.slice(5)).join("\n")')

echo "Packing npm module..."
TGZ_FILE="$(npm pack --silent | tail -n 1)"
if [[ ! -f "$TGZ_FILE" ]]; then
  echo "Error: npm pack did not produce a tarball." >&2
  exit 1
fi
TGZ_FILES+=("$TGZ_FILE")
echo "Created tarball: $TGZ_FILE"

echo "Copying tarball(s) to ${REMOTE_HOST}:${REMOTE_TMP}/..."
scp "${TGZ_FILES[@]}" "${REMOTE_HOST}:${REMOTE_TMP}/"

REMOTE_TGZ="${REMOTE_TMP}/$(basename "$TGZ_FILE")"
REMOTE_DEP_TGZS=""
for t in "${DEP_TGZS[@]+"${DEP_TGZS[@]}"}"; do
  REMOTE_DEP_TGZS+="${REMOTE_TMP}/$(basename "$t") "
done

echo "Deploying on remote host..."
ssh "$REMOTE_HOST" "PKG='$PKG' REMOTE_TGZ='$REMOTE_TGZ' REMOTE_DEP_TGZS='$REMOTE_DEP_TGZS' REMOTE_DIR='$REMOTE_DIR' SERVICE='$SERVICE' bash -s" <<'EOF'
set -euo pipefail

if [[ ! -f "$REMOTE_TGZ" ]]; then
  echo "Error: remote tarball not found: $REMOTE_TGZ" >&2
  exit 1
fi

sudo mkdir -p "$REMOTE_DIR"
sudo find "$REMOTE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
sudo tar -xzf "$REMOTE_TGZ" -C "$REMOTE_DIR" --strip-components=1
# installing the shipped tarballs replaces their file:../ specs in package.json and pulls the rest;
# shellcheck disable=SC2086
sudo npm install --omit=dev --prefix "$REMOTE_DIR" $REMOTE_DEP_TGZS
# shellcheck disable=SC2086
[[ -z "$REMOTE_DEP_TGZS" ]] || sudo rm -f $REMOTE_DEP_TGZS
# npm install -g would create the bin link; a plain tar extract does not
sudo chmod +x "$REMOTE_DIR/index.js"
sudo ln -sfn "$REMOTE_DIR/index.js" "/usr/local/bin/$PKG"
if [[ -z "$SERVICE" ]]; then
  SERVICE="$(systemctl list-units --plain --no-legend --type=service "$PKG@*.service" "$PKG.service" | awk '{print $1}' | tr '\n' ' ')"
fi
if [[ -n "$SERVICE" ]]; then
  echo "Restarting: $SERVICE"
  # shellcheck disable=SC2086
  sudo systemctl restart $SERVICE
else
  echo "No $PKG service found to restart (install one with: sudo $PKG --install -n unifi -c https://192.168.1.1 --username admin --password ... -u mqtt://broker)"
fi
sudo rm -f "$REMOTE_TGZ"
EOF

echo "Deployment complete."
