import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";

// =============================================================================
// Manus Debug Collector - Vite Plugin
// Writes browser logs directly to files, trimmed when exceeding size limit
// =============================================================================

const PROJECT_ROOT = import.meta.dirname;
const LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1MB per log file
const TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6); // Trim to 60% to avoid constant re-trimming

type LogSource = "browserConsole" | "networkRequests" | "sessionReplay";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function trimLogFile(logPath: string, maxSize: number) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }

    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines: string[] = [];
    let keptBytes = 0;

    // Keep newest lines (from end) that fit within 60% of maxSize
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}\n`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }

    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
    /* ignore trim errors */
  }
}

function writeToLogFile(source: LogSource, entries: unknown[]) {
  if (entries.length === 0) return;

  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);

  // Format entries with timestamps
  const lines = entries.map((entry) => {
    const ts = new Date().toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });

  // Append to log file
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

  // Trim if exceeds max size
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}

/**
 * Vite plugin to collect browser debug logs
 * - POST /__manus__/logs: Browser sends logs, written directly to files
 * - Files: browserConsole.log, networkRequests.log, sessionReplay.log
 * - Auto-trimmed when exceeding 1MB (keeps newest entries)
 */
function vitePluginManusDebugCollector(): Plugin {
  return {
    name: "manus-debug-collector",

    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true,
            },
            injectTo: "head",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      // POST /__manus__/logs: Browser sends logs (written directly to files)
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }

        const handlePayload = (payload: any) => {
          // Write logs directly to files
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };

        const reqBody = (req as { body?: unknown }).body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    },
  };
}

// =============================================================================
// Production vs development plugin set
// ─────────────────────────────────────────────────────────────────────────────
// The Manus debug/jsx-loc/runtime plugins inject scripts and middleware that
// are only useful inside the Manus dev sandbox. In production builds they add
// dead code, slow the build, and (for jsx-loc) bloat every JSX element with
// data attributes — so they are excluded when NODE_ENV=production.
// =============================================================================
const isProd = process.env.NODE_ENV === "production";

const devOnlyPlugins: Plugin[] = isProd
  ? []
  : [jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];

const plugins = [react(), tailwindcss(), ...devOnlyPlugins];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      // Force all packages to use the same React instance — prevents
      // "Invalid hook call" errors caused by duplicate React copies after
      // the web-db-user upgrade merged new dependencies.
      "react": path.resolve(import.meta.dirname, "node_modules", "react"),
      "react-dom": path.resolve(import.meta.dirname, "node_modules", "react-dom"),
      "react/jsx-runtime": path.resolve(import.meta.dirname, "node_modules", "react", "jsx-runtime"),
      "react/jsx-dev-runtime": path.resolve(import.meta.dirname, "node_modules", "react", "jsx-dev-runtime"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    force: false,
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  // esbuild minify (Vite default) with console/debugger stripped in prod.
  // esbuild is ~20-30x faster than terser and the size delta is <2%.
  esbuild: isProd
    ? {
        drop: ["console", "debugger"],
        legalComments: "none",
      }
    : undefined,
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // es2020: native dynamic import + optional chaining — covers all
    // browsers that support service workers/PWA install (Chrome 80+,
    // Safari 14+), without paying for legacy transpilation.
    target: "es2020",
    minify: "esbuild",
    // No sourcemaps in prod payloads (they'd double the transfer size).
    // Flip to "hidden" temporarily if you need to debug a prod-only issue.
    sourcemap: false,
    // Split CSS per chunk so lazy routes don't load the full stylesheet.
    cssCodeSplit: true,
    // Inline tiny assets (<4KB) as data URLs to save round-trips on 3G.
    assetsInlineLimit: 4096,
    // modulepreload polyfill + automatic preload of entry chunks (default
    // behaviour) — kept explicit so future edits don't regress it.
    modulePreload: { polyfill: true },
    // Vendor chunks are long-cacheable (content-hashed); warn only when a
    // single chunk threatens the 350KB gzip initial-bundle budget.
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        /**
         * Manual chunk splitting strategy
         * ─────────────────────────────────
         * Splitting heavy libraries into separate chunks means the browser
         * can cache them independently and only downloads what each route needs.
         *
         * Estimated chunk sizes (gzipped):
         *  vendor-react     ~45 KB  — React + ReactDOM (always needed)
         *  vendor-trpc      ~28 KB  — tRPC + TanStack Query
         *  vendor-charts    ~95 KB  — Recharts (only on /portal/analytics)
         *  vendor-motion    ~32 KB  — Framer Motion (onboarding pages)
         *  vendor-maps      ~12 KB  — Google Maps bootstrap
         *  vendor-forms     ~22 KB  — react-hook-form + zod
         *  vendor-ui        ~55 KB  — Radix UI primitives
         */
        manualChunks(id: string) {
          // React core — always needed, cache forever
          if (id.includes("node_modules/react/") ||
              id.includes("node_modules/react-dom/") ||
              id.includes("node_modules/scheduler/")) {
            return "vendor-react";
          }
          // tRPC + TanStack Query
          if (id.includes("node_modules/@trpc/") ||
              id.includes("node_modules/@tanstack/") ||
              id.includes("node_modules/superjson")) {
            return "vendor-trpc";
          }
          // Recharts — only loaded on analytics page
          if (id.includes("node_modules/recharts") ||
              id.includes("node_modules/d3-") ||
              id.includes("node_modules/victory-")) {
            return "vendor-charts";
          }
          // Framer Motion — loaded on onboarding pages
          if (id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }
          // react-hook-form + zod resolvers
          if (id.includes("node_modules/react-hook-form") ||
              id.includes("node_modules/@hookform/") ||
              id.includes("node_modules/zod")) {
            return "vendor-forms";
          }
          // Radix UI primitives
          if (id.includes("node_modules/@radix-ui/")) {
            return "vendor-ui";
          }
          // Google Maps helpers — only needed on the /map route (the JS API
          // itself loads lazily via script bootstrap, so keep any wrapper
          // libs out of the initial bundle too).
          if (id.includes("node_modules/@googlemaps/") ||
              id.includes("node_modules/@react-google-maps/")) {
            return "vendor-maps";
          }
          // Lucide icons
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-icons";
          }
          // Everything else in node_modules → vendor-misc
          if (id.includes("node_modules/")) {
            return "vendor-misc";
          }
        },
      },
    },
  },
  server: {
    host: true,
    hmr: {
      // Use the same port as the server so the WebSocket connection goes
      // through the reverse proxy correctly in the Manus sandbox environment.
      clientPort: 443,
      protocol: "wss",
    },
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
