import { existsSync, renameSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════
// One-time adoption of pre-rename data directories
// ═══════════════════════════════════════════════════════════════
//
// The tool was renamed from Triumph Code to TriumCode, which moved both
// of its data directories: ~/.triumph/config.json (the saved API key) and
// the project-local .triumph/sessions/ (conversation history).  Renaming
// them out from under an existing install would send the user back through
// first-run setup and orphan every saved session, so the old directory is
// adopted instead.

/**
 * Move `legacyPath` to `currentPath` if — and only if — the old directory
 * exists and the new one does not.
 *
 * Never throws.  Adoption is a convenience, not a precondition: a locked
 * or read-only directory must not stop the CLI from starting, and the worst
 * case is that the user re-runs setup.  Callers are expected to ignore the
 * return value — it exists so tests can assert what happened.
 */
export function migrateDir(legacyPath: string, currentPath: string): boolean {
    // An existing current directory wins outright.  Without this check a
    // second run would move the old directory back over the one already in
    // use, discarding whatever was written since.
    if (existsSync(currentPath)) return false;
    if (!existsSync(legacyPath)) return false;

    try {
        renameSync(legacyPath, currentPath);
        return true;
    } catch {
        return false;
    }
}
