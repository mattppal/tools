---
name: tools-styling
description: UI rules for the tools repo - poaster kit primitives and tokens, the sidebar with nested sections and the opt-in Details panel via ToolLayout, the Settings page, mobile layout, and PWA constraints. Use when building or changing any UI in this repo.
---

# Styling

Read `skills/emil-design-eng/SKILL.md` before UI work.

## Primitives and tokens

- `src/kit/` is a copy of poaster's kit (Base UI + Tailwind 4 + `cva`). Use `Button`, `IconButton`, `Input`, `Popover`, `ScrollArea`, `Sheet`, `Tooltip`, and the `Sidebar*` parts before writing new ones.
- Tokens live in `src/styles/tokens.css` and `src/styles/hairline.css`. Use them for color, space, radius, type, and motion: `var(--space-3)`, `var(--text-sm)`, `var(--radius-md)`, `var(--duration-hover)`. Don't hard-code colors; every color token works in light and dark.
- The look is poaster's Hairline preset. Its values (space, type, radius, elevation, 1px `--border-width`, no shadows) live only in `src/styles/presets/hairline.json`. `bun run hairline` generates `src/styles/hairline.css` from it, and `bun run build` fails when they drift. To change one of those tokens, edit the JSON and regenerate; don't redefine them in `tokens.css` or a module. To adopt a newer poaster preset, copy poaster's `src/web/ui/kit-gallery/presets/hairline.json` over ours and run `bun run hairline`.
- Charts draw in the neutral text tokens and get one color, `--chart-accent`, a muted blue, for the series that matters most, like a trend line. Draw it as a plain line with no fill or gradient under it. Raw data points, or daily bars under a trend, stay muted in `--text-3`. Signed changes, like a weight change, tint their text only: `--change-good` and `--change-bad` when the goal says which direction is good, `--change-down` and `--change-up` when it doesn't, and no tint near zero. Scale the tint with the magnitude by mixing the token into `--text-2`, so small changes barely show. Progress fills use the same family: `--change-down` under a target, `--change-good` in range, `--change-bad` over it. Never a background, pill, or dot.
- Tailwind utilities map to the same tokens (`bg-chrome`, `text-muted-foreground`, `h-control-md`). CSS modules are fine; poaster uses both.
- Icons come from `src/shell/icons.tsx` (Hugeicons). Add a glyph there to use a new one.
- No status dots and no status pills, at any width. Don't show state with a colored dot, a light, or a tinted badge. When state matters, say it in plain words in the surrounding text style, like the home page's database line. Often the action already says it (Start, Continue, View), and then the state needs no label at all. `bun run check:style` fails the build on a small, fully rounded element and on a padded, filled, fully rounded one that isn't clickable.

## Edges

- Hairlines by default: surfaces, cards, fields, buttons, and popovers draw `border: var(--border-width) solid var(--border-color)`, or the kit's `edge-surface` / `edge-raised` / `edge-overlay` utilities. Don't hard-code `1px solid`.
- The shell's columns are the exception. The sidebar, the main pane, and the Details panel are separated by shade alone (`--chrome-bg`, `--panel-bg`, `--sunken-bg`) with no border, and so are their phone sheets. Don't add a line there.
- Before adding a border, check that the neighbor doesn't already draw one, so you never get a doubled line. Check light and dark at desktop and 390px.

## Layout

Every page renders `ToolLayout` from `src/shell/tool-layout.tsx`:

```tsx
<ToolLayout
	title="Name"
	actions={<Button>Save</Button>}
	sections={[{ label: "Today", path: "/" }, { label: "History", path: "/history" }]}
	panel={{ label: "Details", content: <Details /> }}
>
	{main}
</ToolLayout>
```

- Sidebar: one column, owned by the shell. It lists the tools and nests the open tool's sections under it. The button in its header or Cmd/Ctrl+S collapses it to an icon rail, and it remembers its state. Don't add a second sidebar.
- Sections (`sections`): optional links to the tool's own pages. Each `path` is relative to `/<slug>`; read the current one with `useToolPath()`. Pass the same list from every page of the tool. The rail hides them.
- Details panel (`panel`): opt-in, per page. The title row shows a quiet button with the panel's `label`, the panel closes from its own header, and Cmd/Ctrl+Option+P toggles it. It docks at 1024px and wider; below that it opens as a sheet from the right. Pass `open` and `onOpenChange` to open it from your own control, like a bottom-bar button. Leave `panel` out on pages with nothing to show; never pass a placeholder.
- The title row holds the title, the tool's `actions`, and the panel button. Don't put layout toggles there.

## Settings

- `/settings` belongs to the shell. The sidebar footer links to it with a quiet row at the bottom left, and on phones it sits at the bottom of the nav sheet. `new-tool` and the skill check refuse a tool named `settings`.
- It holds the theme choice (System, Light, Dark) and the Debug rows: build commit, deploy time, database latency, Access identity, service worker, app install state, and safe-area insets. Rows are plain text. No dots, pills, or colored states.
- Tools add their own rows with `tools/<slug>/debug.ts`; see `tools-add-a-tool`. Every `webhook.ts` gets backlog rows without one.

## Mobile

- Breakpoints come from `useLayout()` in `src/kit/layout.ts`: `compact` under 768px, `medium` to 1023px, `expanded` from 1024px. Use the hook, not new media queries in TS.
- On `compact`, the sidebar becomes a nav sheet opened from the header's menu button, with sections nested under the open tool, and the Details panel becomes a sheet from the right. Keep the main content usable at 360px wide.
- Touch targets are at least `var(--hit)` (44px) where possible.

## Safe areas

- Backgrounds run to the screen edge and content is inset. Inside the shell, pad anything pinned to an edge with `--edge-top`, `--edge-right`, `--edge-bottom`, and `--edge-left`, for example `padding-bottom: calc(var(--space-4) + var(--edge-bottom))`. They hold `env(safe-area-inset-*)` and drop to `0px` where the sidebar already covers that edge.
- No control or title text goes in an inset. In landscape the Dynamic Island or notch sits in the left or right inset, and the home indicator sits in the bottom one.
- The kit `Sheet` already pads its top, bottom, and the side it slides in from. Don't add your own.
- Layouts must work at a top inset of `0`. iOS 27 home-screen apps start below an opaque status bar and report `0`; older installs report the full status-bar height.
- Don't add `apple-mobile-web-app-status-bar-style`. `black-translucent` is deprecated and blurs the top of iOS 26.1+ apps. Without it, iOS tints the status bar from a sticky header's background or from `body`, so give sticky headers a solid surface color.

## PWA

- `public/manifest.webmanifest` is linked with `crossorigin="use-credentials"` because the site sits behind Cloudflare Access.
- App icons and favicons are generated from `src/assets/logo.png` by `bun run icons`. Replace the PNG and rerun; never edit the PNGs in `public/` by hand.
- Install is offered only on phones and tablets (`pointer: coarse`), never on desktop. The sidebar footer's install button comes from `useInstall()` in `src/shell/install.ts`: it opens the browser's install prompt on Android and shows an Add to Home Screen hint on iOS and iPadOS.
- `src/sw/sw.ts` caches only same-origin `/assets/*` and icons, and only 200 responses that were not redirected. It never caches navigations or `/api/*`, so Access login pages never end up in the cache. Keep it that way.
