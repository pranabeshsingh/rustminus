# Telegram Notification Relay Service

A secure, high-performance notification relay designed to bridge `rustminus` (`rust.trylocalhost.com`) alerts, smart alarm raid pings, and squad communications to Telegram.

## Features
- **Telegram Bot API Integration**: Formats raid alerts, upkeep warnings, monument events, and team communications with rich HTML styling.
- **Multi-Layer Security**:
  - Web UI protected by session-based authentication & bcrypt password hashing.
  - REST API protected by API key authentication (`X-API-Key` or `Bearer` token).
  - Built-in sliding-window rate limiting to prevent spam and Telegram API bans.
- **Dark Dashboard**: Monitor relay metrics, configure Telegram credentials, and dispatch test pings directly from your browser.
- **Microservice Design**: Bound locally to `127.0.0.1:3001` and reverse-proxied via Caddy with automatic HTTPS and HSTS preloading.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment:
   ```bash
   cp config.example.json config.json
   ```

3. Start service:
   ```bash
   npm start
   ```

## Production Deployment (systemd)
Copy `notification-relay.service` to `/etc/systemd/system/`:
```bash
sudo cp notification-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now notification-relay.service
```
