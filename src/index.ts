/**
 * /resources [context|skills|prompts|extensions]
 * Show loaded resources without printing them at startup or calling the model.
 *
 * Pi 1.3.0 has no ExtensionAPI method for enumerating event-only extensions.
 * The lifecycle-scoped bridge below adds a read-only snapshot to command
 * contexts using public ExtensionRunner methods. No resources are reloaded.
 */
import { basename, dirname } from "node:path";
import {
  ExtensionRunner,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  ResourceBrowser, displayPath, extensionName, groups, resourceSource, titles,
  type Group, type ResourceGroups,
} from "./browser.ts";

const bridgeKey = Symbol.for("pi-resources.command-context-bridge.v1");
type Bridge = {
  users: number;
  paths: WeakMap<ExtensionCommandContext, string[]>;
  original: ExtensionRunner["createCommandContext"];
  wrapped: ExtensionRunner["createCommandContext"];
};
type BridgedPrototype = typeof ExtensionRunner.prototype & { [bridgeKey]?: Bridge };

function acquireBridge(): { bridge: Bridge; release: () => void } {
  const prototype = ExtensionRunner.prototype as BridgedPrototype;
  let bridge = prototype[bridgeKey];
  if (!bridge) {
    const paths = new WeakMap<ExtensionCommandContext, string[]>();
    const original = prototype.createCommandContext;
    const wrapped: typeof original = function (this: ExtensionRunner) {
      const ctx = original.call(this);
      paths.set(ctx, this.getExtensionPaths());
      return ctx;
    };
    bridge = { users: 0, paths, original, wrapped };
    prototype[bridgeKey] = bridge;
    prototype.createCommandContext = wrapped;
  }
  const current = bridge;
  current.users++;
  let released = false;
  return {
    bridge: current,
    release() {
      if (released) return;
      released = true;
      if (--current.users === 0 && prototype.createCommandContext === current.wrapped) {
        prototype.createCommandContext = current.original;
        delete prototype[bridgeKey];
      }
    },
  };
}

export default function resourcesExtension(pi: ExtensionAPI) {
  let connection: ReturnType<typeof acquireBridge> | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && !connection) connection = acquireBridge();
  });
  pi.on("session_shutdown", () => {
    connection?.release();
    connection = undefined;
  });

  pi.registerCommand("resources", {
    description: "Show loaded context files, skills, prompts, and extensions",
    getArgumentCompletions(prefix) {
      const matches = groups.filter((group) => group.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const filter = args.trim();
      if (filter && !groups.includes(filter as Group)) {
        ctx.ui.notify("Usage: /resources [context|skills|prompts|extensions]", "warning");
        return;
      }
      const options = ctx.getSystemPromptOptions();
      const commands = pi.getCommands();
      const extensionPaths = connection?.bridge.paths.get(ctx);
      const entries: ResourceGroups = {
        context: (options.contextFiles ?? []).map((file) => ({
          name: `${basename(file.path)} · ${displayPath(dirname(file.path))}`, path: file.path,
          source: resourceSource(file.path, ctx.cwd),
        })),
        skills: (options.skills ?? []).map((skill) => ({
          name: skill.name, path: skill.filePath, description: skill.description,
          source: resourceSource(skill.filePath, ctx.cwd, skill.sourceInfo),
        })),
        prompts: commands.filter((command) => command.source === "prompt").map((command) => ({
          name: `/${command.name}`, path: command.sourceInfo.path ?? "", description: command.description,
          source: resourceSource(command.sourceInfo.path ?? "", ctx.cwd, command.sourceInfo),
        })),
        extensions: (extensionPaths ?? []).map((path) => ({
          name: extensionName(path), path, source: resourceSource(path, ctx.cwd),
        })),
      };
      if (!extensionPaths && (!filter || filter === "extensions")) {
        ctx.ui.notify("Extension inventory unavailable; /reload to refresh the compatibility bridge.", "warning");
      }
      let path: string | undefined;
      if (ctx.mode === "tui") {
        path = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
          new ResourceBrowser(entries, (filter || "all") as "all" | Group, tui, theme, keys, done),
          { overlay: true, overlayOptions: { width: "90%", maxHeight: "95%", margin: 1 } },
        );
      } else {
        // RPC clients support built-in dialogs but not custom terminal components.
        const lines: string[] = [];
        const paths = new Map<string, string>();
        for (const group of groups) {
          if (filter && group !== filter) continue;
          const items = entries[group].sort((a, b) => a.name.localeCompare(b.name));
          lines.push(`--- ${titles[group]} (${items.length}) ---`);
          for (const item of items) {
            const label = `${item.name} — ${displayPath(item.path)}`;
            lines.push(label);
            paths.set(label, item.path);
          }
          if (!items.length) lines.push("(none)");
        }
        const selected = await ctx.ui.select("Loaded resources · Esc closes · Enter shows full path", lines);
        path = selected ? paths.get(selected) : undefined;
      }
      if (path) ctx.ui.notify(path, "info");
    },
  });
}
