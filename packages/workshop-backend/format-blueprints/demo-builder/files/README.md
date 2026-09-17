# Demo Builder

Deploy a **private copy of a static site** on Cloudflare and get a private `*.workers.dev` URL to
click around. Deploys and teardowns are **queued for your approval** (handled by the gatekeeper).

Part of the Demo Builder project — see `docs/demo-builder-plan.md`. This gadget is the client
layer; the credentialed deploy path lives in the `gatekeeper-cloudflare-deploy` gatekeeper.

## Install (loose-file blueprint)

Create a new gadget in Cloudflare OS and paste in `server.js` and `client.js` (or import this
directory as a format blueprint). Then wire the binding:

- **Connections → bind this gadget → `CF_DEPLOY`** = your **Cloudflare (deploy)** gatekeeper
  connection (the account you connected with a scoped API token + owner email).

Until `CF_DEPLOY` is bound, the gadget shows a "connect a deploy target" prompt.

## What it does today (Phase 1)

- **Paste HTML** → deploys a single `index.html` as a private assets-only Worker.
- **From URL** → fetches one static page and deploys it (linked assets aren't followed).
- Lists your demos with **pending → live** status and private URLs; **tear down** removes the
  Worker and its Access app.

Every demo is private by default — gated by Cloudflare Access to the email you connected with.

## Coming next (Phase 2)

The **GitHub repo** source is stubbed in the UI. It lights up once the container/Sandbox build
service is connected: paste a repo URL → it's cloned, built, and deployed, via a `deployFromRepo`
method on the gatekeeper. See the plan doc.

## Backend API (`server.js`)

`getState()` · `deployHtml(name, html)` · `deployFromUrl(name, url)` · `teardown(name)` — the
deploy methods return a provisional demo (`status: "pending"`) and the deploy runs only after you
approve it.
