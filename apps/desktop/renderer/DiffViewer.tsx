import { memo, useMemo } from "react";
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

interface DiffLine {
    text: string;
    oldLine: number | null;
    newLine: number | null;
    kind: "context" | "addition" | "deletion" | "meta";
}

interface DiffHunk {
    header: string;
    lines: DiffLine[];
}

interface ParsedDiff {
    preamble: string[];
    hunks: DiffHunk[];
    truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const MAX_RENDERED_DIFF_LINES = 12_000;

const LANGUAGE_BY_SUFFIX: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
    py: "python", sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml",
};

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);

function parseDiff(diff: string): ParsedDiff {
    const lines = diff.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const truncated = lines.length > MAX_RENDERED_DIFF_LINES;
    if (truncated) lines.length = MAX_RENDERED_DIFF_LINES;

    const preamble: string[] = [];
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
        const header = line.match(HUNK_HEADER);
        if (header) {
            current = { header: line, lines: [] };
            hunks.push(current);
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            continue;
        }
        if (!current) {
            preamble.push(line);
            continue;
        }

        const prefix = line[0];
        if (prefix === " ") {
            current.lines.push({ text: line, oldLine: oldLine++, newLine: newLine++, kind: "context" });
        } else if (prefix === "-") {
            current.lines.push({ text: line, oldLine: oldLine++, newLine: null, kind: "deletion" });
        } else if (prefix === "+") {
            current.lines.push({ text: line, oldLine: null, newLine: newLine++, kind: "addition" });
        } else {
            current.lines.push({ text: line, oldLine: null, newLine: null, kind: "meta" });
        }
    }

    return { preamble, hunks, truncated };
}

function preambleKind(line: string): DiffLine["kind"] {
    return line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")
        ? "meta"
        : "context";
}

function languageFromPreamble(preamble: string[]): string | null {
    for (const line of preamble) {
        const match = /^\+\+\+ (?:[ab]\/)?(.+)$/.exec(line);
        if (!match) continue;
        const suffix = match[1].split(".").at(-1)?.toLowerCase() ?? "";
        return LANGUAGE_BY_SUFFIX[suffix] ?? null;
    }
    return null;
}

function highlightLine(line: DiffLine, language: string | null): string | null {
    if (!language || line.kind === "meta") return null;
    try {
        return hljs.highlight(line.text.slice(1), { language, ignoreIllegals: true }).value;
    } catch {
        return null;
    }
}

function renderLine(line: DiffLine, key: number, language: string | null) {
    const html = highlightLine(line, language);
    return <div className={`diff-line ${line.kind}`} key={key}>
        <span className="diff-line-number">{line.oldLine ?? ""}</span>
        <span className="diff-line-number">{line.newLine ?? ""}</span>
        {html === null
            ? <span className="diff-line-text">{line.text}</span>
            : <span className="diff-line-text">{line.text[0] === " " ? " " : <span className="diff-prefix">{line.text[0]}</span>}<span className="diff-code" dangerouslySetInnerHTML={{ __html: html }} /></span>}
    </div>;
}

export const DiffViewer = memo(function DiffViewer({ diff }: { diff: string }) {
    const parsed = useMemo(() => parseDiff(diff), [diff]);
    const language = useMemo(() => languageFromPreamble(parsed.preamble), [parsed]);
    return <div className="diff-viewer" role="group" aria-label="代码差异，包含旧版和新版行号">
        {parsed.truncated && <div className="git-truncated-notice">差异行数超过界面显示上限，已截断。</div>}
        {parsed.preamble.length > 0 && <div className="diff-preamble">
            {parsed.preamble.map((text, index) => renderLine({
                text,
                oldLine: null,
                newLine: null,
                kind: preambleKind(text),
            }, index, language))}
        </div>}
        {parsed.hunks.map((hunk, hunkIndex) => <details className="diff-hunk" open key={`${hunkIndex}-${hunk.header}`}>
            <summary className="diff-hunk-heading">{hunk.header}</summary>
            <div className="diff-hunk-lines">
                {hunk.lines.map((line, lineIndex) => renderLine(line, lineIndex, language))}
            </div>
        </details>)}
    </div>;
});
