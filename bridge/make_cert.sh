#!/usr/bin/env bash
# Self-signed cert for the bridge.
#
# WebXR only runs in a secure context. https:// with a self-signed cert is the
# only way to reach it from a Quest over a LAN (or the Pi's own hotspot at a
# venue) with no internet and no dev machine in the loop. The Quest browser
# will warn once; tap Advanced -> Proceed.
#
# The cert carries the Pi's IP and hostname as subjectAltNames, so it stays
# valid whether you browse by IP or by name.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
mkdir -p "$DIR"

# Every address this box answers on, plus the r_e_c_u_r-style hotspot IP we
# will use at a venue.
IPS=$(hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
HOST=$(hostname 2>/dev/null || echo localhost)

SAN="DNS:localhost,DNS:${HOST},DNS:${HOST}.local,IP:127.0.0.1,IP:10.3.141.1"
for ip in $IPS; do SAN="${SAN},IP:${ip}"; done

echo "subjectAltName = ${SAN}"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -days 3650 -subj "/CN=bummywaaave" \
  -addext "subjectAltName = ${SAN}" \
  -addext "basicConstraints = CA:FALSE" \
  -addext "keyUsage = digitalSignature, keyEncipherment" \
  -addext "extendedKeyUsage = serverAuth" 2>/dev/null

chmod 600 "$DIR/key.pem"
echo
echo "wrote:"
echo "  $DIR/cert.pem"
echo "  $DIR/key.pem"
echo
echo "valid for: ${SAN}"
