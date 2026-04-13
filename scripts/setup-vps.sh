#!/bin/bash

# VPS Setup Script for Matterbridge AI Plugin Factory
# Run this on your Ubuntu VPS to set up the factory environment
#
# Usage: ./setup-vps.sh [--enable-cron]
#   --enable-cron  Enable the cron job for polling mode (disabled by default)

set -e

# Parse arguments
ENABLE_CRON=false
for arg in "$@"; do
  case $arg in
    --enable-cron)
      ENABLE_CRON=true
      shift
      ;;
  esac
done

echo "🏭 Setting up Matterbridge AI Plugin Factory on VPS"
echo "=================================================="

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 24.x (LTS)
echo "📦 Installing Node.js 24.x..."
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js installation
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

# Install build essentials (for native modules)
echo "📦 Installing build tools..."
sudo apt install -y build-essential git

# Install Claude Code CLI (official installer)
echo "📦 Installing Claude Code CLI..."
curl -fsSL https://claude.ai/install.sh | bash

# Create directories
echo "📁 Creating directories..."
sudo mkdir -p /opt/matterbridge-factory

# Set permissions (adjust user as needed)
FACTORY_USER="${FACTORY_USER:-$USER}"
sudo chown -R "$FACTORY_USER:$FACTORY_USER" /opt/matterbridge-factory

# Clone the factory repository
echo "📥 Cloning factory repository..."
cd /opt/matterbridge-factory
if [ -d ".git" ]; then
    git pull
else
    git clone https://github.com/YOUR_USERNAME/matterbridge-ai-plugin-factory.git .
fi

# Install dependencies
echo "📦 Installing factory dependencies..."
npm install

# Create environment file
echo "⚙️ Creating environment configuration..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "⚠️  Please edit /opt/matterbridge-factory/.env with your configuration:"
    echo "    - GITHUB_TOKEN"
    echo "    - GITHUB_REPO_OWNER"
    echo "    - GITHUB_REPO_NAME"
    echo ""
    echo "  Then authenticate Claude Code CLI by running:"
    echo "    claude login"
    echo ""
fi

# Create systemd service for webhook mode
echo "🔧 Creating systemd service..."
sudo tee /etc/systemd/system/matterbridge-factory.service > /dev/null << 'EOF'
[Unit]
Description=Matterbridge AI Plugin Factory
After=network.target

[Service]
Type=simple
User=FACTORY_USER_PLACEHOLDER
WorkingDirectory=/opt/matterbridge-factory
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=FACTORY_MODE=webhook
EnvironmentFile=/opt/matterbridge-factory/.env

[Install]
WantedBy=multi-user.target
EOF

# Replace placeholder with actual user
sudo sed -i "s/FACTORY_USER_PLACEHOLDER/$FACTORY_USER/g" /etc/systemd/system/matterbridge-factory.service

# Reload systemd
sudo systemctl daemon-reload

# Create cron job for polling mode (alternative to webhook)
if [ "$ENABLE_CRON" = true ]; then
  echo "⏰ Enabling cron job for polling mode..."
  CRON_CMD="*/15 * * * * cd /opt/matterbridge-factory && /usr/bin/node src/process-issue.js >> /var/log/matterbridge-factory.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "matterbridge-factory"; echo "$CRON_CMD") | crontab -
else
  echo "⏰ Cron job NOT enabled (use --enable-cron to enable)"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Edit /opt/matterbridge-factory/.env with your credentials"
echo "2. Choose your mode:"
echo ""
echo "   WEBHOOK MODE (recommended for real-time processing):"
echo "   - Configure GitHub webhook to point to your VPS"
echo "   - Start the service: sudo systemctl start matterbridge-factory"
echo "   - Enable on boot: sudo systemctl enable matterbridge-factory"
echo ""
echo "   POLLING MODE (simpler, checks every 15 minutes):"
if [ "$ENABLE_CRON" = true ]; then
  echo "   - The cron job is enabled"
else
  echo "   - Enable cron: re-run with --enable-cron flag"
fi
echo "   - Check logs: tail -f /var/log/matterbridge-factory.log"
echo ""
echo "3. Authenticate Claude Code CLI with your Pro plan:"
echo "   claude login"
echo ""
