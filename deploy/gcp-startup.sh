#!/bin/bash
set -eu

data_device=/dev/disk/by-id/google-compralo-data
data_mount=/mnt/disks/compralo
image=europe-southwest1-docker.pkg.dev/tempvpn-tombo/compralo/compralo-api:latest
secret_resource=projects/295320752338/secrets/compralo-spider-cloud-api-key/versions/latest
docker_config=/var/lib/compralo-docker
docker_network=compralo
https_hostname=34-175-42-226.sslip.io

if ! blkid "$data_device" >/dev/null 2>&1; then
    mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard "$data_device"
fi

mkdir -p "$data_mount"
if ! mountpoint -q "$data_mount"; then
    mount -o discard,defaults "$data_device" "$data_mount"
fi
chmod 0770 "$data_mount"
chown 10001:10001 "$data_mount"

mkdir -p "$docker_config"
DOCKER_CONFIG="$docker_config" docker-credential-gcr configure-docker --registries=europe-southwest1-docker.pkg.dev
DOCKER_CONFIG="$docker_config" docker pull "$image"
docker pull caddy:2-alpine
docker network inspect "$docker_network" >/dev/null 2>&1 || docker network create "$docker_network"
docker rm -f compralo-caddy >/dev/null 2>&1 || true
docker rm -f compralo-api >/dev/null 2>&1 || true
docker run -d \
    --name compralo-api \
    --restart unless-stopped \
    --network "$docker_network" \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    -v "$data_mount:/data" \
    -e SPIDER_CLOUD_API_KEY_SECRET_RESOURCE="$secret_resource" \
    "$image"

docker run -d \
    --name compralo-caddy \
    --restart unless-stopped \
    --network "$docker_network" \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    -p 80:80 \
    -p 443:443 \
    -p 443:443/udp \
    -v compralo-caddy-data:/data \
    -v compralo-caddy-config:/config \
    caddy:2-alpine caddy reverse-proxy \
    --from "$https_hostname" \
    --to compralo-api:8080
