import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = resolve(projectRoot, "out");
const releaseRoot = resolve(outRoot, "desktop-release");

function assertContained(parent, target, label) {
    const childPath = relative(parent, target);
    if (!childPath || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
        throw new Error(`${label} must stay inside its generated output directory.`);
    }
}

function run(command, args, options) {
    const result = spawnSync(command, args, { ...options, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
}

if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The portable preview packager currently supports Windows x64 build hosts only.");
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
    throw new Error("Node.js 22.12 or later is required to package the desktop preview.");
}

const release = JSON.parse(await readFile(resolve(projectRoot, "apps/desktop/release.json"), "utf8"));
if (typeof release.version !== "string" || !/^\d+\.\d+\.\d+-preview\.\d+$/.test(release.version)) {
    throw new Error("apps/desktop/release.json must contain a preview version such as 0.1.0-preview.1.");
}
const electronPackage = JSON.parse(await readFile(resolve(projectRoot, "node_modules/electron/package.json"), "utf8"));
if (electronPackage.version !== release.electronVersion) {
    throw new Error(`Expected Electron ${release.electronVersion}, found ${electronPackage.version}.`);
}

const requiredBuildFiles = [
    "out/main/index.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
];
for (const path of requiredBuildFiles) {
    try { await stat(resolve(projectRoot, path)); }
    catch { throw new Error(`Missing ${path}; run npm run desktop:build before packaging.`); }
}

const repoRealPath = await realpath(projectRoot);
const outRealPath = await realpath(outRoot);
assertContained(repoRealPath, outRealPath, "The build output directory");
await mkdir(releaseRoot, { recursive: true });
const releaseRealPath = await realpath(releaseRoot);
assertContained(outRealPath, releaseRealPath, "The release output directory");

const archiveName = `TriumCode-Desktop-${release.version}-win-x64.zip`;
const archivePath = resolve(releaseRoot, archiveName);
assertContained(releaseRealPath, archivePath, "The release archive");

const tempBase = await realpath(tmpdir());
const stageRoot = await mkdtemp(join(tempBase, "triumcode-desktop-package-"));
const stageRealPath = await realpath(stageRoot);
assertContained(tempBase, stageRealPath, "The temporary package directory");

try {
    const electronDist = resolve(projectRoot, "node_modules/electron/dist");
    await cp(electronDist, stageRoot, { recursive: true });

    const appRoot = resolve(stageRoot, "resources/app");
    await mkdir(appRoot, { recursive: true });

    const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
    packageJson.version = release.version;
    packageJson.productName = "TriumCode";
    const packageLock = JSON.parse(await readFile(resolve(projectRoot, "package-lock.json"), "utf8"));
    if (!packageLock.packages?.[""]) throw new Error("package-lock.json is missing its root package record.");
    packageLock.version = release.version;
    packageLock.packages[""].version = release.version;
    await writeFile(resolve(appRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
    await writeFile(resolve(appRoot, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");

    await cp(resolve(projectRoot, "out/main"), resolve(appRoot, "out/main"), { recursive: true });
    await cp(resolve(projectRoot, "out/preload"), resolve(appRoot, "out/preload"), { recursive: true });
    await cp(resolve(projectRoot, "out/renderer"), resolve(appRoot, "out/renderer"), { recursive: true });
    await cp(
        resolve(projectRoot, "apps/desktop/PREVIEW-README.txt"),
        resolve(stageRoot, "README-Preview.txt"),
    );

    await rename(resolve(stageRoot, "electron.exe"), resolve(stageRoot, "TriumCode.exe"));

    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("Run the packager with npm run desktop:package so it can reuse the supported Node.js runtime.");
    run(process.execPath, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: appRoot });

    await rm(archivePath, { force: true });
    const zipCommand = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:TRIUMCODE_STAGE_ROOT, $env:TRIUMCODE_ARCHIVE_PATH, [System.IO.Compression.CompressionLevel]::Optimal, $false)";
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", zipCommand], {
        cwd: projectRoot,
        env: { ...process.env, TRIUMCODE_STAGE_ROOT: stageRoot, TRIUMCODE_ARCHIVE_PATH: archivePath },
    });

    const archiveSize = (await stat(archivePath)).size;
    console.log(`Created ${archivePath} (${(archiveSize / 1024 / 1024).toFixed(1)} MiB).`);
} finally {
    await rm(stageRoot, { recursive: true, force: true });
}
