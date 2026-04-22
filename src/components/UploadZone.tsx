import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  currentCount: number;
  max: number;
}

export const UploadZone = ({ onFiles, disabled, currentCount, max }: Props) => {
  const onDrop = useCallback(
    (accepted: File[]) => {
      const slots = max - currentCount;
      onFiles(accepted.slice(0, slots));
    },
    [onFiles, currentCount, max],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
    disabled,
  });

  const remaining = max - currentCount;

  return (
    <div
      {...getRootProps()}
      className={cn(
        "rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-all",
        "bg-card hover:border-primary hover:bg-secondary/50",
        isDragActive ? "border-primary bg-secondary scale-[1.01]" : "border-border",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center gap-3">
        <div className="h-14 w-14 rounded-full bg-gradient-hero flex items-center justify-center shadow-elegant">
          <Upload className="h-6 w-6 text-primary-foreground" />
        </div>
        <div>
          <p className="text-base font-semibold text-foreground">
            {isDragActive ? "Drop PDFs here" : "Drag & drop PDF reports, or click to browse"}
          </p>
          <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5 justify-center">
            <FileText className="h-3.5 w-3.5" />
            Up to {max} PDFs · {remaining} slot{remaining === 1 ? "" : "s"} remaining
          </p>
        </div>
      </div>
    </div>
  );
};