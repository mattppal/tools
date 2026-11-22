---
name: tools-styling
description: UI rules for the tools repo - poaster kit primitives and tokens, the primary/secondary/right sidebars via ToolLayout, mobile layout, and PWA constraints. Use when building or changing any UI in this repo.
---

# Styling

Read `skills/emil-design-eng/SKILL.md` before UI work.

## Primitives and tokens

- `src/kit/` is a copy of poaster's kit (Base UI + Tailwind 4 + `cva`). Use `Button`, `IconButton`, `Input`, `ScrollArea`, `Sheet`, `Tooltip`, and the `Sidebar*` parts before writing new ones.
- Tokens live in `src/styles/tokens.css` and `src/styles/hairline.css`. Use them for color, space, radius, type, and motion: `var(--space-3)`, `var(--text-sm)`, `var(--radius-md)`, `var(--duration-hover)`. Don't hard-code colors; every color token works in light and dark.
- The look is poaster's Hairline preset. Its values (space, type, radius, elevation, 1px `--border-width`, no shadows) live only in `src/styles/presets/hairline.json`. `bun run hairline` generates `src/styles/hairline.css` from it, and `bun run build` fails when they drift. To change one of those tokens, edit the JSON and regenerate; don't redefine them in `tokens.css` or a module. To adopt a newer poaster preset, copy poaster's `src/web/ui/kit-gallery/presets/hairline.json` over ours and run `bun run hairline`.
- Tailwind utilities map to the same tokens (`bg-chrome`, `text-muted-foreground`, `h-control-md`). CSS modules are fine; poaster uses both.
- Icons come from `src/shell/icons.tsx` (Hugeicons). Add a glyph there to use a new one.

## Edges

- Hairlines by default: surfaces, cards, fields, buttons, and popovers draw `border: var(--border-width) solid var(--border-color)`, or the kit's `edge-surface` / `edge-raised` / `edge-overlay` utilities. Don't hard-code `1px solid`.
- The shell's columns are the exception. The primary sidebar against the main pane, the secondary sidebar, and the right panel are separated by shade alone (`--chrome-bg`, `--panel-bg`, `--sunken-bg`) with no border, and so are their phone drawers. Don't add a line there.
- Before adding a border, check that the neighbor doesn't already draw one, so you never get a doubled line. Check light and dark at desktop and 390px.

## Layout

Every page renders `ToolLayout` from `src/shell/tool-layout.tsx`:

```tsx
<ToolLayout
	title="Name"
	actions={<Button>Save</Button>}
	sidebar={{ label: "Lists", content: (close) => <SidebarMenu>...</SidebarMenu> }}
	panel={{ label: "Details", open, onOpenChange: setOpen, content: <Details /> }}
>
	{main}
</ToolLayout>
```

- Primary sidebar: the tool list. The shell owns it. It collapses with the header button or Cmd/Ctrl+S and remembers its state.
- Secondary sidebar (`sidebar`): optional second column for the tool's own navigation. Call `close()` after a selection so the phone drawer shuts.
- Right panel (`panel`): optional. Docks at 1024px and wider; below that it opens as a sheet from the right, like poaster's comment panel.

## Mobile

- Breakpoints come from `useLayout()` in `src/kit/layout.ts`: `compact` under 768px, `medium` to 1023px, `expanded` from 1024px. Use the hook, not new media queries in TS.
- On `compact`, all three sidebars become drawers opened from the header. Keep the main content usable at 360px wide.
- Touch targets are at least `var(--hit)` (44px) where possible.

## Safe areas

- Backgrounds run to the screen edge and content is inset. Inside the shell, pad anything pinned to an edge with `--edge-top`, `--edge-right`, `--edge-bottom`, and `--edge-left`, for example `padding-bottom: calc(var(--space-4) + var(--edge-bottom))`. They hold `env(safe-area-inset-*)` and drop to `0px` where the sidebar already covers that edge.
- No control or title text goes in an inset. In landscape the Dynamic Island or notch sits in the left or right inset, and the home indicator sits in the bottom one.
- The kit `Sheet` already pads its top, bottom, and the side it slides in from. Don't add your own.
- Layouts must work at a top inset of `0`. iOS 27 home-screen apps start below an opaque status bar and report `0`; older installs report the full status-bar height.
- Don't add `apple-mobile-web-app-status-bar-style`. `black-translucent` is deprecated and blurs the top of iOS 26.1+ apps. Without it, iOS tints the status bar from a sticky header's background or from `body`, so give sticky headers a solid surface color.

## PWA

- `public/manifest.webmanifest` is linked with `crossorigin="use-credentials"` because the site sits behind Cloudflare Access.
- `src/sw/sw.ts` caches only same-origin `/assets/*` and icons, and only 200 responses that were not redirected. It never caches navigations or `/api/*`, so Access login pages never end up in the cache. Keep it that way.
