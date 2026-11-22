---
name: tool-hello
description: The Hello placeholder tool at /hello. Shows every layout slot (secondary sidebar, right panel) and a database-backed API route. Use when changing tools/hello/ or as the reference for a new tool.
---

# Hello

A placeholder that exercises the shell. Copy its patterns; don't build features on it.

## UI

- Secondary sidebar "Sections" switches between three static sections. Picking one calls `close()` so the phone drawer shuts.
- Right panel "Details" shows the current section. Toggled from the header button or the "Show details" button.
- "Ask the database for the time" calls the API below.

## API

- `GET /api/tools/hello/time` returns `{ now }` from `select now()` through Hyperdrive.

## Data

No tables.
