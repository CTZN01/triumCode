import type { GitCommitSummary } from "./contracts.js";

export interface GitGraphNode {
    hash: string;
    row: number;
    lane: number;
    x: number;
    y: number;
    color: number;
}

export interface GitGraphEdge {
    child: string;
    parent: string;
    firstParent: boolean;
    color: number;
    path: string;
}

export interface GitGraphLayout {
    nodes: GitGraphNode[];
    edges: GitGraphEdge[];
    width: number;
    height: number;
}

const ROW_HEIGHT = 34;
const LANE_WIDTH = 24;
const NODE_X = 14;

export function layoutGitGraph(commits: GitCommitSummary[]): GitGraphLayout {
    const lastByLane = new Map<number, GitGraphNode>();
    let nextColor = 0;
    const nodes = commits.map((commit, row) => {
        const lane = Math.max(0, Math.floor(commit.graph.indexOf("*") / 2));
        const previous = lastByLane.get(lane);
        const color = previous && commits[previous.row].parents.includes(commit.hash) ? previous.color : nextColor++;
        const node = { hash: commit.hash, row, lane, x: NODE_X + lane * LANE_WIDTH, y: row * ROW_HEIGHT + ROW_HEIGHT / 2, color };
        lastByLane.set(lane, node);
        return node;
    });
    const byHash = new Map(nodes.map((node) => [node.hash, node]));
    const edges: GitGraphEdge[] = [];
    for (const child of nodes) {
        for (const [index, parentHash] of commits[child.row].parents.entries()) {
            const parent = byHash.get(parentHash);
            if (!parent || parent.row <= child.row) continue;
            const firstParent = index === 0;
            let path: string;
            if (child.x === parent.x) {
                path = `M ${child.x} ${child.y} V ${parent.y}`;
            } else if (firstParent) {
                const bend = parent.y - ROW_HEIGHT;
                path = `M ${child.x} ${child.y} V ${bend} C ${child.x} ${bend + 17}, ${parent.x} ${bend + 17}, ${parent.x} ${parent.y}`;
            } else {
                const bend = child.y + ROW_HEIGHT;
                path = `M ${child.x} ${child.y} C ${child.x} ${child.y + 17}, ${parent.x} ${child.y + 17}, ${parent.x} ${bend} V ${parent.y}`;
            }
            edges.push({ child: child.hash, parent: parent.hash, firstParent, color: firstParent ? child.color : parent.color, path });
        }
    }
    return { nodes, edges, width: NODE_X * 2 + Math.max(1, ...nodes.map((node) => node.lane + 1)) * LANE_WIDTH, height: commits.length * ROW_HEIGHT };
}
