import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

test("Electron decodes PNG/JPEG/WebP and produces deterministic bounded model and thumbnail images", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "triumcode-image-codec-"));
    const require = createRequire(import.meta.url);
    const electron = require("electron") as string;
    const processorUrl = new URL("./image-processor.js", import.meta.url).href;
    const script = `const {app, BrowserWindow, nativeImage}=require('electron');const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(directory, "user-data"))});app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const {processAttachmentImage}=await import(${JSON.stringify(processorUrl)});
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('data:text/html,test');
 const fixtures=await win.webContents.executeJavaScript('(async()=>{const canvas=new OffscreenCanvas(3000,2000);const ctx=canvas.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,3000,2000);ctx.fillStyle="red";ctx.fillRect(0,0,500,500);ctx.font="64px sans-serif";ctx.fillText("image fixture",600,300);const result=[];for(const type of ["image/png","image/jpeg","image/webp"])result.push(Array.from(new Uint8Array(await(await canvas.convertToBlob({type})).arrayBuffer())));return result})()');
 win.destroy();
 for(const bytes of fixtures){const image=await processAttachmentImage(Buffer.from(bytes));assert.equal(image.width,3000);assert.equal(image.height,2000);assert(Math.max(image.modelWidth,image.modelHeight)<=1568);assert(image.modelWidth*image.modelHeight<=1201000);assert(image.modelBytes.length<=4*1024*1024);const thumb=nativeImage.createFromBuffer(image.thumbnail).getSize();assert(Math.max(thumb.width,thumb.height)<=240);assert.deepEqual((await processAttachmentImage(Buffer.from(bytes))).modelBytes,image.modelBytes);}
 await assert.rejects(processAttachmentImage(Buffer.from('corrupt')),/解码失败/);
 console.log('codec-ok');app.quit();
}).catch(error=>{console.error(error);app.exit(1)});`;
    try {
        const file = join(directory, "main.cjs");
        await writeFile(file, script);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const result = await promisify(execFile)(electron, [file], { env, windowsHide: true, timeout: 25_000 });
        assert.match(result.stdout, /codec-ok/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
