// Demo Builder client UI

const style = document.createElement("style");
style.textContent = `
  :root {
    color-scheme: light;
    --accent: #f38020;
    --accent-fg: #ffffff;
    --green-bg: #e6ffed; --green-fg: #22863a;
    --amber-bg: #fff2d9; --amber-fg: #b45309;
    --red-bg: #ffeef0; --red-fg: #b31d28;
    --border: #d0d7de; --bg: #f6f8fa; --muted: #57606a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: #1f2328; }
  #app { max-width: 860px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 1.4rem; margin: 0; }
  .subtitle { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
  .card { background: white; border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  label.fld { display: block; font-weight: 600; margin: 10px 0 4px; font-size: 0.9rem; }
  input[type=text], input[type=url], textarea { width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; font-family: inherit; }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; resize: vertical; }
  button { cursor: pointer; border: 1px solid var(--border); background: white; border-radius: 8px; padding: 9px 16px; font-size: 0.9rem; font-weight: 600; }
  button:hover:not(:disabled) { background: #fff4ea; }
  button:disabled { opacity: 0.55; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  button.primary:hover:not(:disabled) { background: #d96f16; }
  button.danger { color: var(--red-fg); border-color: #f3c2c7; }
  button.danger:hover:not(:disabled) { background: var(--red-bg); }
  .tabs { display: flex; gap: 6px; margin-bottom: 8px; }
  .tab { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: white; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .tab.active { background: var(--accent); color: white; border-color: var(--accent); }
  .tab.disabled { opacity: 0.5; cursor: default; }
  .hint { font-size: 0.82rem; color: var(--muted); margin-top: 4px; }
  .notice { padding: 10px 12px; border-radius: 8px; font-size: 0.88rem; margin-top: 10px; }
  .notice.ok { background: var(--green-bg); color: var(--green-fg); }
  .notice.err { background: var(--red-bg); color: var(--red-fg); }
  .demo { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
  .demo:first-child { border-top: none; }
  .demo-main { min-width: 0; }
  .demo-name { font-weight: 600; }
  .demo-url { font-size: 0.85rem; }
  .demo-url a { color: var(--accent); text-decoration: none; word-break: break-all; }
  .demo-url a:hover { text-decoration: underline; }
  .badge { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; border-radius: 999px; padding: 2px 10px; }
  .badge.pending { background: var(--amber-bg); color: var(--amber-fg); }
  .badge.live { background: var(--green-bg); color: var(--green-fg); }
  .badge.failed { background: var(--red-bg); color: var(--red-fg); }
  .demo-err { font-size: 0.82rem; color: var(--red-fg); word-break: break-word; margin-top: 2px; }
  .lock { font-size: 0.78rem; color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; font-size: 0.9rem; }
  .acct { font-size: 0.85rem; color: var(--muted); }
  .acct code { background: #f0f0f0; padding: 1px 6px; border-radius: 4px; }
  .spinner { display: inline-block; width: 0.9em; height: 0.9em; border: 2px solid rgba(0,0,0,0.2); border-top-color: #1f2328; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: -0.15em; margin-right: 6px; }
  button.primary .spinner { border-color: rgba(255,255,255,0.5); border-top-color: white; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 600px) { #app { padding: 10px; } }
`;
document.head.appendChild(style);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const app = el("div", { id: "app" });
document.body.appendChild(app);

let state = { connected: false, account: null, demos: [], error: null };
let sourceTab = "html"; // "html" | "url"
let notice = null; // { kind: "ok"|"err", text }
const busy = new Set();
// Preserve form field values across re-renders.
const form = { name: "", html: "", url: "", repoUrl: "", ref: "" };

async function refresh() {
  state = await gadget.getState();
  render();
}

async function withBusy(key, fn) {
  busy.add(key);
  render();
  try {
    await fn();
  } catch (err) {
    notice = { kind: "err", text: (err && err.message) || String(err) };
  } finally {
    busy.delete(key);
    await refresh();
  }
}

function renderHeader() {
  return el("div", {}, [
    el("h1", {}, "Demo Builder"),
    el("div", { class: "subtitle" }, "Deploy a private static-site copy on Cloudflare and get a private workers.dev URL."),
  ]);
}

function renderConnectPrompt() {
  return el("div", { class: "card" }, [
    el("div", { style: "font-weight:600;margin-bottom:6px;" }, "Connect a Cloudflare deploy target"),
    el("div", { class: "hint" }, "Open Connections, bind this gadget, and set CF_DEPLOY to your Cloudflare deploy gatekeeper. Then reload."),
  ]);
}

function renderAccount() {
  if (!state.account) return null;
  return el("div", { class: "card acct" }, [
    "Account ",
    el("code", {}, state.account.accountId),
    " · demos publish to ",
    el("code", {}, `*.${state.account.subdomain}.workers.dev`),
  ]);
}

function tab(id, label, disabled) {
  return el(
    "div",
    {
      class: `tab ${sourceTab === id ? "active" : ""} ${disabled ? "disabled" : ""}`,
      onclick: disabled ? undefined : () => { sourceTab = id; render(); },
    },
    label,
  );
}

function renderNewDemo() {
  const nameInput = el("input", { type: "text", placeholder: "demo name (e.g. acme-landing)", value: form.name });
  nameInput.addEventListener("input", () => { form.name = nameInput.value; });

  const tabs = el("div", { class: "tabs" }, [
    tab("html", "Paste HTML", false),
    tab("url", "From URL", false),
    tab("repo", "GitHub repo", false),
  ]);

  let sourceField;
  let onDeploy;
  const deploying = busy.has("deploy");

  if (sourceTab === "html") {
    const ta = el("textarea", { rows: "8", placeholder: "<!doctype html><html>…</html>" });
    ta.value = form.html;
    ta.addEventListener("input", () => { form.html = ta.value; });
    sourceField = el("div", {}, [el("label", { class: "fld" }, "HTML"), ta,
      el("div", { class: "hint" }, "Deployed as a single index.html. SPA routes fall back to it.")]);
    onDeploy = () => withBusy("deploy", async () => {
      // Read the fields live at click time so a background poll re-render can't drop them.
      const r = await gadget.deployHtml(nameInput.value, ta.value);
      form.name = ""; form.html = "";
      notice = { kind: "ok", text: `Queued "${r.demo.name}" for approval → ${r.demo.url}` };
    });
  } else if (sourceTab === "url") {
    const urlInput = el("input", { type: "url", placeholder: "https://example.com/page.html" });
    urlInput.value = form.url;
    urlInput.addEventListener("input", () => { form.url = urlInput.value; });
    sourceField = el("div", {}, [el("label", { class: "fld" }, "Static page URL"), urlInput,
      el("div", { class: "hint" }, "Fetches just that page (linked assets aren't followed — full sites/repos need the build service).")]);
    onDeploy = () => withBusy("deploy", async () => {
      const r = await gadget.deployFromUrl(nameInput.value, urlInput.value);
      form.name = ""; form.url = "";
      notice = { kind: "ok", text: `Queued "${r.demo.name}" for approval → ${r.demo.url}` };
    });
  } else {
    const repoInput = el("input", { type: "url", placeholder: "https://github.com/owner/repo" });
    repoInput.value = form.repoUrl;
    repoInput.addEventListener("input", () => { form.repoUrl = repoInput.value; });
    const refInput = el("input", { type: "text", placeholder: "branch or tag (optional)" });
    refInput.value = form.ref;
    refInput.addEventListener("input", () => { form.ref = refInput.value; });
    sourceField = el("div", {}, [
      el("label", { class: "fld" }, "GitHub repo URL"), repoInput,
      el("div", { class: "hint" }, "Cloned and built in a Cloudflare container on approval. Must produce static output — a build script (→ dist/build/out/public) or a root index.html. Building can take a few minutes."),
      el("label", { class: "fld" }, "Branch / tag"), refInput,
    ]);
    onDeploy = () => withBusy("deploy", async () => {
      const r = await gadget.deployFromRepo(nameInput.value, repoInput.value, refInput.value.trim() || undefined);
      form.name = ""; form.repoUrl = ""; form.ref = "";
      notice = { kind: "ok", text: `Queued "${r.demo.name}" for approval → ${r.demo.url}` };
    });
  }

  const deployBtn = el("button", {
    class: "primary",
    disabled: deploying,
    onclick: onDeploy,
  }, [deploying ? el("span", { class: "spinner" }) : null, deploying ? "Deploying…" : "Deploy private demo"]);

  const children = [
    el("div", { style: "font-weight:600;margin-bottom:8px;" }, "New demo"),
    el("label", { class: "fld" }, "Name"),
    nameInput,
    el("div", { style: "margin-top:12px;" }, tabs),
    sourceField,
    el("div", { class: "row", style: "margin-top:12px;" }, [deployBtn,
      el("span", { class: "hint" }, "🔒 Private — gated by Cloudflare Access to your email. Queued for your approval.")]),
  ];
  if (notice) children.push(el("div", { class: `notice ${notice.kind === "ok" ? "ok" : "err"}` }, notice.text));
  return el("div", { class: "card" }, children);
}

function renderDemos() {
  const demos = state.demos || [];
  const header = el("div", { class: "row", style: "justify-content:space-between;" }, [
    el("div", { style: "font-weight:600;" }, "Your demos"),
    el("span", { class: "subtitle" }, `${demos.length}`),
  ]);
  const card = el("div", { class: "card" }, [header]);
  if (demos.length === 0) {
    card.append(el("div", { class: "empty", style: "margin-top:8px;" }, "No demos yet. Deploy one above."));
    return card;
  }
  for (const d of demos) {
    const gone = busy.has(`td:${d.name}`);
    const failed = d.status === "failed";
    const row = el("div", { class: "demo" }, [
      el("div", { class: "demo-main" }, [
        el("div", { class: "demo-name" }, [d.name, " ", el("span", { class: "lock" }, d.private ? "🔒" : "🌐")]),
        failed
          ? el("div", { class: "demo-err" }, d.error || "Build failed.")
          : el("div", { class: "demo-url" }, [el("a", { href: d.url, target: "_blank", rel: "noopener" }, d.url)]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: `badge ${d.status}` }, d.status),
        el("button", {
          class: "danger",
          disabled: gone,
          onclick: () => withBusy(`td:${d.name}`, async () => {
            await gadget.teardown(d.name);
            notice = failed
              ? { kind: "ok", text: `Dismissed "${d.name}".` }
              : { kind: "ok", text: `Queued teardown of "${d.name}" for approval.` };
          }),
        }, [gone ? el("span", { class: "spinner" }) : null, failed ? "Dismiss" : "Tear down"]),
      ]),
    ]);
    card.append(row);
  }
  return card;
}

function render() {
  app.innerHTML = "";
  app.append(renderHeader());
  if (!state.connected) {
    app.append(renderConnectPrompt());
    return;
  }
  const acct = renderAccount();
  if (acct) app.append(acct);
  if (state.error) app.append(el("div", { class: "card notice err" }, state.error));
  app.append(renderNewDemo());
  app.append(renderDemos());
}

render();
await refresh();

setInterval(() => {
  // Don't wipe an in-progress edit: skip the poll while a form field is focused.
  const editing = document.activeElement && document.activeElement.closest
    && document.activeElement.closest("#app input, #app textarea");
  if (busy.size === 0 && !editing) refresh();
}, 8000);
