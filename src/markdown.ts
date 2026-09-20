// ═══════════════════════════════════════════════════════════════
// Terminal markdown for streamed model output
// ═══════════════════════════════════════════════════════════════
//
// Deliberately partial. Model output in a terminal wants to stay close to
// plain text: the markers people react to are the ones that break the flow —
// `**bold**` printing its asterisks, `## Heading` printing its hashes, `- item`
// printing a hyphen. Those are handled. Tables and alignment are not: a table
// needs column widths, and column widths need the whole table, which a stream
// does not have.
//
// Streaming is the constraint that shapes everything here. Output must appear
// as it arrives — buffering whole lines would turn a live stream into text that
// lands a paragraph at a time. So the renderer keeps a little state (which line
// it is in, whether bold/code is open) and holds back only the characters whose
// meaning is not yet decided:
//
//   • a line start, until it is clear it is not a heading, list or fence
//   • a trailing `*`, which may be the first half of `**`
//
// Everything else is emitted immediately and in order, so the byte stream the
// user sees is still the model's stream.
//
// Deliberately NOT handled:
//   • `_italic_` / `*italic*` — `snake_case_names` are everywhere in this
//     domain, and one rule that styles them as italic is worse than no rule
//   • links, tables, images, HTML, strikethrough
//
// Markdown inside a fenced code block is left alone. Models emit code
// constantly, and styling a `**` that appears inside a code comment is a bug
// with a very confusing symptom.

/** The styling the renderer applies. Injected so this module owns no palette. */
export interface MarkdownStyles {
    bold: (text: string) => string;
    muted: (text: string) => string;
    accent: (text: string) => string;
    code: (text: string) => string;
}

/** Identity styles, for tests and for callers with no colors. */
export const PLAIN_STYLES: MarkdownStyles = {
    bold: (text) => text,
    muted: (text) => text,
    accent: (text) => text,
    code: (text) => text,
};

/** What kind of line the renderer is currently inside. */
type LineKind = "plain" | "heading" | "bullet" | "ordered" | "fence" | "literal";

const FENCE = "```";
const HEADING = /^(#{1,6})\s+/;
const BULLET = /^(\s*)[-*+]\s+/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+/;

/**
 * True while a partial line could still turn out to be a heading, list item or
 * fence. Only ever true for a short prefix — the moment a character rules the
 * markers out, the line is emitted as ordinary text.
 */
function isUndecided(partial: string): boolean {
    if (partial === "") return true;
    if (FENCE.startsWith(partial)) return true;
    if (/^#{1,6}$/.test(partial)) return true;
    // Leading indentation alone says nothing yet.
    if (/^\s*$/.test(partial)) return true;
    if (/^\s*[-*+]$/.test(partial)) return true;
    if (/^\s*\d{1,3}$/.test(partial)) return true;
    if (/^\s*\d{1,3}\.$/.test(partial)) return true;
    return false;
}

/** Odd trailing run of `*` means one of them may still pair with what comes next. */
function hasUnpairedTrailingStar(text: string): boolean {
    let count = 0;
    for (let i = text.length - 1; i >= 0 && text[i] === "*"; i--) count++;
    return count % 2 === 1;
}

export class MarkdownStream {
    private readonly styles: MarkdownStyles;

    private atLineStart = true;
    /** Chars held while the line start is still undecided. */
    private pending = "";
    private kind: LineKind = "plain";
    private inFence = false;

    // Inline state, reset at every newline.
    private bold = false;
    private code = false;
    /** A trailing `*` held back until the next chunk decides what it is. */
    private tail = "";

    constructor(styles: MarkdownStyles = PLAIN_STYLES) {
        this.styles = styles;
    }

    /**
     * Render one streamed chunk. The return value is what to print, and may be
     * empty — that means the chunk was entirely held back, so the caller must
     * not print anything (not even a newline) for it.
     */
    write(text: string): string {
        let out = "";
        let rest = text;
        while (true) {
            const newline = rest.indexOf("\n");
            if (newline === -1) {
                out += this.consume(rest, false);
                break;
            }
            out += this.consume(rest.slice(0, newline), true);
            rest = rest.slice(newline + 1);
            if (rest === "") break;
        }
        return out;
    }

    /**
     * Emit whatever is still held back, for the end of a stream. A held `*` or
     * an unfinished line start is real model output, so it is never dropped.
     */
    flush(): string {
        const pending = this.pending;
        this.pending = "";
        let out = "";
        if (this.inFence) {
            out += pending;
        } else {
            this.kind = "plain";
            out += this.inline(pending, true);
        }
        if (this.tail) {
            out += this.tail;
            this.tail = "";
        }
        return out;
    }

    /** Drop all state. Called when a test's fake terminal starts clean. */
    reset(): void {
        this.atLineStart = true;
        this.pending = "";
        this.kind = "plain";
        this.inFence = false;
        this.bold = false;
        this.code = false;
        this.tail = "";
    }

    // ── Line handling ───────────────────────────────────────────

    private consume(text: string, hasNewline: boolean): string {
        // Inside a fence nothing is interpreted, and closing a fence needs the
        // whole line — so this is the one place a line is buffered. Code is not
        // streamed word-by-word in any way a reader notices.
        if (this.inFence) {
            this.pending += text;
            if (!hasNewline) return "";
            const line = this.pending;
            this.pending = "";
            this.atLineStart = true;
            if (/^\s*```/.test(line)) {
                this.inFence = false;
                return this.styles.muted(line) + "\n";
            }
            return line + "\n";
        }

        if (this.atLineStart) {
            this.pending += text;
            if (!hasNewline && isUndecided(this.pending)) return "";
            const line = this.pending;
            this.pending = "";
            const decided = this.decide(line);
            this.kind = decided.kind;
            let out = decided.prefix + this.content(decided.rest, hasNewline);
            if (hasNewline) {
                out += "\n";
                this.endLine();
            } else {
                this.atLineStart = false;
            }
            return out;
        }

        let out = this.content(text, hasNewline);
        if (hasNewline) {
            out += "\n";
            this.endLine();
        }
        return out;
    }

    /** Classify a decided line start and render whatever replaces its marker. */
    private decide(line: string): { prefix: string; kind: LineKind; rest: string } {
        if (/^```/.test(line)) {
            this.inFence = true;
            return { prefix: this.styles.muted(line), kind: "fence", rest: "" };
        }

        const heading = HEADING.exec(line);
        if (heading) {
            // The hashes are the marker; the text is what matters.
            return { prefix: "", kind: "heading", rest: line.slice(heading[0].length) };
        }

        const bullet = BULLET.exec(line);
        if (bullet) {
            return {
                prefix: bullet[1] + this.styles.muted("•") + " ",
                kind: "bullet",
                rest: line.slice(bullet[0].length),
            };
        }

        const ordered = ORDERED.exec(line);
        if (ordered) {
            return {
                prefix: ordered[1] + this.styles.accent(`${ordered[2]}.`) + " ",
                kind: "ordered",
                rest: line.slice(ordered[0].length),
            };
        }

        return { prefix: "", kind: "plain", rest: line };
    }

    /** Style one run of line content according to the kind of line it is on. */
    private content(text: string, endOfLine: boolean): string {
        switch (this.kind) {
            case "fence":
            case "literal":
                return text;
            case "heading":
                // A heading is bold as a whole. Inline markers inside it are
                // left as written rather than parsed — a heading is short, and
                // half-parsing it would be worse than not parsing it. The empty
                // guard keeps a heading that ends mid-stream from emitting an
                // empty styled span.
                return text ? this.styles.bold(text) : "";
            default:
                return this.inline(text, endOfLine);
        }
    }

    private endLine(): void {
        this.atLineStart = true;
        this.kind = "plain";
        this.bold = false;
        this.code = false;
        this.tail = "";
    }

    // ── Inline handling ─────────────────────────────────────────

    /**
     * Render `**bold**` and `` `code` `` incrementally. Text between markers is
     * emitted as it arrives — the state machine toggles on the markers rather
     * than pre-parsing the line, which is what keeps this streaming-safe.
     */
    private inline(text: string, endOfLine: boolean): string {
        if (this.tail) {
            text = this.tail + text;
            this.tail = "";
        }

        // Hold back a `*` that may still pair with the next chunk's. Only at a
        // chunk boundary: once the line has ended, an odd `*` is literal.
        if (!endOfLine && !this.code && hasUnpairedTrailingStar(text)) {
            this.tail = "*";
            text = text.slice(0, -1);
        }

        let out = "";
        let buffer = "";
        const flush = (): void => {
            if (!buffer) return;
            out += this.paint(buffer);
            buffer = "";
        };

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (this.code) {
                if (ch === "`") {
                    flush();
                    this.code = false;
                    continue;
                }
                buffer += ch;
                continue;
            }
            if (ch === "`") {
                flush();
                this.code = true;
                continue;
            }
            if (ch === "*" && text[i + 1] === "*") {
                flush();
                this.bold = !this.bold;
                i++;
                continue;
            }
            buffer += ch;
        }
        flush();
        return out;
    }

    private paint(text: string): string {
        if (!text) return "";
        if (this.code) return this.styles.code(text);
        if (this.bold) return this.styles.bold(text);
        return text;
    }
}
