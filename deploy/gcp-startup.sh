#!/bin/bash
set -eu

data_device=/dev/disk/by-id/google-compralo-data
data_mount=/mnt/disks/compralo
image=europe-southwest1-docker.pkg.dev/tempvpn-tombo/compralo/compralo-api:latest
secret_resource=projects/295320752338/secrets/compralo-spider-cloud-api-key/versions/latest

if ! blkid "$data_device" >/dev/null 2>&1; then
    mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard "$data_device"
fi

mkdir -p "$data_mount"
if ! mountpoint -q "$data_mount"; then
    mount -o discard,defaults "$data_device" "$data_mount"
fi
chmod 0770 "$data_mount"
chown 10001:10001 "$data_mount"

docker-credential-gcr configure-docker --registries=europe-southwest1-docker.pkg.dev
docker pull "$image"
docker rm -f compralo-api >/dev/null 2>&1 || true
docker run -d \
    --name compralo-api \
    --restart unless-stopped \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    -p 80:8080 \
    -v "$data_mount:/data" \
    -e SPIDER_CLOUD_API_KEY_SECRET_RESOURCE="$secret_resource" \
    "$image"
