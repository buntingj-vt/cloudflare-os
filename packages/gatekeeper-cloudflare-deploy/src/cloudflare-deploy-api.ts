// Write client for the Cloudflare Workers REST API — the credentialed core of the deploy
// gatekeeper. This is the Worker-runtime port of the Phase 0 de-risk script
// (scripts/demo-builder/phase0-deploy.mjs in the parent repo): same proven sequence, but using
// Web Crypto (`crypto.subtle`) instead of node:crypto, since this Worker runs without
// `nodejs_compat`.
//
// Sequence to deploy an assets-only Worker:
//   assets-upload-session (manifest of hashes) -> upload asset batches (auth: session JWT) ->
//   PUT script (metadata references the completion JWT) -> enable per-script workers.dev route.
// Plus per-host Cloudflare Access app management (privacy) and script teardown.
//
// The manifest hash MUST be sha256(base64(content) + extension), hex, first 32 chars — a wrong
// recipe makes the upload session reject every file. Validated live in Phase 0.

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareDeployCredentials {
  /** Scoped API token: Workers Scripts:Edit, Account Settings:Read, Access Apps&Policies:Edit. */
  token: string;
  /** 32-hex Cloudflare account id. */
  accountId: string;
}

/** One file to deploy. `bytes` is the raw content; `path` is the site-relative path (no leading slash). */
export interface DeployFile {
  path: string;
  bytes: Uint8Array;
  /** MIME type; inferred from the extension when omitted. */
  contentType?: string;
}

export interface DeployAssetsConfig {
  /** SPA fallback etc. Defaults to single-page-application + auto-trailing-slash. */
  htmlHandling?: string;
  notFoundHandling?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp", ".avif": "image/avif",
  ".txt": "text/plain", ".xml": "application/xml", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".map": "application/json", ".wasm": "application/wasm",
  ".pdf": "application/pdf", ".webmanifest": "application/manifest+json",
};

function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function mimeFor(file: DeployFile): string {
  return file.contentType ?? MIME[extname(file.path)] ?? "application/octet-stream";
}

/** Standard base64 of raw bytes (chunked to avoid blowing the call stack on large files). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function hexEncode(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare's asset manifest hash: sha256(base64(content) + extension), hex, first 32 chars. */
async function assetHash(base64Content: string, extension: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(base64Content + extension),
  );
  return hexEncode(digest).slice(0, 32);
}

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

export class CloudflareApiError extends Error {
  constructor(readonly status: number, readonly path: string, readonly detail: string) {
    super(`Cloudflare API ${path} -> ${status}: ${detail}`);
    this.name = "CloudflareApiError";
  }
}

export class CloudflareDeployApi {
  readonly #token: string;
  readonly #accountId: string;

  constructor(creds: CloudflareDeployCredentials) {
    this.#token = creds.token;
    this.#accountId = creds.accountId;
  }

  get accountId(): string {
    return this.#accountId;
  }

  #acct(path: string): string {
    return `/accounts/${this.#accountId}${path}`;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const env = (await resp.json().catch(() => ({}))) as CfEnvelope<T>;
    if (!resp.ok || env.success === false) {
      throw new CloudflareApiError(resp.status, path, JSON.stringify(env.errors ?? env));
    }
    return env.result as T;
  }

  /** Verify the token is active. Returns the token id. */
  async verifyToken(): Promise<string> {
    const r = await this.#json<{ id: string; status: string }>("GET", "/user/tokens/verify");
    if (r.status !== "active") throw new Error(`API token is not active (status: ${r.status}).`);
    return r.id;
  }

  /** The account's registered workers.dev subdomain (throws if none is registered). */
  async getSubdomain(): Promise<string> {
    const r = await this.#json<{ subdomain?: string }>("GET", this.#acct("/workers/subdomain"));
    if (!r.subdomain) {
      throw new Error(
        "This account has no workers.dev subdomain registered. Register one in the Cloudflare " +
          "dashboard (Workers & Pages) before deploying.",
      );
    }
    return r.subdomain;
  }

  /** Full deploy of an assets-only Worker from a set of files. Idempotent per script name. */
  async deployStaticSite(
    scriptName: string,
    files: DeployFile[],
    config: DeployAssetsConfig = {},
  ): Promise<void> {
    if (files.length === 0) throw new Error("Cannot deploy an empty site (no files).");
    const completionToken = await this.#uploadAssets(scriptName, files);
    await this.#putAssetsOnlyScript(scriptName, completionToken, config);
  }

  /** Steps 1–2: manifest -> upload session -> batch upload. Returns the completion JWT. */
  async #uploadAssets(scriptName: string, files: DeployFile[]): Promise<string> {
    const prepared = await Promise.all(
      files.map(async (f) => {
        const base64 = bytesToBase64(f.bytes);
        const hash = await assetHash(base64, extname(f.path));
        return { file: f, base64, hash };
      }),
    );

    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const p of prepared) {
      manifest["/" + p.file.path.replace(/^\/+/, "")] = { hash: p.hash, size: p.file.bytes.length };
    }

    const session = await this.#json<{ jwt: string; buckets?: string[][] }>(
      "POST", this.#acct(`/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`),
      { manifest },
    );

    const buckets = session.buckets ?? [];
    if (buckets.length === 0) return session.jwt; // all assets already present

    const byHash = new Map(prepared.map((p) => [p.hash, p]));
    let completion: string | null = null;
    for (const bucket of buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const p = byHash.get(hash);
        if (!p) throw new Error(`Upload session requested unknown asset hash ${hash}.`);
        form.append(hash, new Blob([p.base64], { type: mimeFor(p.file) }), p.file.path);
      }
      // NOTE: the bearer here is the SESSION jwt, not the account API token.
      const resp = await fetch(`${API_BASE}${this.#acct("/workers/assets/upload")}?base64=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.jwt}` },
        body: form,
      });
      const env = (await resp.json().catch(() => ({}))) as CfEnvelope<{ jwt?: string }>;
      if (!resp.ok || env.success === false) {
        throw new CloudflareApiError(resp.status, "/workers/assets/upload", JSON.stringify(env.errors ?? env));
      }
      if (env.result?.jwt) completion = env.result.jwt;
    }
    if (!completion) throw new Error("Asset upload finished without a completion token.");
    return completion;
  }

  /** Step 3: PUT an assets-only Worker (no user code) referencing the uploaded assets. */
  async #putAssetsOnlyScript(
    scriptName: string,
    completionToken: string,
    config: DeployAssetsConfig,
  ): Promise<void> {
    const metadata = {
      compatibility_date: "2025-01-01",
      assets: {
        jwt: completionToken,
        config: {
          html_handling: config.htmlHandling ?? "auto-trailing-slash",
          not_found_handling: config.notFoundHandling ?? "single-page-application",
        },
      },
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    const resp = await fetch(
      `${API_BASE}${this.#acct(`/workers/scripts/${encodeURIComponent(scriptName)}`)}`,
      { method: "PUT", headers: { Authorization: `Bearer ${this.#token}` }, body: form },
    );
    const env = (await resp.json().catch(() => ({}))) as CfEnvelope<unknown>;
    if (!resp.ok || env.success === false) {
      throw new CloudflareApiError(resp.status, `/workers/scripts/${scriptName}`, JSON.stringify(env.errors ?? env));
    }
  }

  /** Enable the per-script workers.dev route. Returns the full URL. */
  async enableSubdomain(scriptName: string, subdomain: string): Promise<string> {
    await this.#json("POST", this.#acct(`/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`), {
      enabled: true,
      previews_enabled: false,
    });
    return `https://${scriptName}.${subdomain}.workers.dev`;
  }

  async deleteScript(scriptName: string): Promise<void> {
    try {
      await this.#json("DELETE", this.#acct(`/workers/scripts/${encodeURIComponent(scriptName)}`));
    } catch (e) {
      // A 404 (already gone) is a successful teardown.
      if (e instanceof CloudflareApiError && e.status === 404) return;
      throw e;
    }
  }

  // ---- Cloudflare Access (privacy) — per-host self-hosted app + email policy ----------------

  /**
   * Ensure a self-hosted Access app gates exactly `hostname`, allowing only `email`.
   * Per-host by default (zero blast radius). Returns the app id. Idempotent.
   */
  async ensureAccessApp(hostname: string, email: string): Promise<string> {
    const apps = await this.#json<Array<{ id: string; domain: string }>>(
      "GET", this.#acct("/access/apps"),
    );
    let app = apps.find((a) => a.domain === hostname);
    if (!app) {
      app = await this.#json<{ id: string; domain: string }>("POST", this.#acct("/access/apps"), {
        name: `Demo: ${hostname}`,
        domain: hostname,
        type: "self_hosted",
        session_duration: "24h",
      });
    }
    await this.#json("POST", this.#acct(`/access/apps/${app.id}/policies`), {
      name: `allow ${email}`,
      decision: "allow",
      include: [{ email: { email } }],
    });
    return app.id;
  }

  /** Remove the Access app gating `hostname`, if any. */
  async deleteAccessAppForDomain(hostname: string): Promise<void> {
    const apps = await this.#json<Array<{ id: string; domain: string }>>(
      "GET", this.#acct("/access/apps"),
    );
    const app = apps.find((a) => a.domain === hostname);
    if (app) await this.#json("DELETE", this.#acct(`/access/apps/${app.id}`));
  }
}
