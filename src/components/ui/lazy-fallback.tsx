import { Loader2 } from "lucide-react";

interface LazyFallbackProps {
  readonly label?: string;
}

/** Minimal spinner shown while a lazy-loaded component is fetching. */
export function LazyFallback({ label }: LazyFallbackProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full gap-3">
      <Loader2 size={24} className="animate-spin text-[#888888]" />
      {label && (
        <span className="text-[12px] text-[#888888] font-medium">{label}</span>
      )}
    </div>
  );
}
