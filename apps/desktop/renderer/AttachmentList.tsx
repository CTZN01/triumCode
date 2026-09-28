import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../shared/contracts.js";

function fileSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function AttachmentCard({ attachment, workspaceId, sessionId, onRemove, onPreview, disabled }: {
    attachment: Attachment; workspaceId: string; sessionId: string;
    onRemove?: (id: string) => void; onPreview: (attachment: Attachment) => void; disabled?: boolean;
}) {
    const [thumbnail, setThumbnail] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        if (attachment.type !== "image") return;
        let current = true;
        void window.desktop.getAttachmentPreview(workspaceId, sessionId, attachment.id).then(value => {
            if (current) setThumbnail(value);
        }).catch(failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
        return () => { current = false; };
    }, [attachment.id, attachment.type, workspaceId, sessionId]);
    const type = attachment.type === "image" ? "图片" : attachment.name.split(".").at(-1)?.toUpperCase() ?? "文件";
    return <div className={`attachment-card ${attachment.type}`} title={attachment.path} data-attachment-id={attachment.id}>
        {attachment.type === "image" ? <button type="button" className="attachment-thumbnail" onClick={() => onPreview(attachment)} aria-label={`预览图片：${attachment.name}`}>
            {thumbnail ? <img src={thumbnail} alt={attachment.name} onError={() => setError("图片加载失败，请重新添加。")} /> : <span>{error ? "图片不可用" : "加载中"}</span>}
        </button> : <span className="attachment-file-icon" aria-hidden="true"><svg width="23" height="27" viewBox="0 0 24 28" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 1h10l6 6v20H4zM14 1v7h6M8 14h8M8 19h8" /></svg></span>}
        <div className="attachment-card-info"><strong>{attachment.name}</strong><small>{type} · {fileSize(attachment.size)}{attachment.type === "workspace_file" ? " · 项目引用" : ""}</small>
            {(error || attachment.notice) && <span className={error ? "attachment-error" : "attachment-notice"}>{error || attachment.notice}</span>}
        </div>
        {onRemove && <button type="button" className="attachment-remove" onClick={() => onRemove(attachment.id)} disabled={disabled} aria-label={`移除附件：${attachment.name}`} title="移除附件">×</button>}
    </div>;
}

function ImagePreview({ attachment, workspaceId, sessionId, onClose }: { attachment: Attachment; workspaceId: string; sessionId: string; onClose: () => void }) {
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const [source, setSource] = useState("");
    const [error, setError] = useState("");
    const [actualSize, setActualSize] = useState(false);
    useEffect(() => {
        const dialog = dialogRef.current;
        dialog?.showModal();
        let current = true;
        void window.desktop.getAttachmentPreview(workspaceId, sessionId, attachment.id, true)
            .then(value => { if (current) setSource(value); })
            .catch(failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
        return () => { current = false; dialog?.close(); };
    }, [workspaceId, sessionId, attachment.id]);
    return <dialog ref={dialogRef} className="attachment-preview" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-label={`图片预览：${attachment.name}`}>
        <header><strong>{attachment.name}</strong><button type="button" onClick={() => setActualSize(value => !value)}>{actualSize ? "适应窗口" : "原始尺寸"}</button><button type="button" onClick={onClose} aria-label="关闭图片预览">×</button></header>
        <div className={`attachment-preview-body${actualSize ? " actual-size" : ""}`}>
            {error ? <p role="alert">{error}</p> : source ? <img src={source} alt={attachment.name} onError={() => setError("图片解码失败，本地副本可能已损坏。")} /> : <p role="status">正在加载原图...</p>}
        </div>
    </dialog>;
}

export function AttachmentList({ attachments, workspaceId, sessionId, onRemove, disabled }: {
    attachments: readonly Attachment[]; workspaceId: string; sessionId: string; onRemove?: (id: string) => void; disabled?: boolean;
}) {
    const [preview, setPreview] = useState<Attachment | null>(null);
    if (!attachments.length) return null;
    return <><div className="attachment-list">{attachments.map(attachment => <AttachmentCard key={attachment.id} attachment={attachment} workspaceId={workspaceId} sessionId={sessionId} onRemove={onRemove} onPreview={setPreview} disabled={disabled} />)}</div>
        {preview && <ImagePreview attachment={preview} workspaceId={workspaceId} sessionId={sessionId} onClose={() => setPreview(null)} />}</>;
}
