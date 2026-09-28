import assert from "node:assert/strict";
import { test } from "node:test";
import { codeLanguage, highlightCodeLines } from "./code-highlight.js";

test("file paths select TypeScript and JSX syntax highlighting", () => {
    assert.equal(codeLanguage('"src/Component.tsx"'), "typescript");
    const html = highlightCodeLines('const item = <span className="label">Hello</span>;', codeLanguage("Component.tsx"))[0];
    assert.match(html, /hljs-keyword/);
    assert.match(html, /hljs-string/);
    assert.doesNotMatch(html, /<span className=/);
});

test("multiline comments and template strings keep their colors and balanced spans", () => {
    const output = highlightCodeLines("/* first\nsecond */\nconst message = `first\nsecond`;", "typescript");
    assert.equal(output.length, 4);
    assert.match(output[1], /hljs-comment/);
    assert.match(output[3], /hljs-string/);
    for (const line of output) {
        assert.equal(line.match(/<span\b/g)?.length ?? 0, line.match(/<\/span>/g)?.length ?? 0);
    }
});

test("unsupported files display escaped source without injecting HTML", () => {
    assert.equal(codeLanguage("file.unknown"), null);
    assert.deepEqual(highlightCodeLines('<img src="x" onerror="alert(1)"> &', null), ['&lt;img src="x" onerror="alert(1)"&gt; &amp;']);
});
