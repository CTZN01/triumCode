import { app, BrowserWindow, clipboard, ClipboardItem, dialog } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentHost } from "./agent-host.js";
import { WorkspaceStore } from "./workspace-store.js";
import { SettingsStore } from "./settings-store.js";
import { CredentialStore } from "./credential-store.js";
import { TerminalService } from "./terminal-service.js";
import { WorkspaceWatchService } from "./workspace-watch-service.js";
import { registerIpcHandlers } from "./ipc.js";
import { SessionStore, sessionAttachmentDirectory } from "../../../src/session.js";
import type { Attachment } from "../../../src/attachments.js";

const [directory, scenario] = process.argv.slice(2);
app.setPath("userData", join(directory, "electron"));
process.env.ANTHROPIC_API_KEY = "attachment-test-key";
app.on("window-all-closed", () => {});

async function run(): Promise<void> {
    await app.whenReady();
    const root = join(directory, "workspace");
    await mkdir(root, { recursive: true });
    const externalPath = join(directory, "external-log.txt");
    await writeFile(externalPath, "LOCAL_FILE_SENTINEL_NEVER_INLINE\nrequested external line\n" + "irrelevant log\n".repeat(200_000));
    const bodies: Array<{ messages: Array<{ content: Array<{ type: string; source?: { data: string }; cache_control?: unknown }> }> }> = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        const toolTurn = scenario === "draft" && bodies.length === 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const blocks = toolTurn ? [
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read-attached-log", name: "read_file", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: externalPath, offset: 2, limit: 1 }) } },
        ] : [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "附件请求已收到。" } },
        ];
        for (const value of [
            { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "vision-fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } },
            ...blocks,
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: toolTurn ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
            { type: "message_stop" },
        ]) response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        response.end();
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert(address && typeof address !== "string");
    const workspaceStore = new WorkspaceStore(directory);
    const settings = new SettingsStore(directory);
    settings.save({ ...settings.get(), model: "vision-fixture", modelPreset: null, apiBase: `http://127.0.0.1:${address.port}`, protocol: "anthropic", thinking: false, effort: "low" });
    const window = new BrowserWindow({ show: false, width: 1360, height: 1000, titleBarStyle: "hidden", titleBarOverlay: true,
        webPreferences: { preload: resolve("out/preload/index.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const host = new AgentHost(workspaceStore, settings, new CredentialStore(directory), directory, event => window.webContents.send("desktop:event", event));
    const workspace = host.openWorkspace(root);
    const session = host.createSession(workspace.id).session;
    const watch = new WorkspaceWatchService(workspaceStore, () => {});
    const terminals = new TerminalService(workspaceStore, () => {});
    registerIpcHandlers({ host, terminals, workspaceWatch: watch, getWindow: () => window });
    const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>;
    const until = async (code: string): Promise<void> => {
        for (let attempts = 0; attempts < 120; attempts++) {
            if (await js<boolean>(code)) return;
            await new Promise(done => setTimeout(done, 50));
        }
        throw new Error(`UI condition timed out: ${code}\n${await js<string>("document.body.innerText")}`);
    };
    await window.loadFile(resolve("out/renderer/index.html"));
    await until("Boolean(document.querySelector('.composer textarea:not(:disabled)'))");
    const fixtures = await js<number[][]>(`(async()=>{const canvas=new OffscreenCanvas(640,360);const ctx=canvas.getContext('2d');ctx.fillStyle='#202530';ctx.fillRect(0,0,640,360);ctx.fillStyle='#8dc9ff';ctx.font='40px sans-serif';ctx.fillText('Attachment preview',35,105);ctx.fillStyle='#e8896c';ctx.fillRect(35,170,160,110);ctx.fillStyle='#9acd8d';ctx.fillRect(225,170,160,110);ctx.fillStyle='#bb99ee';ctx.fillRect(415,170,160,110);const files=[];for(const type of ['image/png','image/jpeg','image/webp'])files.push(Array.from(new Uint8Array(await(await canvas.convertToBlob({type})).arrayBuffer())));return files})()`);
    const imagePath = join(root, "sample.webp");
    const textPath = join(root, "large-log.txt");
    await writeFile(imagePath, Buffer.from(fixtures[2]));
    await writeFile(textPath, "LOCAL_FILE_SENTINEL_NEVER_INLINE\n" + "log row\n".repeat(300_000));
    const originalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [imagePath, textPath] })) as typeof dialog.showOpenDialog;
    await js("document.querySelector('.composer-attach').click()");
    await until("document.querySelectorAll('.composer .attachment-card').length===2 && !document.querySelector('.attachment-loading')");
    const ids = await js<string[]>("Array.from(document.querySelectorAll('.composer .attachment-card')).map(card=>card.dataset.attachmentId)");
    const added = await Promise.all(ids.map(id => host.getAttachmentPreview(workspace.id, session.id, id, false).catch(() => "")));
    assert(added[0].startsWith("data:image/png;base64,"));
    const managed = sessionAttachmentDirectory(session.id, root);
    const textMetadata = JSON.parse(await readFile(join(managed, ids[1], "attachment.json"), "utf8")).attachment as Attachment;
    assert.equal(textMetadata.type, "workspace_file");
    assert.equal(textMetadata.path, textPath);
    await js("document.querySelector('.composer .attachment-thumbnail').click()");
    await until("Boolean(document.querySelector('.attachment-preview[open] img'))");
    assert.equal(await js<number>("document.querySelector('.attachment-preview img').naturalWidth"), 640);
    await js("document.querySelector('[aria-label=\"关闭图片预览\"]').click()");
    if (scenario === "cards") {
        for (const theme of ["light", "dark"]) {
            await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
            await js("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
            assert.equal(await js<string>("getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()"), theme === "dark" ? "#181818" : "#ffffff");
            assert(await js<boolean>("Array.from(document.querySelectorAll('.attachment-card')).every(card=>card.getBoundingClientRect().height>=60 && card.querySelector('strong').getBoundingClientRect().width>40)"));
            const screenshotDirectory = process.env.TRIUMCODE_ATTACHMENT_SCREENSHOT_DIR ?? directory;
            await mkdir(screenshotDirectory, { recursive: true });
            await writeFile(join(screenshotDirectory, `attachments-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        }
        await rm(join(managed, ids[0], "original.webp"));
        await js("document.querySelector('.composer .attachment-thumbnail').click()");
        await until("Boolean(document.querySelector('.attachment-preview [role=alert]'))");
        assert.match(await js<string>("document.querySelector('.attachment-preview [role=alert]').textContent"), /无法加载图片/);
        await js("document.querySelector('[aria-label=\"关闭图片预览\"]').click()");
        await js("document.querySelector('.composer .attachment-remove').click()");
        await until("document.querySelectorAll('.composer .attachment-card').length===1");
        for (let i = 0; i < 100; i++) {
            try { await readFile(join(managed, ids[0], "attachment.json")); }
            catch { break; }
            await new Promise(done => setTimeout(done, 20));
        }
        await assert.rejects(readFile(join(managed, ids[0], "attachment.json")));
        assert((await readFile(textPath, "utf8")).startsWith("LOCAL_FILE_SENTINEL"));
    } else {
        // A real native clipboard paste exercises Chromium File -> isolated preload -> IPC.
        const clipboardBefore = await Promise.all((await clipboard.read()).map(async item => {
            const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)] as const));
            return new ClipboardItem(Object.fromEntries(entries));
        }));
        try {
            await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(fixtures[0])], { type: "image/png" }) })]);
            const fallback = await js<Attachment>(`window.desktop.addClipboardImage(${JSON.stringify(workspace.id)},${JSON.stringify(session.id)})`);
            assert.equal(fallback.type, "image", "the native clipboard fallback also creates a managed image");
            await host.removeAttachment(workspace.id, session.id, fallback.id);
            await js("document.querySelector('.composer textarea').focus()");
            window.webContents.paste();
            await until("document.querySelectorAll('.composer .attachment-card').length===3 && !document.querySelector('.attachment-loading')");
            window.webContents.paste();
            await until("document.querySelectorAll('.composer .attachment-card').length===4 && !document.querySelector('.attachment-loading')");
            await clipboard.writeText("普通文本粘贴");
            window.webContents.paste();
            await until("document.querySelector('.composer textarea').value==='普通文本粘贴'");
            assert.equal(await js<number>("document.querySelectorAll('.composer .attachment-card').length"), 4);
        } finally { await clipboard.write(clipboardBefore); }
        await js(`(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(${JSON.stringify(fixtures[1])})],'dropped.jpg',{type:'image/jpeg'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
        await until("document.querySelectorAll('.composer .attachment-card').length===5 && !document.querySelector('.attachment-loading')");
        const codePath = join(root, "dropped-code.ts");
        await writeFile(codePath, "export const physicalDrop = true;");
        await js("(()=>{const input=document.createElement('input');input.type='file';input.id='fixture-file';document.body.append(input)})()");
        window.webContents.debugger.attach("1.3");
        try {
            const document = await window.webContents.debugger.sendCommand("DOM.getDocument");
            const input = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#fixture-file" });
            await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [codePath] });
            await js("(()=>{const input=document.querySelector('#fixture-file');const data=new DataTransfer();data.items.add(input.files[0]);document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));input.remove()})()");
        } finally { window.webContents.debugger.detach(); }
        await until("document.querySelectorAll('.composer .attachment-card').length===6 && !document.querySelector('.attachment-loading')");
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [externalPath] })) as typeof dialog.showOpenDialog;
        await js("document.querySelector('.composer-attach').click()");
        await until("document.querySelectorAll('.composer .attachment-card').length===7 && !document.querySelector('.attachment-loading')");
        await js("document.querySelector('.composer-wrap').requestSubmit()");
        await until("document.querySelectorAll('.conversation .attachment-card').length===7 && document.body.innerText.includes('附件请求已收到。') && !document.querySelector('.agent-working')");
        assert.equal(bodies.length, 2);
        assert(JSON.stringify(bodies[1]).includes("2 | requested external line"), "the Agent can read only the requested external attachment line");
        const imageBlocks = bodies[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "image");
        assert.equal(imageBlocks.length, 4);
        assert(imageBlocks.every(block => block.source && Buffer.from(block.source.data, "base64").subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))));
        assert(!JSON.stringify(bodies).includes("LOCAL_FILE_SENTINEL_NEVER_INLINE"));
        const saved = new SessionStore(root).load(session.id)!;
        assert(!JSON.stringify(saved.messages).includes(imageBlocks[0].source!.data));
        const savedAttachments = (saved.messages.find(message => (message as { attachments?: unknown[] }).attachments) as { attachments: Attachment[] }).attachments;
        assert.equal(savedAttachments.length, 7);
        assert.equal(savedAttachments.find(attachment => attachment.name === "dropped-code.ts")?.path, codePath);
        await new Promise<void>(done => { window.webContents.once("did-finish-load", () => done()); window.reload(); });
        await until("document.querySelectorAll('.conversation .attachment-card').length===7 && document.querySelectorAll('.conversation .attachment-thumbnail img').length===4");
        const restored = host.openSession(workspace.id, session.id);
        assert.equal(restored.messages.find(message => message.attachments)?.attachments?.length, 7);
        await host.startRun(workspace.id, session.id, "继续检查", randomUUID());
        await until("document.body.innerText.includes('附件请求已收到。') && !document.querySelector('.agent-working')");
        for (let i = 0; i < 100 && bodies.length < 3; i++) await new Promise(done => setTimeout(done, 50));
        assert.equal(bodies.length, 3);
        assert.deepEqual(bodies[2].messages[0].content.map(({ cache_control: _cache, ...block }) => block),
            bodies[0].messages[0].content.map(({ cache_control: _cache, ...block }) => block), "historical visual input stays byte stable when the cache marker moves to the new message");
    }
    dialog.showOpenDialog = originalDialog;
    watch.close();
    await terminals.closeAll();
    await host.stopAll();
    new SessionStore(root).delete(session.id);
    await assert.rejects(readFile(join(managed, ids[1], "attachment.json")));
    assert((await readFile(textPath, "utf8")).startsWith("LOCAL_FILE_SENTINEL"));
    window.destroy();
    server.close();
    console.log(`attachment-ui-${scenario}-ok`);
    app.quit();
}

run().catch(error => { console.error(error); app.exit(1); });
