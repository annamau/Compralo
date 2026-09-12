#!/bin/sh
set -eu

if [ -z "${SPIDER_CLOUD_API_KEY:-}" ] && [ -n "${SPIDER_CLOUD_API_KEY_SECRET_RESOURCE:-}" ]; then
    metadata_url="http://metadata.google.internal/computeMetadata/v1"
    token_json="$(curl --fail --silent --show-error \
        -H 'Metadata-Flavor: Google' \
        "$metadata_url/instance/service-accounts/default/token")"
    access_token="$(printf '%s' "$token_json" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
    if [ -z "$access_token" ]; then
        echo "could not obtain a GCP metadata access token" >&2
        exit 1
    fi

    secret_json="$(curl --fail --silent --show-error \
        -H "Authorization: Bearer $access_token" \
        "https://secretmanager.googleapis.com/v1/${SPIDER_CLOUD_API_KEY_SECRET_RESOURCE}:access")"
    encoded_secret="$(printf '%s' "$secret_json" | sed -n 's/.*"data": *"\([^"]*\)".*/\1/p')"
    if [ -z "$encoded_secret" ]; then
        echo "could not read the configured Spider Cloud secret" >&2
        exit 1
    fi
    SPIDER_CLOUD_API_KEY="$(printf '%s' "$encoded_secret" | base64 -d)"
    export SPIDER_CLOUD_API_KEY
fi

exec /usr/local/bin/compralo-server "$@"
