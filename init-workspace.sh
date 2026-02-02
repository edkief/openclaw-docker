#!/bin/bash
INIT_FILE="~/.workspace-initialized"

if [ -f "$INIT_FILE" ]; then
  echo "Workspace already initialized"
  exit 0
fi

echo "Initializing workspace"
mkdir -p ~/bin
cat > ~/bin/openclaw <<'EOF'
#!/bin/sh
exec node /app/dist/index.js "$@"
EOF

chmod +x ~/bin/openclaw

cat > ~/.bashrc <<'EOF'
# Add local bin to PATH
export PATH="$PATH:$HOME/bin"

# Alias for convenience (optional, but PATH is better)
# alias openclaw="node /app/dist/index.js"

# pnpm
export PNPM_HOME="/home/node/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end
EOF

touch $INIT_FILE

echo "Workspace initialized"