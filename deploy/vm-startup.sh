#!/bin/bash
# Compralo — GCE startup script (Debian 12).
#
# Runs as root on every boot; everything below is idempotent. Its only job is to make
# `docker compose up -d --build` work when `./deploy/gcp.sh push` arrives. It does not
# clone the repository: the code is private and deploy/.env cannot live in git, so the
# source and the secrets both come over rsync from the operator's machine.
#
# Lineage: deploy/gcp-startup.sh (P1's single-container Artifact Registry deploy).
# This one builds from source on the VM instead, so all four services can ship without
# a registry, and adds the swap that the Rust release build needs on 2 GB of RAM.

set -eux

MARKER=/var/lib/compralo-bootstrap.done
SWAPFILE=/swapfile
SWAP_GB=6

exec > >(tee -a /var/log/compralo-startup.log) 2>&1
echo "=== compralo startup $(date -Is) ==="

# ---- swap ---------------------------------------------------------------------
# An e2-small has 2 GB. `cargo build --release` across the P1 workspace will be killed
# by the OOM reaper without this. Slow, but it finishes.
if [ ! -f "$SWAPFILE" ]; then
    fallocate -l "${SWAP_GB}G" "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_GB * 1024))
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE"
fi
swapon --show | grep -q "$SWAPFILE" || swapon "$SWAPFILE"
grep -q "^$SWAPFILE" /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
sysctl -w vm.swappiness=10

# ---- docker engine + compose plugin --------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

# Daemon-wide log caps, belt and braces with the per-service limits in compose.yaml.
if [ ! -f /etc/docker/daemon.json ]; then
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
    systemctl restart docker
fi

# rsync is how `push` delivers the tree; Debian cloud images do not ship it.
command -v rsync >/dev/null 2>&1 || { apt-get update && apt-get install -y --no-install-recommends rsync; }

# ---- destination ---------------------------------------------------------------
# `push` rsyncs into the SSH user's ~/compralo; this is only a convenience symlink
# target for anyone poking around the box later.
mkdir -p /opt/compralo

touch "$MARKER"
echo "=== compralo startup complete $(date -Is) ==="
