// After a pairing completes, on BOTH machines (docs/peers.md): who it is,
// what pairing means, and what the other machine is for. Global rather than
// part of Settings > Agent access, because the machine that showed the code
// may be on any screen when the other side types it.
//
// Driven by the backend's `peer://pairing` event, sent once per completed
// pairing on each side. The note it asks for is the same one Settings edits
// ("What it is for"); agents read it.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { PEER_PAIRING_EVENT, peerSetNote } from "@/lib/ipc";
import type { PairingView } from "@/lib/types";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PeerRoleChips } from "@/components/settings/PeerRoles";

export function PeerPairingDialog() {
  const { t } = useTranslation("dialogs");
  const [current, setCurrent] = useState<PairingView | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    void listen<PairingView>(PEER_PAIRING_EVENT, ev => { setCurrent(ev.payload); setNote(""); })
      .then(f => { if (gone) f(); else un = f; })
      .catch(() => {});
    return () => { gone = true; un?.(); };
  }, []);

  if (!current) return null;
  const name = current.peer_name;

  async function done() {
    const text = note.trim();
    if (text) {
      try {
        await peerSetNote(current!.peer_id, text);
      } catch (e) {
        useUI.getState().pushToast(String(e), "error");
        return;
      }
    }
    setCurrent(null);
  }

  return (
    <AppDialog open onOpenChange={v => { if (!v) setCurrent(null); }} title={t("peerPairing.title", { name })} className="max-w-lg">
      <div
        data-testid="peer-pair-dialog"
        data-direction={current.direction}
        data-peer={current.peer_id}
        className="flex flex-col gap-4 pt-1"
      >
        <p data-testid="peer-pair-together" className="text-[12.5px] text-[var(--color-fg-dim)]">
          {t("peerPairing.together", { name })}
        </p>
        {current.replaces_existing && (
          <p data-testid="peer-pair-replaces" className="text-[12.5px] text-[var(--color-fg-dim)]">
            {t("peerPairing.replaced", { name })}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <div className="text-[13.5px] font-medium">{t("peerPairing.question", { name })}</div>
          <div className="text-[12px] text-[var(--color-fg-faint)]">{t("peerPairing.questionHint")}</div>
          <PeerRoleChips note={note} onPick={setNote} testid="peer-pair-roles" />
          <Input
            data-testid="peer-pair-note"
            value={note}
            maxLength={200}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void done(); }}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" data-testid="peer-pair-skip" onClick={() => setCurrent(null)}>
            {t("peerPairing.skip")}
          </Button>
          <Button variant="primary" data-testid="peer-pair-done" onClick={() => void done()}>
            {t("peerPairing.done")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
