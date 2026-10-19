#!/usr/bin/env bash
# Push the working tree to the Pi. The Mac is an editor; the Pi runs everything.
set -euo pipefail
PI="${PI:-miapi@192.168.1.100}"
DEST="${DEST:-~/bummyWAVES}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rsync -av --delete \
  --exclude '.git' --exclude 'bridge/certs' --exclude '__pycache__' \
  --exclude '.DS_Store' --exclude '.venv' \
  ./ "$PI:$DEST/"
echo
echo "deployed to $PI:$DEST"
echo "  ssh $PI 'cd $DEST && ./bridge/make_cert.sh && python3 bridge/bridge.py'"
