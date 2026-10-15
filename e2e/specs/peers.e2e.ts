// LAN pairing (docs/peers.md), end to end against the REAL peer listener.
//
// The second machine is a fake in this process: it speaks the peer protocol
// with node:crypto (HKDF-SHA256, ChaCha20-Poly1305) and @noble/curves for
// SPAKE2 over Ed25519, so every pairing here is also a cross-implementation
// check of peer_crypto.rs and the spake2 crate: the fake types the code the
// app's pairing mode shows (or shows one the app types), and the pairing
// only completes when both derived the same key from it.
//
// wdio.conf.ts sets TERMIC_PEER_LOOPBACK=1, so sharing binds 127.0.0.1 and
// skips mDNS: no Local Network or firewall prompt for a run that only talks
// to itself. Discovery is unit-tested in mdns.rs; this file covers the UI,
// the listener, pairing both ways, sealed calls, grants, rename and unpair.
//
// Order matters: a WRONG CODE cools the address down for 2 seconds, and every
// request here comes from 127.0.0.1, so that case runs after the last
// pairing the fake starts against the app.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { ed25519 } from "@noble/curves/ed25519";
import { dataDir } from "../../wdio.conf.js";
import {
  waitForText,
  cliBinary, clickPresent, requireTermicApi, setInputValue, snap, waitForAppShell, waitForAttr, waitVisible,
} from "../helpers.js";

const PREFIX = "/termic-peer/v1";

// ── the protocol, as the fake speaks it ─────────────────────────────

const sha256 = (...parts: Buffer[]) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const hkdf32 = (salt: Buffer, ikm: Buffer, info: string) =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info), 32));
const pairKey = (secret: Buffer, idA: string, idB: string) =>
  hkdf32(Buffer.from("termic-pair-v2"), secret, `termic-peer-v2|${idA}|${idB}`);

// SPAKE2 over Ed25519, as the spake2 crate (0.4) runs it: messages are a
// side byte ('A' 0x41 typed the code, 'B' 0x42 shows it) and a compressed
// point; the password scalar is HKDF(pw, "SPAKE2 pw") read big-endian; the
// key is SHA256 over H(pw), H(idA), H(idB), X, Y and K.
const Ed = ed25519.ExtendedPoint;
const L = ed25519.CURVE.n;
const M = Ed.fromHex("15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312");
const N = Ed.fromHex("f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3");
const toScalar = (b: Buffer) => BigInt(`0x${b.toString("hex")}`) % L;

function spake(side: "A" | "B", code: string, idA: string, idB: string) {
  const pw = Buffer.from(code);
  const w = toScalar(Buffer.from(crypto.hkdfSync("sha256", pw, Buffer.alloc(0), Buffer.from("SPAKE2 pw"), 48)));
  const x = toScalar(crypto.randomBytes(64)) || 1n;
  const mine = Buffer.from(Ed.BASE.multiply(x).add((side === "A" ? M : N).multiply(w)).toRawBytes());
  const msg = Buffer.concat([Buffer.from([side === "A" ? 0x41 : 0x42]), mine]);
  const finish = (theirs: Buffer) => {
    const t = theirs.subarray(1);
    const k = Ed.fromHex(t).add((side === "A" ? N : M).multiply(L - w)).multiply(x);
    const [X, Y] = side === "A" ? [mine, t] : [t, mine];
    return sha256(sha256(pw), sha256(Buffer.from(idA)), sha256(Buffer.from(idB)), X, Y, Buffer.from(k.toRawBytes()));
  };
  return { msg, finish };
}
const dirKey = (k: Buffer, sender: string, receiver: string) =>
  hkdf32(Buffer.from("termic-dir-v1"), k, `${sender}->${receiver}`);
const aad = (path: string, sender: string, receiver: string) =>
  Buffer.from(`termic-peer-v1|${path}|${sender}|${receiver}`);

interface Envelope { from: string; n: string; c: string }

function seal(k: Buffer, path: string, sender: string, receiver: string, msg: unknown): Envelope {
  const plain = Buffer.from(JSON.stringify(msg));
  const n = crypto.randomBytes(12);
  const c = crypto.createCipheriv("chacha20-poly1305", dirKey(k, sender, receiver), n, { authTagLength: 16 });
  c.setAAD(aad(path, sender, receiver), { plaintextLength: plain.length });
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { from: sender, n: n.toString("base64"), c: ct.toString("base64") };
}

function open(k: Buffer, path: string, receiver: string, env: Envelope): any {
  const buf = Buffer.from(env.c, "base64");
  const d = crypto.createDecipheriv("chacha20-poly1305", dirKey(k, env.from, receiver),
    Buffer.from(env.n, "base64"), { authTagLength: 16 });
  d.setAAD(aad(path, env.from, receiver), { plaintextLength: buf.length - 16 });
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
}

const sealed = (body: unknown, extra: Record<string, unknown> = {}) =>
  ({ ts: Date.now(), rid: crypto.randomBytes(16).toString("hex"), body, ...extra });

/** One HTTP exchange with the app's peer listener. */
function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } }, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on("error", reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The CLI, ASYNCHRONOUSLY. Not helpers' runCli: execFileSync blocks this
 *  process's event loop, and the machine a `--peer` call reaches is a fake
 *  server in this same process, so the call could never be answered. Same
 *  socket pinning as runCli (a release sidecar must not reach a real app). */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const sock = process.platform === "win32" ? {} : { TERMIC_SOCKET: path.join(dataDir, "termic.sock") };
  return new Promise(resolve => {
    execFile(cliBinary(), args, { env: { ...process.env, TERMIC_DATA_DIR: dataDir, ...sock, ...env }, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code ?? 1) : 0, stdout, stderr }));
  });
}

// ── the fake machine ────────────────────────────────────────────────

/** A paired fake: what it needs to call the app, and to be called. */
interface Fake { id: string; name: string; key?: Buffer; port: number }

function newFake(name: string): Fake {
  return { id: crypto.randomBytes(16).toString("hex"), name, port: 9 };
}

/** The fake types `code` against the app's pairing mode (an INCOMING pairing
 *  on the app's side). Returns what the app answered at each step, and the
 *  key when the app accepted the confirm. */
async function fakePairs(app: number, fake: Fake, code: string) {
  const hello = JSON.parse((await req(app, "GET", `${PREFIX}/hello`)).body);
  const a = spake("A", code, fake.id, hello.id);
  const start = await req(app, "POST", `${PREFIX}/pair/start`, {
    from: { id: fake.id, name: fake.name, version: "0.0.0-e2e", proto: hello.proto, pv: 2, port: fake.port },
    msg: a.msg.toString("base64"),
  });
  const base = { appId: hello.id as string, proto: hello.proto as number, start: start.status };
  if (start.status !== 200) return { ...base, confirm: 0, error: start.body, key: undefined as Buffer | undefined, grant: undefined as string | undefined };
  const s = JSON.parse(start.body);
  expect(s.to.id).toBe(hello.id);
  const key = pairKey(a.finish(Buffer.from(s.msg, "base64")), fake.id, hello.id);
  const path = `${PREFIX}/pair/confirm`;
  const msg = sealed({ grant: "drive" });
  const r = await req(app, "POST", path, { pairing: s.pairing, env: seal(key, path, fake.id, hello.id, msg) });
  if (r.status !== 200) return { ...base, confirm: r.status, error: r.body, key: undefined, grant: undefined };
  // The app's answer opens under the fake's key: one key from one code.
  const answer = open(key, path, fake.id, JSON.parse(r.body));
  expect(answer.rid).toBe(msg.rid);
  return { ...base, confirm: 200, error: "", key, grant: answer.body.grant as string };
}

/** A sealed call from the fake, as `termic --peer` on its side would send it. */
async function fakeCalls(app: number, fake: Fake, appId: string, proto: number, cmd: Record<string, unknown>) {
  const path = `${PREFIX}/call`;
  const msg = sealed({ proto, request: { id: "e2e", ...cmd } }, { port: fake.port });
  const r = await req(app, "POST", path, seal(fake.key!, path, fake.id, appId, msg));
  if (r.status !== 200) return { status: r.status, reply: null as any };
  return { status: 200, reply: open(fake.key!, path, fake.id, JSON.parse(r.body)).body.reply };
}

// ── the app ─────────────────────────────────────────────────────────

const status = () => browser.execute(() => window.__termic!.invoke("peer_status")) as Promise<any>;

const setSharing = (on: boolean) =>
  browser.execute(async (v) => {
    const t = window.__termic!;
    const s = await t.ipc.settingsLoad();
    await t.ipc.settingsSave({ ...s, lan_sharing_enabled: v });
  }, on);

/** The after-pairing dialog, from one side. */
const dialog = (direction: string) => `[data-testid="peer-pair-dialog"][data-direction="${direction}"]`;

async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeout = 15_000): Promise<T> {
  let last: T | undefined;
  await browser.waitUntil(async () => ok((last = await read())), {
    timeout,
    timeoutMsg: `${what} (last: ${JSON.stringify(last)})`,
  });
  return last as T;
}

/** Set a native <select> the way React sees a user pick. */
const pick = (selector: string, value: string) =>
  browser.execute((sel, v) => {
    const el = document.querySelector(sel) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);

describe("LAN pairing", () => {
  let appPort = 0;
  const incoming = newFake("Fake laptop");

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  after(async () => {
    // Leave the profile as it was: no pairs, the default name, sharing off.
    const s = await status().catch(() => null);
    for (const p of s?.peers ?? []) {
      await browser.execute((id) => window.__termic!.invoke("peer_unpair", { peer: id }), p.id).catch(() => {});
    }
    await browser.execute(() => window.__termic!.invoke("peer_set_name", { name: "" })).catch(() => {});
    await setSharing(false).catch(() => {});
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings()).catch(() => {});
  });

  it("opens Other computers with sharing off and nothing listening", async () => {
    await setSharing(false);
    // MCP off too, so the next case can show sharing turns it on.
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, mcp_enabled: false });
    });
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("peers" as any));
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "false");
    const s = await status();
    expect(s.enabled).toBe(false);
    expect(s.port).toBeNull();
    // It opens Agent access on its MCP tab, pairing first, no CLI.
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="access-tab-mcp"]')?.getAttribute("aria-selected"))).toBe("true");
    expect(await browser.execute(() => document.body.innerText.includes("Enable CLI"))).toBe(false);
    // Off is off, and short: with nothing paired the section stops at its
    // toggle, so it does not push MCP down the page.
    for (const gone of ["peers-address-input", "peers-self-name", "peers-paired-empty"]) {
      expect(await browser.execute((id) => !!document.querySelector(`[data-testid="${id}"]`), gone)).toBe(false);
    }
    expect(await browser.execute(() => {
      const r = document.querySelector('[data-testid="settings-peers"]')!.getBoundingClientRect();
      return r.height;
    })).toBeLessThan(200);
    await snap("peers-off.png");
  });

  it("turns sharing on from the toggle and answers hello on its port", async () => {
    await clickPresent('[data-testid="peers-toggle"] [role="switch"]');
    await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "true");
    // Sharing turns MCP on with it: agents reach a paired computer through
    // this Termic's MCP tools. Saved, bound, and drawn on, not just stored.
    expect(await browser.execute(async () => (await window.__termic!.ipc.settingsLoad()).mcp_enabled)).toBe(true);
    await waitFor("MCP binds",
      async (): Promise<{ url: string | null }> => browser.execute(() => window.__termic!.invoke("mcp_status")) as never,
      v => !!v.url);
    await waitForText("Connect an agent");
    const s = await waitFor("the listener binds", status, v => v.port !== null);
    appPort = s.port;
    expect(s.addresses).toEqual([`127.0.0.1:${appPort}`]);
    const hello = await req(appPort, "GET", `${PREFIX}/hello`);
    expect(hello.status).toBe(200);
    const who = JSON.parse(hello.body);
    expect(Object.keys(who).sort()).toEqual(["id", "name", "port", "proto", "pv", "version"]);
    expect(who.id).toBe(s.self_id);
    // The page shows where it can be reached, with the port once.
    await browser.waitUntil(async () =>
      (await browser.execute(() => document.querySelector('[data-testid="peers-self-address"]')?.textContent ?? ""))
        .includes(`127.0.0.1:${appPort}`) , { timeoutMsg: "the address line never showed the bound address" });
    expect(await browser.execute(() => document.querySelector('[data-testid="peers-self-address"]')!.textContent))
      .not.toContain(`:${appPort}:`);
    await waitForAttr('[data-testid="peers-paired-empty"]', "data-testid", "peers-paired-empty");
    // The two halves of pairing, side by side.
    await waitForAttr('[data-testid="peers-card-show"]', "data-testid", "peers-card-show");
    await waitForAttr('[data-testid="peers-card-enter"]', "data-testid", "peers-card-enter");
    await browser.execute(() => document.querySelector('[data-testid="peers-card-show"]')!.scrollIntoView({ block: "center" }));
    await snap("peers-on.png");
  });

  it("renames this machine, and the new name is what others see", async () => {
    await setInputValue('[data-testid="peers-self-name"]', "E2E Studio");
    await browser.keys("Enter");
    await waitFor("the name is saved", status, v => v.self_name === "E2E Studio");
    expect(JSON.parse((await req(appPort, "GET", `${PREFIX}/hello`)).body).name).toBe("E2E Studio");
  });

  it("refuses a pairing request from a web page", async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const q = http.request({
        host: "127.0.0.1", port: appPort, path: `${PREFIX}/pair/start`, method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example.io" },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      q.on("error", reject);
      q.end("{}");
    });
    expect(r).toBe(403);
    expect((await status()).pair_mode).toBeNull();
  });

  let appId = "";
  let proto = 0;

  it("pairs with nobody while it is not in pairing mode", async () => {
    const p = await fakePairs(appPort, newFake("Stranger"), "1234");
    expect([p.start, JSON.parse(p.error).error]).toEqual([403, "not_pairing"]);
    expect((await status()).peers).toEqual([]);
    // Nothing on this screen either: no dialog for a request nobody invited.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="peer-pair-dialog"]'))).toBe(false);
  });

  it("shows a code in pairing mode, and pairs when the other machine types it", async () => {
    await clickPresent('[data-testid="peers-pair-open"]');
    await waitVisible('[data-testid="peers-pair-mode"]');
    const code = await browser.execute(() => document.querySelector('[data-testid="peers-pair-mode"]')!.getAttribute("data-code")!);
    expect(code).toMatch(/^\d{4}$/);
    expect(await browser.execute(() => document.querySelector('[data-testid="peers-pair-code"]')!.textContent)).toBe(code);
    expect((await status()).pair_mode.code).toBe(code);
    await snap("peers-pair-mode.png");

    const p = await fakePairs(appPort, incoming, code);
    expect([p.start, p.confirm]).toEqual([200, 200]);
    expect(p.grant).toBe("drive");
    appId = p.appId;
    proto = p.proto;
    incoming.key = p.key;
    // The code is spent: pairing mode closed on success.
    await waitFor("pairing mode closed", status, v => v.pair_mode === null);

    // The after-pairing dialog: who, what pairing means, what it is for.
    await waitVisible(dialog("incoming"));
    await waitVisible('[data-testid="peer-pair-together"]');
    await clickPresent('[data-testid="peer-pair-roles"] [data-role="worker"]');
    const note = await browser.execute(() => (document.querySelector('[data-testid="peer-pair-note"]') as HTMLInputElement).value);
    expect(note).toMatch(/^Worker: /);
    await snap("peers-paired-dialog.png");
    await clickPresent('[data-testid="peer-pair-done"]');
    await waitFor("the role is the note", status, v => v.peers.some((x: any) => x.id === incoming.id && x.note === note));

    const row = `[data-testid="peer-row-${incoming.id}"]`;
    await waitForAttr(row, "data-grant", "drive");
    await waitForAttr(`[data-testid="peer-their-grant-${incoming.id}"]`, "data-their-grant", "drive");
    await snap("peers-paired-list.png");
  });

  it("refuses a wrong code, counts it, and pairs nobody", async () => {
    await clickPresent('[data-testid="peers-pair-open"]');
    const code = await waitFor("the code is up", status, v => !!v.pair_mode).then(v => v.pair_mode.code as string);
    const wrong = code === "0000" ? "0001" : "0000";
    const p = await fakePairs(appPort, newFake("Guesser"), wrong);
    expect([p.start, p.confirm, JSON.parse(p.error).error]).toEqual([200, 403, "wrong_code"]);
    expect((await status()).peers.map((x: any) => x.id)).toEqual([incoming.id]);
    await waitForText("Wrong codes typed: 1 of 3");
    // Stop pairing closes it, and the code is dead.
    await clickPresent('[data-testid="peers-pair-stop"]');
    await waitFor("pairing mode closed", status, v => v.pair_mode === null);
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="peers-pair-mode"]')),
      { timeoutMsg: "the code panel stayed up" });
    // The 2 s cooldown a wrong code starts applies to pairing starts only,
    // and nothing after this case starts one against the app.
  });

  it("runs a sealed call from a Drive peer and refuses it once the grant is Reply only", async () => {
    const list = await fakeCalls(appPort, incoming, appId, proto, { cmd: "list" });
    expect(list.status).toBe(200);
    expect(list.reply.ok).toBe(true);
    expect(list.reply.data.kind).toBe("list");
    // The real dispatch answered (the profile may have no live tasks now).
    expect(Array.isArray(list.reply.data.tasks)).toBe(true);

    // Even Drive cannot quit the app.
    const quit = await fakeCalls(appPort, incoming, appId, proto, { cmd: "quit", commit: true });
    expect(quit.reply.error.code).toBe("auth");

    await pick(`[data-testid="peer-grant-${incoming.id}"]`, "reply");
    await waitForAttr(`[data-testid="peer-row-${incoming.id}"]`, "data-grant", "reply");
    const refused = await fakeCalls(appPort, incoming, appId, proto, { cmd: "list" });
    expect(refused.reply.ok).toBe(false);
    expect(refused.reply.error.code).toBe("auth");
    expect(refused.reply.error.message).toContain("reply");
  });

  it("refuses a replayed call and a caller that is not paired, identically", async () => {
    const path = `${PREFIX}/call`;
    const env = seal(incoming.key!, path, incoming.id, appId, sealed({ proto, request: { id: "x", cmd: "agents" } }));
    expect((await req(appPort, "POST", path, env)).status).toBe(200);
    const again = await req(appPort, "POST", path, env);
    expect([again.status, again.body]).toEqual([401, ""]);
    const stranger = newFake("Stranger");
    const forged = seal(crypto.randomBytes(32), path, stranger.id, appId, sealed({}));
    const r = await req(appPort, "POST", path, forged);
    expect([r.status, r.body]).toEqual([401, ""]);
  });

  it("renames a paired machine locally", async () => {
    const input = `[data-testid="peer-rename-${incoming.id}"]`;
    await setInputValue(input, "Build laptop");
    await browser.keys("Enter");
    const s = await waitFor("the alias is saved", status, v => v.peers.some((p: any) => p.name === "Build laptop"));
    const p = s.peers.find((x: any) => x.id === incoming.id);
    expect(p.advertised_name).toBe("Fake laptop");
    expect(p.alias).toBe("Build laptop");
  });

  it("keeps a note of what a paired machine is for, and the CLI's peer list carries it", async () => {
    const input = `[data-testid="peer-note-${incoming.id}"]`;
    await setInputValue(input, "  Windows builds and   installer tests ");
    await browser.keys("Enter");
    // Saved as one tidy line.
    await waitFor("the note is saved", status,
      v => v.peers.some((p: any) => p.id === incoming.id && p.note === "Windows builds and installer tests"));
    await snap("peers-note.png");
    // What an agent reads: `termic peer list` names it, so a prompt need not.
    const out = await cli(["--no-launch", "--json", "peer", "list"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const listed = JSON.parse(out.stdout).peers.find((p: any) => p.id === incoming.id);
    expect(listed.note).toBe("Windows builds and installer tests");
    // Cleared, it is gone from the list rather than an empty string.
    await setInputValue(input, "");
    await browser.keys("Enter");
    await waitFor("the note is cleared", status, v => v.peers.some((p: any) => p.id === incoming.id && p.note === ""));
    const again = JSON.parse((await cli(["--no-launch", "--json", "peer", "list"])).stdout).peers.find((p: any) => p.id === incoming.id);
    expect(again.note).toBeUndefined();
  });

  it("unpairs from Settings after a confirmation, and the old key stops working", async () => {
    await clickPresent(`[data-testid="peer-unpair-${incoming.id}"]`);
    await clickPresent('[data-testid="confirm-ok"]');
    await waitFor("the pair is gone", status, v => !v.peers.some((p: any) => p.id === incoming.id));
    await browser.waitUntil(
      () => browser.execute((id) => !document.querySelector(`[data-testid="peer-row-${id}"]`), incoming.id),
      { timeoutMsg: "the unpaired row is still drawn" },
    );
    const r = await fakeCalls(appPort, incoming, appId, proto, { cmd: "list" });
    expect(r.status).toBe(401);
  });

  describe("pairing out, to a machine that answers", () => {
    const remote = newFake("Fake desktop");
    let server: http.Server;
    const remoteCode = "4821";
    const calls: any[] = [];
    let unpaired = false;

    before(async () => {
      // The fake as a SERVER: hello, the three pairing steps (it accepts with
      // Drive), and the two sealed endpoints. Its state is one pairing.
      let pending: { appId: string; key: Buffer } | null = null;
      server = http.createServer((q, res) => {
        let raw = "";
        q.on("data", d => (raw += d));
        q.on("end", () => {
          const send = (status: number, body: unknown = "") => {
            const out = typeof body === "string" ? body : JSON.stringify(body);
            res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
            res.end(out);
          };
          const who = { id: remote.id, name: remote.name, version: "0.0.0-e2e", proto, pv: 2, port: remote.port };
          const body = raw ? JSON.parse(raw) : {};
          switch (q.url) {
            case `${PREFIX}/hello`: return send(200, who);
            case `${PREFIX}/pair/start`: {
              // The fake is in pairing mode, showing `remoteCode`.
              const b = spake("B", remoteCode, body.from.id, remote.id);
              const secret = b.finish(Buffer.from(body.msg, "base64"));
              pending = { appId: body.from.id, key: pairKey(secret, body.from.id, remote.id) };
              return send(200, { to: who, pairing: "e2epairing0001", msg: b.msg.toString("base64") });
            }
            case `${PREFIX}/pair/confirm`: {
              const p = pending!;
              const path = `${PREFIX}/pair/confirm`;
              let msg: any;
              try { msg = open(p.key, path, remote.id, body.env); } catch { return send(403, { error: "wrong_code" }); }
              remote.key = p.key;
              return send(200, seal(p.key, path, remote.id, p.appId, { ...sealed({ grant: "drive" }), rid: msg.rid }));
            }
            case `${PREFIX}/call`: {
              const path = `${PREFIX}/call`;
              const msg = open(remote.key!, path, remote.id, body);
              calls.push(msg.body.request);
              const reply = { id: msg.body.request.id, ok: true, data: { kind: "list", tasks: [] } };
              return send(200, seal(remote.key!, path, remote.id, pending!.appId, { ...sealed({ reply }, { grant: "drive" }), rid: msg.rid }));
            }
            case `${PREFIX}/unpair`: {
              const path = `${PREFIX}/unpair`;
              const msg = open(remote.key!, path, remote.id, body);
              unpaired = true;
              return send(200, seal(remote.key!, path, remote.id, pending!.appId, { ...sealed({}), rid: msg.rid }));
            }
            default: return send(404);
          }
        });
      });
      await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
      remote.port = (server.address() as AddressInfo).port;
    });

    after(() => { server?.close(); });

    it("pairs by address with the code the other machine shows, and refuses a wrong one", async () => {
      // Folded behind a link: discovery is the normal way in.
      if (!await browser.execute(() => !!document.querySelector('[data-testid="peers-address-input"]'))) {
        await clickPresent('[data-testid="peers-address-toggle"]');
      }
      await setInputValue('[data-testid="peers-address-input"]', `127.0.0.1:${remote.port}`);
      await setInputValue('[data-testid="peers-address-code"]', "1111");
      await snap("peers-address-open.png");
      await clickPresent('[data-testid="peers-address-pair"]');
      await waitForText(`That is not the code ${remote.name} shows`);
      expect((await status()).peers.some((x: any) => x.id === remote.id)).toBe(false);

      await setInputValue('[data-testid="peers-address-code"]', remoteCode);
      await clickPresent('[data-testid="peers-address-pair"]');
      await waitVisible(dialog("outgoing"));
      await snap("peers-outgoing-dialog.png");
      await clickPresent('[data-testid="peer-pair-skip"]');
      await waitForAttr(`[data-testid="peer-their-grant-${remote.id}"]`, "data-their-grant", "drive");
      // Paired computers work together: the app lets it drive here too.
      await waitForAttr(`[data-testid="peer-row-${remote.id}"]`, "data-grant", "drive");
    });

    it("forwards `termic --peer` to it, without this machine's paths", async () => {
      const out = await cli(["--no-launch", "--json", "--peer", "Fake desktop", "list"], {
        TERMIC_TASK_ID: "e2e-caller-task",
      });
      expect([out.code, out.stderr]).toEqual([0, ""]);
      expect(JSON.parse(out.stdout)).toEqual({ tasks: [] });
      expect(calls.length).toBe(1);
      expect(calls[0].cmd).toBe("list");
      // Neither the caller's cwd nor its task id are the other machine's
      // business; the task id stays on THIS side as a reply contact.
      expect(calls[0].cwd).toBeUndefined();
      expect(JSON.stringify(calls[0])).not.toContain("e2e-caller-task");
    });

    it("names an unknown machine instead of guessing", async () => {
      const out = await cli(["--no-launch", "--peer", "nobody-by-that-name", "list"]);
      expect(out.code).toBe(1);
      const message = out.stderr;
      expect(message).toContain("no paired machine called nobody-by-that-name");
      expect(message).toContain("Fake desktop");
    });

    it("exits 12 when the paired machine does not answer", async () => {
      server.close();
      await new Promise(r => server.once("close", r)).catch(() => {});
      const out = await cli(["--no-launch", "--peer", "Fake desktop", "list"]);
      expect(out.code).toBe(12);
      expect(out.stderr).toContain("Could not reach Fake desktop");
      // Back up for the unpair notice, on the same port.
      await new Promise<void>(r => server.listen(remote.port, "127.0.0.1", () => r()));
    });

    it("tells the other machine when it is unpaired", async () => {
      await clickPresent(`[data-testid="peer-unpair-${remote.id}"]`);
      await clickPresent('[data-testid="confirm-ok"]');
      await waitFor("the pair is gone", status, v => !v.peers.some((p: any) => p.id === remote.id));
      await browser.waitUntil(async () => unpaired, { timeoutMsg: "the fake never received the unpair notice" });
    });
  });

  // Last, in its own block: mocha runs nested describes AFTER the outer its.
  describe("switching off", () => {
    it("stops listening when sharing is turned off", async () => {
      await clickPresent('[data-testid="peers-toggle"] [role="switch"]');
      await waitForAttr('[data-testid="peers-toggle"]', "data-enabled", "false");
      await waitFor("the listener is gone", status, v => v.port === null);
      const err = await req(appPort, "GET", `${PREFIX}/hello`).then(r => `status ${r.status}`, e => String(e));
      expect(err).toMatch(/ECONNREFUSED|status 403/);
    });
  });
});
