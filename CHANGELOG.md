# Changelog

## 2.0.0
### Security
- Device IDs are now secret; other devices only see a hashed public ID (fixes interception of private transfers)
- Optional PIN login (`ORBIT_PIN`) with rate limiting
- Cross-site request blocking, security headers, filename sanitization, per-IP rate limit
- Only the uploader (or accepted target) can delete/rename files; history is private per device

### Large files
- No per-file or total size limit by default (set `ORBIT_MAX_FILE_MB` / `ORBIT_STORAGE_GB` to add one); uploads are refused only if the host disk is full
- Disabled Node's 5-minute request timeout so multi-GB uploads on slow Wi-Fi don't fail

### Fixes
- Texts from other devices now appear automatically
- Failed/oversized uploads show an error instead of "Uploaded!"
- Accepting several files downloads all of them
- Storage cap enforced; orphaned files cleaned on restart; expired files remove pending transfers
- QR/LAN address skips virtual adapters (VirtualBox, Docker, WSL); `ORBIT_HOST` override
- Unicode filenames, clipboard copy on http, rename cancel, duplicate accept prompts, zoom accessibility
- Clean shutdown and clear port-in-use message

### Project
- Multer 2.x, Node 18+ engines, `dev`/`check`/`test` scripts, smoke tests, CI, LICENSE, rewritten README
- `START Orbit.bat`: installs dependencies on first run, optional PIN prompt, respects `PORT`

### Privacy (2.0.0)
- Downloads are never cached by the browser (`Cache-Control: no-store`)
- Shared files are wiped on Ctrl+C, closing the console window, and any normal exit; any leftovers from a hard kill are removed on next start
- Orbit writes no log files; history/texts live in memory only






