# Orbit 🪐

Local network file sharing between your devices — no cloud, no account, no
cables. Start it on one machine, scan a QR code from your phone, and drag
files, photos, and text back and forth over your own Wi-Fi.

![status](https://img.shields.io/badge/node-%3E%3D14-brightgreen) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- 📡 **QR code pairing** — scan once from your phone, no typing IP addresses
- 📁 **Drag-and-drop file transfer** between any devices on the same network
- 🎯 **Send to everyone or a specific device**, with an accept/decline prompt
  on the receiving end for targeted transfers
- 🖼 **Built-in photo gallery** with a lightbox viewer for shared images
- 📋 **Text/clipboard sharing** — send quick snippets without a file
- 📜 **Activity history** of uploads, accepts, declines, and messages
- ⏱ **Auto-expiring files** — uploads are automatically deleted after 60
  minutes to avoid filling up disk space
- 🌗 Light/dark theme, mobile-friendly layout

## Requirements

- [Node.js](https://nodejs.org) 14 or later
- All devices connected to the **same local network** (Wi-Fi or LAN)

## Install & Run

1. Download or clone this repository.
2. Open a terminal in the `Orbit` folder and install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
   (Windows users can instead double-click `START Orbit.bat`, which checks
   for Node.js and opens your browser automatically.)
4. Orbit prints two URLs — open the `localhost` one on the PC running it, and
   scan the QR code (or visit the LAN URL) from any other device on the same
   network.

## Usage

1. On first visit, each device picks a display name (e.g. "My iPhone").
2. Drop files onto the upload zone, or tap it to choose files. Optionally
   pick a specific device from the **To:** dropdown instead of sending to
   everyone.
3. If a file is sent to a specific device, that device gets an accept/decline
   prompt before the file appears in their list.
4. Use the **Gallery** tab to browse shared images, **Clipboard** to send
   quick text snippets, and **History** to see recent activity.

## How it works

- `server.js` is a single-file Express app: it serves the entire frontend
  (HTML/CSS/JS) as one inline page from `GET /`, and exposes a small REST API
  for devices, files, text, and history.
- Device presence is tracked via a `POST /api/heartbeat` the frontend calls
  every 2.5 seconds; a device is considered "online" if it's heartbeated in
  the last 15 seconds.
- Uploaded files are stored on disk in `shared/` (created automatically) with
  randomized filenames, and their metadata (original name, uploader, target
  device, accepted state) is tracked in memory.
- `GET /api/download/:id` enforces the same visibility rule as `GET
  /api/files`: a file is only served to the device that uploaded it, to
  anyone if it was sent to "everyone," or to the specific target device once
  they've accepted it. This prevents a file that's still pending
  accept/decline (or targeted at a different device) from being fetched
  directly by ID.
- All app state (devices, file metadata, pending transfers, history) lives in
  memory and resets when the server restarts; files already on disk in
  `shared/` are not automatically re-indexed after a restart.

## Security notes

Orbit has **no authentication** — this is by design, the same model as tools
like Snapdrop: anyone who can reach the server's address on your local
network can open the page, upload files, and receive anything sent to
"everyone." Don't run it on a network you don't trust (e.g. public Wi-Fi),
and don't expose port 3000 to the internet (no port forwarding / no putting
it on a public-facing server).

`multer` (the upload-handling dependency) currently pulls in the `1.x`
branch, which has known advisories fixed in `2.x`. A future update should
migrate to `multer@2`, which involves some API differences — contributions
welcome.

## Limitations

- No authentication (see above) — anyone on the network can use it.
- No persistence across restarts: in-memory state (file list, device names,
  pending transfers, history) is lost when the server stops; only the raw
  files in `shared/` remain on disk, orphaned from their metadata.
- Files auto-delete after 60 minutes; there's currently no way to pin a file
  to keep it longer.
- Default 2 GB storage display limit and 500 MB per-file upload limit are
  hardcoded in `server.js` (`SHARE`/`limits.fileSize`/`storage.limit`) —
  adjust there if you need different limits.

## Repo layout

```
Orbit/
├── server.js          # entire app: Express server + inline frontend
├── package.json
├── package-lock.json
├── START Orbit.bat     # Windows convenience launcher
├── data/                # reserved for future use (currently unused)
└── shared/              # uploaded files land here at runtime (gitignored)
```

`node_modules/` and the contents of `shared/` are intentionally not part of
the repo — run `npm install` after cloning to fetch dependencies.

## Contributing

Issues and pull requests are welcome. Please test manually across at least
two devices on the same network before submitting, since there's no
automated test suite.

## License

MIT — see [LICENSE](LICENSE).
