import assert from "node:assert/strict";
import { test } from "node:test";
import { inline, parse } from "./md.ts";

test("inline bold and code", () => {
  assert.deepEqual(inline("use **GOGC** and `GOMEMLIMIT`"), [
    { kind: "text", text: "use " },
    { kind: "bold", text: "GOGC" },
    { kind: "text", text: " and " },
    { kind: "code", text: "GOMEMLIMIT" },
  ]);
  assert.deepEqual(inline("2 * 3 = 6"), [{ kind: "text", text: "2 * 3 = 6" }]);
});

test("answer layout: line, bullets, code", () => {
  const b = parse("Short answer.\n- one\n- **two**\n\n1. first\n2) second\n```go\nfmt.Println()\n```\ntail");
  assert.deepEqual(
    b.map((x) => x.kind),
    ["p", "ul", "ol", "code", "p"],
  );
  assert.equal(b[1].kind === "ul" && b[1].items.length, 2);
  assert.equal(b[3].kind === "code" && b[3].text, "fmt.Println()");
});

test("streaming: an unclosed fence and blank lines", () => {
  const b = parse("```\nlet x");
  assert.deepEqual(b, [{ kind: "code", text: "let x" }]);
  assert.deepEqual(parse("\n\n"), []);
  const p = parse("a\nb");
  assert.equal(p.length === 1 && p[0].kind === "p" && p[0].lines.length, 2);
});
