import { describe, it, expect } from "vitest";
import { extractSlideshowJson, parseSlideshowJson, isSlideshowData, isSlideshowPatch } from "../slideshow-parser";

// ---------------------------------------------------------------------------
// extractSlideshowJson
// ---------------------------------------------------------------------------

describe("extractSlideshowJson", () => {
  it("returns found=false when no slideshow block exists", () => {
    const result = extractSlideshowJson("Hello world");
    expect(result.found).toBe(false);
  });

  it("extracts a complete slideshow block", () => {
    const content = `Here is a presentation:

\`\`\`slideshow
{"title":"Test","slides":[]}
\`\`\`

Done!`;
    const result = extractSlideshowJson(content);
    expect(result.found).toBe(true);
    expect(result.isComplete).toBe(true);
    expect(result.rawJson).toBe('{"title":"Test","slides":[]}');
  });

  it("extracts a streaming (incomplete) block", () => {
    const content = `\`\`\`slideshow
{"title":"Test","slides":[{"layout":"title","elem`;
    const result = extractSlideshowJson(content);
    expect(result.found).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.rawJson).toContain('"title":"Test"');
  });

  it("handles newline after fence open", () => {
    const content = "```slideshow\n{\"title\":\"A\"}\n```";
    const result = extractSlideshowJson(content);
    expect(result.found).toBe(true);
    expect(result.isComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSlideshowJson — strict mode
// ---------------------------------------------------------------------------

describe("parseSlideshowJson (strict)", () => {
  it("parses valid JSON", () => {
    const json = '{"title":"Deck","slides":[{"layout":"title","elements":[]}]}';
    const { data, error } = parseSlideshowJson(json, false);
    expect(error).toBeNull();
    expect(data?.title).toBe("Deck");
    expect(data?.slides).toHaveLength(1);
  });

  it("returns error for completely invalid JSON in strict mode", () => {
    const { data, error } = parseSlideshowJson("not json at all", false);
    expect(data).toBeNull();
    expect(error).toBe("Invalid JSON");
  });

  it("returns null for empty input", () => {
    const { data, error } = parseSlideshowJson("", false);
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it("rejects JSON without a title field", () => {
    const { data } = parseSlideshowJson('{"slides":[]}', false);
    expect(data).toBeNull();
  });

  it("repairs missing commas even in strict mode via jsonrepair", () => {
    // jsonrepair runs before strict/lenient branching
    const json = '{\n  "title": "T"\n  "slides": []\n}';
    const { data } = parseSlideshowJson(json, false);
    expect(data?.title).toBe("T");
  });
});

// ---------------------------------------------------------------------------
// parseSlideshowJson — lenient mode (streaming)
// ---------------------------------------------------------------------------

describe("parseSlideshowJson (lenient)", () => {
  it("parses valid JSON in lenient mode", () => {
    const json = '{"title":"OK","slides":[]}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("OK");
  });

  it("closes a missing brace", () => {
    const json = '{"title":"X","slides":[]';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("X");
  });

  it("closes a missing bracket and brace", () => {
    const json = '{"title":"X","slides":[{"layout":"title","elements":[]}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("X");
    expect(data?.slides).toHaveLength(1);
  });

  it("handles deeply truncated JSON", () => {
    const json = '{"title":"X","slides":[{"layout":"content","elements":[{"type":"title","text":"Hello"';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("X");
  });

  it("returns null for completely garbage input", () => {
    const { data, error } = parseSlideshowJson("not json at all", true);
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it("preserves theme when present", () => {
    const json = '{"title":"T","theme":{"backgroundColor":"#0f172a","accentColor":"#3b82f6"},"slides":[]}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.theme?.backgroundColor).toBe("#0f172a");
    expect(data?.theme?.accentColor).toBe("#3b82f6");
  });

  it("preserves icon and imageKeyword fields on slides", () => {
    const json = '{"title":"T","slides":[{"layout":"title","elements":[],"icon":"rocket","imageKeyword":"technology"}]}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.slides[0]?.icon).toBe("rocket");
    expect(data?.slides[0]?.imageKeyword).toBe("technology");
  });

  it("handles truncated icon field during streaming", () => {
    const json = '{"title":"T","slides":[{"layout":"title","elements":[],"icon":"roc';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("T");
  });

  it("recovers multiple slides from deeply truncated JSON", () => {
    const json = '{"title":"SEO Guide","slides":[' +
      '{"layout":"title","elements":[{"type":"title","text":"Page 1"}]},' +
      '{"layout":"content","elements":[{"type":"title","text":"Page 2"}]},' +
      '{"layout":"content","elements":[{"type":"title","text":"Page 3"}]},' +
      '{"layout":"content","elements":[{"type":"title","text":"Page 4"},{"type":"bullets","items":[{"text":"item';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("SEO Guide");
    expect(data!.slides.length).toBeGreaterThanOrEqual(3);
  });

  it("recovers from truncation mid-string in bullet text", () => {
    const json = '{"title":"T","slides":[' +
      '{"layout":"content","elements":[{"type":"bullets","items":[{"text":"first"},{"text":"sec';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("T");
    expect(data!.slides.length).toBeGreaterThanOrEqual(1);
  });

  it("handles trailing comma before truncation", () => {
    const json = '{"title":"T","slides":[{"layout":"title","elements":[]},';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("T");
    expect(data!.slides.length).toBe(1);
  });

  it("does not misidentify a full document as a patch", () => {
    const json = '{"title":"Deck","slides":[{"layout":"title","elements":[]}]}';
    const { data, patch } = parseSlideshowJson(json, true);
    expect(data).not.toBeNull();
    expect(patch).toBeNull();
  });

  // --- jsonrepair-powered fixes ---

  it("fixes missing commas between properties (LLM error)", () => {
    const json = '{\n  "title": "SEO Guide"\n  "theme": {\n    "backgroundColor": "#0f172a"\n  },\n  "slides": []\n}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("SEO Guide");
    expect(data?.theme?.backgroundColor).toBe("#0f172a");
  });

  it("fixes missing commas between array elements", () => {
    const json = '{"title":"T","slides":[\n  {"layout":"title","elements":[]}\n  {"layout":"content","elements":[]}\n]}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("T");
    expect(data!.slides.length).toBe(2);
  });

  it("fixes trailing commas before closing brackets", () => {
    const json = '{"title":"T","slides":[{"layout":"title","elements":[],},],}';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("T");
    expect(data!.slides.length).toBe(1);
  });

  it("fixes missing commas in large multi-slide JSON", () => {
    const json = `{
  "title": "SEO 搜索引擎优化"
  "theme": {
    "backgroundColor": "#08090d"
    "titleColor": "#f1f5f9"
  }
  "slides": [
    {
      "layout": "title"
      "elements": [
        {"type": "title", "text": "SEO Guide", "level": 1}
      ]
    }
    {
      "layout": "content"
      "elements": [
        {"type": "title", "text": "Chapter 1"}
        {"type": "paragraph", "text": "Some content"}
      ]
    }
  ]
}`;
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("SEO 搜索引擎优化");
    expect(data?.theme?.backgroundColor).toBe("#08090d");
    expect(data!.slides.length).toBe(2);
    expect(data!.slides[1].elements.length).toBe(2);
  });

  it("fixes missing commas + truncation combined", () => {
    // Both issues at once: missing commas AND truncated
    const json = '{\n  "title": "T"\n  "slides": [\n    {"layout": "title"\n      "elements": [{"type": "title", "text": "Hello"';
    const { data } = parseSlideshowJson(json, true);
    expect(data?.title).toBe("T");
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe("isSlideshowData", () => {
  it("accepts object with title string", () => {
    expect(isSlideshowData({ title: "T", slides: [] })).toBe(true);
  });
  it("rejects null", () => {
    expect(isSlideshowData(null)).toBe(false);
  });
  it("rejects object without title", () => {
    expect(isSlideshowData({ slides: [] })).toBe(false);
  });
});

describe("isSlideshowPatch", () => {
  it("accepts valid patch", () => {
    expect(isSlideshowPatch({ slideIndex: 0, slide: { layout: "content", elements: [] } })).toBe(true);
  });
  it("rejects missing slideIndex", () => {
    expect(isSlideshowPatch({ slide: { layout: "content", elements: [] } })).toBe(false);
  });
  it("rejects missing slide", () => {
    expect(isSlideshowPatch({ slideIndex: 0 })).toBe(false);
  });
  it("rejects non-numeric slideIndex", () => {
    expect(isSlideshowPatch({ slideIndex: "0", slide: {} })).toBe(false);
  });
  it("rejects null", () => {
    expect(isSlideshowPatch(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSlideshowJson — patch mode
// ---------------------------------------------------------------------------

describe("parseSlideshowJson (patch mode)", () => {
  it("parses a valid patch JSON", () => {
    const json = '{"slideIndex":2,"slide":{"layout":"content","elements":[{"type":"title","text":"New Title"}]}}';
    const { data, patch, error } = parseSlideshowJson(json, false);
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(patch).not.toBeNull();
    expect(patch!.slideIndex).toBe(2);
    expect(patch!.slide.elements).toHaveLength(1);
  });

  it("parses a patch with optional theme", () => {
    const json = '{"slideIndex":0,"slide":{"layout":"title","elements":[]},"theme":{"accentColor":"#ff0000"}}';
    const { patch } = parseSlideshowJson(json, false);
    expect(patch).not.toBeNull();
    expect(patch!.theme?.accentColor).toBe("#ff0000");
  });

  it("repairs missing commas in patch JSON", () => {
    const json = '{\n  "slideIndex": 1\n  "slide": {"layout": "content"\n    "elements": []}\n}';
    const { patch } = parseSlideshowJson(json, false);
    expect(patch).not.toBeNull();
    expect(patch!.slideIndex).toBe(1);
  });

  it("handles truncated patch in lenient mode", () => {
    const json = '{"slideIndex":3,"slide":{"layout":"content","elements":[{"type":"title","text":"Hel';
    const { patch } = parseSlideshowJson(json, true);
    expect(patch).not.toBeNull();
    expect(patch!.slideIndex).toBe(3);
  });

  it("repairs truncated patch via jsonrepair even in strict mode", () => {
    // jsonrepair runs before strict/lenient branching, so it can fix simple truncations
    const json = '{"slideIndex":3,"slide":{"layout":"content","elements":[{"type":"title","text":"Hel';
    const { data, patch } = parseSlideshowJson(json, false);
    expect(data).toBeNull();
    expect(patch).not.toBeNull();
    expect(patch!.slideIndex).toBe(3);
  });

  it("does not confuse a full document with a patch", () => {
    const json = '{"title":"Deck","slides":[{"layout":"title","elements":[]}]}';
    const { data, patch } = parseSlideshowJson(json, false);
    expect(data).not.toBeNull();
    expect(patch).toBeNull();
  });

  it("handles patch with icon and imageKeyword", () => {
    const json = '{"slideIndex":1,"slide":{"layout":"content","elements":[],"icon":"brain","imageKeyword":"ai"}}';
    const { patch } = parseSlideshowJson(json, false);
    expect(patch).not.toBeNull();
    expect(patch!.slide.icon).toBe("brain");
    expect(patch!.slide.imageKeyword).toBe("ai");
  });
});
