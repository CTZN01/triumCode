import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./theme.css";

try {
    const preference = JSON.parse(window.localStorage.getItem("triumcode.desktop.panel-widths.v1") ?? "null") as { theme?: unknown } | null;
    document.documentElement.dataset.theme = preference?.theme === "dark" || preference?.theme === "light" ? preference.theme : "system";
} catch {
    document.documentElement.dataset.theme = "system";
}

const root = document.getElementById("root");
if (!root) throw new Error("TriumCode renderer root element is missing.");

if (typeof window.desktop === "undefined") {
    const error = document.createElement("div");
    error.setAttribute("role", "alert");
    error.style.cssText = "min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--canvas);color:var(--danger);font:14px 'Segoe UI Variable','Segoe UI',sans-serif;text-align:center";
    error.textContent = "桌面服务加载失败。请重新启动 TriumCode；如果问题仍然存在，请重新下载并完整解压桌面包。";
    root.replaceChildren(error);
} else {
    createRoot(root).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}
