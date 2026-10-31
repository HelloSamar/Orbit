# 🪐 Orbit

Private AirDrop-style sharing for the devices on your own Wi-Fi: files, text & clipboard.
No cloud, no account, no cables, and nothing to install on the phone — any browser works.

> **v1.0** — see [CHANGELOG.md](CHANGELOG.md). Orbit relays transfers through the host computer on your LAN (it is not peer-to-peer).

## Get started

Pick one:

**1. Download and double-click (no Node.js needed)**
Get the file for your system from the [Releases page](https://github.com/HelloSamar/Orbit/releases):
`orbit-win-x64.exe`, `orbit-macos-arm64`, `orbit-macos-x64` or `orbit-linux-x64`.
Run it, choose a PIN (or press Enter for a random one), and your browser opens.

- Windows: SmartScreen may warn about an unsigned app — *More info → Run anyway*.
- macOS: `tar xzf orbit-macos-*.tar.gz`, then `codesign --sign - ./orbit-macos-arm64 && xattr -d com.apple.quarantine ./orbit-macos-arm64` (once), then `./orbit-macos-arm64`.
- Linux: `tar xzf orbit-linux-x64.tar.gz && ./orbit-linux-x64`.

**2. Node.js 18+ (from source)**
```bash
git clone https://github.com/HelloSamar/Orbit.git
cd Orbit
npm install
npm start
```
Windows: double-click `START Orbit.bat`. macOS/Linux: `bash "START Orbit.sh"`.

**3. Docker**
```bash
ORBIT_HOST=192.168.1.20 docker compose up -d     # use your computer's LAN IP
docker compose logs orbit                          # shows the PIN
```
Or run the published image: `docker run -p 3000:3000 -e ORBIT_HOST=192.168.1.20 -e ORBIT_PIN=random --tmpfs /app/shared ghcr.io/hellosamar/orbit`.

Then open the printed address (or scan the QR code in the sidebar) on any device on the same network.

## Features

- Send files to everyone or to one specific device (the receiver must accept)
- No file-size limit (only your free disk space), tested with multi-GB files
- Drag-and-drop upload with progress, cancel, rename, delete
- Image gallery with fast server-generated thumbnails and a lightbox
- Text/clipboard sharing
- Per-device history, dark/light theme
- PIN protection (random 6-digit PIN by default when started from a terminal)
- Optional HTTPS, no logs, files wiped on exit

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ORBIT_PIN` | ask in terminal | PIN to require. `random` = new 6-digit PIN each start (printed in the console), `0` = no PIN, or your own value |
| `ORBIT_HTTPS` | off | `1` = serve HTTPS with an auto-generated self-signed certificate |
| `ORBIT_CERT` / `ORBIT_KEY` | – | Paths to your own certificate and key (enables HTTPS) |
| `ORBIT_HOST` | auto | IP shown in the QR code (set it in Docker, or if auto-detect picks the wrong adapter) |
| `ORBIT_OPEN` | off | `1` = open the browser on start (always on for the downloadable app) |
| `ORBIT_MAX_FILE_MB` | `0` (no limit) | Max size per file |
| `ORBIT_STORAGE_GB` | `0` (no limit) | Total storage cap |
| `ORBIT_TTL_MIN` | `60` | Minutes before shared files auto-delete |

Example: `ORBIT_PIN=random ORBIT_HTTPS=1 npm start` (PowerShell: `$env:ORBIT_HTTPS=1; npm start`).

## Security model

- Orbit is made for a network you trust. **Use a PIN** on shared Wi-Fi, and **HTTPS** if you want the PIN and files encrypted on the wire. With HTTPS the browser shows a one-time warning per device because the certificate is self-signed.
- Each device has a secret ID known only to itself; other devices only see a hashed public ID, so private transfers can't be intercepted.
- Files live in `shared/` (in RAM only in Docker), are indexed in memory, and are deleted after the TTL, on shutdown, or on restart. Orbit writes no logs.
- A strict Content-Security-Policy, cross-site-write blocking, rate limiting and filename sanitising are on by default.
- Thumbnails are generated in memory (via `sharp`) and never stored. If `sharp` isn't available Orbit just shows the original image.
- Do not expose Orbit to the internet.

## Project layout

```
server.js        startup, HTTP/HTTPS, shutdown
src/             config, security, routes, in-memory store, thumbnails, TLS, PIN
public/          the web app (index.html, app.js, style.css)
test/smoke.js    end-to-end tests
```

## Development

```bash
npm run dev       # auto-restart on change
npm run check     # syntax check
npm test          # end-to-end smoke tests
npm run build:exe # build standalone binaries into dist/
```

Pushing a tag like `v1.0.0` builds the binaries and the Docker image automatically (see `.github/workflows/release.yml`).

## Troubleshooting

- **Phone can't connect:** same Wi-Fi? Allow Node.js through your firewall (private networks). Some public/hotel Wi-Fi isolates devices from each other, which Orbit can't work around. If the QR address is wrong, set `ORBIT_HOST`.
- **Port in use:** run with `PORT=3001`.
- **Copy button on http pages:** uses a fallback because browsers disable the Clipboard API outside HTTPS.

## License

MIT
