// TypeScript interface for the Cloudflare Deploy gatekeeper. These types are exposed to gadgets
// and agents granted access to a Cloudflare account deploy target.
//
// This gatekeeper deploys **assets-only Workers** (static sites) to the connected Cloudflare
// account and returns a private `*.workers.dev` URL, fronted by Cloudflare Access so only an
// allowed email can open it.
//
// =====================================================================================
// APPROVAL
// =====================================================================================
//
// Deploying and tearing down are side effects and are QUEUED FOR APPROVAL. A write method's
// promise resolves as soon as the action is queued — it does NOT wait for the deploy to actually
// run. The returned deployment carries a provisional id (prefixed with "~") and status "pending"
// until the user approves it; reads reflect the deployment as if already live so you can keep
// working. Once approved, the deploy runs against Cloudflare and the provisional id resolves to
// the real deployment.

import type { RpcTarget } from "cloudflare:workers";

/** A file in a static site to deploy. */
export interface DemoFile {
  /** Site-relative path, no leading slash, forward slashes (e.g. "index.html", "assets/app.js"). */
  path: string;
  /** File contents, base64-encoded. */
  contentBase64: string;
  /** MIME type. Inferred from the file extension when omitted. */
  contentType?: string;
}

export interface DeployOptions {
  /**
   * Gate the deployment behind Cloudflare Access so only `accessEmail` can open it. Default true.
   * When false the workers.dev URL is public.
   */
  private?: boolean;
  /** Email allowed through Access. Required when `private` is true. */
  accessEmail?: string;
}

/** A deployed (or pending) demo. */
export interface DemoDeployment {
  /** Stable id. Provisional ids are prefixed with "~" until the deploy is approved. */
  id: string;
  /** The Worker script name (also the workers.dev subdomain label). */
  name: string;
  /** The `https://<name>.<subdomain>.workers.dev` URL. */
  url: string;
  /** Whether the URL is gated by Cloudflare Access. */
  private: boolean;
  /** "pending" until the deploy action is approved and applied, then "live". */
  status: "pending" | "live";
  /** UNIX millis when the deployment was created/queued. */
  createdAt: number;
}

/** Metadata about the connected Cloudflare account deploy target. */
export interface DeployAccountInfo {
  /** 32-hex Cloudflare account id. */
  accountId: string;
  /** The account's workers.dev subdomain (the `<subdomain>` in `*.subdomain.workers.dev`). */
  subdomain: string;
}

/** Session for a Cloudflare account deploy target. */
export interface CloudflareDeploySession extends RpcTarget {
  /** Get the connected account id and its workers.dev subdomain. */
  getAccount(): Promise<DeployAccountInfo>;

  /** List demos deployed through this gatekeeper (including pending ones). */
  listDemos(): Promise<DemoDeployment[]>;

  /** Get one demo by name, or null if there is none. */
  getDemo(name: string): Promise<DemoDeployment | null>;

  /**
   * Deploy a static site as an assets-only Worker and return its (private) workers.dev URL.
   * QUEUED FOR APPROVAL — see the APPROVAL note above.
   *
   * @param name  Desired demo name. Becomes the Worker script name and workers.dev label; it is
   *              slugified (lowercased, non-alphanumerics to "-") and may get a short suffix to
   *              stay unique. Read the returned `name`/`url` for the final value.
   * @param files The site's files. Must include an `index.html`.
   * @param options Privacy options (defaults to private, gated to the account owner's email).
   * @example
   * const demo = await session.deployStaticSite("acme-landing", [
   *   { path: "index.html", contentBase64: btoa("<h1>hi</h1>") },
   * ]);
   * // demo.url -> https://acme-landing.<subdomain>.workers.dev  (behind Access)
   */
  deployStaticSite(
    name: string,
    files: DemoFile[],
    options?: DeployOptions,
  ): Promise<DemoDeployment>;

  /**
   * Build a GitHub repo (or any git URL) in a container and deploy its static output as a private
   * demo. QUEUED FOR APPROVAL — the clone+build+deploy runs only after you approve it.
   *
   * The repo must produce static output: either a `build` script whose output lands in
   * dist/build/out/public, or a plain `index.html` at the root. Full-stack/server apps aren't
   * supported. Requires the build service to be configured on the gatekeeper.
   *
   * @param name Desired demo name (slugified; read the returned name/url for the final value).
   * @param repoUrl https git URL, e.g. "https://github.com/owner/repo".
   * @param options `ref` selects a branch/tag; plus the usual privacy options.
   * @example const demo = await session.deployFromRepo("acme", "https://github.com/acme/site");
   */
  deployFromRepo(
    name: string,
    repoUrl: string,
    options?: DeployOptions & { ref?: string },
  ): Promise<DemoDeployment>;

  /**
   * Tear down a demo: delete the Worker script and its Access app. QUEUED FOR APPROVAL.
   * @example await session.teardownDemo("acme-landing");
   */
  teardownDemo(name: string): Promise<void>;
}
