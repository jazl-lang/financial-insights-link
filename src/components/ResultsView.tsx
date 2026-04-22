import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Flag, FileSpreadsheet, Download, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { exportToJson, exportToXlsx } from "@/lib/exporter";
import {
  formatMoney,
  type Confidence,
  type ExtractionResult,
  type NoteRow,
  type PnLRow,
} from "@/lib/mockExtractor";

interface Props {
  results: ExtractionResult[];
  onUpdateNoteParent: (fileId: string, noteId: string, newParentId: string) => void;
  onReset: () => void;
}

const confColor: Record<Confidence, string> = {
  high: "bg-success/15 text-success border-success/30",
  medium: "bg-warning/15 text-warning border-warning/30",
  low: "bg-destructive/15 text-destructive border-destructive/30",
};

export const ResultsView = ({ results, onUpdateNoteParent, onReset }: Props) => {
  const successful = results.filter((r) => r.status === "success");
  const [confFilter, setConfFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-card border shadow-card">
        <div>
          <h2 className="text-lg font-semibold">Extraction Results</h2>
          <p className="text-sm text-muted-foreground">
            {successful.length} of {results.length} files processed successfully
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Filter line items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48"
          />
          <Select value={confFilter} onValueChange={setConfFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Confidence" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All confidence</SelectItem>
              <SelectItem value="high">High only</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low / flagged</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => exportToJson(results)}>
            <Download className="h-4 w-4 mr-2" /> JSON
          </Button>
          <Button onClick={() => exportToXlsx(results)} className="bg-gradient-hero text-primary-foreground hover:opacity-90">
            <FileSpreadsheet className="h-4 w-4 mr-2" /> Export XLSX
          </Button>
          <Button variant="ghost" onClick={onReset}>
            New session
          </Button>
        </div>
      </div>

      {successful.map((r) => (
        <ReportCard
          key={r.fileId}
          result={r}
          confFilter={confFilter}
          search={search}
          onUpdateNoteParent={onUpdateNoteParent}
        />
      ))}
    </div>
  );
};

const ReportCard = ({
  result,
  confFilter,
  search,
  onUpdateNoteParent,
}: {
  result: ExtractionResult;
  confFilter: string;
  search: string;
  onUpdateNoteParent: (fileId: string, noteId: string, newParentId: string) => void;
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const filteredRows = useMemo(() => {
    return result.pnl.filter((p) => {
      if (search && !p.lineItem.toLowerCase().includes(search.toLowerCase())) return false;
      if (confFilter !== "all") {
        const noteRows = result.notes.filter((n) => n.parentLineItemId === p.id);
        if (!noteRows.some((n) => n.confidence === confFilter)) return false;
      }
      return true;
    });
  }, [result, search, confFilter]);

  return (
    <Card className="shadow-card">
      <CardHeader className="bg-gradient-subtle rounded-t-xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{result.company}</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {result.statementTitle} · {result.period} · {result.currency}
              </CardDescription>
              <p className="text-xs text-muted-foreground mt-1 truncate max-w-md">{result.fileName}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Badge variant="outline">{result.pnl.length} P&L lines</Badge>
            <Badge variant="outline">{result.notes.length} note rows</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Line Item</TableHead>
              <TableHead className="w-20">Note</TableHead>
              <TableHead className="text-right">Current Year</TableHead>
              <TableHead className="text-right">Prior Year</TableHead>
              <TableHead className="w-16 text-right">Page</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row) => {
              const noteRows = result.notes.filter((n) => n.parentLineItemId === row.id);
              const hasNotes = noteRows.length > 0;
              const isOpen = expanded.has(row.id);
              const flagged = noteRows.some((n) => n.flagged);
              return (
                <RowGroup
                  key={row.id}
                  row={row}
                  noteRows={noteRows}
                  isOpen={isOpen}
                  hasNotes={hasNotes}
                  flagged={flagged}
                  currency={result.currency}
                  onToggle={() => toggle(row.id)}
                  pnlOptions={result.pnl}
                  onReassign={(noteId, newParentId) => onUpdateNoteParent(result.fileId, noteId, newParentId)}
                />
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};

const RowGroup = ({
  row,
  noteRows,
  isOpen,
  hasNotes,
  flagged,
  currency,
  onToggle,
  pnlOptions,
  onReassign,
}: {
  row: PnLRow;
  noteRows: NoteRow[];
  isOpen: boolean;
  hasNotes: boolean;
  flagged: boolean;
  currency: string;
  onToggle: () => void;
  pnlOptions: PnLRow[];
  onReassign: (noteId: string, newParentId: string) => void;
}) => {
  return (
    <>
      <TableRow className={cn("group", hasNotes && "cursor-pointer hover:bg-secondary/40")} onClick={hasNotes ? onToggle : undefined}>
        <TableCell>
          {hasNotes ? (
            isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />
          ) : null}
        </TableCell>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {row.lineItem}
            {flagged && <Flag className="h-3.5 w-3.5 text-warning" />}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground text-sm">{row.noteRef ?? "—"}</TableCell>
        <TableCell className="text-right font-mono tabular-nums">{formatMoney(row.currentYear, currency)}</TableCell>
        <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatMoney(row.priorYear, currency)}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">p.{row.page}</TableCell>
      </TableRow>
      {isOpen && hasNotes && (
        <TableRow className="bg-secondary/30 hover:bg-secondary/30">
          <TableCell colSpan={6} className="p-0">
            <div className="p-4 pl-12">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-2">
                Note breakdown
                <span className="text-foreground/70">·</span>
                <span>{noteRows[0]?.noteTitle}</span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead className="w-32">Match</TableHead>
                    <TableHead className="text-right">Current Year</TableHead>
                    <TableHead className="text-right">Prior Year</TableHead>
                    <TableHead className="w-16 text-right">Page</TableHead>
                    <TableHead className="w-28 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {noteRows.map((n) => (
                    <TableRow key={n.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {n.component}
                          {n.flagged && <Flag className="h-3 w-3 text-warning" />}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={cn("text-[10px] uppercase border rounded px-1.5 py-0.5", confColor[n.confidence])}>
                          {n.matchMethod} · {n.confidence}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatMoney(n.currentYear, currency)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{formatMoney(n.priorYear, currency)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">p.{n.page}</TableCell>
                      <TableCell className="text-right">
                        <ReassignDialog note={n} pnlOptions={pnlOptions} currentParentId={row.id} onReassign={(pid) => onReassign(n.id, pid)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
};

const ReassignDialog = ({
  note,
  pnlOptions,
  currentParentId,
  onReassign,
}: {
  note: NoteRow;
  pnlOptions: PnLRow[];
  currentParentId: string;
  onReassign: (newParentId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(currentParentId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 text-xs">Reassign</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign note to a different P&L line</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Move <span className="font-medium text-foreground">{note.component}</span> ({note.noteTitle}) to:
          </p>
          <Select value={val} onValueChange={setVal}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pnlOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.lineItem}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => { onReassign(val); setOpen(false); }}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};