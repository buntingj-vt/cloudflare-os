# @gadgets/cloudflare-deploy-gatekeeper

Deploys static-site demos as **assets-only Workers** into a connected Cloudflare account and hands
back a **private `*.workers.dev` URL** gated by Cloudflare Access. This is the write path behind the
Demo Builder gadget (see `docs/demo-builder-plan.md` in the parent repo). Phase 1: deploy a
pre-baked static bundle; Phase 2 adds a container build step for real repos.

## Model

- **Auth:** the user connects a Cloudflare account by pasting a scoped **API token**, the **account
  ID**, and the **email** allowed through Access (no OAuth). Credentials live in the per-connection
  `UserAccount` Durable Object. Mirrors `gatekeeper-homeassistant`; registered as a no-input
  singleton in `scripts/release/manifest-lib.ts`.
- **Resource:** one per account (`https://dash.cloudflare.com/:accountId`), bound as `CF_DEPLOY`,
  session type `CloudflareDeploySession` (see `src/types.d.ts`).
- **Writes are human-gated.** `deployStaticSite()` / `teardownDemo()` queue an action via
  `approvalQueue.submitAction()`; the deploy runs against Cloudflare only in `applyAction()` after
  approval. A deploy is revertible (revert removes the demo); teardown is not.

## Layout

- `src/cloudflare-deploy-api.ts` — Worker-runtime REST client (the proven Phase 0 loop:
  assets-upload-session → batch upload with the session JWT → assets-only script PUT → subdomain →
  per-host Access app → teardown). Hashes with `crypto.subtle` (no `nodejs_compat`).
- `src/cloudflare-deploy.ts` — vendor, `UserAccount` DO, per-user handle, per-resource gatekeeper
  DO + approval-gated actions, and the `CloudflareDeploySession` RpcTarget.
- `src/types.d.ts` (+ `types.txt` symlink) — the agent-facing session API.
- `src/configurator/account-configurator-ui.tsx` — trivial account-confirm configurator.

## Scopes for the API token

Workers Scripts:Edit · Account Settings:Read · Access: Apps and Policies:Edit ·
Access: Organizations, Identity Providers, and Groups:Read (all Account-level).

## Build / check

```
pnpm exec vp run --no-cache build:configurator   # regenerate src/generated/*.txt
pnpm exec capnweb-validate build --out .wrangler/validate
pnpm exec tsc --noEmit                            # run against src (remove .wrangler first)
```

In dev, `pnpm dev-server` at the repo root auto-discovers `packages/gatekeeper-*` and the vendor
appears on the Connectors page.
