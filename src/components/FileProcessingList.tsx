import { CheckCircle2, AlertCircle, Loader2, FileText, X } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import type { ExtractionResult } from "@/lib/mockExtractor";
import { cn } from "@/lib/utils";

interface Props {
  items: ExtractionResult[];
  onRemove?: (id: string) => void;
}

const STEPS = ["Reading file", "Uploading", "Extracting financials"];

function stepIndex(step?: string): number {
  if (!step) return -1;
  if (step === "Reading file") return 0;
  if (step === "Uploading") return 1;
  if (step === "Extracting financials") return 2;
  return 3; // "Done"
}

export const FileProcessingList = ({ items, onRemove }: Props) => {
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.fileId} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
          <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium truncate">{it.fileName}</p>
              <StatusBadge status={it.status} />
            </div>

            {(it.status === "processing" || it.status === "queued") && (
              <>
                <Progress value={it.progress} className="h-1.5 mt-2" />
                <div className="mt-2 space-y-1">
                  {STEPS.map((label, i) => {
                    const cur = stepIndex(it.step);
                    const done = i < cur;
                    const active = i === cur;
                    return (
                      <div key={label} className="flex items-center gap-1.5 text-xs">
                        {done ? (
                          <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                        ) : active ? (
                          <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />
                        ) : (
                          <div className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0" />
                        )}
                        <span className={cn(
                          done && "text-muted-foreground",
                          active && "text-foreground font-medium",
                          !done && !active && "text-muted-foreground/40",
                        )}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {it.status === "success" && (
              <p className="text-xs text-muted-foreground mt-1">
                {it.company} · {it.period} · {it.pnl.length} P&L lines · {it.notes.length} note rows
              </p>
            )}

            {it.status === "error" && (
              <p className="text-xs text-destructive mt-1">{it.error}</p>
            )}
          </div>

          {onRemove && it.status !== "processing" && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onRemove(it.fileId)}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
};

const StatusBadge = ({ status }: { status: ExtractionResult["status"] }) => {
  const map = {
    queued: { label: "Queued", icon: Loader2, cls: "text-muted-foreground", spin: false },
    processing: { label: "Processing", icon: Loader2, cls: "text-primary", spin: true },
    success: { label: "Done", icon: CheckCircle2, cls: "text-success", spin: false },
    error: { label: "Failed", icon: AlertCircle, cls: "text-destructive", spin: false },
  } as const;
  const m = map[status];
  const Icon = m.icon;
  return (
    <span className={cn("flex items-center gap-1 text-xs font-medium shrink-0", m.cls)}>
      <Icon className={cn("h-3.5 w-3.5", m.spin && "animate-spin")} />
      {m.label}
    </span>
  );
};
