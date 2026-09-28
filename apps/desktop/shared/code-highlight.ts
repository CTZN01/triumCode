import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, javascript, json, markdown, python, typescript, xml, yaml })) {
    hljs.registerLanguage(name, language);
}

const LANGUAGE_BY_SUFFIX: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
    py: "python", sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml",
};

export function codeLanguage(path: string): string | null {
    const suffix = path.replace(/^"|"$/g, "").split(".").at(-1)?.toLowerCase() ?? "";
    return LANGUAGE_BY_SUFFIX[suffix] ?? null;
}

/** Keep multiline token spans balanced in each independently rendered code row. */
export function highlightCodeLines(code: string, language: string | null): string[] {
    const escaped = () => code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    let html: string;
    try { html = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escaped(); }
    catch { html = escaped(); }
    const result: string[] = [];
    const spans: string[] = [];
    let line = "";
    for (const token of html.match(/<[^>]+>|\n|[^<\n]+/g) ?? []) {
        if (token === "\n") {
            result.push(line + "</span>".repeat(spans.length));
            line = spans.join("");
        } else {
            if (token.startsWith("<span")) spans.push(token);
            else if (token === "</span>") spans.pop();
            line += token;
        }
    }
    result.push(line + "</span>".repeat(spans.length));
    return result;
}
