---
name: tool-sleep
description: "The Sleep tool at /sleep. Last night and recent nights from Eight Sleep, Apple Watch and Withings. Use when changing tools/sleep/."
---

# Sleep

Last night and recent nights from Eight Sleep, Apple Watch and Withings.

## UI

- `index.tsx` renders `ToolLayout` with one page. The top shows the selected night, last night by default: time asleep, a sentence with when sleep started and ended, time in bed and the source, a hypnogram with Awake, REM, Light and Deep lanes (or one Asleep lane for a source without stages), and the stage totals with resting HR, HRV and breathing. The arrows step to earlier and later nights.
- Recent nights has a 30-night, 90-night and 1-year range. It shows averages, a bar per night with a 7-night average line, and a table, newest first. Tapping a bar or a row selects that night. The table drops its optional columns under 640px.
- No status dots or pills. The selected bar is the only filled bar, in `--text-1`; the average line uses `--chart-accent`.

## API

None. The page reads `GET /api/tools/activity/nights`, which Activity owns. Its rules are under Nights in `tools/activity/SKILL.md`.

## Data

None of its own. Nights come from `activity.apple_health_sleep`, `activity.apple_health_samples` and `activity.withings_sleep`.
