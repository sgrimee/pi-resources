import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const sdk = await import("@earendil-works/pi-coding-agent");
const root = sdk.getPackageDir();
const { loadThemeFromPath } = await import(pathToFileURL(path.join(root, "dist/modes/interactive/theme/theme.js")));
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences, CURSOR_MARKER } = await import("@earendil-works/pi-tui");
const theme = loadThemeFromPath(path.join(root, "dist/modes/interactive/theme/dark.json"), "truecolor");
const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const original = sdk.ExtensionRunner.prototype.createCommandContext;
const commands = [
  { name: "review", source: "prompt", description: "Review the current changes", sourceInfo: { path: "/tmp/review.md", scope: "project" } },
  { name: "helper", source: "extension", sourceInfo: { path: "/tmp/helper.ts" } },
];
const plain = (lines) => lines.map((line) => stripTerminalSequences(line)).join("\n");

async function fixture({ mode = "tui", rows = 40, width = 112, contextFiles, skills, extraExtensions = [], keys } = {}) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-resources-test-"));
  const loaded = await sdk.discoverAndLoadExtensions([extensionPath], sandbox, sandbox);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getCommands = () => commands;
  const extension = loaded.extensions[0];
  const extensionStub = (name) => ({ ...extension, path: name, commands: new Map(), handlers: new Map(), tools: new Map() });
  const runner = new sdk.ExtensionRunner([extension, extensionStub("/tmp/event-only.ts"), ...extraExtensions.map(extensionStub)], loaded.runtime, "/tmp", {}, {});
  const screens = [];
  const notices = [];
  const terminal = { rows, columns: width + 4 };
  const tui = { terminal, requestRender() {} };
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, keys);
  let action = (browser) => browser.handleInput("\x1b");
  let selection;
  runner.setUIContext({
    select: async (title, items) => { screens.push({ title, items }); return selection; },
    custom: async (factory, options) => {
      let result;
      let closed = false;
      const browser = await factory(tui, theme, keybindings, (value) => { result = value; closed = true; });
      browser.focused = true;
      const screen = { browser, options, raw: browser.render(width) };
      screen.items = screen.raw.map(stripTerminalSequences);
      screens.push(screen);
      action(browser, screen);
      if (!closed) browser.handleInput("\x1b");
      return result;
    },
    notify: (message, level) => notices.push({ message, level }),
  }, mode);
  await runner.emit({ type: "session_start" });
  async function run(args = "", { hasUI = true } = {}) {
    const ctx = runner.createCommandContext();
    ctx.getSystemPromptOptions = () => ({
      cwd: "/tmp",
      contextFiles: contextFiles ?? [{ path: "/tmp/AGENTS.md", content: "private instructions" }],
      skills: skills ?? [{ name: "example", filePath: "/tmp/example/SKILL.md", description: "A useful example skill" }],
    });
    if (!hasUI) Object.defineProperty(ctx, "hasUI", { value: false });
    await extension.commands.get("resources").handler(args, ctx);
  }
  return {
    runner, extension, screens, notices, run, terminal,
    interact(callback) { action = callback; },
    select(value) { selection = value; },
    close: async () => {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

async function withFixture(options, callback) {
  const f = await fixture(options);
  try { await callback(f); } finally { await f.close(); }
  assert.equal(sdk.ExtensionRunner.prototype.createCommandContext, original);
}

test("all groups have colored headings, counts, friendly names, and no file contents", async () => {
  await withFixture({}, async (f) => {
    await f.run();
    const screen = f.screens[0];
    const text = screen.items.join("\n");
    for (const expected of ["Context files (1)", "Skills (1)", "Prompt templates (1)", "Extensions (2)", "/tmp/AGENTS.md", "example", "/review", "event-only", "[project]", "5 available"]) {
      assert.ok(text.includes(expected), expected);
    }
    assert.ok(!text.includes("private instructions"));
    assert.ok(screen.raw.some((line) => /\x1b\[38;2;/.test(line)), "truecolor theme applied");
    assert.ok(screen.raw.some((line) => /\x1b\[48;2;/.test(line)), "selected row has background");
    assert.equal(screen.options.overlay, true);
    assert.deepEqual(f.notices, []);
  });
});

test("category arguments initially show only that category's nonselectable heading", async () => {
  await withFixture({}, async (f) => {
    for (const group of ["context", "skills", "prompts", "extensions"]) {
      await f.run(group);
      const headings = f.screens.at(-1).items.filter((line) => /│\s+(Context files|Skills|Prompt templates|Extensions) \(/.test(line));
      assert.equal(headings.length, 1, group);
    }
  });
});

test("unknown filters explain usage without opening UI", async () => {
  await withFixture({}, async (f) => {
    await f.run("unknown");
    assert.equal(f.screens.length, 0);
    assert.equal(f.notices[0].level, "warning");
    assert.match(f.notices[0].message, /Usage:/);
  });
});

test("Enter displays full source path; Escape is silent", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => browser.handleInput("\r"));
    await f.run("context");
    assert.deepEqual(f.notices, [{ message: "/tmp/AGENTS.md", level: "info" }]);
  });
});

test("arrow navigation skips section headers and detail pane follows selection", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => {
      browser.handleInput("\x1b[B");
      const rendered = plain(browser.render(112));
      assert.match(rendered, /A useful example skill/);
      browser.handleInput("\r");
    });
    await f.run();
    assert.equal(f.notices[0].message, "/tmp/example/SKILL.md");
  });
});

test("Tab and Shift+Tab cycle categories without changing the inventory", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => {
      browser.handleInput("\t");
      assert.ok(!plain(browser.render(112)).includes("Skills (1)"));
      browser.handleInput("\x1b[Z");
      assert.ok(plain(browser.render(112)).includes("Skills (1)"));
    });
    await f.run();
  });
});

test("search matches descriptions and paths, supports multiword filtering", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => {
      browser.handleInput("useful example");
      const text = plain(browser.render(112));
      assert.ok(text.includes("Skills (1)"));
      assert.ok(!text.includes("Context files (1)"));
      browser.handleInput("\r");
    });
    await f.run();
    assert.equal(f.notices[0].message, "/tmp/example/SKILL.md");
  });
});

test("no-match search is explicit and Enter does not emit a bogus path", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => {
      browser.handleInput("notfound");
      assert.match(plain(browser.render(112)), /No matches/);
      browser.handleInput("\r");
    });
    await f.run();
    assert.deepEqual(f.notices, []);
  });
});

test("empty categories are explicit", async () => {
  await withFixture({ skills: [] }, async (f) => {
    await f.run("skills");
    assert.match(f.screens[0].items.join("\n"), /No resources loaded/);
  });
});

test("long lists page correctly, including event-only extensions", async () => {
  const extraExtensions = Array.from({ length: 80 }, (_, i) => `/tmp/extension-${String(i).padStart(3, "0")}.ts`);
  await withFixture({ extraExtensions }, async (f) => {
    f.interact((browser) => {
      for (let i = 0; i < 100; i++) browser.handleInput("\x1b[6~");
      const text = plain(browser.render(112));
      assert.ok(text.includes("82/82"));
      assert.ok(text.includes("resources"));
      browser.handleInput("\r");
    });
    await f.run("extensions");
    assert.equal(f.notices[0].message, extensionPath);
  });
});

test("width/height bounds survive tiny terminals, long paths, Unicode, and resizing", async () => {
  await withFixture({ contextFiles: [{ path: `/tmp/${"資料😀".repeat(80)}/AGENTS.md`, content: "private" }] }, async (f) => {
    f.interact((browser) => {
      for (const rows of [4, 12, 14, 18, 24, 40, 80]) {
        f.terminal.rows = rows;
        for (const width of [1, 8, 19, 20, 30, 40, 60, 74, 80, 112, 180]) {
          const lines = browser.render(width);
          assert.ok(lines.length <= Math.max(1, rows - 2), `height ${lines.length} > ${rows - 2} at ${width}x${rows}`);
          for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${visibleWidth(line)} > ${width}`);
        }
      }
    });
    await f.run();
  });
});

test("search focus propagates for cursor/IME positioning", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => {
      browser.focused = true;
      assert.ok(browser.render(112).some((line) => line.includes(CURSOR_MARKER)));
      browser.focused = false;
      assert.ok(!browser.render(112).some((line) => line.includes(CURSOR_MARKER)));
    });
    await f.run();
  });
});

test("mouse wheel and row clicks update selection without selecting headings", async () => {
  await withFixture({}, async (f) => {
    f.interact((browser) => {
      browser.handleMouse({ type: "wheel", wheelDelta: 1 });
      let lines = browser.render(112);
      assert.match(plain(lines), /A useful example skill/);
      const y = lines.findIndex((line) => stripTerminalSequences(line).includes("AGENTS.md"));
      browser.handleMouse({ type: "press", button: "left", x: 5, y });
      browser.handleInput("\r");
    });
    await f.run();
    assert.equal(f.notices[0].message, "/tmp/AGENTS.md");
  });
});

test("customized selection keys are honored", async () => {
  await withFixture({ keys: { "tui.select.down": "ctrl+n" } }, async (f) => {
    f.interact((browser) => { browser.handleInput("\x0e"); browser.handleInput("\r"); });
    await f.run();
    assert.equal(f.notices[0].message, "/tmp/example/SKILL.md");
  });
});

test("RPC retains a built-in selector rather than a terminal-only overlay", async () => {
  await withFixture({ mode: "rpc" }, async (f) => {
    f.select("AGENTS.md · /tmp — /tmp/AGENTS.md");
    await f.run();
    assert.equal(f.screens[0].browser, undefined);
    assert.ok(f.screens[0].items.includes("event-only — /tmp/event-only.ts"));
    assert.equal(f.notices[0].message, "/tmp/AGENTS.md");
  });
});

test("noninteractive invocation does not access UI", async () => {
  await withFixture({}, async (f) => {
    await f.run("", { hasUI: false });
    assert.equal(f.screens.length, 0);
    assert.equal(f.notices.length, 0);
  });
});

test("overlapping runtimes share bridge and final shutdown restores original", async () => {
  const first = await fixture();
  const wrapped = sdk.ExtensionRunner.prototype.createCommandContext;
  const second = await fixture();
  try {
    assert.equal(sdk.ExtensionRunner.prototype.createCommandContext, wrapped);
    await first.close();
    assert.equal(sdk.ExtensionRunner.prototype.createCommandContext, wrapped);
    await second.run("extensions");
    assert.ok(second.screens[0].items.join("\n").includes("event-only"));
  } finally { await first.close(); await second.close(); }
  assert.equal(sdk.ExtensionRunner.prototype.createCommandContext, original);
});

test("startup and shutdown stay silent and register no shortcut", async () => {
  await withFixture({}, async (f) => {
    assert.equal(f.extension.shortcuts.size, 0);
    assert.equal(f.screens.length, 0);
    assert.equal(f.notices.length, 0);
  });
});
