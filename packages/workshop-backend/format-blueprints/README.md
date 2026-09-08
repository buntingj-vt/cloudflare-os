# Bundled format blueprints

This directory contains the output-format blueprints that ship with this repo. A fresh deployment
installs them into BLUEPRINTS KV and BLUEPRINT_CONTENT R2 on its first `/api` request, after which
they are ordinary blueprints.

## Layout

Each blueprint is committed as reviewable source:

```
workspace-docs/
  blueprint.json
  files/
    README.md
    client.js         import { el, iconBtn } from "gadgets:ui/client"
    server.js         import { MutationQueue } from "gadgets:sync/server"
    gadget.json       {"libraries": {"sync": "latest", "ui": "latest"}}
```

`files/` is the gadget's code and may contain nested directories. `blueprint.json` contains its
install ID, presentation, provenance,
bindings, blueprint `version`, and bundled `revision`. The build converts these files into the same
gzip-compressed Yjs `.gadget` representation used by uploaded blueprints and embeds it in the
generated Worker module. No binary archive is committed.

### Libraries

A blueprint may import a **gadget library** -- shared code the deployment ships, `gadgets:<name>/client`
and `gadgets:<name>/server`, built from `packages/gadget-libraries/<name>/` (see that package's
README and `docs/blueprints.md`). Its `files/gadget.json` names each library it imports:

```json
{"libraries": {"sync": "latest", "ui": "latest"}}
```

A gadget pins every library it loads, *transitively*: a library that imports another makes the
gadget pin both, and the build says which pin is missing when it is not.

The build checks the two against each other: every `gadgets:` import reachable from `client.js` or
`server.js` must be pinned, must name the side it is imported from (a client may not import
`gadgets:x/server`), and must name a library that exists in `packages/gadget-libraries`; and every
pin must be imported by something. The import survives into the archive, and the Workshop resolves
it when it loads the gadget. The Docs, Sheets and Slides blueprints are built on the `ui` and `sync`
libraries, with their own domain code in `files/`; the agent learns a library's interface through its
`describeGadgetLibrary` tool.

`blueprintId` is the install key. Never change it after deployment: the new ID would install a
second format while the old one remained. `version` is the blueprint's published content version
and R2 key. The build fingerprints the generated archive, so direct edits under `files/` reinstall
automatically. `revision` remains an explicit reinstall trigger and is bumped by the importer.

## Editing presentation

Edit `blueprint.json` and rebuild. Changes to title, description, output, or author are included in
the install fingerprint and do not need a `revision` bump.

## Updating code

Build the blueprint in a Workshop, export it, then import the export:

```
pnpm import:format-blueprint ~/Downloads/Gadgets-Doc-v4.gadget format.document
```

The importer replaces `files/`, updates archive-owned metadata (`created`, `version`, `lastUpdated`,
and `bindings`), bumps `revision`, rebuilds `src/generated/format-blueprints.ts`, and reports changed
files and bindings. Review the resulting source diff normally.

## Adding a format

```
pnpm import:format-blueprint ~/Downloads/Brief.gadget --new acme-brief
```

This extracts the files and writes a valid scaffolded `blueprint.json`. Before deploying, replace
the scaffold description and review `output`. Prefer a generic `output.id` such as `document`; the
Outputs page uses it to group related formats.

## Shipping your own formats

`FORMAT_BLUEPRINTS_DIR` points the build at another directory in this same extracted layout:

```
FORMAT_BLUEPRINTS_DIR=../../acme-formats pnpm exec vp run build
```

The named directory replaces this set rather than extending it. It can be empty to ship no bundled
formats. The import command honors the same variable. Keeping deployment-owned formats outside this
repo avoids modifying it when it is consumed as a submodule.

Directories using the previous `<name>.gadget` plus `<name>.json` layout remain supported, so an
existing deployment can update this repo without coordinating a format conversion. Importing a new
export into one of those entries migrates that pair to the extracted layout automatically.

Administrators can also publish and promote ordinary blueprints at runtime instead of rebuilding a
deployment.
