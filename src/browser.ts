import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { SourceInfo, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Input, Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type KeybindingsManager, type TUI,
  type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export const groups = ["context", "skills", "prompts", "extensions"] as const;
export type Group = (typeof groups)[number];
export type ResourceItem = { name: string; path: string; description?: string; source?: string };
export type ResourceGroups = Record<Group, ResourceItem[]>;
export const titles: Record<Group, string> = {
  context: "Context files", skills: "Skills", prompts: "Prompt templates", extensions: "Extensions",
};
const shortTitles: Record<Group, string> = {
  context: "Context", skills: "Skills", prompts: "Prompts", extensions: "Extensions",
};
const colors: Record<Group, ThemeColor> = {
  context: "accent", skills: "success", prompts: "warning", extensions: "mdHeading",
};
const clean = (text: string) => stripTerminalSequences(text).replace(/\s+/g, " ").trim();

export function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function extensionName(path: string): string {
  if (path.startsWith("builtin:")) return path.slice("builtin:".length);
  const packageMatch = path.replace(/\\/g, "/").match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/);
  if (packageMatch) {
    const leaf = basename(packageMatch[2]).replace(/\.[cm]?[jt]s$/, "");
    return leaf === "index" ? packageMatch[1] : `${packageMatch[1]} / ${leaf}`;
  }
  const leaf = basename(path).replace(/\.[cm]?[jt]s$/, "");
  if (leaf !== "index") return leaf;
  const parent = dirname(path);
  return ["src", "dist", "extensions"].includes(basename(parent)) ? basename(dirname(parent)) : basename(parent);
}

export function resourceSource(path: string, cwd: string, info?: SourceInfo): string {
  if (path.startsWith("builtin:")) return "built-in";
  if (info?.origin === "package" || path.includes("/node_modules/")) return "package";
  if (info?.scope) return info.scope === "temporary" ? "session" : info.scope;
  if (path === cwd || path.startsWith(`${cwd}/`)) return "project";
  if (path.startsWith(`${homedir()}/.pi/agent/`)) return "user";
  return "local";
}

type ItemRow = { kind: "item"; group: Group; item: ResourceItem; index: number };
type Row = ItemRow | { kind: "heading"; group: Group; count: number } | { kind: "empty"; group: Group };

/** A grouped, searchable viewport; headings never participate in selection. */
export class ResourceBrowser implements Component, Focusable {
  private readonly search = new Input({ prompt: "Search  ", placeholder: "name, path, or description…" });
  private category: "all" | Group;
  private rows: Row[] = [];
  private items: ItemRow[] = [];
  private selected = 0;
  private top = 0;
  private pageSize = 10;
  private mouseRows = new Map<number, ItemRow>();
  private searchRow = 0;

  constructor(
    private readonly entries: ResourceGroups,
    initialCategory: "all" | Group,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly done: (path: string | undefined) => void,
  ) {
    this.category = initialCategory;
    this.refresh();
  }

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }
  invalidate(): void { this.search.invalidate(); }

  private refresh(): void {
    this.rows = [];
    this.items = [];
    const words = clean(this.search.getValue()).toLowerCase().split(" ").filter(Boolean);
    for (const group of groups) {
      if (this.category !== "all" && this.category !== group) continue;
      const items = this.entries[group].filter((item) => {
        const haystack = `${titles[group]} ${item.name} ${item.path} ${item.description ?? ""} ${item.source ?? ""}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      if (words.length && !items.length) continue;
      this.rows.push({ kind: "heading", group, count: items.length });
      for (const item of items) {
        const row: ItemRow = { kind: "item", group, item, index: this.items.length };
        this.items.push(row);
        this.rows.push(row);
      }
      if (!items.length) this.rows.push({ kind: "empty", group });
    }
    this.selected = 0;
    this.top = 0;
  }

  private move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) { this.done(undefined); return; }
    if (this.keys.matches(data, "tui.select.confirm")) { this.done(this.items[this.selected]?.item.path || undefined); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      const categories = ["all", ...groups] as const;
      const delta = matchesKey(data, Key.shift("tab")) ? -1 : 1;
      this.category = categories[(categories.indexOf(this.category) + delta + categories.length) % categories.length];
      this.refresh();
    } else if (this.keys.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.move(1);
    else if (this.keys.matches(data, "tui.select.pageUp")) this.move(-this.pageSize);
    else if (this.keys.matches(data, "tui.select.pageDown")) this.move(this.pageSize);
    else {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.refresh();
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.move(event.wheelDelta ?? 0);
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.type === "press" && event.button === "left") {
      const row = this.mouseRows.get(event.y);
      if (row) this.selected = row.index;
      if (event.y === this.searchRow) this.search.handleMouse({ ...event, x: event.x - 2, y: 0, width: Math.max(1, event.width - 4) });
      this.tui.requestRender();
      return { handled: true, focus: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.min(34, this.tui.terminal.rows - 2));
    this.mouseRows.clear();
    if (width < 20 || height < 12) {
      return ["Loaded resources", "Enlarge terminal to browse", "Esc closes"].slice(0, height).map((line) => truncateToWidth(line, width));
    }
    const inner = width - 4;
    const fg = (color: ThemeColor, text: string) => this.theme.fg(color, text);
    const count = groups.reduce((sum, group) => sum + this.entries[group].length, 0);
    const title = `${fg("accent", this.theme.bold("LOADED RESOURCES"))}  ${fg("muted", `${count} available`)}`;
    const tabs = (["all", ...groups] as const).map((group) => {
      const label = group === "all" ? `All ${count}` : `${shortTitles[group]} ${this.entries[group].length}`;
      const color = group === "all" ? "accent" : colors[group];
      return this.theme.style(` ${label} `, { fg: color, bold: group === this.category, bg: group === this.category ? "selectedBg" : undefined });
    }).join(" ");
    const rule = fg("borderMuted", "─".repeat(inner));
    const tabLines = width >= 74 ? wrapTextWithAnsi(tabs, inner) : [fg("accent", `${this.category === "all" ? "All resources" : titles[this.category]} · Tab to switch`)];
    const header = [title, ...tabLines, ...this.search.render(inner), rule];
    this.searchRow = header.length - 1; // one border row + zero-based search offset
    const current = this.items[this.selected];
    const detail = [rule];
    if (current) {
      detail.push(fg(colors[current.group], this.theme.bold(clean(current.item.name))));
      detail.push(...wrapTextWithAnsi(fg("muted", clean(current.item.path) || "No source path"), inner).slice(0, height >= 20 ? 2 : 1));
      if (current.item.description && height >= 20) detail.push(fg("dim", truncateToWidth(clean(current.item.description), inner)));
    } else detail.push(fg("muted", this.search.getValue() ? "No matching resources. Clear the search to see everything." : "No resources in this category."));
    const keyLabel = (id: "tui.select.confirm" | "tui.select.cancel") => this.keys.getKeys(id)[0] ?? "unbound";
    const helpText = height >= 20 ? `↑↓ navigate · Tab categories · type to search · ${keyLabel("tui.select.confirm")} path · ${keyLabel("tui.select.cancel")} close` : `↑↓ · Tab · ${keyLabel("tui.select.cancel")} close`;
    const help = wrapTextWithAnsi(fg("dim", helpText), inner).slice(0, height >= 20 ? 2 : 1);
    this.pageSize = Math.max(1, height - 2 - header.length - detail.length - help.length);
    const selectedRow = this.rows.findIndex((row) => row.kind === "item" && row.index === this.selected);
    if (selectedRow >= 0) {
      if (selectedRow < this.top) this.top = Math.max(0, selectedRow - 1);
      if (selectedRow >= this.top + this.pageSize) this.top = selectedRow - this.pageSize + 1;
    }
    this.top = Math.max(0, Math.min(this.top, this.rows.length - this.pageSize));
    const body: string[] = [];
    for (const row of this.rows.slice(this.top, this.top + this.pageSize)) {
      if (row.kind === "heading") {
        body.push(fg(colors[row.group], this.theme.bold(` ${titles[row.group]} (${row.count})`)));
      } else if (row.kind === "empty") {
        body.push(fg("dim", "  No resources loaded"));
      } else {
        const active = row.index === this.selected;
        const badge = inner >= 32 && row.item.source ? ` [${clean(row.item.source)}]` : "";
        const nameWidth = Math.max(1, inner - 2 - visibleWidth(badge));
        let line = fg(active ? colors[row.group] : "text", `${active ? "› " : "  "}${truncateToWidth(clean(row.item.name), nameWidth, "…", true)}`) + fg("dim", badge);
        if (active) line = this.theme.bg("selectedBg", line);
        this.mouseRows.set(1 + header.length + body.length, row);
        body.push(line);
      }
    }
    if (!this.rows.length) body.push(fg("warning", "  No matches"));
    while (body.length < this.pageSize) body.push("");
    const position = this.items.length ? ` ${this.selected + 1}/${this.items.length} ` : "";
    const bottom = fg("border", `╰${"─".repeat(Math.max(0, width - 2 - visibleWidth(position)))}${position}╯`);
    const frame = (line: string) => fg("border", "│ ") + truncateToWidth(line, inner, "…", true) + fg("border", " │");
    return [fg("border", `╭${"─".repeat(width - 2)}╮`), ...header.map(frame), ...body.map(frame), ...detail.map(frame), ...help.map(frame), bottom];
  }
}
