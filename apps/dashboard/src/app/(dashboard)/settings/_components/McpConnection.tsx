"use client";

/**
 * MCP connection card. Shows the JSON-RPC endpoint for the current runtime
 * target and a ready-to-paste client config. Auth is a Personal Access Token
 * (the card just above) — no separate credential.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Boxes, Copy, Check } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { getRestApiBaseUrl } from "@/lib/api/urls";

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };
  return { copied, copy };
}

function CopyRow({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 min-w-0 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
        {value || "…"}
      </code>
      <button
        onClick={() => copy(value)}
        disabled={!value}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function CopyBlock({ value }: { value: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-3 pr-16 font-mono text-xs leading-relaxed text-foreground">
        {value}
      </pre>
      <button
        onClick={() => copy(value)}
        className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function McpConnection() {
  // Resolve on the client — getRestApiBaseUrl reads window.location, so compute
  // after mount to avoid an SSR/hydration mismatch.
  const [endpoint, setEndpoint] = useState("");
  useEffect(() => {
    setEndpoint(`${getRestApiBaseUrl()}/mcp`);
  }, []);

  const configSnippet = [
    "{",
    '  "mcpServers": {',
    '    "openship": {',
    `      "url": "${endpoint || "https://<your-openship>/api/mcp"}",`,
    '      "headers": { "Authorization": "Bearer opsh_pat_…" }',
    "    }",
    "  }",
    "}",
  ].join("\n");

  return (
    <SettingsSection
      icon={Boxes}
      title="MCP"
      description="Connect AI agents to your Openship API over the Model Context Protocol."
      iconBg="bg-emerald-500/10"
      iconColor="text-emerald-500"
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">Endpoint</p>
          <CopyRow value={endpoint} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Streamable-HTTP JSON-RPC. Authenticate with a Bearer access token — create one in the{" "}
            <Link
              href="/settings?tab=tokens"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              Tokens
            </Link>{" "}
            tab. A read-only token limits the agent to reads.
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-foreground">Client config</p>
          <CopyBlock value={configSnippet} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Replace <code className="font-mono">opsh_pat_…</code> with your token. Works from any MCP client that
            supports an HTTP server URL with headers.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
