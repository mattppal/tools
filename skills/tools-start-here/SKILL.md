---
name: tools-start-here
description: Entry point for any work in the tools repo (tools.mattpalmer.io). Read first, every session. Sets the working mode and points to the repo's other skills.
---

# Start here

This repo is one Cloudflare Worker that serves a homepage and a directory of tools. Each tool lives in `tools/<slug>/`.

## How to work

1. Work in poteto-mode. Read `skills/poteto-mode/SKILL.md` and follow it. Workers read `skills/poteto-mode/worker.md`.
2. For any UI work, also read `skills/emil-design-eng/SKILL.md`.
3. Code follows `skills/no-comments/SKILL.md`.
4. Prose (skills, docs, PR text, commit messages) follows `skills/unslop/SKILL.md`.

## Which skill next

| Task | Skill |
| --- | --- |
| Run, build, deploy, preview, local database | `skills/tools-commands/SKILL.md` |
| Add or change a tool | `skills/tools-add-a-tool/SKILL.md` |
| Layout, sidebars, styling, mobile, PWA | `skills/tools-styling/SKILL.md` |
| Deploys, domain, Access, previews | `skills/tools-deploy/SKILL.md` |
| Work inside one tool | `tools/<slug>/SKILL.md` |

## Rules the build enforces

`bun run build` runs `scripts/check-skills.ts` first. It fails when:

- a `tools/<slug>/` has no `SKILL.md`, or its `name` is not `tool-<slug>`;
- a skill's frontmatter is missing, invalid, or its `name` does not match its folder;
- a vendored skill in `skills/` has no `skills-lock.json` entry, or its files no longer match the locked hash.

Skills named `tools-*` belong to this repo. Every other folder in `skills/` is vendored. Don't edit vendored skills; update them with `bunx skills add <source> --skill <name>` and copy the result from `.agents/skills/` into `skills/`.
