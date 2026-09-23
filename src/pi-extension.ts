/**
 * The Pi extension `refluent install --agent pi` writes into
 * `~/.pi/agent/extensions/refluent.ts`.
 *
 * Pi has no hook file, so capture happens here: `before_agent_start` carries the
 * outgoing prompt. The prompt is never modified or delayed — the capture call is
 * detached — and Pi's status bar is keyed, so refluent's line coexists with the
 * lines other extensions set instead of competing for one slot.
 */
export interface PiExtensionPaths {
  /** Absolute path to the `refluent` bin entrypoint. */
  binPath: string;
  /** Absolute path to the node executable that runs it. */
  nodePath: string;
}

/** The file name refluent owns inside Pi's personal extensions directory. */
export const PI_EXTENSION_FILENAME = 'refluent.ts';

export function piExtensionSource(paths: PiExtensionPaths): string {
  const bin = JSON.stringify(paths.binPath);
  const node = JSON.stringify(paths.nodePath);
  return `// refluent: English phrasing suggestions from the messages you send to Pi.
// Written by \`refluent install --agent pi\`; \`refluent uninstall --agent pi\` removes it.
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NODE = ${node};
const BIN = ${bin};
const STATUS_KEY = "refluent";
/** The suggestion expires with the status line's own 15-minute window. */
const REFRESH_MS = 5000;
const SUGGESTION_TTL_MS = 15 * 60 * 1000;

function run(args: string[], input?: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const child = spawn(NODE, [BIN, ...args], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(out));
      if (input !== undefined) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    } catch {
      resolve("");
    }
  });
}

/** Fire-and-forget: capture must never delay or alter the prompt. */
function capture(payload: Record<string, unknown>): void {
  try {
    const child = spawn(NODE, [BIN, "hook", "user-prompt-submit", "--agent", "pi"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch {
    // Best-effort by design.
  }
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let shownAt = 0;

  /** Pi has no UI in print/JSON modes; a status update must never break the run. */
  function setStatus(ctx: { ui?: { setStatus?: (key: string, text?: string) => void } }, text?: string) {
    try {
      ctx.ui?.setStatus?.(STATUS_KEY, text);
    } catch {
      // Terminal-only by nature.
    }
  }

  async function refresh(ctx: { ui?: { setStatus?: (key: string, text?: string) => void } }) {
    const line = (await run(["hook", "statusline", "--agent", "pi"])).trimEnd();
    if (line.length > 0) {
      setStatus(ctx, line);
      shownAt = Date.now();
    } else if (shownAt !== 0 && Date.now() - shownAt > SUGGESTION_TTL_MS) {
      setStatus(ctx, undefined);
      shownAt = 0;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const notice = (await run(["hook", "session-start", "--agent", "pi"])).trim();
    if (notice.length > 0) {
      try {
        const parsed = JSON.parse(notice) as { systemMessage?: string };
        if (parsed.systemMessage) ctx.ui.notify(parsed.systemMessage, "info");
      } catch {
        // A malformed notice is never worth interrupting a session for.
      }
    }
    if (timer === null) {
      timer = setInterval(() => void refresh(ctx), REFRESH_MS);
      timer.unref?.();
    }
    void refresh(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    capture({ prompt: event.prompt, session_id: ctx.sessionId ?? null });
    // The analysis runs detached, so the first refresh has to wait for it.
    setTimeout(() => void refresh(ctx), 1500);
  });

  pi.on("agent_end", async (_event, ctx) => {
    void refresh(ctx);
  });
}
`;
}
