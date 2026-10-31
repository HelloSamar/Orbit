# 🪐 Orbit

Private AirDrop-style sharing for the devices on your own Wi-Fi: files, text & clipboard.
No cloud, no account, no cables. Everything stays on the computer running Orbit.

## Quick start

Requires [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/HelloSamar/Orbit.git
cd Orbit
npm install
npm start
```

Windows: double-click `START Orbit.bat`. macOS/Linux: `bash "START Orbit.sh"`.

Open the printed address (or scan the QR code in the sidebar) on any device on the same network.

> **v2.0** — see [CHANGELOG.md](CHANGELOG.md). Orbit relays transfers through the host computer on your LAN (it is not peer-to-peer).

## Features

- Send files to everyone or to one specific device (the receiver must accept)
- No file-size limit (only your free disk space), tested with multi-GB files
- Drag-and-drop upload with progress, cancel, rename, delete
- Image gallery with lightbox
- Text/clipboard sharing
- Per-device history, dark/light theme, optional PIN

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ORBIT_PIN` | *(none)* | Require this PIN before anyone can use Orbit |
| `ORBIT_HOST` | auto | IP shown in the QR code (override if auto-detect picks the wrong adapter) |
| `ORBIT_MAX_FILE_MB` | `0` (no limit) | Max size per file |
| `ORBIT_STORAGE_GB` | `0` (no limit) | Total storage cap |
| `ORBIT_TTL_MIN` | `60` | Minutes before shared files auto-delete |

Example: `ORBIT_PIN=4821 PORT=8080 npm start` (PowerShell: `$env:ORBIT_PIN=4821; npm start`).

## Security model

- Orbit speaks plain HTTP and is meant for a network you trust. **Set `ORBIT_PIN`** on shared Wi-Fi.
- Each device has a secret ID known only to itself; other devices only see a hashed public ID, so private transfers can't be intercepted.
- Files live in `shared/`, are indexed in memory, and are deleted after the TTL, on shutdown, or on restart.
- Cross-site writes are blocked and filenames are sanitized.
- Do not expose Orbit to the internet.

## Development

```bash
npm run dev     # auto-restart on change
npm run check   # syntax check
npm test        # end-to-end smoke tests
```

## Troubleshooting

- **Phone can't connect:** same Wi-Fi? Allow Node.js through your firewall. If the QR address is wrong, set `ORBIT_HOST`.
- **Port in use:** run with `PORT=3001`.
- **Copy button on http pages:** uses a fallback because browsers disable the Clipboard API outside HTTPS.

## License

MIT
