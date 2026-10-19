# pi-resources

A [Pi](https://pi.dev) extension for browsing **loaded context files, skills,
prompt templates, and extensions** only when you want to see them.

Run `/resources` for a theme-aware browser with:

- Color-coded category headings and resource counts.
- Category tabs, live search, and compact names with source badges.
- A detail panel with the selected resource's full path and description.
- Keyboard navigation, mouse selection, and responsive terminal sizing.
- A built-in selector fallback for RPC clients.

It makes **no model calls**, reloads no resources, and never displays instruction
file contents. Escape closes the browser without adding anything to the transcript.

## Requirements

- Pi **1.3.0** (tested); Node.js ≥ 22.19.
- Interactive TUI for the styled browser. RPC clients get a plain selector.
  Print and JSON invocations are inert.

> Extension inventory uses a small compatibility bridge around Pi's exported
> `ExtensionRunner.createCommandContext()` and `getExtensionPaths()` methods.
> Pi currently provides no equivalent extension-facing inventory API. The bridge
> is reference-counted, attaches only during UI sessions, and restores the
> original method on final shutdown. This includes event-only extensions, but
> future Pi versions or other extensions patching the same method may require
> compatibility updates.

## Install

From GitHub:

```bash
pi install git:github.com/sgrimee/pi-resources
# or pin a release:
pi install git:github.com/sgrimee/pi-resources@v0.1.0
```

Try it for one session without installing:

```bash
pi -e git:github.com/sgrimee/pi-resources
```

Published on GitHub; no npm account or separate build step is needed.

From a local checkout:

```bash
pi install /absolute/path/to/pi-resources
```

Run `/reload` in existing Pi sessions after installation.

### Quiet startup

This extension does **not** change your settings. To hide the startup resource
listing while keeping Pi's version and key hints, add this to
`~/.pi/agent/settings.json`:

```json
{
  "quietStartup": "header"
}
```

Use `true` instead to hide the startup header too. Resources still load normally;
`/resources` only changes how you inspect them.

## Usage

| Command | Initial view |
|---|---|
| `/resources` | All categories |
| `/resources context` | Context/instruction files |
| `/resources skills` | Skills |
| `/resources prompts` | Prompt templates |
| `/resources extensions` | Extensions, including event-only extensions |

Inside the browser:

| Action | Control |
|---|---|
| Move through resources | ↑ / ↓ |
| Move a page | Page Up / Page Down |
| Switch category | Tab / Shift+Tab |
| Search names, paths, descriptions, or sources | Type |
| Edit/clear the search | Standard input editing keys |
| Show the full source path in the transcript and close | Enter |
| Close without transcript output | Escape |
| Select / navigate | Click a row / mouse wheel |

Selection, paging, confirmation, and cancellation honor Pi's configured selection
keybindings. No global shortcut is registered.

Source badges distinguish built-in, package, user, project, session, and local
resources. Resource counts refer to the loaded session snapshot, not files
rediscovered from disk.

## Development

```bash
npm ci --ignore-scripts
npm run check
pi -e ./src/index.ts
```

Layout matches a standard source-based Pi package:

```text
src/index.ts       extension, runtime inventory bridge, RPC fallback
src/browser.ts     themed resource browser and display helpers
test/              runtime/UI and package-distribution tests
.github/workflows/ CI
```

The tests use isolated temporary agent directories and the development Pi SDK;
they do not depend on a personal `~/.pi` installation or call a model.

## Release

The `pi.extensions` manifest points directly to TypeScript source, so both GitHub
and npm installs work without a compilation step. Pi supplies the SDK and TUI;
they are peer dependencies, never bundled runtime dependencies.

1. Run `npm ci --ignore-scripts`, then `npm run check`.
2. Inspect `npm pack --dry-run`. Only source, package metadata, and public docs
   should be included.
3. Commit the release. For later releases, use `npm version patch` (or the
   appropriate bump) and update the pinned install example above.
4. Push `main` and the release tag to `github.com/sgrimee/pi-resources`.
5. Confirm GitHub Actions passes, then create a GitHub release for the tag.
6. Test `pi install git:github.com/sgrimee/pi-resources@v<version>` with an
   isolated `PI_CODING_AGENT_DIR`.

GitHub is the published install source. The package is also npm-ready, but is not
published to the npm registry. The `prepack` hook runs typechecking and tests
before packing.

## License

MIT
