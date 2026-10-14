#!/bin/sh
# Ubuntu 24.04 only. Does not remove or upgrade an existing Docker installation.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run with sudo'; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo 'Use the documented Ubuntu 24.04 deployment target'; exit 1; }
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null
  docker compose version
  python3 -c 'import sys; assert sys.version_info >= (3,11)'
  exit 0
fi
apt-get update
apt-get install -y ca-certificates curl git python3
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker info >/dev/null
docker compose version
