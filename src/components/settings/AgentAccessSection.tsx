// Agent access: every way an agent reaches Termic, one tab at a time. The
// sections were one long scroll first, which read as a single wall of prose
// and buried pairing at the bottom. MCP comes first and carries pairing at
// its top, because pairing is how agents reach another computer's Termic;
// the CLI is the other tab. Tab ids are settings tabs ("mcp", "cli"), and
// "peers" is the MCP tab, so old links still land on pairing.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug, SquareTerminal } from "lucide-react";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { CliSection } from "./CliSection";
import { McpSection } from "./McpSection";
import { PeersSection } from "./PeersSection";

export function AgentAccessSection({ tab }: { tab: "cli" | "mcp" | "peers" }) {
  const { t } = useTranslation("settings");
  const openSettings = useApp(s => s.openSettings);
  // Turning pairing on also turns MCP on (PeersSection writes both), so the
  // MCP section below remounts to re-read the settings it cached.
  const [mcpKey, setMcpKey] = useState(0);
  const shown = tab === "cli" ? "cli" : "mcp";
  const tiles = [
    { id: "mcp", icon: Plug, label: t("access.mcp"), hint: t("access.mcpHint") },
    { id: "cli", icon: SquareTerminal, label: t("access.cli"), hint: t("access.cliHint") },
  ] as const;
  return (
    <>
      <div className="mb-10 grid grid-cols-2 gap-2 text-[13px]" role="tablist">
        {tiles.map(opt => {
          const active = shown === opt.id;
          const Ic = opt.icon;
          return (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`access-tab-${opt.id}`}
              onClick={() => openSettings(opt.id)}
              // No transition-colors: WKWebView does not repaint a themed
              // border-color through a transition (docs/gotchas.md).
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left",
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)]/15"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium text-[var(--color-fg)]">
                <Ic className={cn("h-3.5 w-3.5", active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                {opt.label}
              </span>
              <span className="text-[12px] text-[var(--color-fg-faint)]">{opt.hint}</span>
            </button>
          );
        })}
      </div>
      {shown === "cli" && <CliSection />}
      {shown === "mcp" && (
        <>
          <div data-testid="settings-peers"><PeersSection onSharingOn={() => setMcpKey(k => k + 1)} /></div>
          <div className="mt-12 border-t border-[var(--color-border)] pt-10">
            <McpSection key={mcpKey} />
          </div>
        </>
      )}
    </>
  );
}
