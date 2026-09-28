import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    main: {
        build: {
            rollupOptions: {
                input: resolve(root, "apps/desktop/main/index.ts"),
            },
        },
    },
    preload: {
        build: {
            rollupOptions: {
                input: resolve(root, "apps/desktop/preload/index.ts"),
                output: {
                    format: "cjs",
                    entryFileNames: "index.cjs",
                },
            },
        },
    },
    renderer: {
        root: resolve(root, "apps/desktop/renderer"),
        plugins: [react()],
        build: {
            rollupOptions: {
                input: resolve(root, "apps/desktop/renderer/index.html"),
            },
        },
    },
});
