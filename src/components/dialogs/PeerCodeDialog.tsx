// The code to type, on the machine somebody clicked Pair on (docs/peers.md).
// Global rather than part of Settings: the click happens at the OTHER
// computer, and this one may be on any screen when it lands. It closes on its
// own when pairing succeeds (then PeerPairingDialog takes over), when the code
// expires, after three wrong codes, or on Decline.
//
// Driven by `peer://changed`: the backend opens pairing mode with
// `requested_by` set when `/pair/request` arrives, and says so through that
// event. No polling; the 1s tick only runs while the dialog is up, for the
// countdown.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { PEER_CHANGED_EVENT, peerPairMode, peerStatus } from "@/lib/ipc";
import type { PairModeView } from "@/lib/types";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";

export function PeerCodeDialog() {
  const { t } = useTranslation("dialogs");
  const [mode, setMode] = useState<PairModeView | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    const read = () => {
      void peerStatus()
        .then(s => {
          if (gone) return;
          const m = s.pair_mode;
          setMode(m && m.requested_by ? m : null);
        })
        .catch(() => {});
    };
    read();
    void listen(PEER_CHANGED_EVENT, read)
      .then(f => { if (gone) f(); else un = f; })
      .catch(() => {});
    return () => { gone = true; un?.(); };
  }, []);

  useEffect(() => {
    if (!mode) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [mode]);

  if (!mode) return null;
  const left = Math.max(0, Math.ceil((mode.expires_at_ms - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const name = mode.requested_by ?? "";
  const decline = () => { setMode(null); void peerPairMode(false).catch(() => {}); };

  return (
    <AppDialog open onOpenChange={v => { if (!v) decline(); }} title={t("peerCode.title", { name })} className="max-w-md">
      <div data-testid="peer-code-dialog" data-code={mode.code} data-peer={name} className="flex flex-col gap-3 pt-1">
        <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("peerCode.hint", { name })}</p>
        <div
          data-testid="peer-code"
          className="select-text text-center font-mono text-[48px] font-semibold leading-tight tracking-[0.3em] tabular-nums"
        >
          {mode.code}
        </div>
        <div className="flex items-center justify-between text-[12px] text-[var(--color-fg-faint)]">
          <span className="tabular-nums">{t("peerCode.timeLeft", { time: clock })}</span>
          {mode.wrong_codes > 0 && (
            <span data-testid="peer-code-wrong" className="text-[var(--color-warn,inherit)]">
              {t("peerCode.wrongCodes", { count: mode.wrong_codes })}
            </span>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" size="md" data-testid="peer-code-decline" onClick={decline}>
            {t("peerCode.decline")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
