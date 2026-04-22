import { useState } from "react";
import { FileSpreadsheet, Sparkles, FileSearch, Link2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { UploadZone } from "@/components/UploadZone";
import { FileProcessingList } from "@/components/FileProcessingList";
import { ResultsView } from "@/components/ResultsView";
import {
  extractFromPdfReal,
  getDemoResults,
  type ExtractionResult,
} from "@/lib/mockExtractor";

const MAX_FILES = 30;

const Index = () => {
  const [items, setItems] = useState<ExtractionResult[]>([]);
  const [processing, setProcessing] = useState(false);

  const successCount = items.filter((i) => i.status === "success").length;
  const showResults = successCount > 0 && !processing;

  const updateItem = (id: string, patch: Partial<ExtractionResult>) => {
    setItems((prev) => prev.map((it) => (it.fileId === id ? { ...it, ...patch } : it)));
  };

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    const queued: ExtractionResult[] = files.map((f, i) => ({
      fileId: `${f.name}-${Date.now()}-${i}`,
      fileName: f.name,
      status: "queued",
      progress: 0,
      company: "",
      period: "",
      currency: "",
      statementTitle: "",
      pnl: [],
      notes: [],
    }));
    setItems((prev) => [...prev, ...queued]);
    setProcessing(true);

    for (let i = 0; i < files.length; i++) {
      const id = queued[i].fileId;
      updateItem(id, { status: "processing", progress: 5 });
      try {
        const result = await extractFromPdfReal(files[i], (p) => updateItem(id, { progress: p }));
        updateItem(id, { ...result, status: "success", fileId: id });
      } catch (e) {
        updateItem(id, { status: "error", error: e instanceof Error ? e.message : "Unknown error" });
      }
    }
    setProcessing(false);
    toast.success("Processing complete");
  };

  const loadDemo = () => {
    setItems(getDemoResults());
    toast.info("Loaded sample data from 2 demo annual reports");
  };

  const reset = () => setItems([]);

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.fileId !== id));

  const handleUpdateNoteParent = (fileId: string, noteId: string, newParentId: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.fileId === fileId
          ? {
              ...it,
              notes: it.notes.map((n) =>
                n.id === noteId ? { ...n, parentLineItemId: newParentId, flagged: false, matchMethod: "explicit" as const, confidence: "high" as const } : n,
              ),
            }
          : it,
      ),
    );
    toast.success("Note reassigned");
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container max-w-6xl flex items-center justify-between py-4">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-gradient-hero flex items-center justify-center shadow-elegant">
              <FileSpreadsheet className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-semibold leading-tight">P&amp;L Note Extractor</h1>
              <p className="text-xs text-muted-foreground">Annual report → structured Excel</p>
            </div>
          </div>
          {items.length > 0 && (
            <Button variant="ghost" onClick={reset}>Start over</Button>
          )}
        </div>
      </header>

      <main className="container max-w-6xl py-10">
        {!showResults && (
          <section className="mb-8 text-center max-w-2xl mx-auto">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-primary bg-primary/10 px-3 py-1 rounded-full mb-4">
              <Sparkles className="h-3.5 w-3.5" /> Built for finance & audit teams
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-3">
              Extract Profit &amp; Loss statements and their notes — automatically.
            </h2>
            <p className="text-muted-foreground">
              Upload up to 30 annual reports. We detect the income statement, link each line to its
              explanatory note breakdown, and export everything into one clean Excel workbook.
            </p>
          </section>
        )}

        {!showResults && (
          <div className="space-y-4">
            <UploadZone
              onFiles={handleFiles}
              disabled={processing || items.length >= MAX_FILES}
              currentCount={items.length}
              max={MAX_FILES}
            />

            {!items.length && (
              <div className="grid md:grid-cols-3 gap-3 pt-4">
                <Feature icon={FileSearch} title="Smart detection" desc="Finds P&L variants: income statement, statement of operations, statement of profit or loss." />
                <Feature icon={Link2} title="Note linking" desc="Resolves explicit refs first, then title and semantic matches when references are missing." />
                <Feature icon={ShieldCheck} title="Confidence flags" desc="Ambiguous matches are flagged for review — never silently guessed." />
              </div>
            )}

            {!items.length && (
              <div className="text-center pt-6">
                <Button variant="outline" onClick={loadDemo}>
                  <Sparkles className="h-4 w-4 mr-2" /> Try with sample data
                </Button>
              </div>
            )}

            {items.length > 0 && (
              <div className="pt-2">
                <FileProcessingList items={items} onRemove={removeItem} />
              </div>
            )}
          </div>
        )}

        {showResults && (
          <ResultsView
            results={items}
            onUpdateNoteParent={handleUpdateNoteParent}
            onReset={reset}
          />
        )}
      </main>
    </div>
  );
};

const Feature = ({ icon: Icon, title, desc }: { icon: typeof FileSearch; title: string; desc: string }) => (
  <div className="p-4 rounded-lg border bg-card shadow-card">
    <Icon className="h-5 w-5 text-primary mb-2" />
    <h3 className="font-medium text-sm">{title}</h3>
    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{desc}</p>
  </div>
);

export default Index;
