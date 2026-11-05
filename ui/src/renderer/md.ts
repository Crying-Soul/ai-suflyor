// The small Markdown subset Claude's answers use: paragraphs, "-"/"*" bullets, numbered lists,
// **bold**, `code` and ``` fences. Built as DOM nodes with textContent, never innerHTML,
// so model output cannot inject markup and the page CSP stays strict.

export type Inline = { kind: "text" | "bold" | "code"; text: string };
export type Block =
  | { kind: "p"; lines: Inline[][] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "code"; text: string };

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  for (const part of s.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ kind: "bold", text: part.slice(2, -2) });
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push({ kind: "code", text: part.slice(1, -1) });
    else out.push({ kind: "text", text: part });
  }
  return out;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;

export function parse(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = blocks[blocks.length - 1];
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      // An unclosed fence (still streaming) runs to the end.
      while (++i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
    } else if (BULLET.test(line) || NUMBER.test(line)) {
      const kind = BULLET.test(line) ? "ul" : "ol";
      const item = inline(line.replace(kind === "ul" ? BULLET : NUMBER, ""));
      if (last?.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] }); // paragraph break; empty ones are dropped below
    } else {
      // Headings are not expected (the prompt forbids them); show them as bold text.
      const text = line.replace(/^#{1,6}\s+/, "");
      const content = text === line ? inline(line) : [{ kind: "bold" as const, text }];
      if (last?.kind === "p" && last.lines.length) last.lines.push(content);
      else blocks.push({ kind: "p", lines: [content] });
    }
  }
  return blocks.filter((b) => b.kind !== "p" || b.lines.length);
}

function inlineNodes(parts: Inline[]): Node[] {
  return parts.map((p) => {
    if (p.kind === "text") return document.createTextNode(p.text);
    const e = document.createElement(p.kind === "bold" ? "strong" : "code");
    e.textContent = p.text;
    return e;
  });
}

export function render(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of parse(md)) {
    if (b.kind === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = b.text;
      pre.append(code);
      frag.append(pre);
    } else if (b.kind === "p") {
      const p = document.createElement("p");
      b.lines.forEach((l, i) => {
        if (i) p.append(document.createElement("br"));
        p.append(...inlineNodes(l));
      });
      frag.append(p);
    } else {
      const list = document.createElement(b.kind);
      for (const item of b.items) {
        const li = document.createElement("li");
        li.append(...inlineNodes(item));
        list.append(li);
      }
      frag.append(list);
    }
  }
  return frag;
}
