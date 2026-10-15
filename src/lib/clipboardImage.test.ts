import { describe, it, expect } from "vitest";
import { imageFromClipboard, pastePathText, windowsPasteText, PASTEABLE_IMAGE_TYPES } from "./clipboardImage";

// Minimal DataTransfer stand-in: jsdom's is not constructible with files.
function dt(opts: { types?: string[]; files?: File[]; items?: Array<{ kind: string; type: string; file?: File }> }) {
  return {
    types: opts.types ?? [],
    files: opts.files ?? [],
    items: (opts.items ?? []).map(i => ({ ...i, getAsFile: () => i.file ?? null })),
  } as unknown as DataTransfer;
}
const png = (name = "shot.png") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

describe("imageFromClipboard", () => {
  it("finds a screenshot pasted as a file", () => {
    expect(imageFromClipboard(dt({ types: ["Files"], files: [png()] }))?.name).toBe("shot.png");
  });

  it("falls back to items, which is how a web-page image copy arrives", () => {
    const f = png("from-web.png");
    const got = imageFromClipboard(dt({ types: ["Files"], items: [{ kind: "file", type: "image/png", file: f }] }));
    expect(got?.name).toBe("from-web.png");
  });

  it("leaves an ordinary text paste alone", () => {
    expect(imageFromClipboard(dt({ types: ["text/plain"] }))).toBeNull();
    expect(imageFromClipboard(null)).toBeNull();
    expect(imageFromClipboard(undefined)).toBeNull();
  });

  it("treats a mixed text+image paste as text", () => {
    // Copying a chunk of a web page carries both. Pasting an article does
    // not mean "save this favicon to disk", and hijacking it would break
    // the single most common paste in the app.
    const mixed = dt({ types: ["text/plain", "Files"], files: [png()] });
    expect(imageFromClipboard(mixed)).toBeNull();
  });

  it("ignores a non-image file", () => {
    const pdf = new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" });
    expect(imageFromClipboard(dt({ types: ["Files"], files: [pdf] }))).toBeNull();
    expect(PASTEABLE_IMAGE_TYPES).not.toContain("application/pdf");
  });
});

describe("pastePathText", () => {
  it("escapes the space every one of these paths actually has", () => {
    // The clipboard dir lives under ~/Library/Application Support/termic, so
    // an unescaped path is not a rare edge case, it is every single paste.
    const out = pastePathText("/Users/x/Library/Application Support/termic/clipboard/pasted-1-ab.png", true, false);
    expect(out).toContain("Application\\ Support");
    expect(out.endsWith(" ")).toBe(true);
    expect(out).not.toContain("Application Support");
  });

  it("escapes the rest of what a shell would eat", () => {
    expect(pastePathText("/tmp/a(1)&b'c.png", true, false)).toContain("a\\(1\\)\\&b\\'c.png");
  });

  it("leaves an ordinary path readable", () => {
    expect(pastePathText("/tmp/shot.png", true, false)).toBe("/tmp/shot.png ");
  });

  it("gives a Windows Docker task the container's view of the path", () => {
    expect(pastePathText("C:\\Users\\u\\Temp\\pasted-1-ab.png", true, true)).toBe("/c/Users/u/Temp/pasted-1-ab.png ");
  });

  it("gives a Windows task outside Docker the native path, quoted only when it must be", () => {
    // Backslash-escaping would corrupt it: the separators are backslashes.
    expect(pastePathText("C:\\Users\\u\\Temp\\pasted-1-ab.png", false, true)).toBe("C:\\Users\\u\\Temp\\pasted-1-ab.png ");
    expect(pastePathText("C:\\Users\\bob smith\\Temp\\p.png", false, true)).toBe('"C:\\Users\\bob smith\\Temp\\p.png" ');
  });
});

describe("windowsPasteText", () => {
  const image = () => Promise.resolve("C:\\Users\\u\\Temp\\pasted-1-ab.png");
  const noImage = () => Promise.reject(new Error("no image"));

  it("pastes the text and never reads the image when there is text", async () => {
    let asked = false;
    const got = await windowsPasteText(() => Promise.resolve("hello"), () => { asked = true; return image(); }, false, true);
    expect(got).toBe("hello");
    expect(asked).toBe(false);
  });

  it("pastes the image's path when the clipboard holds no text", async () => {
    expect(await windowsPasteText(() => Promise.resolve(""), image, false, true))
      .toBe("C:\\Users\\u\\Temp\\pasted-1-ab.png ");
  });

  it("treats a rejected text read as no text, which an image-only clipboard may do", async () => {
    expect(await windowsPasteText(() => Promise.reject(new Error("denied")), image, false, true))
      .toBe("C:\\Users\\u\\Temp\\pasted-1-ab.png ");
  });

  it("pastes nothing when the clipboard holds neither", async () => {
    expect(await windowsPasteText(() => Promise.resolve(""), noImage, false, true)).toBeNull();
  });
});
