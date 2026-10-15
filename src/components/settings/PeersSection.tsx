// Other computers, in Settings > Agent access (LAN pairing, docs/peers.md). Off by default and badged
// Experimental: turning it on runs a second listener on the network and
// advertises this Termic over mDNS, so another Termic can ask to pair.
//
// Everything on this page is read from `peer_status` and re-read on the
// backend's `peer://changed` event, never polled. Bursts of that event
// (discovery answers arrive in clumps) are coalesced: one fetch in flight,
// and a dirty flag that buys exactly one more when it lands.
//
// Pairing: one computer opens pairing mode (a code on its screen, here), the
// other types that code on the Nearby row (or by address). The dialog after
// a pairing is global (PeerPairingDialog), because the machine that showed
// the code may be anywhere when the other side types it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  PEER_CHANGED_EVENT, openPath, peerPair, peerPairRequest, peerRefresh, peerRename, peerSetGrant, peerSetName, peerSetNote, peerStatus, peerUnpair,
} from "@/lib/ipc";
import type { NearbyView, PeerGrant, PeerStatus, PeerView } from "@/lib/types";
import { PeerRoleChips } from "./PeerRoles";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/Tooltip";
import { Info, RefreshCw } from "lucide-react";

/** peer_status, kept fresh by the backend's change event while mounted. */
function usePeerStatus(): [PeerStatus | null, () => void] {
  const [status, setStatus] = useState<PeerStatus | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const live = useRef(true);

  const refresh = useCallback(() => {
    if (inFlight.current) { dirty.current = true; return; }
    inFlight.current = true;
    peerStatus()
      .then(s => { if (live.current) setStatus(s); })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        if (dirty.current && live.current) { dirty.current = false; refresh(); }
      });
  }, []);

  useEffect(() => {
    live.current = true;
    refresh();
    let un: (() => void) | undefined;
    let gone = false;
    void listen(PEER_CHANGED_EVENT, () => refresh())
      .then(f => { if (gone) f(); else un = f; })
      .catch(() => {});
    return () => { live.current = false; gone = true; un?.(); };
  }, [refresh]);

  return [status, refresh];
}

/** "Last seen 5 minutes ago", in the UI language, with no locale keys of its
 *  own: Intl already knows how to say it in both. */
function useRelative() {
  const { i18n } = useTranslation();
  return useCallback((ms: number) => {
    const fmt = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
    const s = Math.round((ms - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (abs < 60) return fmt.format(s, "second");
    if (abs < 3600) return fmt.format(Math.round(s / 60), "minute");
    if (abs < 86400) return fmt.format(Math.round(s / 3600), "hour");
    return fmt.format(Math.round(s / 86400), "day");
  }, [i18n.language]);
}

const selectClass =
  "h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]";

const linkClass =
  "text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)]";

export function PeersSection({ onSharingOn }: { onSharingOn?: () => void } = {}) {
  const { t } = useTranslation("settings");
  const { settings, patch } = useBackendSettings();
  const [status, refresh] = usePeerStatus();
  // Seeded false for the pre-settingsLoad frame: a wrong "on" flash is the
  // worse one for a switch that exposes the machine.
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [addressOpen, setAddressOpen] = useState(false);
  /** The name of the machine at the typed address once it was asked. */
  const [addressAsked, setAddressAsked] = useState<string | null>(null);
  const [addressCode, setAddressCode] = useState("");
  const [pairing, setPairing] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setEnabled(settings.lan_sharing_enabled === true);
  }, [settings]);

  const selfName = status?.self_name ?? "";
  const defaultName = status?.default_name ?? "";
  useEffect(() => {
    // Show the field empty while the name is the default one, so the
    // placeholder carries it and clearing the field means "back to default".
    setName(selfName && selfName !== defaultName ? selfName : "");
  }, [selfName, defaultName]);

  async function saveEnabled(v: boolean) {
    if (!settings) return;
    setEnabled(v);
    // Sharing turns MCP on with it: a paired computer is reached by an
    // agent through this Termic's MCP tools (peer, peer_call), so pairing
    // with MCP off would pair two machines no agent can use. Turning
    // sharing off leaves MCP alone.
    const turnOnMcp = v && settings.mcp_enabled !== true;
    if (!(await patch(turnOnMcp ? { lan_sharing_enabled: v, mcp_enabled: true } : { lan_sharing_enabled: v }))) {
      setEnabled(!v);
      return;
    }
    // settings_save binds or unbinds before it resolves.
    refresh();
    if (v) onSharingOn?.();
  }

  async function saveName() {
    const next = name.trim();
    const current = selfName === defaultName ? "" : selfName;
    if (next === current) return;
    try {
      await peerSetName(next);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    refresh();
  }

  async function pair(target: string, code: string): Promise<boolean> {
    if (pairing) return false;
    setPairing(target);
    try {
      // On success both machines raise the "what is it for" dialog
      // (peer://pairing); the list refreshes from peer://changed.
      await peerPair(target, code);
      return true;
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      return false;
    } finally {
      setPairing(null);
    }
  }

  // Click Pair: the other machine shows a code (`/pair/request`), and the
  // name it answers with is who the code box asks about.
  async function request(target: string): Promise<string | null> {
    try {
      return await peerPairRequest(target);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      return null;
    }
  }

  async function requestByAddress() {
    const a = address.trim();
    if (!a || pairing) return;
    setPairing(a);
    const name = await request(a);
    setPairing(null);
    if (name) setAddressAsked(name);
  }

  async function pairByAddress() {
    const a = address.trim();
    if (!a || addressCode.length !== 4) return;
    if (await pair(a, addressCode)) { setAddress(""); setAddressCode(""); setAddressAsked(null); setAddressOpen(false); }
    else setAddressCode("");
  }

  const peers = status?.peers ?? [];
  // Machines ready to pair first: that is who the person came here for.
  const nearby = [...(status?.nearby ?? [])].sort((x, y) => Number(y.pairing) - Number(x.pairing));
  // Each address already carries its port ("192.168.1.10:23620").
  const where = status && status.addresses.length > 0 ? status.addresses.join(", ") : null;

  // Layout rule for this page: one short line per thing, the long story in a
  // tooltip. The first version stacked a paragraph under every heading and
  // read as a wall of text; what a person needs here is "is it on, who is
  // nearby, pair".
  return (
    <div className="flex flex-col gap-7" data-testid="peers-section">
      <SectionTitle title={t("peers.title")} badge={t("shared.experimental")} />

      <Block first>
        <div data-testid="peers-toggle" data-enabled={enabled ? "true" : "false"}>
          <Toggle
            label={t("peers.enable.label")}
            hint={enabled ? t("peers.enable.hint") : t("peers.enable.hintOff")}
            value={enabled}
            onChange={saveEnabled}
          />
        </div>
      </Block>

      {enabled && (
        <Block>
          {/* The one failure that looked like an empty network: the OS
              refusing every discovery send. Said plainly, with the way out. */}
          {status?.network_blocked && (
            <div data-testid="peers-network-blocked" className="mb-4 flex items-center justify-between gap-4 rounded-md border border-[var(--color-warn,var(--color-border))] px-3 py-2 text-[12.5px]">
              <span>{t(status.platform === "macos" ? "peers.blocked.macos" : "peers.blocked.other")}</span>
              {status.platform === "macos" && (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="peers-network-blocked-open"
                  onClick={() => { void openPath("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork").catch(() => {}); }}
                >
                  {t("peers.blocked.open")}
                </Button>
              )}
            </div>
          )}

          {/* Pairing, like Bluetooth: click Pair on a computer, it shows a
              code on its own screen (PeerCodeDialog there), type it here.
              Nobody has to open anything on the other side first. */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-medium">{t("peers.pair.title")}</div>
              <p className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("peers.pair.how")}</p>
            </div>
            <Tip content={t("peers.nearby.refresh")} side="top">
              <button
                type="button"
                aria-label={t("peers.nearby.refresh")}
                data-testid="peers-refresh"
                onClick={() => { void peerRefresh().catch(() => {}); }}
                className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>

          {nearby.length === 0 ? (
            <p data-testid="peers-nearby-empty" className="mt-3 flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-faint)]">
              {t("peers.nearby.empty")}
              <Tip content={<span className="block max-w-[340px] whitespace-normal">{t("peers.nearby.emptyTip")}</span>} side="top">
                <Info className="h-3.5 w-3.5 hover:text-[var(--color-fg-dim)]" />
              </Tip>
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {nearby.map(n => (
                <NearbyRow
                  key={n.id}
                  n={n}
                  busy={pairing === n.id}
                  disabled={pairing !== null && pairing !== n.id}
                  onRequest={() => request(n.id)}
                  onPair={code => pair(n.id, code)}
                />
              ))}
            </div>
          )}

          {/* By address: folded, since discovery is the normal way in. The
              same two steps: ask, then type the code it shows. */}
          <div className="mt-3">
            {!addressOpen ? (
              <button
                type="button"
                data-testid="peers-address-toggle"
                onClick={() => setAddressOpen(true)}
                className={linkClass}
              >
                {t("peers.address.title")}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  data-testid="peers-address-input"
                  aria-label={t("peers.address.label")}
                  value={address}
                  placeholder="192.168.1.20"
                  autoFocus
                  disabled={addressAsked !== null}
                  onChange={e => setAddress(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") void requestByAddress(); }}
                  className="w-48 font-mono"
                />
                {addressAsked === null ? (
                  <Button
                    variant="secondary"
                    size="md"
                    data-testid="peers-address-request"
                    disabled={pairing !== null || address.trim() === ""}
                    onClick={() => void requestByAddress()}
                  >
                    {t("peers.nearby.pair")}
                  </Button>
                ) : (
                  <>
                    <span className="text-[12px] text-[var(--color-fg-dim)]">{t("peers.nearby.codeFor", { name: addressAsked })}</span>
                    <Input
                      data-testid="peers-address-code"
                      aria-label={t("peers.address.code")}
                      value={addressCode}
                      placeholder={t("peers.nearby.codePlaceholder")}
                      inputMode="numeric"
                      maxLength={4}
                      autoFocus
                      disabled={pairing !== null}
                      onChange={e => {
                        const c = e.target.value.replace(/\D/g, "");
                        setAddressCode(c);
                        if (c.length === 4) void (async () => {
                          const a = address.trim();
                          if (await pair(a, c)) { setAddress(""); setAddressAsked(null); setAddressOpen(false); }
                          setAddressCode("");
                        })();
                      }}
                      onKeyDown={e => { if (e.key === "Enter") void pairByAddress(); }}
                      className="w-28 text-center font-mono tracking-[0.2em] placeholder:tracking-normal"
                    />
                    <button type="button" className={linkClass} onClick={() => { setAddressAsked(null); setAddressCode(""); }}>
                      {t("peers.nearby.cancel")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </Block>
      )}

      {/* Off with no pairs, the section stops at the toggle. Pairs stay
          listed while off, so one can still be unpaired. */}
      {(enabled || peers.length > 0) && <Block>
        <div className="text-[14px] font-medium">{t("peers.paired.title")}</div>
        {peers.length === 0 ? (
          <p data-testid="peers-paired-empty" className="mt-1 text-[12.5px] text-[var(--color-fg-faint)]">
            {t("peers.paired.empty")}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {peers.map(p => <PeerRow key={p.id} peer={p} onChanged={refresh} />)}
          </div>
        )}
      </Block>}

      {enabled && <Block>
        <div className="flex items-center gap-1.5 text-[14px] font-medium">
          {t("peers.self.title")}
          <Tip content={<span className="block max-w-[340px] whitespace-normal">{t("peers.self.hint")}</span>} side="top">
            <Info className="h-3.5 w-3.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]" />
          </Tip>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Input
            data-testid="peers-self-name"
            aria-label={t("peers.self.nameLabel")}
            value={name}
            placeholder={defaultName}
            maxLength={63}
            onChange={e => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={e => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(selfName && selfName !== defaultName ? selfName : "");
              }
            }}
            className="w-72"
          />
          <span data-testid="peers-self-address" className="font-mono text-[12px] text-[var(--color-fg-faint)]">
            {where ?? t("peers.self.noAddress")}
          </span>
        </div>
        {status?.bind_error && (
          <p data-testid="peers-bind-error" className="mt-2 text-[12px] text-[var(--color-warn,inherit)]">
            {status.bind_error}
          </p>
        )}
        {status?.discovery_error && (
          <p data-testid="peers-discovery-error" className="mt-2 text-[12px] text-[var(--color-warn,inherit)]">
            {t("peers.self.discoveryError", { error: status.discovery_error })}
          </p>
        )}
        {status?.platform === "windows" && (
          <p data-testid="peers-windows-hint" className="mt-2 text-[12px] text-[var(--color-fg-faint)]">
            {t("peers.self.windowsHint")}
          </p>
        )}
      </Block>}
    </div>
  );
}

/** One machine in sight. Pair asks for the code its screen shows, right
 *  here on the row, and submits once four digits are in. */
function NearbyRow({ n, busy, disabled, onRequest, onPair }: {
  n: NearbyView; busy: boolean; disabled: boolean;
  onRequest: () => Promise<string | null>;
  onPair: (code: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("settings");
  // idle: a Pair button. asked: the other screen shows a code; type it.
  const [asked, setAsked] = useState(false);
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState("");

  async function ask() {
    setAsking(true);
    const name = await onRequest();
    setAsking(false);
    if (name) setAsked(true);
  }

  async function submit(c: string) {
    if (c.length !== 4) return;
    if (await onPair(c)) setAsked(false);
    setCode("");
  }

  return (
    <div
      data-testid={`nearby-row-${n.id}`}
      data-proto-ok={n.proto_ok ? "true" : "false"}
      data-asked={asked ? "true" : "false"}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2",
        asked ? "border-[var(--color-accent)]" : "border-[var(--color-border-soft)]",
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium">{n.name}</div>
        <div className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
          {asked
            ? <span className="text-[var(--color-accent)]">{t("peers.nearby.codeFor", { name: n.name })}</span>
            : !n.proto_ok ? t("peers.versionMismatch") : n.address}
        </div>
      </div>
      {!asked ? (
        <Button
          variant="primary"
          size="sm"
          data-testid={`nearby-pair-${n.id}`}
          disabled={disabled || asking || !n.proto_ok}
          onClick={() => void ask()}
        >
          {asking ? t("peers.nearby.asking") : t("peers.nearby.pair")}
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          {busy && <span className="text-[12px] text-[var(--color-fg-faint)]">{t("peers.nearby.pairing")}</span>}
          <Input
            autoFocus
            data-testid={`nearby-code-${n.id}`}
            aria-label={t("peers.nearby.codeFor", { name: n.name })}
            value={code}
            placeholder={t("peers.nearby.codePlaceholder")}
            inputMode="numeric"
            maxLength={4}
            disabled={busy}
            onChange={e => {
              const c = e.target.value.replace(/\D/g, "");
              setCode(c);
              if (c.length === 4) void submit(c);
            }}
            onKeyDown={e => {
              if (e.key === "Enter") void submit(code);
              if (e.key === "Escape") { e.stopPropagation(); setAsked(false); setCode(""); }
            }}
            className="w-28 text-center font-mono tracking-[0.2em] placeholder:tracking-normal"
          />
          <button type="button" className={linkClass} onClick={() => { setAsked(false); setCode(""); }}>
            {t("peers.nearby.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function PeerRow({ peer, onChanged }: { peer: PeerView; onChanged: () => void }) {
  const { t } = useTranslation("settings");
  const relative = useRelative();
  const [draft, setDraft] = useState(peer.name);
  useEffect(() => { setDraft(peer.name); }, [peer.name]);
  const [note, setNote] = useState(peer.note);
  useEffect(() => { setNote(peer.note); }, [peer.note]);

  async function saveNote() {
    if (note.trim() === peer.note) return;
    try {
      await peerSetNote(peer.id, note);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      setNote(peer.note);
    }
    onChanged();
  }

  async function saveName() {
    const next = draft.trim();
    if (next === peer.name) return;
    // Typing the machine's own name back means "no alias".
    const alias = next === peer.advertised_name ? "" : next;
    try {
      await peerRename(peer.id, alias);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      setDraft(peer.name);
    }
    onChanged();
  }

  async function setGrant(g: PeerGrant) {
    try {
      await peerSetGrant(peer.id, g);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    onChanged();
  }

  async function unpair() {
    const ok = await useUI.getState().askConfirm({
      title: t("peers.paired.unpairTitle", { name: peer.name }),
      message: t("peers.paired.unpairMessage", { name: peer.name }),
      confirmLabel: t("peers.paired.unpair"),
      destructive: true,
    });
    const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
    if (!confirmed) return;
    try {
      await peerUnpair(peer.id);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    onChanged();
  }

  const seen = peer.online
    ? t("peers.paired.online")
    : peer.last_seen_ms
      ? t("peers.paired.lastSeen", { when: relative(peer.last_seen_ms) })
      : t("peers.paired.neverSeen");

  return (
    <div
      data-testid={`peer-row-${peer.id}`}
      data-online={peer.online ? "true" : "false"}
      data-grant={peer.grant}
      data-revoked={peer.revoked_by_peer ? "true" : "false"}
      className="flex flex-col gap-3 rounded-lg border border-[var(--color-border-soft)] px-3 py-3"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                peer.online ? "bg-[var(--color-ok)]" : "bg-[var(--color-fg-faint)]",
              )}
            />
            <Input
              data-testid={`peer-rename-${peer.id}`}
              aria-label={t("peers.paired.renameLabel")}
              value={draft}
              placeholder={peer.advertised_name}
              maxLength={63}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={e => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { e.stopPropagation(); setDraft(peer.name); }
              }}
              className="h-8 w-64 font-medium"
            />
          </div>
          <div className="mt-1 pl-4 text-[12px] text-[var(--color-fg-faint)]">
            {seen}
            {peer.address && <> · <span className="font-mono">{peer.address}</span></>}
            {peer.version && <> · {t("peers.paired.version", { version: peer.version })}</>}
            {peer.alias && peer.alias !== peer.advertised_name && (
              <> · {t("peers.paired.callsItself", { name: peer.advertised_name })}</>
            )}
          </div>
          {!peer.proto_ok && (
            <div className="mt-1 pl-4 text-[12px] text-[var(--color-warn,inherit)]">{t("peers.versionMismatch")}</div>
          )}
          {peer.revoked_by_peer && (
            <div data-testid={`peer-revoked-${peer.id}`} className="mt-1 pl-4 text-[12px] text-[var(--color-warn,inherit)]">
              {t("peers.paired.revoked")}
            </div>
          )}
        </div>
        <Button
          variant="secondary"
          size="md"
          data-testid={`peer-unpair-${peer.id}`}
          onClick={() => void unpair()}
        >
          {t("peers.paired.unpair")}
        </Button>
      </div>

      <label className="flex flex-col gap-1 pl-4">
        <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{t("peers.paired.noteLabel")}</span>
        <Input
          data-testid={`peer-note-${peer.id}`}
          value={note}
          placeholder={t("peers.paired.notePlaceholder")}
          maxLength={200}
          onChange={e => setNote(e.target.value)}
          onBlur={() => void saveNote()}
          onKeyDown={e => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.stopPropagation(); setNote(peer.note); }
          }}
          className="h-8"
        />
        <span className="text-[12px] text-[var(--color-fg-faint)]">{t("peers.paired.noteHint")}</span>
      </label>
      <div className="-mt-1 pl-4">
        <PeerRoleChips
          note={note}
          testid={`peer-roles-${peer.id}`}
          onPick={text => {
            setNote(text);
            void peerSetNote(peer.id, text).then(onChanged, e => useUI.getState().pushToast(String(e), "error"));
          }}
        />
      </div>

      <div className="grid gap-3 pl-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{t("peers.paired.mayDo")}</span>
          <select
            data-testid={`peer-grant-${peer.id}`}
            value={peer.grant}
            onChange={e => void setGrant(e.target.value as PeerGrant)}
            className={selectClass}
          >
            <option value="reply">{t("peers.grant.reply")}</option>
            <option value="drive">{t("peers.grant.drive")}</option>
          </select>
          <span className="text-[12px] text-[var(--color-fg-faint)]">
            {peer.grant === "drive" ? t("peers.grant.driveHint") : t("peers.grant.replyHint")}
          </span>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{t("peers.paired.letsYou")}</span>
          <span
            data-testid={`peer-their-grant-${peer.id}`}
            data-their-grant={peer.their_grant ?? "unknown"}
            className="pt-2 text-[13px]"
          >
            {peer.their_grant === "drive"
              ? t("peers.grant.drive")
              : peer.their_grant === "reply"
                ? t("peers.grant.reply")
                : t("peers.paired.theirGrantUnknown")}
          </span>
        </div>
      </div>
    </div>
  );
}
