# Setup

## Easiest: the downloadable app
1. Download the file for your system from the Releases page.
2. Run it. Pick a PIN (Enter = random), your browser opens.
3. On another device on the same Wi-Fi, scan the QR code or open the LAN address shown.

## From source
1. Install Node.js 18 or newer.
2. `npm install`
3. `npm start` (or `ORBIT_PIN=random ORBIT_HTTPS=1 npm start`)

## Docker
`ORBIT_HOST=<your LAN IP> docker compose up -d`, then `docker compose logs orbit` to see the PIN.

Firewall prompt on Windows/macOS: allow Orbit/Node.js on **private** networks.

See README.md for all options.
