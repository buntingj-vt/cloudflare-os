import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ActionDescription,
  type ApprovalQueue,
  type AvatarImage,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { CloudflareAccountConfiguratorRpc } from "./configurator/account-configurator-types";
import { CloudflareApiError, CloudflareDeployApi, type AssetManifestEntry, type DeployFile } from "./cloudflare-deploy-api";
import type {
  CloudflareDeploySession,
  DemoDeployment,
  DemoFile,
  DeployAccountInfo,
  DeployOptions,
} from "./types";
import TYPES_CODE from "./types.txt";

// ---------------------------------------------------------------------------
// Configuration & nonce helpers

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  /** Build service endpoint (Phase 2). Set as a var; the secret below authenticates to it. */
  BUILD_SERVICE_URL?: string;
  BUILD_SERVICE_SECRET?: string;
};

interface BuildWorkerBundle {
  mainModule: string;
  contentBase64: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
}
type BuildServiceResponse =
  | { ok: true; kind: "static"; type: string; entry: string; buildId: string; manifest: AssetManifestEntry[]; totalBytes: number }
  | { ok: true; kind: "worker"; type: string; entry: string; buildId: string; manifest: AssetManifestEntry[]; worker: BuildWorkerBundle; totalBytes: number }
  | { ok: false; error: string; stage: string; log?: string };
type BuildStarted = Extract<BuildServiceResponse, { ok: true }>;
type BuildContentResponse =
  | { ok: true; files: Record<string, string> }
  | { ok: false; error: string };

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;
// Guard against oversized bundles going through DO storage; Phase 2 stages large builds in R2.
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/cloudflare-deploy");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Slugify a requested demo name into a valid Worker script name (also the workers.dev label). */
function slugifyName(name: string): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) slug = "demo";
  if (!/^[a-z]/.test(slug)) slug = `demo-${slug}`;
  return slug.slice(0, 54);
}

/** Default demo name from a git URL's last path segment (e.g. .../owner/repo(.git) -> "repo"). */
function repoNameFromUrl(repoUrl: string): string {
  try {
    const parts = new URL(repoUrl).pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    return parts[parts.length - 1] || "demo";
  } catch {
    return "demo";
  }
}

// ---------------------------------------------------------------------------
// Resource descriptor + branding

// Cloudflare logomark (simplified cloud) in brand orange, inline as a data URL.
const CLOUDFLARE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<path fill="#F38020" d="M410 320c34 0 62-28 62-62 0-33-26-60-59-62-9-46-49-80-97-80-38 0-71 22-87 54-8-4-17-6-27-6-31 0-57 24-59 55-27 6-47 30-47 59 0 33 27 60 60 60z"/>\
</svg>`;
const CLOUDFLARE_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(CLOUDFLARE_LOGO_SVG)}`;
const CLOUDFLARE_ICON: AvatarImage = { url: CLOUDFLARE_LOGO_URL };

// One resource type: a Cloudflare account you can deploy demos into. The canonical URL is the
// account's dashboard URL; the accountId travels in the path so the resource identity is the account.
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://dash.cloudflare.com/:accountId",
  title: "Cloudflare account (deploy)",
  description:
    "Deploy static-site demos as private Workers into this Cloudflare account and get " +
    "private *.workers.dev URLs.",
  icon: CLOUDFLARE_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

function accountResourceUrl(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}`;
}

function assertAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
  return accountId.toLowerCase();
}

// ---------------------------------------------------------------------------
// Connect flow HTML

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Cloudflare (deploy)</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 560px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #f38020; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #f38020; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #f38020; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #d96f16; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect Cloudflare (deploy)</h1>
    <p>Provide a scoped Cloudflare API token, the account to deploy into, and the email allowed to open your private demos.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeAttr(params.actionUrl)}">
      <label for="token">Cloudflare API token</label>
      <input id="token" name="token" type="password" required placeholder="••••••••">
      <div class="hint">Scopes: Workers Scripts:Edit, Account Settings:Read, Access: Apps and Policies:Edit, Access: Orgs/IdP/Groups:Read.</div>

      <label for="accountId">Account ID</label>
      <input id="accountId" name="accountId" type="text" required placeholder="32-hex account id">
      <div class="hint">Dashboard → Workers &amp; Pages → Account details.</div>

      <label for="ownerEmail">Allowed email (Cloudflare Access)</label>
      <input id="ownerEmail" name="ownerEmail" type="email" required placeholder="you@example.com">
      <div class="hint">Private demos are gated by Cloudflare Access; only this email can open them.</div>

      <details>
        <summary>How to create the API token</summary>
        <ol>
          <li>Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom Token.</li>
          <li>Add the scopes listed above (all Account-level).</li>
          <li>Create the token and paste it here.</li>
        </ol>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Authorization Link Expired</h2>
  <p>This connection link is invalid or has expired. Please return to Cloudflare OS and start over.</p>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// fetch handler: serves the connect form and accepts its POST

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response(CONNECT_FORM_HTML({ actionUrl: req.url }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const token = String(formData.get("token") ?? "").trim();
        const accountIdInput = String(formData.get("accountId") ?? "").trim();
        const ownerEmail = String(formData.get("ownerEmail") ?? "").trim();
        if (!token || !accountIdInput || !ownerEmail) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "Token, account ID, and email are all required." }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        let accountId: string;
        try {
          accountId = assertAccountId(accountIdInput);
        } catch {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "Account ID must be 32 hex characters." }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(nonce, token, accountId, ownerEmail);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (result.kind === "error") {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        return htmlResponse(connectHandoffPageHtml(result.handoff));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare (deploy)",
      url: "https://developers.cloudflare.com/workers/",
      logo: CLOUDFLARE_ICON,
      tagline: "Deploy static-site demos as private Workers and get private workers.dev URLs.",
      description:
        "Connect a Cloudflare account so Cloudflare OS can deploy static sites as assets-only " +
        "Workers, gate them behind Cloudflare Access, and hand back a private *.workers.dev URL. " +
        "Powers the Demo Builder gadget.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores the API token + account id + owner email

interface StoredCredentials {
  token: string;
  accountId: string;
  ownerEmail: string;
}

interface StoredNonce {
  value: string;
  expiresAt: number;
  reconnect?: true;
  connecting?: true;
}

type CompleteConnectionResult =
  | { kind: "ok"; handoff: ConnectHandoff }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
      reconnect: true,
    });
  }

  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt) return false;
    return constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(
    nonce: string,
    token: string,
    accountId: string,
    ownerEmail: string,
  ): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.connecting || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: true });

    // Validate the token can reach the account and it has a workers.dev subdomain.
    try {
      const api = new CloudflareDeployApi({ token, accountId });
      await api.verifyToken();
      await api.getSubdomain();
    } catch (e: any) {
      this.#releaseNonceClaim(nonce);
      const msg = e instanceof CloudflareApiError
        ? `Cloudflare rejected the token/account: ${e.detail}`
        : `Unable to validate: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return { kind: "error", message: "Connection callback expired. Please restart." };

    const creds: StoredCredentials = { token, accountId, ownerEmail };
    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      const stageId = stageCredentials<StoredCredentials>(this.ctx.storage.kv, creds, Date.now());
      try {
        handoff = await callback.reconnectComplete(stageId);
      } catch (e: any) {
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    } else {
      this.ctx.storage.kv.put<StoredCredentials>("credentials", creds);
      this.ctx.storage.kv.put("expiredNotified", false);
      try {
        const props: CloudflareDeployUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.CloudflareDeployUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok", handoff };
  }

  #releaseNonceClaim(nonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || !stored.connecting || !constantTimeEqual(stored.value, nonce)) return;
    const { connecting: _, ...released } = stored;
    this.ctx.storage.kv.put<StoredNonce>("nonce", released);
  }

  async commitReconnect(stageId: string): Promise<void> {
    const creds = commitStagedCredentials<StoredCredentials>(this.ctx.storage.kv, Date.now(), stageId);
    if (!creds) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.ctx.storage.kv.put<StoredCredentials>("credentials", creds);
    this.ctx.storage.kv.put("expiredNotified", false);
  }

  getCredentials(): StoredCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) throw new Error("Cloudflare deploy credentials are not configured for this account.");
    return creds;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type CloudflareDeployUserImplProps = { userObjectId: string };

@validateRpc()
export class CloudflareDeployUserImpl
  extends WorkerEntrypoint<Env, CloudflareDeployUserImplProps>
  implements GatekeeperUser
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<StoredCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    const creds = await this.#getCreds();
    return {
      displayName: `Cloudflare deploy (${creds.accountId.slice(0, 8)}…)`,
      uniqueName: creds.accountId,
      avatar: CLOUDFLARE_ICON,
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    const userAccount = this.#userAccount();
    const credsGetter = async () => await userAccount.getCredentials();
    return {
      iframeHtml: ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new AccountConfiguratorUI(credsGetter)),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      throw new Error(`Invalid Cloudflare account URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    if (parsed.hostname !== "dash.cloudflare.com") {
      throw new Error(`Unsupported URL for Cloudflare deploy: ${url}`);
    }
    const accountId = assertAccountId(parsed.pathname.split("/").filter(Boolean)[0] ?? "");
    return {
      class: this.ctx.exports.CloudflareDeployGatekeeperImpl({
        props: { userObjectId: this.ctx.props.userObjectId, accountId },
      }),
      resource: ACCOUNT_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CloudflareDeployVerifier({});
  }
}

@validateRpc()
export class CloudflareDeployVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Configurator UI (single account resource — no user-selectable inputs)

const accountConfiguratorGetters = new WeakMap<object, () => Promise<StoredCredentials>>();

@validateRpc()
class AccountConfiguratorUI extends RpcTarget implements CloudflareAccountConfiguratorRpc {
  constructor(getCredentials: () => Promise<StoredCredentials>) {
    super();
    accountConfiguratorGetters.set(this, getCredentials);
  }

  async resourceUrl(): Promise<string> {
    const getter = accountConfiguratorGetters.get(this);
    if (!getter) throw new Error("Configurator is not initialized.");
    const creds = await getter();
    return accountResourceUrl(creds.accountId);
  }

  async describeAccount(): Promise<{ accountId: string }> {
    const getter = accountConfiguratorGetters.get(this);
    if (!getter) throw new Error("Configurator is not initialized.");
    const creds = await getter();
    return { accountId: creds.accountId };
  }
}

// ---------------------------------------------------------------------------
// Per-resource gatekeeper DO + approval-gated deploy/teardown

type CloudflareDeployGatekeeperImplProps = { userObjectId: string; accountId: string };

interface DeployActionData {
  type: "deploy";
  id: number;
  scriptName: string;
  files: DemoFile[];
  private: boolean;
  accessEmail?: string;
  url: string;
  hostname: string;
  submittedAt: number;
}
interface DeployRepoActionData {
  type: "deployRepo";
  id: number;
  scriptName: string;
  repoUrl: string;
  ref?: string;
  private: boolean;
  accessEmail?: string;
  url: string;
  hostname: string;
  submittedAt: number;
}
interface TeardownActionData {
  type: "teardown";
  id: number;
  scriptName: string;
  hostname: string;
  submittedAt: number;
}
type CfAction = DeployActionData | DeployRepoActionData | TeardownActionData;

type PendingActionRow = { id: number; action: CfAction };
type AppliedActionRow = { id: number; action: CfAction; appliedAt: number };

export class CloudflareDeployGatekeeperImpl
  extends DurableObject<Env, CloudflareDeployGatekeeperImplProps>
  implements Gatekeeper<CloudflareDeploySession>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<StoredCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async #api(): Promise<CloudflareDeployApi> {
    const creds = await this.#getCreds();
    return new CloudflareDeployApi({ token: creds.token, accountId: this.ctx.props.accountId });
  }

  /** Fetch and cache the account's workers.dev subdomain. */
  async #subdomain(): Promise<string> {
    const cached = this.ctx.storage.kv.get<string>("subdomain");
    if (cached) return cached;
    const sub = await (await this.#api()).getSubdomain();
    this.ctx.storage.kv.put("subdomain", sub);
    return sub;
  }

  async describe(): Promise<ResourceDescription> {
    const accountId = this.ctx.props.accountId;
    return {
      url: accountResourceUrl(accountId),
      title: `Cloudflare deploy (${accountId.slice(0, 8)}…)`,
      snippet: `Deploy private static-site demos into Cloudflare account ${accountId}.`,
      suggestedBindingName: "CF_DEPLOY",
      tsType: "CloudflareDeploySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    // Phase 1: deploys/teardowns always require manual approval.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareDeploySession> {
    return new CloudflareDeploySessionImpl(this, approvalQueue.dup());
  }

  // Personal single-account resource: low-stakes observer strategy (see gatekeeper-homeassistant).
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(actionId: number): Promise<void> {
    const pending = this.#getPending(actionId);
    if (!pending) throw new Error(`No queued Cloudflare deploy action exists with id ${actionId}.`);
    const action = pending.action;
    const api = await this.#api();

    if (action.type === "deploy" || action.type === "deployRepo") {
      try {
        if (action.type === "deployRepo") {
          // Clone + build happen now (only after approval). The build service keeps the built output
          // in a sandbox; we stream it up one bucket at a time, so nothing large buffers in memory.
          const build = await this.#startBuild(action.repoUrl, action.ref);
          try {
            if (build.kind === "worker") {
              // A server (SSR) demo: deploy a real Worker (module + assets), ASSETS binding only.
              await api.deployWorkerSite(
                action.scriptName,
                {
                  mainModule: build.worker.mainModule,
                  moduleBytes: base64ToBytes(build.worker.contentBase64),
                  compatibilityDate: build.worker.compatibilityDate,
                  compatibilityFlags: build.worker.compatibilityFlags,
                },
                build.manifest,
                (paths) => this.#pullBuildContent(build.buildId, paths),
              );
            } else {
              await api.deployStaticSiteStreamed(
                action.scriptName,
                build.manifest,
                (paths) => this.#pullBuildContent(build.buildId, paths),
              );
            }
            await this.#finishDeploy(api, action);
          } finally {
            await this.#releaseBuild(build.buildId);
          }
        } else {
          const files: DeployFile[] = action.files.map((f) => ({
            path: f.path,
            bytes: base64ToBytes(f.contentBase64),
            contentType: f.contentType,
          }));
          await api.deployStaticSite(action.scriptName, files);
          await this.#finishDeploy(api, action);
        }
      } catch (e) {
        // Expired credentials: let the action re-queue so the user can reconnect and retry.
        if (e instanceof CloudflareApiError && (e.status === 401 || e.status === 403)) {
          await this.#userAccount().noteCredentialsExpired();
          throw e;
        }
        // Any other build/deploy failure (unsupported repo, size cap, build error, …) must not
        // silently loop back to the review queue as a perpetual "pending". Record the reason on the
        // demo so the gadget can show it, then consume the action.
        this.#markDemoFailed(action, e);
        this.#deletePending(actionId);
        return;
      }
    } else {
      try {
        await api.deleteScript(action.scriptName);
        await api.deleteAccessAppForDomain(action.hostname);
        this.#deleteDemo(action.scriptName);
      } catch (e) {
        if (e instanceof CloudflareApiError && (e.status === 401 || e.status === 403)) {
          await this.#userAccount().noteCredentialsExpired();
        }
        throw e;
      }
    }
    this.#storeApplied(action);
    this.#deletePending(actionId);
  }

  /** Record a failed deploy on the demo so the gadget surfaces the reason instead of a stuck spinner. */
  #markDemoFailed(action: DeployActionData | DeployRepoActionData, e: unknown): void {
    this.#putDemo({
      id: action.scriptName,
      name: action.scriptName,
      url: action.url,
      private: action.private,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      createdAt: action.submittedAt,
    });
  }

  /** Post-upload steps shared by both deploy paths: enable the subdomain, gate it, mark it live. */
  async #finishDeploy(
    api: CloudflareDeployApi,
    action: DeployActionData | DeployRepoActionData,
  ): Promise<void> {
    const subdomain = await this.#subdomain();
    await api.enableSubdomain(action.scriptName, subdomain);
    if (action.private && action.accessEmail) {
      await api.ensureAccessApp(action.hostname, action.accessEmail);
    }
    this.#putDemo({
      id: action.scriptName,
      name: action.scriptName,
      url: action.url,
      private: action.private,
      status: "live",
      createdAt: action.submittedAt,
    });
  }

  #buildServiceCall(body: object): Promise<Response> {
    const url = this.env.BUILD_SERVICE_URL;
    const secret = this.env.BUILD_SERVICE_SECRET;
    if (!url || !secret) {
      throw new Error(
        "The build service isn't configured — set BUILD_SERVICE_URL and BUILD_SERVICE_SECRET on " +
          "the Cloudflare deploy gatekeeper to enable GitHub-repo builds.",
      );
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
  }

  /** Kick off a clone+build; returns the build (kind + manifest + build id, and worker bundle if SSR). */
  async #startBuild(repoUrl: string, ref?: string): Promise<BuildStarted> {
    const resp = await this.#buildServiceCall({ repoUrl, ref });
    const data = (await resp.json().catch(() => null)) as BuildServiceResponse | null;
    if (!data) throw new Error(`Build service returned a non-JSON response (HTTP ${resp.status}).`);
    if (!data.ok) throw new Error(`Build failed at ${data.stage}: ${data.error}`);
    return data;
  }

  /** Fetch a batch of built files (base64) from the kept-alive build sandbox. */
  async #pullBuildContent(buildId: string, paths: string[]): Promise<Record<string, string>> {
    const resp = await this.#buildServiceCall({ action: "content", buildId, paths });
    const data = (await resp.json().catch(() => null)) as BuildContentResponse | null;
    if (!data || !data.ok) {
      throw new Error(`Failed to fetch built files: ${data && !data.ok ? data.error : `HTTP ${resp.status}`}`);
    }
    return data.files;
  }

  /** Free the build sandbox after upload (best-effort; the platform idle-stops it otherwise). */
  async #releaseBuild(buildId: string): Promise<void> {
    try { await this.#buildServiceCall({ action: "release", buildId }); } catch { /* idle-stop reaps it */ }
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const pending = this.#getPending(actionId);
    if (pending?.action.type === "deploy" || pending?.action.type === "deployRepo") {
      // The provisional (pending) demo never went live; drop it if it's still pending.
      const demo = this.#getDemo(pending.action.scriptName);
      if (demo?.status === "pending") this.#deleteDemo(pending.action.scriptName);
    }
    this.#deletePending(actionId);
  }

  async revertAction(
    actionId: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const applied = this.#getApplied(actionId);
    if (!applied) throw new Error(`No applied Cloudflare deploy action exists with id ${actionId}.`);
    if (applied.action.type !== "deploy" && applied.action.type !== "deployRepo") {
      throw new Error("This action cannot be reverted.");
    }
    // Reverting a deploy removes the demo (delete the script + its Access app).
    const api = await this.#api();
    await api.deleteScript(applied.action.scriptName);
    await api.deleteAccessAppForDomain(applied.action.hostname);
    this.#deleteDemo(applied.action.scriptName);
  }

  // ---- Session-facing helpers (called by CloudflareDeploySessionImpl) ----------------------

  async submitDeploy(
    approvalQueue: RpcStub<ApprovalQueue>,
    name: string,
    files: DemoFile[],
    options: DeployOptions | undefined,
  ): Promise<DemoDeployment> {
    if (files.length === 0) throw new Error("Cannot deploy an empty site (no files).");
    if (!files.some((f) => f.path.replace(/^\/+/, "") === "index.html")) {
      throw new Error("A static site must include an index.html at its root.");
    }
    const totalBytes = files.reduce((n, f) => n + Math.ceil((f.contentBase64.length * 3) / 4), 0);
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `Bundle is too large (~${Math.round(totalBytes / 1024)} KiB) for direct deploy; ` +
          "Phase 2 will stage large builds in R2.",
      );
    }
    const creds = await this.#getCreds();
    const isPrivate = options?.private ?? true;
    const accessEmail = options?.accessEmail ?? creds.ownerEmail;
    if (isPrivate && !accessEmail) throw new Error("A private demo needs an accessEmail.");

    const scriptName = slugifyName(name);
    const subdomain = await this.#subdomain();
    const hostname = `${scriptName}.${subdomain}.workers.dev`;
    const url = `https://${hostname}`;
    const id = this.#nextActionId();
    const submittedAt = Date.now();

    const action: DeployActionData = {
      type: "deploy", id, scriptName, files, private: isPrivate,
      accessEmail: isPrivate ? accessEmail : undefined, url, hostname, submittedAt,
    };
    this.ctx.storage.kv.put<PendingActionRow>(`pending:${id}`, { id, action });
    this.#putDemo({ id: scriptName, name: scriptName, url, private: isPrivate, status: "pending", createdAt: submittedAt });

    const description: ActionDescription = {
      title: `Deploy demo "${scriptName}"`,
      description:
        `Deploy a static site (${files.length} file(s)) as an assets-only Worker at ${url}` +
        (isPrivate ? `, gated by Cloudflare Access for ${accessEmail}` : " (public)") +
        `. Reverting removes the demo.`,
      implementsRevert: true,
      awaitDecision: true,
      actionKind: { tag: "deploy-demo", label: "Deploy demo" },
    };
    try {
      await approvalQueue.submitAction(id, description);
    } catch (e) {
      this.#deletePending(id);
      if (this.#getDemo(scriptName)?.status === "pending") this.#deleteDemo(scriptName);
      throw e;
    }
    return { id: scriptName, name: scriptName, url, private: isPrivate, status: "pending", createdAt: submittedAt };
  }

  async submitDeployRepo(
    approvalQueue: RpcStub<ApprovalQueue>,
    name: string,
    repoUrl: string,
    options: (DeployOptions & { ref?: string }) | undefined,
  ): Promise<DemoDeployment> {
    if (!repoUrl) throw new Error("A repo URL is required.");
    if (!this.env.BUILD_SERVICE_URL || !this.env.BUILD_SERVICE_SECRET) {
      throw new Error(
        "The build service isn't configured — set BUILD_SERVICE_URL and BUILD_SERVICE_SECRET on " +
          "the Cloudflare deploy gatekeeper to enable GitHub-repo builds.",
      );
    }
    const creds = await this.#getCreds();
    const isPrivate = options?.private ?? true;
    const accessEmail = options?.accessEmail ?? creds.ownerEmail;
    if (isPrivate && !accessEmail) throw new Error("A private demo needs an accessEmail.");

    const scriptName = slugifyName(name || repoNameFromUrl(repoUrl));
    const subdomain = await this.#subdomain();
    const hostname = `${scriptName}.${subdomain}.workers.dev`;
    const url = `https://${hostname}`;
    const id = this.#nextActionId();
    const submittedAt = Date.now();

    const action: DeployRepoActionData = {
      type: "deployRepo", id, scriptName, repoUrl, ref: options?.ref, private: isPrivate,
      accessEmail: isPrivate ? accessEmail : undefined, url, hostname, submittedAt,
    };
    this.ctx.storage.kv.put<PendingActionRow>(`pending:${id}`, { id, action });
    this.#putDemo({ id: scriptName, name: scriptName, url, private: isPrivate, status: "pending", createdAt: submittedAt });

    const description: ActionDescription = {
      title: `Deploy demo "${scriptName}" from ${repoUrl}`,
      description:
        `Clone ${repoUrl}${options?.ref ? ` (ref ${options.ref})` : ""}, build it in a container, and ` +
        `deploy the static output as an assets-only Worker at ${url}` +
        (isPrivate ? `, gated by Cloudflare Access for ${accessEmail}` : " (public)") +
        `. Reverting removes the demo.`,
      implementsRevert: true,
      awaitDecision: true,
      actionKind: { tag: "deploy-repo", label: "Deploy demo from repo" },
    };
    try {
      await approvalQueue.submitAction(id, description);
    } catch (e) {
      this.#deletePending(id);
      if (this.#getDemo(scriptName)?.status === "pending") this.#deleteDemo(scriptName);
      throw e;
    }
    return { id: scriptName, name: scriptName, url, private: isPrivate, status: "pending", createdAt: submittedAt };
  }

  async submitTeardown(approvalQueue: RpcStub<ApprovalQueue>, name: string): Promise<void> {
    const scriptName = slugifyName(name);
    const demo = this.#getDemo(scriptName);
    if (!demo) throw new Error(`No demo named "${scriptName}".`);
    // A failed demo never deployed a Worker — just drop the record; no approval or API call needed.
    if (demo.status === "failed") {
      this.#deleteDemo(scriptName);
      return;
    }
    const subdomain = await this.#subdomain();
    const hostname = `${scriptName}.${subdomain}.workers.dev`;
    const id = this.#nextActionId();
    const action: TeardownActionData = { type: "teardown", id, scriptName, hostname, submittedAt: Date.now() };
    this.ctx.storage.kv.put<PendingActionRow>(`pending:${id}`, { id, action });
    const description: ActionDescription = {
      title: `Tear down demo "${scriptName}"`,
      description: `Delete the Worker ${hostname} and its Cloudflare Access app. This cannot be reverted.`,
      implementsRevert: false,
      awaitDecision: true,
      actionKind: { tag: "teardown-demo", label: "Tear down demo" },
    };
    try {
      await approvalQueue.submitAction(id, description);
    } catch (e) {
      this.#deletePending(id);
      throw e;
    }
  }

  async accountInfo(): Promise<DeployAccountInfo> {
    return { accountId: this.ctx.props.accountId, subdomain: await this.#subdomain() };
  }

  listDemos(): DemoDeployment[] {
    return [...this.ctx.storage.kv.list<DemoDeployment>({ prefix: "demo:" })]
      .map(([, v]) => v)
      .toSorted((a, b) => b.createdAt - a.createdAt);
  }

  getDemo(name: string): DemoDeployment | null {
    return this.#getDemo(slugifyName(name)) ?? null;
  }

  // ---- Storage --------------------------------------------------------------------------------

  #nextActionId(): number {
    const v = (this.ctx.storage.kv.get<number>("counter:nextActionId") ?? 0) + 1;
    this.ctx.storage.kv.put("counter:nextActionId", v);
    return v;
  }
  #getPending(id: number): PendingActionRow | undefined {
    return this.ctx.storage.kv.get<PendingActionRow>(`pending:${id}`);
  }
  #deletePending(id: number): void {
    this.ctx.storage.kv.delete(`pending:${id}`);
  }
  #storeApplied(action: CfAction): void {
    this.ctx.storage.kv.put<AppliedActionRow>(`applied:${action.id}`, { id: action.id, action, appliedAt: Date.now() });
  }
  #getApplied(id: number): AppliedActionRow | undefined {
    return this.ctx.storage.kv.get<AppliedActionRow>(`applied:${id}`);
  }
  #getDemo(scriptName: string): DemoDeployment | undefined {
    return this.ctx.storage.kv.get<DemoDeployment>(`demo:${scriptName}`);
  }
  #putDemo(demo: DemoDeployment): void {
    this.ctx.storage.kv.put<DemoDeployment>(`demo:${demo.name}`, demo);
  }
  #deleteDemo(scriptName: string): void {
    this.ctx.storage.kv.delete(`demo:${scriptName}`);
  }
}

// ---------------------------------------------------------------------------
// Session (agent-facing RpcTarget)

@validateRpc()
class CloudflareDeploySessionImpl extends RpcTarget implements CloudflareDeploySession {
  #gk: CloudflareDeployGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(gk: CloudflareDeployGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#approvalQueue = approvalQueue;
  }

  async getAccount(): Promise<DeployAccountInfo> {
    const info = await this.#gk.accountInfo();
    await this.#approvalQueue.authorizeObservation({
      title: "Read Cloudflare account info",
      description: `Read account id and workers.dev subdomain for ${info.accountId}.`,
    });
    return info;
  }

  async listDemos(): Promise<DemoDeployment[]> {
    const demos = this.#gk.listDemos();
    await this.#approvalQueue.authorizeObservation({
      title: "List demos",
      description: `List ${demos.length} demo deployment(s).`,
    });
    return demos;
  }

  async getDemo(name: string): Promise<DemoDeployment | null> {
    const demo = this.#gk.getDemo(name);
    await this.#approvalQueue.authorizeObservation({
      title: `Read demo "${name}"`,
      description: demo ? `Read demo ${demo.name} (${demo.url}).` : `No demo named "${name}".`,
    });
    return demo;
  }

  async deployStaticSite(name: string, files: DemoFile[], options?: DeployOptions): Promise<DemoDeployment> {
    return await this.#gk.submitDeploy(this.#approvalQueue, name, files, options);
  }

  async deployFromRepo(
    name: string,
    repoUrl: string,
    options?: DeployOptions & { ref?: string },
  ): Promise<DemoDeployment> {
    return await this.#gk.submitDeployRepo(this.#approvalQueue, name, repoUrl, options);
  }

  async teardownDemo(name: string): Promise<void> {
    await this.#gk.submitTeardown(this.#approvalQueue, name);
  }

  [Symbol.dispose](): void {
    try {
      (this.#approvalQueue as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();
    } catch {
      // already disposed / missing dispose: ignore
    }
  }
}
