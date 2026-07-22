"use client";

import React, { useState } from "react";
import { Copy, Check, Server, Info } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

interface DnsConfigurationProps {
  domain: string;
  records?: DnsRecord[];
  mode?: "cloud" | "selfhosted";
}

const DnsConfiguration: React.FC<DnsConfigurationProps> = ({ domain, records, mode }) => {
  const { t } = useI18n();
  const recordDescriptions: Record<string, string> = {
    CNAME: t.deploy.dns.descCname,
    A: t.deploy.dns.descA,
    TXT: t.deploy.dns.descTxt,
  };
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const displayRecords = records ?? [];

  if (!displayRecords.length) return null;

  return (
    <div className="bg-card rounded-xl border border-border/50 shadow-lg overflow-hidden animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Server className="size-4 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t.deploy.dns.title}</h3>
          <p className="text-xs text-muted-foreground">
            {t.deploy.dns.addRecordsFor} <span className="font-medium text-foreground">{domain}</span>
          </p>
        </div>
      </div>

      <div className="p-5 space-y-3">
        {displayRecords.map((record, i) => (
            <div key={i} className="bg-muted/30 rounded-xl border border-border/50 p-4">
              <div className="flex items-center gap-3 mb-3">
                <span className="px-2.5 py-1 bg-foreground text-background text-xs font-bold rounded-lg">
                  {record.type}
                </span>
                <span className="text-xs text-muted-foreground">
                  {recordDescriptions[record.type] ?? ""}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{t.deploy.dns.nameHost}</p>
                  <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                    <code className="flex-1 text-sm font-medium text-foreground">{record.host}</code>
                    <button
                      onClick={() => copyToClipboard(record.host, `${i}-host`)}
                      className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
                    >
                      {copied === `${i}-host` ? (
                        <Check className="size-3.5 text-success" />
                      ) : (
                        <Copy className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{t.deploy.dns.valueTarget}</p>
                  <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                    <code className="flex-1 text-sm font-medium text-foreground truncate">{record.value}</code>
                    <button
                      onClick={() => copyToClipboard(record.value, `${i}-value`)}
                      className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
                    >
                      {copied === `${i}-value` ? (
                        <Check className="size-3.5 text-success" />
                      ) : (
                        <Copy className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}

        <div className="flex items-start gap-2 p-3 bg-primary/5 rounded-xl border border-primary/10">
            <Info className="size-3.5 text-primary shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground leading-relaxed">
              {mode === "selfhosted" ? (
                <p>
                  {t.deploy.dns.selfInfoPre}<span className="font-medium text-foreground">{t.deploy.dns.recordA}</span>{t.deploy.dns.selfInfoMid}<span className="font-medium text-foreground">{t.deploy.dns.recordTxt}</span>{t.deploy.dns.verifySuffix}
                </p>
              ) : (
                <p>
                  {t.deploy.dns.cloudInfoPre}<span className="font-medium text-foreground">{t.deploy.dns.recordCname}</span>{t.deploy.dns.cloudInfoMid}<span className="font-medium text-foreground">{t.deploy.dns.recordTxt}</span>{t.deploy.dns.verifySuffix}
                </p>
              )}
            </div>
          </div>
      </div>
    </div>
  );
};

export default DnsConfiguration;
