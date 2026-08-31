#!/usr/bin/env bash
# Phase 0 host bootstrap for the Netcup box. Idempotent. Run as root.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
HOSTNAME_SHORT="${HOSTNAME_SHORT:-jarvis-netcup}"
JARVIS_UID="${JARVIS_UID:-1000}"
DEPLOY_SRC="${DEPLOY_SRC:-/opt/jarvis/deploy}"

echo "==> packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y \
  ca-certificates curl gnupg git ufw fail2ban unattended-upgrades \
  apt-listchanges restic jq openssl dbus

if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${CODENAME} stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update -y
if ! apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
  echo "==> docker apt repo failed; using get.docker.com"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "==> unattended-upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat >/etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Origins-Pattern {
  "origin=Debian,codename=${distro_codename},label=Debian";
  "origin=Debian,codename=${distro_codename},label=Debian-Security";
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Automatic-Reboot "false";
EOF

echo "==> hostname"
hostnamectl set-hostname "${HOSTNAME_SHORT}" || true

echo "==> user and disk layout"
if ! id -u jarvis >/dev/null 2>&1; then
  useradd --system --uid "${JARVIS_UID}" --home-dir /var/lib/jarvis \
    --shell /usr/sbin/nologin --no-create-home jarvis
fi
install -d -m 0750 -o root -g jarvis /var/lib/jarvis
for d in keys harness-auth artifacts worktrees browsers indexes quarantine openclaw; do
  install -d -m 0750 -o jarvis -g jarvis "/var/lib/jarvis/${d}"
done
chmod 0750 /var/lib/jarvis/keys
chown root:jarvis /var/lib/jarvis/keys
install -d -m 0755 /opt/jarvis/core /opt/jarvis/control-center /opt/jarvis/deploy
install -d -m 0750 -o root -g jarvis /etc/jarvis

if [[ ! -f /var/lib/jarvis/keys/master.key ]]; then
  umask 077
  openssl rand -out /var/lib/jarvis/keys/master.key 32
fi
chown root:jarvis /var/lib/jarvis/keys/master.key
chmod 0440 /var/lib/jarvis/keys/master.key

if [[ ! -f /etc/jarvis/compose.env ]]; then
  umask 077
  cat >/etc/jarvis/compose.env <<EOF
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '\n')
EOF
fi
chmod 0640 /etc/jarvis/compose.env
chown root:jarvis /etc/jarvis/compose.env

echo "==> fail2ban"
systemctl enable --now fail2ban

echo "==> ufw"
sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw || true
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
ufw status verbose

echo "==> deploy files"
if [[ -d "${DEPLOY_SRC}" ]]; then
  if [[ -f "${DEPLOY_SRC}/www/index.html" ]]; then
    install -m 0644 "${DEPLOY_SRC}/www/index.html" /opt/jarvis/control-center/index.html
  fi
fi

echo "==> compose"
if [[ -f /opt/jarvis/deploy/compose.yaml ]]; then
  docker compose -f /opt/jarvis/deploy/compose.yaml up -d
  docker compose -f /opt/jarvis/deploy/compose.yaml ps
fi

echo "==> phase0-host done"
echo "Tailscale is installed but not logged in. Run: tailscale up --ssh --hostname jarvis-netcup"
echo "Restic is installed but not initialized (needs B2)."
