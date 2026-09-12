#!/usr/bin/env bash
#
# Compralo — one VM, four services, one command.
#
#   ./deploy/gcp.sh create     reserve an IP, open 80/443, boot the VM (costs money)
#   ./deploy/gcp.sh push       rsync the repo + deploy/.env, then compose up --build
#   ./deploy/gcp.sh status     where it is, what is running, what is healthy
#   ./deploy/gcp.sh logs [svc] follow the logs
#   ./deploy/gcp.sh ssh        a shell on the box
#   ./deploy/gcp.sh destroy    delete the VM, the firewall rule and the IP
#
#   ./deploy/gcp.sh config     print the resolved settings and touch nothing
#   ./deploy/gcp.sh local      bring the same compose file up on this machine
#
# Every command that talks to Google or to the VM is echoed before it runs. `create`
# is idempotent: it describes each resource first and only creates what is missing.
#
# Nothing here reads a key. Secrets live in deploy/.env, which is gitignored, is
# rsynced to the VM by `push`, and is read by compose at `up` time.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="$HERE/.env"

# ---- pretty ---------------------------------------------------------------------
if [ -t 2 ]; then B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; N=$'\033[0m'
else B=''; DIM=''; RED=''; GRN=''; YEL=''; N=''; fi

say()  { printf '%s\n' "${B}$*${N}" >&2; }
info() { printf '%s\n' "$*" >&2; }
warn() { printf '%s\n' "${YEL}warning:${N} $*" >&2; }
die()  { printf '%s\n' "${RED}error:${N} $*" >&2; exit 1; }

# Every shell-out goes through run(), so the transcript of a deploy is the transcript
# of the commands that made it.
run() { printf '%s\n' "${DIM}+ $*${N}" >&2; "$@"; }

# Same, but a non-zero exit is an answer rather than a failure (existence probes).
try() { printf '%s\n' "${DIM}+ $*${N}" >&2; "$@"; }

# ---- settings -------------------------------------------------------------------
# deploy/.env carries both the container secrets and the GCP_* knobs. Only the GCP_*
# ones and DOMAIN are used here.
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

REGION="${GCP_REGION:-europe-southwest1}"
ZONE="${GCP_ZONE:-europe-southwest1-a}"
VM="${GCP_VM_NAME:-compralo}"
MACHINE="${GCP_MACHINE_TYPE:-e2-small}"
DISK_GB="${GCP_BOOT_DISK_GB:-30}"
ADDR_NAME="${GCP_ADDRESS_NAME:-${VM}-ip}"
FW_NAME="${GCP_FIREWALL_NAME:-${VM}-allow-web}"
TAG="${GCP_NETWORK_TAG:-${VM}-web}"
REMOTE_DIR="${GCP_REMOTE_DIR:-compralo}"
COMPOSE="docker compose -f deploy/compose.yaml"

need_gcloud() {
  command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed. See deploy/README.md § 1."
}

project() {
  if [ -n "${GCP_PROJECT:-}" ]; then printf '%s' "$GCP_PROJECT"; return; fi
  local p; p="$(gcloud config get-value project 2>/dev/null || true)"
  [ -n "$p" ] && [ "$p" != "(unset)" ] || die "no project set. Run: gcloud config set project YOUR_PROJECT_ID"
  printf '%s' "$p"
}

G() { run gcloud --project "$(project)" "$@"; }
Gq() { try gcloud --project "$(project)" "$@"; }

static_ip() {
  gcloud --project "$(project)" compute addresses describe "$ADDR_NAME" \
    --region "$REGION" --format='value(address)' 2>/dev/null || true
}

vm_ip() {
  gcloud --project "$(project)" compute instances describe "$VM" --zone "$ZONE" \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true
}

ssh_host() { printf '%s.%s.%s' "$VM" "$ZONE" "$(project)"; }

# One remote command, echoed, over gcloud's own SSH (it handles key provisioning).
remote() {
  run gcloud --project "$(project)" compute ssh "$VM" --zone "$ZONE" --command "$*"
}

remote_tty() {
  run gcloud --project "$(project)" compute ssh "$VM" --zone "$ZONE" -- -t "$*"
}

# ---- preflight ------------------------------------------------------------------
cmd_config() {
  need_gcloud
  say "Resolved settings"
  printf '  %-18s %s\n' \
    project        "$(project)" \
    region         "$REGION" \
    zone           "$ZONE" \
    vm             "$VM" \
    machine-type   "$MACHINE" \
    boot-disk      "${DISK_GB} GB" \
    static-ip-name "$ADDR_NAME" \
    firewall       "$FW_NAME" \
    network-tag    "$TAG" \
    remote-dir     "~/$REMOTE_DIR" \
    domain         "${DOMAIN:-<none — plain HTTP on the IP>}" \
    env-file       "$ENV_FILE $([ -f "$ENV_FILE" ] && echo '(present)' || echo '(MISSING)')" >&2
  echo >&2
  say "Auth"
  try gcloud auth list --format='table(account, status)'
  echo >&2
  say "Reserved address"
  local ip; ip="$(static_ip)"
  info "  ${ip:-<not reserved yet>}"
}

require_env_file() {
  [ -f "$ENV_FILE" ] || die "deploy/.env is missing. Run: cp deploy/.env.example deploy/.env, then fill it in."
  local missing=()
  for v in STRIPE_SECRET_KEY ZINC_API_KEY SPIDER_CLOUD_API_KEY; do
    [ -n "${!v:-}" ] || missing+=("$v")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "deploy/.env is missing required values: ${missing[*]}
     Those three are hard requirements: money.mjs exits without a sk_test_ key,
     zinc.mjs exits without a zn_test_ key, and core refuses to start without Spider."
  fi
  case "${STRIPE_SECRET_KEY:-}" in sk_test_*) ;; *) die "STRIPE_SECRET_KEY must be a TEST key (sk_test_…). money.mjs refuses anything else." ;; esac
  case "${ZINC_API_KEY:-}"      in zn_test_*) ;; *) die "ZINC_API_KEY must be a SANDBOX key (zn_test_…). zinc.mjs refuses anything else." ;; esac
}

# ---- create ---------------------------------------------------------------------
cmd_create() {
  need_gcloud
  local P; P="$(project)"
  say "Creating Compralo infrastructure in ${P} / ${ZONE}"
  warn "this creates billable resources: 1 × ${MACHINE}, ${DISK_GB} GB disk, 1 static IP"

  say "1/4  Enable the Compute Engine API"
  G services enable compute.googleapis.com

  say "2/4  Reserve a static external IP (${ADDR_NAME}, ${REGION})"
  if [ -n "$(static_ip)" ]; then
    info "  already reserved: $(static_ip)"
  else
    G compute addresses create "$ADDR_NAME" --region "$REGION" --network-tier PREMIUM
  fi
  local IP; IP="$(static_ip)"
  [ -n "$IP" ] || die "could not read the reserved address back"
  info "  ${GRN}${IP}${N}"

  say "3/4  Firewall: allow 80/443 to anything tagged ${TAG}"
  if gcloud --project "$P" compute firewall-rules describe "$FW_NAME" >/dev/null 2>&1; then
    info "  ${FW_NAME} already exists"
  else
    G compute firewall-rules create "$FW_NAME" \
      --direction INGRESS --priority 1000 --network default --action ALLOW \
      --rules tcp:80,tcp:443,udp:443 --source-ranges 0.0.0.0/0 --target-tags "$TAG" \
      --description "Compralo edge (Caddy): HTTP, HTTPS and HTTP/3"
  fi

  say "4/4  VM: ${VM} (${MACHINE}, Debian 12, docker via startup script)"
  if gcloud --project "$P" compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
    info "  ${VM} already exists at $(vm_ip)"
  else
    G compute instances create "$VM" \
      --zone "$ZONE" \
      --machine-type "$MACHINE" \
      --image-family debian-12 --image-project debian-cloud \
      --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced \
      --address "$IP" \
      --tags "$TAG" \
      --metadata-from-file "startup-script=${HERE}/vm-startup.sh" \
      --metadata enable-oslogin=TRUE \
      --labels app=compralo \
      --description "Compralo: backend + money + market + core behind Caddy"
  fi

  echo >&2
  say "Done. The startup script is installing docker now — give it 1–2 minutes."
  info "  static IP   ${GRN}${IP}${N}"
  info "  HTTPS with no DNS to buy:  ${B}DOMAIN=${IP//./-}.sslip.io${N}  in deploy/.env"
  echo >&2
  info "  next:  ${B}./deploy/gcp.sh push${N}"
}

# ---- push -----------------------------------------------------------------------
cmd_push() {
  need_gcloud
  require_env_file
  local P; P="$(project)"
  gcloud --project "$P" compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1 \
    || die "no VM named ${VM} in ${ZONE}. Run ./deploy/gcp.sh create first."

  say "1/3  Refresh the SSH config so rsync can reach the VM by name"
  G compute config-ssh --quiet

  local HOST; HOST="$(ssh_host)"
  say "2/3  Sync the repository (including deploy/.env) to ${HOST}:~/${REMOTE_DIR}"
  if command -v rsync >/dev/null 2>&1; then
    run rsync -az --delete --info=stats1 \
      --exclude-from="$HERE/rsync-exclude.txt" \
      --rsync-path="mkdir -p ~/${REMOTE_DIR} && rsync" \
      "$ROOT/" "${HOST}:${REMOTE_DIR}/"
  else
    warn "rsync not found locally; falling back to a tar stream (no --delete)"
    run bash -c "tar czf - -C '$ROOT' --exclude-from='$HERE/rsync-exclude.txt' . | gcloud --project '$P' compute ssh '$VM' --zone '$ZONE' --command 'mkdir -p ~/${REMOTE_DIR} && tar xzf - -C ~/${REMOTE_DIR}'"
  fi

  say "3/3  Build and start all five containers on the VM"
  info "  the Rust image is a cold release build the first time — 5–15 min on an e2-small"
  remote "cd ~/${REMOTE_DIR} && sudo ${COMPOSE} up -d --build --remove-orphans"

  echo >&2
  cmd_status
}

# ---- status ---------------------------------------------------------------------
cmd_status() {
  need_gcloud
  local P; P="$(project)"
  say "VM"
  Gq compute instances describe "$VM" --zone "$ZONE" \
     --format='table[box](name, status, machineType.basename(), networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP)' \
     || { warn "no VM named ${VM} in ${ZONE}"; return 0; }

  local IP; IP="$(vm_ip)"
  echo >&2
  say "Containers"
  remote "cd ~/${REMOTE_DIR} && sudo ${COMPOSE} ps" || warn "compose is not up yet — run ./deploy/gcp.sh push"

  echo >&2
  say "Health (from inside the VM, through Caddy)"
  remote "for p in /health /money/health /market/retailers /core/health; do printf '  %-22s ' \$p; curl -fsS -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1\$p || echo DOWN; done" || true

  echo >&2
  local base
  if [ -n "${DOMAIN:-}" ]; then base="https://${DOMAIN}"; else base="http://${IP}"; fi
  say "URLs"
  info "  dashboard     ${base}/dashboard"
  info "  backend API   ${base}/           (/instructions, /events/stream, /understand)"
  info "  money API     ${base}/money/     (/funds/commit, /checkout, /coverage)"
  info "  market sim    ${base}/market/    (/offers, /admin/offers)"
  info "  core API      ${base}/core/      (/v1/monitors, /openapi.json)"
}

# ---- logs / ssh -----------------------------------------------------------------
cmd_logs() {
  need_gcloud
  local svc="${1:-}"
  remote_tty "cd ~/${REMOTE_DIR} && sudo ${COMPOSE} logs -f --tail=200 ${svc}"
}

cmd_ssh() {
  need_gcloud
  run gcloud --project "$(project)" compute ssh "$VM" --zone "$ZONE"
}

# ---- destroy --------------------------------------------------------------------
cmd_destroy() {
  need_gcloud
  local P; P="$(project)"
  say "About to delete, in ${P}:"
  info "  instance      ${VM} (${ZONE})   — its disk and every docker volume go with it"
  info "  firewall      ${FW_NAME}"
  info "  address       ${ADDR_NAME} (${REGION})  $(static_ip)"
  echo >&2
  read -r -p "Type the VM name (${VM}) to confirm: " answer
  [ "$answer" = "$VM" ] || die "not confirmed; nothing was deleted"

  if gcloud --project "$P" compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
    G compute instances delete "$VM" --zone "$ZONE" --quiet
  else info "  instance ${VM} already gone"; fi

  if gcloud --project "$P" compute firewall-rules describe "$FW_NAME" >/dev/null 2>&1; then
    G compute firewall-rules delete "$FW_NAME" --quiet
  else info "  firewall ${FW_NAME} already gone"; fi

  if [ -n "$(static_ip)" ]; then
    G compute addresses delete "$ADDR_NAME" --region "$REGION" --quiet
  else info "  address ${ADDR_NAME} already gone"; fi

  say "Gone. An unattached reserved IP still bills, so deleting it is the point."
}

# ---- local ----------------------------------------------------------------------
# The same compose file, on this machine. Caddy will bind :80 and :443 locally.
cmd_local() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  require_env_file
  run bash -c "cd '$ROOT' && ${COMPOSE} up -d --build"
  run bash -c "cd '$ROOT' && ${COMPOSE} ps"
  info "  dashboard http://localhost/dashboard   money http://localhost/money/health"
}

cmd_local_down() {
  run bash -c "cd '$ROOT' && ${COMPOSE} down"
}

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//' >&2
  exit "${1:-0}"
}

case "${1:-}" in
  create)     shift; cmd_create "$@" ;;
  push)       shift; cmd_push "$@" ;;
  status)     shift; cmd_status "$@" ;;
  logs)       shift; cmd_logs "$@" ;;
  ssh)        shift; cmd_ssh "$@" ;;
  destroy)    shift; cmd_destroy "$@" ;;
  config)     shift; cmd_config "$@" ;;
  local)      shift; cmd_local "$@" ;;
  local-down) shift; cmd_local_down "$@" ;;
  ""|-h|--help|help) usage 0 ;;
  *) printf 'unknown command: %s\n\n' "$1" >&2; usage 1 ;;
esac
