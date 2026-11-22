---
name: tool-hello
description: The Hello placeholder tool at /hello. Shows sections, an opt-in Details panel, and a database-backed API route. Use when changing tools/hello/ or as the reference for a new tool.
---

# Hello

A placeholder that exercises the shell. Copy its patterns; don't build features on it.

## UI

- Two sections, Overview (`/hello`) and Database (`/hello/database`), nest under Hello in the sidebar.
- Database has "Ask the database for the time", which calls the API below, and a Details panel with the endpoint and the round trip. Overview has no panel.

## API

- `GET /api/tools/hello/time` returns `{ now }` from `select now()` through Hyperdrive.

## Data

No tables.
