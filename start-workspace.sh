#!/bin/sh

# Start Filebrowser in background
# Rooted at the workspace directory
# Port 8081
# FILEBROWSER_BASE_URL: if set, passed as --baseURL (e.g. /workspace)
# FILEBROWSER_EXTRA_ARGS: optional extra args; omitted if unset
echo "Starting Filebrowser on port 8081..."
filebrowser \
  --database /tmp/filebrowser.db \
  --root /home/node/.openclaw/workspace \
  --port 8081 \
  --address 0.0.0.0 \
  --log stdout \
  ${FILEBROWSER_BASE_URL:+--baseURL $FILEBROWSER_BASE_URL} \
  ${FILEBROWSER_EXTRA_ARGS:+$FILEBROWSER_EXTRA_ARGS} \
  --noauth & 
# WARNING: --noauth used for demo simplicity inside k8s. 
# In production, remove --noauth to use default admin/admin.

# Start TTYD (Web Terminal)
# Port 8082
echo "Starting TTYD on port 8082..."
ttyd -p 8082 -W -t fontSize=14 bash &

# Start OpenClaw
echo "Verifying and fixing configuration..."
node dist/index.js doctor --fix
echo "Starting OpenClaw..."
exec node dist/index.js gateway --bind lan --port 18789 --allow-unconfigured

