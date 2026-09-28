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
    const summary = [attachment.name, `${type} · ${fileSize(attachment.size)}`,
        attachment.type === "workspace_file" ? "项目引用" : "", attachment.notice ?? ""].filter(Boolean).join(" · ");
    return <div className={`attachment-card ${attachment.type}`} title={summary} data-attachment-id={attachment.id}>
        {attachment.type === "image" ? <button type="button" className="attachment-thumbnail" onClick={() => onPreview(attachment)} aria-label={`预览图片：${attachment.name}`}>
            {thumbnail ? <img src={thumbnail} alt={attachment.name} onError={() => setError("图片加载失败，请重新添加。")} /> : <span>{error ? "图片不可用" : "加载中"}</span>}
        </button> : <><span className="attachment-file-icon" aria-hidden="true"><svg width="23" height="27" viewBox="0 0 24 28" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 1h10l6 6v20H4zM14 1v7h6M8 14h8M8 19h8" /></svg></span><span className="attachment-file-name">{attachment.name}</span></>}
        {onRemove && <button type="button" className="attachment-remove" onClick={() => onRemove(attachment.id)} disabled={disabled} aria-label={`移除附件：${attachment.name}`} title="移除附件">×</button>}
    </div>;
}

const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
// The fit scale keeps the whole image on screen, leaving room for the floating
// toolbar so it never covers the picture.
const FIT_PADDING_X = 32;
const FIT_PADDING_TOP = 32;
const FIT_PADDING_BOTTOM = 88;

function clampZoom(value: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function ImagePreview({ attachment, workspaceId, sessionId, onClose }: { attachment: Attachment; workspaceId: string; sessionId: string; onClose: () => void }) {
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [source, setSource] = useState("");
    const [error, setError] = useState("");
    const [natural, setNatural] = useState({ width: 0, height: 0 });
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const [zoom, setZoom] = useState<number | null>(null);
    useEffect(() => {
        const dialog = dialogRef.current;
        dialog?.showModal();
        let current = true;
        void window.desktop.getAttachmentPreview(workspaceId, sessionId, attachment.id, true)
            .then(value => { if (current) setSource(value); })
            .catch(failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)); });
        return () => { current = false; dialog?.close(); };
    }, [workspaceId, sessionId, attachment.id]);
    useEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const measure = () => setViewport({ width: body.clientWidth, height: body.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        return () => observer.disconnect();
    }, [source]);
    const fitZoom = natural.width && natural.height && viewport.width && viewport.height
        ? clampZoom(Math.min(1, (viewport.width - FIT_PADDING_X * 2) / natural.width, (viewport.height - FIT_PADDING_TOP - FIT_PADDING_BOTTOM) / natural.height))
        : 1;
    const scale = zoom ?? fitZoom;
    const ready = Boolean(source) && !error && natural.width > 0;
    return <dialog ref={dialogRef} className="attachment-preview" onCancel={onClose} aria-label={`图片预览：${attachment.name}`}>
        <div ref={bodyRef} className="attachment-preview-body" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
            {error ? <p role="alert">{error}</p> : source ? <img src={source} alt={attachment.name} width={natural.width ? natural.width * scale : undefined} draggable={false}
                onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => setError("图片解码失败，本地副本可能已损坏。")} /> : <p role="status">正在加载原图...</p>}
        </div>
        {ready && <div className="attachment-preview-toolbar">
            <button type="button" className="attachment-actual-size" onClick={() => setZoom(1)}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 6V2h4M14 10v4h-4M14 6V2h-4M2 10v4h4" /></svg>原始尺寸</button>
            <span className="attachment-zoom-group">
                <button type="button" onClick={() => setZoom(clampZoom(scale - ZOOM_STEP))} disabled={scale <= MIN_ZOOM} aria-label="缩小">−</button>
                <span className="attachment-zoom-value">{Math.round(scale * 100)}%</span>
                <button type="button" onClick={() => setZoom(clampZoom(scale + ZOOM_STEP))} disabled={scale >= MAX_ZOOM} aria-label="放大">+</button>
            </span>
        </div>}
        <button type="button" className="attachment-preview-close" onClick={onClose} aria-label="关闭图片预览">×</button>
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
