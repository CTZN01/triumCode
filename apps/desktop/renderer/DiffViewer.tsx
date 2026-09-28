import { memo, useMemo } from "react";
import { codeLanguage, highlightCodeLines } from "../shared/code-highlight.js";

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
        if (match && match[1] !== "/dev/null") return codeLanguage(match[1]);
    }
    const oldFile = preamble.find((line) => line.startsWith("--- "));
    return oldFile ? codeLanguage(oldFile.slice(4)) : null;
}

function highlightHunk(hunk: DiffHunk, language: string | null): Array<string | null> {
    const oldRows = hunk.lines.filter((line) => line.kind === "context" || line.kind === "deletion");
    const newRows = hunk.lines.filter((line) => line.kind === "context" || line.kind === "addition");
    const before = highlightCodeLines(oldRows.map((line) => line.text.slice(1)).join("\n"), language);
    const after = highlightCodeLines(newRows.map((line) => line.text.slice(1)).join("\n"), language);
    let oldIndex = 0;
    let newIndex = 0;
    return hunk.lines.map((line) => {
        if (line.kind === "context") { oldIndex++; return after[newIndex++]; }
        if (line.kind === "deletion") return before[oldIndex++];
        if (line.kind === "addition") return after[newIndex++];
        return null;
    });
}

function renderLine(line: DiffLine, key: number, html: string | null, compact: boolean) {
    return <div className={`diff-line ${line.kind}`} key={key}>
        {compact ? <span className="diff-line-number" title={`旧行 ${line.oldLine ?? "-"} / 新行 ${line.newLine ?? "-"}`}>{line.kind === "deletion" ? line.oldLine : line.newLine}</span> : <><span className="diff-line-number">{line.oldLine ?? ""}</span><span className="diff-line-number">{line.newLine ?? ""}</span></>}
        <span className="diff-line-text">
            {!compact && <span className="diff-prefix">{line.text[0]}</span>}
            {html === null ? line.text.slice(1) : <span className="diff-code" dangerouslySetInnerHTML={{ __html: html }} />}
        </span>
    </div>;
}

export const DiffViewer = memo(function DiffViewer({ diff, compact = false, filePath }: { diff: string; compact?: boolean; filePath?: string }) {
    const parsed = useMemo(() => parseDiff(diff), [diff]);
    const language = useMemo(() => filePath ? codeLanguage(filePath) : languageFromPreamble(parsed.preamble), [filePath, parsed]);
    const highlights = useMemo(() => parsed.hunks.map((hunk) => highlightHunk(hunk, language)), [parsed, language]);
    return <div className={`diff-viewer${compact ? " compact-diff" : ""}`} role="group" aria-label="代码差异，包含旧版和新版行号">
        {parsed.truncated && <div className="git-truncated-notice">差异行数超过界面显示上限，已截断。</div>}
        {!compact && parsed.preamble.length > 0 && <div className="diff-preamble">
            {parsed.preamble.map((text, index) => renderLine({
                text,
                oldLine: null,
                newLine: null,
                kind: preambleKind(text),
            }, index, null, false))}
        </div>}
        {parsed.hunks.map((hunk, hunkIndex) => <details className="diff-hunk" open key={`${hunkIndex}-${hunk.header}`}>
            <summary className="diff-hunk-heading">{compact ? `变更块 ${hunkIndex + 1}` : hunk.header}</summary>
            <div className="diff-hunk-lines">
                {hunk.lines.map((line, lineIndex) => renderLine(line, lineIndex, highlights[hunkIndex][lineIndex], compact))}
            </div>
        </details>)}
    </div>;
});
