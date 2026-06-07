#!/bin/bash
# install.sh - Automated Deployment Script for vpngate-pro on VPS (Linux)
set -e

echo "=== vpngate-pro Installer ==="

# 1. Check Root
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root."
  exit 1
fi

# 2. Install Dependencies (Debian/Ubuntu/CentOS)
echo "[1/6] Checking and installing packages..."
if command -v apt-get >/dev/null; then
    apt-get update -y || true
    apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" openvpn socat python3 iptables ca-certificates || true
elif command -v yum >/dev/null; then
    yum install -y epel-release || true
    yum install -y openvpn socat python3 iptables ca-certificates || true
else
    echo "Warning: Package manager not found. Please ensure openvpn and socat are installed manually."
fi

# 3. Stop and Disable Old Service
echo "[2/6] Disabling old services..."
systemctl stop aimilivpn || true
systemctl disable aimilivpn || true
systemctl stop vpngate-pro || true
pkill -f "main.py --proxy-only" || true
killall -9 socat || true
killall -9 openvpn || true

# 4. Setup Target Directory
TARGET_DIR="/opt/vpngate-pro"
echo "[3/6] Copying codebase to ${TARGET_DIR}..."
mkdir -p "${TARGET_DIR}/core"
mkdir -p "${TARGET_DIR}/web"
mkdir -p "${TARGET_DIR}/vpngate_data"

# Find script directory to locate source files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Copy main files
cp "${SCRIPT_DIR}/main.py" "${TARGET_DIR}/"
cp -r "${SCRIPT_DIR}/core/"* "${TARGET_DIR}/core/"
cp -r "${SCRIPT_DIR}/web/"* "${TARGET_DIR}/web/"

chmod +x "${TARGET_DIR}/main.py"
chmod +x "${TARGET_DIR}"/core/*.sh 2>/dev/null || true

# Preserve old IP cache if available, to speed up startup geolocations
OLD_CACHE="/opt/aimilivpn/vpngate_data/ip_cache.json"
NEW_CACHE="${TARGET_DIR}/vpngate_data/ip_cache.json"
if [ -f "$OLD_CACHE" ]; then
    echo "Found existing IP cache. Migrating to new workspace..."
    cp "$OLD_CACHE" "$NEW_CACHE"
fi

# Migrate credentials from old ui_auth.json if present
OLD_AUTH="/opt/aimilivpn/vpngate_data/ui_auth.json"
NEW_CONFIG="${TARGET_DIR}/vpngate_data/config.json"
if [ -f "$OLD_AUTH" ]; then
    echo "Found existing ui_auth.json. Migrating credentials..."
    python3 -c "
import json
try:
    with open('$OLD_AUTH') as f: old = json.load(f)
    cfg = {
        'username': old.get('username', 'admin'),
        'password': old.get('password', ''),
        'secret_path': old.get('secret_path', 'wdj91VRBdqYx'),
        'ui_port': old.get('port', 8787),
        'proxy_port': 7928,
        'routing_mode': old.get('routing_mode', 'auto'),
        'force_country': old.get('force_country', ''),
        'connection_enabled': old.get('connection_enabled', False),
        'fixed_node_id': old.get('fixed_node_id', ''),
        'scamalytics_threshold': 10
    }
    with open('$NEW_CONFIG', \"w\") as f: json.dump(cfg, f, indent=2)
    print('Credentials migrated successfully.')
except Exception as e:
    print('Failed to migrate credentials:', e)
"
fi

# 5. Create Systemd Service File
echo "[4/6] Configuring systemd service..."
cat <<EOF > /etc/systemd/system/vpngate-pro.service
[Unit]
Description=AetherGate Pro Gateway Manager (netns isolated)
After=network.target

[Service]
Type=simple
WorkingDirectory=${TARGET_DIR}
ExecStart=/usr/bin/python3 main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Reload Systemd
systemctl daemon-reload

# 6. Enable IP Forwarding persistently
echo "[5/6] Enabling sysctl IP forwarding..."
sysctl -w net.ipv4.ip_forward=1
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf; then
    echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
fi

# 7. Start the Service
echo "[6/6] Starting vpngate-pro service..."
systemctl enable vpngate-pro.service
systemctl start vpngate-pro.service

sleep 2
systemctl status vpngate-pro.service --no-pager

echo "============================================="
echo "Deployment successful!"
echo "UI: http://<VPS_IP>:8787/wdj91VRBdqYx/"
echo "Proxy (SOCKS5/HTTP): <VPS_IP>:7928"
echo "============================================="
