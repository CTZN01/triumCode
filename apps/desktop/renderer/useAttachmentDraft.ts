import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type Dispatch, type SetStateAction } from "react";
import { MAX_ATTACHMENTS, type Attachment } from "../../../src/attachments.js";

interface DraftScope { workspaceId: string | null; sessionId: string | null; files: Attachment[] }

export function useAttachmentDraft(workspaceId: string | null, sessionId: string | null, onError: (message: string) => void) {
    const [attachments, updateAttachments] = useState<Attachment[]>([]);
    const [pending, setPending] = useState(0);
    const scopeRef = useRef<DraftScope>({ workspaceId, sessionId, files: [] });
    const queue = useRef<Promise<void>>(Promise.resolve());
    const errorRef = useRef(onError);
    errorRef.current = onError;

    const discard = useCallback(async (scope: DraftScope, files: Attachment[]) => {
        if (!scope.workspaceId || !scope.sessionId) return;
        await Promise.all(files.map(file => window.desktop.removeAttachment(scope.workspaceId!, scope.sessionId!, file.id)));
    }, []);

    useEffect(() => {
        const previous = scopeRef.current;
        if (previous.workspaceId === workspaceId && previous.sessionId === sessionId) return;
        scopeRef.current = { workspaceId, sessionId, files: [] };
        updateAttachments([]);
        setPending(0);
        void discard(previous, previous.files).catch(error => errorRef.current(String(error)));
    }, [workspaceId, sessionId, discard]);

    useEffect(() => () => {
        const previous = scopeRef.current;
        scopeRef.current = { workspaceId: null, sessionId: null, files: [] };
        void discard(previous, previous.files).catch(() => {});
    }, [discard]);

    const restore: Dispatch<SetStateAction<Attachment[]>> = useCallback(value => {
        const next = typeof value === "function" ? value(scopeRef.current.files) : value;
        scopeRef.current.files = next;
        updateAttachments(next);
    }, []);

    const clear = useCallback((removeFiles = true) => {
        const scope = scopeRef.current;
        const previous = scope.files;
        scope.files = [];
        updateAttachments([]);
        if (removeFiles) void discard(scope, previous).catch(error => errorRef.current(String(error)));
    }, [discard]);

    const enqueue = useCallback((create: (scope: DraftScope) => Promise<Attachment[]>) => {
        const scope = scopeRef.current;
        if (!scope.workspaceId || !scope.sessionId) return;
        setPending(value => value + 1);
        const task = async () => {
            let added: Attachment[] = [];
            try {
                if (scopeRef.current !== scope) return;
                added = await create(scope);
                if (scopeRef.current !== scope) { await discard(scope, added); return; }
                if (scope.files.length + added.length > MAX_ATTACHMENTS) throw new Error(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`);
                scope.files = [...scope.files, ...added];
                updateAttachments(scope.files);
            } catch (error) {
                await discard(scope, added).catch(() => {});
                if (scopeRef.current === scope) errorRef.current(error instanceof Error ? error.message : String(error));
            } finally {
                if (scopeRef.current === scope) setPending(value => Math.max(0, value - 1));
            }
        };
        queue.current = queue.current.then(task, task);
    }, [discard]);

    const addFiles = useCallback((files: File[]) => enqueue(async scope => {
        if (scope.files.length + files.length > MAX_ATTACHMENTS) throw new Error(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`);
        const added: Attachment[] = [];
        try {
            for (const file of files) added.push(await window.desktop.addAttachmentFile(scope.workspaceId!, scope.sessionId!, file));
            return added;
        } catch (error) { await discard(scope, added); throw error; }
    }), [enqueue, discard]);

    const choose = useCallback(() => enqueue(scope => window.desktop.chooseAttachmentFiles(scope.workspaceId!, scope.sessionId!)), [enqueue]);
    const paste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = [...event.clipboardData.items].filter(item => item.kind === "file" && item.type.startsWith("image/"))
            .map(item => item.getAsFile()).filter((file): file is File => file !== null);
        if (files.length) { event.preventDefault(); addFiles(files); }
        else if ([...event.clipboardData.types].some(type => type.startsWith("image/"))) {
            event.preventDefault();
            enqueue(async scope => [await window.desktop.addClipboardImage(scope.workspaceId!, scope.sessionId!)]);
        }
    }, [addFiles, enqueue]);

    const remove = useCallback((id: string) => {
        const scope = scopeRef.current;
        const file = scope.files.find(item => item.id === id);
        if (!file) return;
        scope.files = scope.files.filter(item => item.id !== id);
        updateAttachments(scope.files);
        void discard(scope, [file]).catch(error => errorRef.current(String(error)));
    }, [discard]);

    return { attachments, pending: pending > 0, clear, restore, addFiles, choose, paste, remove };
}
