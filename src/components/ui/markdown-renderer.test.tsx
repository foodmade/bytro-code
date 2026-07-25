import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./markdown-renderer";

describe("MarkdownRenderer", () => {
  it("renders markdown syntax while in lightweight streaming mode", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={"**Important**\n\n- first item"}
        lightweight
        variant="chat"
      />,
    );

    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).not.toContain("**Important**");
  });

  it("keeps an unfinished streaming code fence rendered as a code block", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={"```tsx\nconst value = 1;"}
        lightweight
        variant="chat"
      />,
    );

    expect(html).toContain("<pre");
    expect(html).toContain("const value = 1;");
    expect(html).not.toContain("```tsx");
  });
});
