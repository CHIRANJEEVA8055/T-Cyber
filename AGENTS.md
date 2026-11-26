<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## The running app is a service

On this server the app runs as the systemd user service `t-cyber` (port 3000, dev mode, so edits show up live). Do not start `next dev`/`npm run dev`, and never `pkill`/`kill` the Next.js server or move `.next/dev` while it runs. Use `scripts/service.sh status | restart | clean-restart | logs`; stop it only when the user asks (`scripts/service.sh stop`).
