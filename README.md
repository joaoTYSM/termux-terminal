# VStermu-x

A single-file Node.js server that provides a browser-based terminal, a separate
file-manager window, and an editor for Termux.

## Install on Termux

Follow the step-by-step instructions in [install.txt](install.txt). The
interactive terminal for `nano` and similar programs requires the listed
WebSocket, xterm.js, and Android ARM64 PTY packages.

## Defaults and security

- The server binds to `127.0.0.1` and is intended to run locally on the Android
  device.
- `.env` files are hidden and blocked in the file-manager API by default.
- Background video and particles are off by default.
- The HTML preview runs in a sandboxed iframe.

The `.env` setting protects access through VStermu-x's file-manager and preview
routes. It does not restrict commands run directly in Termux's shell.

## Repository files

- `server.js` — the complete application server and inline web interface.
- `install.txt` — Termux dependencies and installation steps.
- `assets/` — optional default background video and particle image.