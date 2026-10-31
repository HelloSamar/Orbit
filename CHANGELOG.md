# Changelog

## 1.0.0
First stable release.

### Core
- Share files, text and clipboard between your own devices over your local network — any browser, nothing to install on the phone
- Send to everyone or one device (receiver accepts or declines), drag-and-drop, progress, rename, delete, gallery, history
- No file-size limit by default (only free disk space); Node's 5-minute request timeout disabled so multi-GB uploads work

### Security & privacy
- Secret device IDs with hashed public IDs (private transfers can't be intercepted)
- PIN login with rate limiting; random 6-digit PIN option (`ORBIT_PIN=random`, default prompt in a terminal)
- Optional HTTPS (auto self-signed certificate, or bring your own with `ORBIT_CERT`/`ORBIT_KEY`)
- Strict Content-Security-Policy, cross-site request blocking, security headers, filename sanitising
- Only the uploader (or accepted target) can delete/rename; history is private per device
- Zero logs; downloads never cached; shared files wiped on Ctrl+C, window close, or exit, and on next start after a hard kill

### Quality
- Gallery uses fast in-memory thumbnails (`sharp`, optional) with automatic fallback to the original
- Code split into `src/` modules and a `public/` web app instead of one 1,300-line file
- Reliable uploads (real error messages, 413/507 handling), all accepted files download, texts sync live
- QR/LAN address skips virtual adapters (VirtualBox, Docker, WSL); `ORBIT_HOST` override
- Unicode filenames, clipboard copy on http, clean shutdown, clear port-in-use message

### Distribution
- Standalone binaries (Windows, macOS, Linux) and a Docker image (`docker compose up`)
- Release workflow builds both on every `v*` tag; CI on Node 18/20/22; end-to-end smoke tests
- `START Orbit.bat` / `START Orbit.sh` install dependencies on first run and open the browser
