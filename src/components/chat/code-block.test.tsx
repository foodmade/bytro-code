import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "./code-block";

describe("CodeBlock", () => {
  it("highlights bash code passed through the code prop", () => {
    const html = renderToStaticMarkup(
      <CodeBlock language="bash" code="npm run test -- --watch" />,
    );

    expect(html).toContain("language-bash");
    expect(html).toContain("hljs");
    expect(html).toContain("npm");
  });
});
