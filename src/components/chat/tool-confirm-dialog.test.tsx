import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import type { FileConfirmationPreview } from "./tool-confirmation-utils";
import { renderFileConfirmationPreviewCard } from "./tool-confirm-dialog";

describe("renderFileConfirmationPreviewCard", () => {
  it("shows a structured file summary rail for edited file confirmations", () => {
    const preview: FileConfirmationPreview = {
      kind: "edited",
      filePath: "src/App.css",
      fileName: "App.css",
      extension: "css",
      added: 4,
      removed: 3,
      oldText: ".tool-card {\n  opacity: 1;\n}\n",
      newText: ".tool-card {\n  opacity: 1;\n  transform: translateY(0);\n}\n",
    };

    const html = renderToStaticMarkup(
      <>{renderFileConfirmationPreviewCard(preview, i18n.t.bind(i18n))}</>,
    );

    expect(html).toContain('data-tool-confirm-file-preview="true"');
    expect(html).toContain('data-tool-confirm-file-kind="edited"');
    expect(html).toContain('data-tool-confirm-file-summary="true"');
    expect(html).toContain('data-tool-confirm-file-summary-chip="language"');
    expect(html).toContain('data-tool-confirm-file-summary-chip="line-delta"');
    expect(html).toContain('data-tool-confirm-file-summary-chip="change"');
    expect(html).toContain('data-tool-confirm-file-summary-chip="net-change"');
    expect(html).toContain('data-tool-confirm-file-section="before"');
    expect(html).toContain('data-tool-confirm-file-section="after"');
  });
});
