"use client";

import React from "react";
import { Download, RefreshCw, Copy, Check } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface LogsActionsProps {
  onCopy: () => void;
  onDownload: () => void;
  onClear: () => void;
  copied: boolean;
  logsCount: number;
}

export const LogsActions: React.FC<LogsActionsProps> = ({
  onCopy,
  onDownload,
  onClear,
  copied,
  logsCount,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      {/* Copy */}
      <button
        onClick={onCopy}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/60 rounded-md transition-colors text-xs text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? t.projectDetail.logs.actions.copied : t.projectDetail.logs.actions.copy}
      </button>

      {/* Download */}
      <button
        onClick={onDownload}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/60 rounded-md transition-colors text-xs text-muted-foreground hover:text-foreground"
      >
        <Download className="w-3.5 h-3.5" />
        {t.projectDetail.logs.actions.download}
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-danger-bg rounded-md transition-colors text-xs text-muted-foreground hover:text-danger"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        {t.projectDetail.logs.actions.clear}
      </button>
    </div>
  );
};

