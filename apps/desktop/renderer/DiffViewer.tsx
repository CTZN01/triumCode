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

function renderLine(line: DiffLine, key: number) {
    return <div className={`diff-line ${line.kind}`} key={key}>
        <span className="diff-line-number">{line.oldLine ?? ""}</span>
        <span className="diff-line-number">{line.newLine ?? ""}</span>
        <span className="diff-line-text">{line.text}</span>
    </div>;
}

function preambleKind(line: string): DiffLine["kind"] {
    return line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")
        ? "meta"
        : "context";
}

export function DiffViewer({ diff }: { diff: string }) {
    const parsed = parseDiff(diff);
    return <div className="diff-viewer" role="group" aria-label="代码差异，包含旧版和新版行号">
        {parsed.truncated && <div className="git-truncated-notice">差异行数超过界面显示上限，已截断。</div>}
        <div className="diff-column-heading" aria-hidden="true"><span>旧版</span><span>新版</span><span>差异</span></div>
        {parsed.preamble.length > 0 && <div className="diff-preamble">
            {parsed.preamble.map((text, index) => renderLine({
                text,
                oldLine: null,
                newLine: null,
                kind: preambleKind(text),
            }, index))}
        </div>}
        {parsed.hunks.map((hunk, hunkIndex) => <details className="diff-hunk" open key={`${hunkIndex}-${hunk.header}`}>
            <summary className="diff-hunk-heading">{hunk.header}</summary>
            <div className="diff-hunk-lines">
                {hunk.lines.map((line, lineIndex) => renderLine(line, lineIndex))}
            </div>
        </details>)}
    </div>;
}
