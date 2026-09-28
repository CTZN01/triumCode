import { app, BrowserWindow, dialog } from "electron";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
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
import { SessionStore } from "../../../src/session.js";
import { getTool } from "../../../src/tools.js";
import type { Protocol } from "../shared/contracts.js";

const [directory, selectedProtocol] = process.argv.slice(2);
const protocol = selectedProtocol as Protocol;
app.setPath("userData", join(directory, "electron"));
process.env.ANTHROPIC_API_KEY = "steering-test-key";
app.on("window-all-closed", () => {});

interface WireBody { system?: unknown; instructions?: string; messages?: unknown[]; input?: unknown[] }

function emit(response: ServerResponse, value: Record<string, unknown>): void {
    response.write(`${value.type ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
}

function respond(response: ServerResponse, index: number, toolPath: string): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const text = index === 2 ? "新的要求已执行" : "旧任务进展";
    const tool = index === 3;
    if (protocol === "anthropic") {
        emit(response, { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } });
        emit(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        emit(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        emit(response, { type: "content_block_stop", index: 0 });
        if (tool) {
            emit(response, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "slow-write", name: "write_file", input: {} } });
            emit(response, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: toolPath, content: "already dispatched" }) } });
            emit(response, { type: "content_block_stop", index: 1 });
        }
        if (index === 2) { emit(response, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }); emit(response, { type: "message_stop" }); response.end(); }
    } else if (protocol === "openai-chat") {
        emit(response, { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
        if (tool) {
            emit(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "slow-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ file_path: toolPath, content: "already dispatched" }) } }] }, finish_reason: "tool_calls" }] });
            response.end("data: [DONE]\n\n");
        }
        if (index === 2) { emit(response, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 8 } }); response.end("data: [DONE]\n\n"); }
    } else {
        emit(response, { type: "response.created", response: { id: "response", status: "in_progress" } });
        emit(response, { type: "response.output_item.added", output_index: 0, item: { id: "text", type: "message", role: "assistant", content: [] } });
        emit(response, { type: "response.output_text.delta", item_id: "text", output_index: 0, content_index: 0, delta: text });
        emit(response, { type: "response.output_item.done", output_index: 0, item: { id: "text", type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
        if (tool) {
            const item = { id: "tool", type: "function_call", call_id: "slow-write", name: "write_file", arguments: JSON.stringify({ file_path: toolPath, content: "already dispatched" }) };
            emit(response, { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } });
            emit(response, { type: "response.function_call_arguments.delta", item_id: "tool", output_index: 1, delta: item.arguments });
            emit(response, { type: "response.output_item.done", output_index: 1, item });
        }
        if (index === 2) { emit(response, { type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: 50, output_tokens: 8 } } }); response.end(); }
    }
}

async function run(): Promise<void> {
    await app.whenReady();
    const root = join(directory, "workspace");
    await mkdir(root, { recursive: true });
    const toolPath = join(root, "slow-write.txt");
    const bodies: WireBody[] = [];
    const closed = new Set<number>();
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        const index = bodies.length;
        response.once("close", () => closed.add(index));
        respond(response, index, toolPath);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert(address && typeof address !== "string");
    const workspaces = new WorkspaceStore(directory);
    const settings = new SettingsStore(directory);
    settings.save({ ...settings.get(), model: "m", modelPreset: null, apiBase: `http://127.0.0.1:${address.port}`, protocol, thinking: false });
    const window = new BrowserWindow({ show: false, width: 1360, height: 1000, titleBarStyle: "hidden", titleBarOverlay: true,
        webPreferences: { preload: resolve("out/preload/index.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const host = new AgentHost(workspaces, settings, new CredentialStore(directory), directory, event => window.webContents.send("desktop:event", event));
    const workspace = host.openWorkspace(root);
    const session = host.createSession(workspace.id).session;
    host.updatePermissionMode(workspace.id, session.id, "desktopAcceptEdits");
    const watch = new WorkspaceWatchService(workspaces, () => {});
    const terminals = new TerminalService(workspaces, () => {});
    registerIpcHandlers({ host, terminals, workspaceWatch: watch, getWindow: () => window });
    const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>;
    const until = async (condition: string): Promise<void> => {
        for (let attempt = 0; attempt < 160; attempt++) {
            if (await js<boolean>(condition)) return;
            await new Promise(done => setTimeout(done, 30));
        }
        throw new Error(`UI timed out: ${condition}\nDraft: ${await js<string>("document.querySelector('.composer textarea')?.value")}\n${await js<string>("document.body.innerText")}`);
    };
    const type = (text: string) => js(`(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const send = () => js("document.querySelector('.composer-wrap').requestSubmit()");
    await window.loadFile(resolve("out/renderer/index.html"));
    await until("Boolean(document.querySelector('.composer textarea'))");
    await type("执行旧任务"); await send();
    await until("document.body.innerText.includes('旧任务进展') && Boolean(document.querySelector('.stop-button'))");
    assert.equal(await js<boolean>("document.querySelector('.composer textarea').disabled"), false);
    assert.equal(await js<boolean>("document.querySelector('.composer-attach').disabled"), false);
    await type("按新的要求执行");
    assert(await js<boolean>("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true}))"));
    assert(await js<boolean>("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}))"));
    assert.equal(bodies.length, 1, "IME confirmation and Shift+Enter never send or interrupt");
    const imagePath = join(root, "new-direction.png");
    const bytes = await js<number[]>("(async()=>{const canvas=new OffscreenCanvas(64,64);canvas.getContext('2d').fillRect(0,0,64,64);return Array.from(new Uint8Array(await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer()))})()");
    await writeFile(imagePath, Buffer.from(bytes));
    const notePath = join(directory, "steering-note.txt");
    await writeFile(notePath, "FILE_CONTENT_NOT_INLINED".repeat(1000));
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [imagePath, notePath] })) as typeof dialog.showOpenDialog;
    await js("document.querySelector('.composer-attach').click()");
    await until("document.querySelectorAll('.composer .attachment-card').length===2 && !document.querySelector('.attachment-loading')");
    assert.equal(await js<string>("document.querySelector('.send-button').getAttribute('aria-label')"), "中断并继续");
    await js("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
    await until("document.body.innerText.includes('新的要求已执行') && !document.querySelector('.agent-working')");
    assert.equal(bodies.length, 2);
    assert(closed.has(1), "old streaming request is aborted before the next request");
    assert.match(JSON.stringify(bodies[1]), protocol === "anthropic" ? /\"type\":\"image\"/ : protocol === "openai-chat" ? /\"type\":\"image_url\"/ : /\"type\":\"input_image\"/);
    assert(!JSON.stringify(bodies).includes("FILE_CONTENT_NOT_INLINED"));
    const prefix = (body: WireBody) => JSON.stringify(protocol === "anthropic" ? body.messages?.[0] : protocol === "openai-chat" ? body.messages?.slice(0, 2) : body.input?.[0], (key, value: unknown) => key === "cache_control" ? undefined : value);
    assert.equal(prefix(bodies[1]), prefix(bodies[0]));
    assert.deepEqual(bodies[1].system ?? bodies[1].instructions, bodies[0].system ?? bodies[0].instructions);
    const visible = await js<Array<{ role: string; text: string }>>("Array.from(document.querySelectorAll('.message')).map(element=>({role:element.classList.contains('user')?'user':'assistant',text:element.innerText}))");
    assert(visible.findIndex(message => message.text.includes("旧任务进展")) < visible.findIndex(message => message.text.includes("按新的要求执行")), "old progress stays before the follow-up message");
    const store = new SessionStore(root);
    assert.equal(host.openSession(workspace.id, session.id).messages.filter(message => message.role === "user").length, 2);
    assert(!JSON.stringify(store.load(session.id)?.messages).includes(Buffer.from(bytes).toString("base64")));
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>(done => { writeStarted = done; });
    const gate = new Promise<void>(done => { releaseWrite = done; });
    const writer = getTool("write_file")!;
    const originalCall = writer.call;
    writer.call = async (input, context) => { writeStarted(); await gate; return originalCall(input, context); };
    await type("启动慢速写入"); await send();
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("The scripted write did not start.")), 5000))]);
    await type("取消这个方向，改写另一处"); await send();
    await until("document.querySelector('.send-button').disabled && Boolean(document.querySelector('.stop-button'))");
    await type("保留的新草稿");
    await js("document.querySelector('.stop-button').click()");
    await new Promise(done => setTimeout(done, 80));
    assert.equal(bodies.length, 3);
    releaseWrite();
    await until("!document.querySelector('.agent-working') && document.querySelector('.composer textarea').value.includes('取消这个方向，改写另一处')");
    assert.match(await js<string>("document.querySelector('.composer textarea').value"), /保留的新草稿/);
    assert.equal(await readFile(toolPath, "utf8"), "already dispatched");
    assert.equal(bodies.length, 3, "stopping during handoff must not start the follow-up");
    const saved = store.load(session.id)!;
    const blocks = saved.messages.flatMap(message => {
        const content = (message as { content?: Array<{ type: string }> }).content;
        return Array.isArray(content) ? content : [];
    });
    assert.equal(blocks.filter(block => block.type === "tool_use").length, 1);
    assert.equal(blocks.filter(block => block.type === "tool_result").length, 1);
    assert(!JSON.stringify(saved.messages).includes("取消这个方向，改写另一处"));
    writer.call = originalCall;
    await type("运行第四轮"); await send();
    await until("Boolean(document.querySelector('.stop-button')) && document.querySelector('.composer textarea').value===''");
    const vanishedPath = join(root, "vanished.txt");
    await writeFile(vanishedPath, "temporary");
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [vanishedPath] })) as typeof dialog.showOpenDialog;
    await js("document.querySelector('.composer-attach').click()");
    await until("document.querySelectorAll('.composer .attachment-card').length===1 && !document.querySelector('.attachment-loading')");
    await rm(vanishedPath);
    await type("有附件的补充要求");
    await until("!document.querySelector('.send-button').disabled");
    await send();
    await until("document.body.innerText.includes('不存在或已被删除') && document.querySelector('.composer textarea').value==='有附件的补充要求'");
    assert.equal(bodies.length, 4);
    assert(!closed.has(4), "invalid attachments must be rejected before cancelling the existing task");
    assert(host.hasRunningTasks());
    await js("document.querySelector('.stop-button').click()");
    await until("!document.querySelector('.agent-working')");
    const persisted = store.load(session.id)!;
    const externalLease = store.acquireRun(session.id, persisted.revision ?? 0);
    try { await assert.rejects(host.startRun(workspace.id, session.id, "不能中断外部进程", randomUUID(), [], true), /另一个进程/); }
    finally { externalLease(); }
    watch.close(); await terminals.closeAll(); await host.stopAll();
    store.delete(session.id);
    window.destroy(); server.close();
    console.log(`steering-ui-${protocol}-ok`);
    app.quit();
}

run().catch(error => { console.error(error); app.exit(1); });
