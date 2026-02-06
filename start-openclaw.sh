#/bin/sh
# Start OpenClaw
echo "Starting OpenClaw..."
exec node dist/index.js gateway --bind lan --port 18789 --allow-unconfigured

