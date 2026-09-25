import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { TerminalSummary } from "../shared/contracts.js";
import "@xterm/xterm/css/xterm.css";

const terminalPalettes = {
    light: {
        background: "#ffffff", foreground: "#242424", cursor: "#242424",
        selectionBackground: "#d9d9d9", black: "#242424", red: "#b42318",
        green: "#267247", yellow: "#946200", blue: "#285ea8",
        magenta: "#8a4ca8", cyan: "#147b87", white: "#ededed",
        brightBlack: "#666666", brightRed: "#c7463c", brightGreen: "#348e58",
        brightYellow: "#ad7915", brightBlue: "#3975bf", brightMagenta: "#a263ba",
        brightCyan: "#23939b", brightWhite: "#ffffff",
    },
    dark: {
        background: "#171717", foreground: "#e8e8e8", cursor: "#e8e8e8",
        selectionBackground: "#444444", black: "#171717", red: "#ee8580",
        green: "#8ccfa5", yellow: "#e2c078", blue: "#91b8e8",
        magenta: "#c9a3e3", cyan: "#8ad1d4", white: "#e8e8e8",
        brightBlack: "#777777", brightRed: "#f29b95", brightGreen: "#a8dcb7",
        brightYellow: "#eed098", brightBlue: "#a9c9ed", brightMagenta: "#d9b8ed",
        brightCyan: "#a4e0e2", brightWhite: "#ffffff",
    },
};

export function TerminalPanel({
    theme,
    workspaceId,
    workspaceName,
    workspacePath,
    onClose,
    onCopySelection,
}: {
    theme: "light" | "dark";
    workspaceId: string;
    workspaceName: string;
    workspacePath: string;
    onClose: () => void;
    onCopySelection: (text: string) => void;
}) {
    const surface = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const [summary, setSummary] = useState<TerminalSummary | null>(null);
    const [title, setTitle] = useState("");
    const [error, setError] = useState("");
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [selectedText, setSelectedText] = useState("");
    const [generation, setGeneration] = useState(0);
    const exited = useRef(false);

    useEffect(() => {
        const root = surface.current;
        if (!root) return;
        let live = true;
        let terminalId: string | null = null;
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
            fontSize: 12,
            scrollback: 5000,
            theme: terminalPalettes[theme],
        });
        terminalRef.current = terminal;
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(root);
        exited.current = false;
        setSummary(null);
        setTitle("");
        setExitCode(null);
        setError("");

        const unsubscribe = window.desktop.onTerminalEvent((event) => {
            if (!live || event.workspaceId !== workspaceId || event.terminalId !== terminalId) return;
            if (event.payload.type === "data") terminal.write(event.payload.data);
            else if (event.payload.type === "output-truncated") {
                terminal.writeln(`\r\n[Older terminal output was dropped (${event.payload.droppedBytes} bytes).]`);
            } else {
                exited.current = true;
                setExitCode(event.payload.exitCode);
                terminal.writeln(`\r\n[PowerShell exited with code ${event.payload.exitCode}.]`);
            }
        });
        const input = terminal.onData((data) => {
            if (!terminalId || exited.current) return;
            void window.desktop.writeTerminal(terminalId, data).catch((failure: unknown) => {
                if (live) setError(failure instanceof Error ? failure.message : String(failure));
            });
        });
        const selection = terminal.onSelectionChange(() => setSelectedText(terminal.getSelection()));
        terminal.onTitleChange(setTitle);

        const resize = () => {
            try {
                fit.fit();
                if (terminalId) void window.desktop.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(() => undefined);
            } catch { /* the panel may not have a measurable size yet */ }
        };
        const observer = new ResizeObserver(resize);
        observer.observe(root);
        requestAnimationFrame(resize);

        void window.desktop.createTerminal(workspaceId, terminal.cols, terminal.rows).then((created) => {
            if (!live) {
                void window.desktop.closeTerminal(created.id);
                return;
            }
            terminalId = created.id;
            setSummary(created);
            terminal.focus();
            resize();
        }).catch((failure: unknown) => {
            if (live) setError(failure instanceof Error ? failure.message : String(failure));
        });

        return () => {
            live = false;
            observer.disconnect();
            unsubscribe();
            input.dispose();
            selection.dispose();
            terminal.dispose();
            terminalRef.current = null;
            if (terminalId) void window.desktop.closeTerminal(terminalId).catch(() => undefined);
        };
    }, [generation, workspaceId]);

    useEffect(() => {
        if (terminalRef.current) terminalRef.current.options.theme = terminalPalettes[theme];
    }, [theme]);

    const restart = async () => {
        if (!window.confirm("重启 PowerShell 会结束当前 shell 和它启动的前台程序。继续吗？")) return;
        if (summary) {
            try { await window.desktop.closeTerminal(summary.id); }
            catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return; }
        }
        setGeneration((current) => current + 1);
    };

    return <section className="terminal-panel" aria-label="集成终端">
        <div className="terminal-toolbar">
            <div className="terminal-heading"><strong>终端</strong><span>{summary ? `${summary.shell} · ${title || summary.cwd}` : `${workspaceName} · ${workspacePath}`}</span></div>
            <div className="terminal-actions"><button disabled={!selectedText.trim()} onClick={() => onCopySelection(selectedText)}>插入到 Agent</button><button onClick={() => void restart()}>{exitCode === null ? "重启" : "重新启动"}</button><button className="terminal-close" onClick={onClose}>关闭</button></div>
        </div>
        <div className="terminal-surface" ref={surface} />
        <div className="terminal-status-row"><span>当前终端固定绑定此工作区；输入的命令由你直接运行，独立于 Agent。</span>{error && <span className="terminal-error" role="alert">{error}</span>}</div>
    </section>;
}
