// Demo Builder gadget — deploy a private static-site copy on Cloudflare via the CF_DEPLOY
// gatekeeper and get back a private *.workers.dev URL.
//
// Binding: env.CF_DEPLOY is a CloudflareDeploySession (from the gatekeeper-cloudflare-deploy
// gatekeeper). Wire it post-instantiation: Connections → bind this gadget → CF_DEPLOY.
//
// Deploys/teardowns are human-gated by the gatekeeper: the call returns a provisional demo
// (status "pending") and the deploy runs only after you approve it. Reads (getAccount/listDemos)
// are observations.
//
// Phase 1 sources: paste HTML, or fetch a single static page by URL. Full GitHub-repo builds land
// when the Phase 2 build service is connected (deployFromRepo).

import { DurableObject } from "cloudflare:workers";

const MAX_CONTENT_BYTES = 1.5 * 1024 * 1024;

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid URL (including https://).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://.");
  }
  const h = url.hostname.toLowerCase();
  const isPrivate =
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (isPrivate) throw new Error("Refusing to fetch a private/loopback address.");
  return url;
}

export class Gadget extends DurableObject {
  #requireDeploy() {
    if (!this.env.CF_DEPLOY) {
      throw new Error(
        "No Cloudflare deploy target is connected. Open Connections, bind this gadget, and set " +
          "CF_DEPLOY to your Cloudflare deploy gatekeeper.",
      );
    }
    return this.env.CF_DEPLOY;
  }

  async getState() {
    if (!this.env.CF_DEPLOY) {
      return { connected: false, account: null, demos: [], error: null };
    }
    let account = null;
    let demos = [];
    let error = null;
    try {
      account = await this.env.CF_DEPLOY.getAccount();
    } catch (e) {
      error = (e && e.message) || String(e);
    }
    try {
      demos = await this.env.CF_DEPLOY.listDemos();
    } catch (e) {
      error = error || (e && e.message) || String(e);
    }
    return { connected: true, account, demos, error };
  }

  // Deploy a single pasted HTML page as a private demo.
  async deployHtml(name, html) {
    const deploy = this.#requireDeploy();
    const bytes = new TextEncoder().encode(String(html ?? ""));
    if (bytes.length === 0) throw new Error("Nothing to deploy — the HTML is empty.");
    if (bytes.length > MAX_CONTENT_BYTES) {
      throw new Error(`HTML is too large (${Math.round(bytes.length / 1024)} KiB; max ~1.5 MiB).`);
    }
    const file = { path: "index.html", contentBase64: bytesToBase64(bytes), contentType: "text/html" };
    const demo = await deploy.deployStaticSite(String(name || "demo"), [file], {
      private: true,
    });
    return { demo, state: await this.getState() };
  }

  // Fetch a single static page by URL and deploy it as a private demo. Grabs only that page
  // (linked assets aren't followed — full sites/repos need the Phase 2 build service).
  async deployFromUrl(name, url) {
    const deploy = this.#requireDeploy();
    const parsed = assertPublicHttpUrl(url);
    let resp;
    try {
      resp = await fetch(parsed.toString(), { redirect: "follow" });
    } catch (e) {
      throw new Error(`Couldn't fetch ${parsed.hostname}: ${(e && e.message) || e}`);
    }
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status} from ${parsed.hostname}.`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error("The URL returned an empty body.");
    if (buf.length > MAX_CONTENT_BYTES) {
      throw new Error(`Page is too large (${Math.round(buf.length / 1024)} KiB; max ~1.5 MiB).`);
    }
    const contentType = (resp.headers.get("content-type") || "text/html").split(";")[0].trim();
    const file = { path: "index.html", contentBase64: bytesToBase64(buf), contentType };
    const fallbackName = parsed.hostname.replace(/^www\./, "");
    const demo = await deploy.deployStaticSite(String(name || fallbackName), [file], { private: true });
    return { demo, state: await this.getState() };
  }

  // Clone + build a GitHub repo in a container (via the gatekeeper's build service) and deploy its
  // static output as a private demo. The clone/build runs only after you approve the action.
  async deployFromRepo(name, repoUrl, ref) {
    const deploy = this.#requireDeploy();
    const url = String(repoUrl ?? "").trim();
    if (!url) throw new Error("A GitHub repo URL is required.");
    const options = ref && String(ref).trim() ? { ref: String(ref).trim() } : undefined;
    const demo = await deploy.deployFromRepo(String(name || ""), url, options);
    return { demo, state: await this.getState() };
  }

  async teardown(name) {
    const deploy = this.#requireDeploy();
    await deploy.teardownDemo(String(name));
    return await this.getState();
  }
}
