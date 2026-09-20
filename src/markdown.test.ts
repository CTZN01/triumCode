import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownStream, type MarkdownStyles } from "./markdown.js";

// ═══════════════════════════════════════════════════════════════
// Terminal markdown for streamed output
// ═══════════════════════════════════════════════════════════════
//
// Styles are tag functions rather than colors, so the assertions read as
// structure ("this run came out bold") instead of escape bytes. What the user
// sees is `strip(out)`.

const STYLES: MarkdownStyles = {
    bold: (text) => `<b>${text}</b>`,
    muted: (text) => `<m>${text}</m>`,
    accent: (text) => `<a>${text}</a>`,
    code: (text) => `<c>${text}</c>`,
};

const strip = (text: string): string => text.replace(/<\/?[bmac]>/g, "");

/** Everything a stream produced, including what it was holding at the end. */
function run(chunks: string[], styles: MarkdownStyles = STYLES): string {
    const md = new MarkdownStream(styles);
    return chunks.map((chunk) => md.write(chunk)).join("") + md.flush();
}

// ── Streaming contract ───────────────────────────────────────

test("plain text streams through unchanged, chunk by chunk", () => {
    // The property the existing tests depend on: text is not buffered into
    // lines, it comes out as the model writes it.
    const md = new MarkdownStream();
    assert.equal(md.write("Hello"), "Hello");
    assert.equal(md.write(" world"), " world");
    assert.equal(md.write(", again"), ", again");
    assert.equal(md.flush(), "");
});

test("blank lines and paragraph breaks survive", () => {
    assert.equal(run(["a\n\nb"]), "a\n\nb");
    assert.equal(run(["a\n", "\n", "b"]), "a\n\nb");
});

test("a chunk that is entirely held back renders as nothing", () => {
    // Callers skip an empty result rather than printing a blank line or
    // stopping the spinner for it.
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("-"), "");
    assert.equal(md.write(" item"), "<m>•</m> item");
});

// ── Inline styling ───────────────────────────────────────────

test("bold and inline code lose their markers", () => {
    assert.equal(run(["run **npm test** now"]), "run <b>npm test</b> now");
    assert.equal(run(["see `src/ui.ts`"]), "see <c>src/ui.ts</c>");
});

test("bold split across chunks is still one span", () => {
    const out = run(["run **bo", "ld** now"]);
    assert.equal(strip(out), "run bold now");
    assert.doesNotMatch(out, /\*/, "no marker survives");
});

test("a bold pair split between its two asterisks renders", () => {
    const out = run(["a **", "b**"]);
    assert.equal(strip(out), "a b");
    assert.doesNotMatch(out, /\*/);
});

test("a lone trailing asterisk is held, then printed as written", () => {
    // Held only while it could still open a bold run; at the end of the stream
    // it is emitted rather than dropped.
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("2 *"), "2 ");
    assert.equal(md.flush(), "*");
});

test("an asterisk inside a word is left alone", () => {
    assert.equal(run(["a*b"]), "a*b");
});

test("asterisks inside inline code are literal", () => {
    assert.equal(run(["`a ** b`"]), "<c>a ** b</c>");
});

test("underscores are never styled", () => {
    // Underscore italics are deliberately unsupported: snake_case identifiers
    // are everywhere in this domain and one rule that breaks them is worse than
    // no rule at all.
    assert.equal(run(["call snake_case_name here"]), "call snake_case_name here");
    assert.equal(run(["__dunder__ method"]), "__dunder__ method");
});

// ── Block styling ────────────────────────────────────────────

test("a heading loses its hashes and comes out bold", () => {
    assert.equal(run(["# Title"]), "<b>Title</b>");
    assert.equal(run(["###### Deep"]), "<b>Deep</b>");
    assert.equal(run(["# Title\nafter"]), "<b>Title</b>\nafter");
});

test("a heading split after the hashes still renders", () => {
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("#"), "");           // could still become ##, ###...
    assert.equal(md.write(" Title"), "<b>Title</b>");
    assert.equal(md.flush(), "");
});

test("bullets replace the list marker and keep indentation", () => {
    assert.equal(run(["- one"]), "<m>•</m> one");
    assert.equal(run(["* one"]), "<m>•</m> one");
    assert.equal(run(["+ one"]), "<m>•</m> one");
    assert.equal(run(["- one\n  - two"]), "<m>•</m> one\n  <m>•</m> two");
    assert.equal(run(["  - two"]), "  <m>•</m> two");
});

test("a line that opens with ** is bold, not a bullet", () => {
    // A bullet needs the space; without it the asterisks are a bold marker.
    assert.equal(run(["**bold**"]), "<b>bold</b>");
    assert.equal(run(["-- flag"]), "-- flag");
});

test("ordered lists keep their numbers, styled", () => {
    assert.equal(run(["1. first"]), "<a>1.</a> first");
    assert.equal(run(["12) twelfth"]), "<a>12.</a> twelfth");
    assert.equal(run(["1. first\n2. second"]), "<a>1.</a> first\n<a>2.</a> second");
});

test("a bare number is not yet a list item", () => {
    // "1." alone could still be a sentence; only the space decides it.
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("1."), "");
    assert.equal(md.write(" item"), "<a>1.</a> item");
});

test("a digit that starts ordinary prose is left alone", () => {
    assert.equal(run(["2026 was a year"]), "2026 was a year");
});

// ── Fenced code ──────────────────────────────────────────────

test("markdown inside a fenced block is left alone", () => {
    const input = "```\n**not bold**\n- not a list\n```\n";
    assert.equal(strip(run([input])), input);
});

test("a fence split across chunks still protects its contents", () => {
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("``"), "");                  // could still become ```
    assert.equal(md.write("`\n**literal**\n"), "<m>```</m>\n**literal**\n");
    assert.equal(md.flush(), "", "still inside the fence");
});

test("text after a closing fence is styled again", () => {
    assert.equal(strip(run(["```\ncode\n```\n**bold**"])), "```\ncode\n```\nbold");
});

// ── State ────────────────────────────────────────────────────

test("reset drops held markers and line state", () => {
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("**bold**\n-"), "<b>bold</b>\n");   // the "-" is held
    md.reset();
    assert.equal(md.flush(), "");
    assert.equal(md.write("plain"), "plain");
});

test("reset closes an unclosed bold or fence", () => {
    // A message that ends mid-marker must not carry the state into the next
    // one, or the rest of the reply renders inside it.
    const bolded = new MarkdownStream(STYLES);
    bolded.write("**unclosed");
    bolded.reset();
    assert.equal(bolded.write("next message"), "next message");

    const fenced = new MarkdownStream(STYLES);
    fenced.write("```\ncode\n");
    fenced.reset();
    assert.equal(fenced.write("next message"), "next message");
});

test("flush releases a line start that never resolved into a marker", () => {
    const md = new MarkdownStream(STYLES);
    assert.equal(md.write("-"), "");
    assert.equal(md.flush(), "-");
});
