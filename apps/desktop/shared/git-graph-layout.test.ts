import assert from "node:assert/strict";
import test from "node:test";
import type { GitCommitSummary } from "./contracts.js";
import { layoutGitGraph } from "./git-graph-layout.js";

function commit(hash: string, graph: string, parents: string[]): GitCommitSummary {
    return { hash, graph, parents, subject: hash, author: "Author", authoredAt: "2026-01-01T00:00:00Z", decorations: "" };
}

test("straight history uses real parent edges and keeps one color", () => {
    const layout = layoutGitGraph([commit("c", "* ", ["b"]), commit("b", "* ", ["a"]), commit("a", "* ", [])]);
    assert.deepEqual(layout.edges.map(({ child, parent }) => [child, parent]), [["c", "b"], ["b", "a"]]);
    assert.deepEqual(layout.nodes.map(({ lane, color }) => [lane, color]), [[0, 0], [0, 0], [0, 0]]);
    assert.ok(layout.edges.every((edge) => edge.path.includes(" V ")));
});

test("fork and merge connect only the actual parents", () => {
    const commits = [
        commit("merge", "*   ", ["main", "side"]),
        commit("main", "* | ", ["base"]),
        commit("side", "| * ", ["base"]),
        commit("base", "* ", []),
    ];
    const layout = layoutGitGraph(commits);
    assert.deepEqual(layout.edges.map(({ child, parent }) => [child, parent]), [
        ["merge", "main"], ["merge", "side"], ["main", "base"], ["side", "base"],
    ]);
    assert.equal(layout.edges.find((edge) => edge.child === "merge" && edge.parent === "side")?.firstParent, false);
    assert.equal(layout.nodes.find((node) => node.hash === "side")?.lane, 1);
    assert.notEqual(layout.nodes.find((node) => node.hash === "main")?.color, layout.nodes.find((node) => node.hash === "side")?.color);
});

test("a reused lane gets a new color and invisible parents get no invented edge", () => {
    const layout = layoutGitGraph([
        commit("tip-a", "| * ", ["base-a"]),
        commit("base-a", "* ", []),
        commit("tip-b", "| * ", ["outside"]),
    ]);
    assert.notEqual(layout.nodes[0].color, layout.nodes[2].color);
    assert.deepEqual(layout.edges.map(({ child, parent }) => [child, parent]), [["tip-a", "base-a"]]);
});
