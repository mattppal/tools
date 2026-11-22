import { defineMcpTool, McpToolError, toolMcp } from "../../worker/mcp.ts";
import * as input from "./schemas.ts";
import { addCheckin, bulkImport, getYear, linkTodoist, listGoals, Rejected, setNorthStar, setStatus, upsertGoal } from "./store.ts";

async function asTool<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof Rejected) throw new McpToolError(error.message);
		throw error;
	}
}

export const goalsMcp = toolMcp({
	name: "goals",
	tools: [
		defineMcpTool({
			name: "upsert_goal",
			description:
				"Create a goal, or update one by id or by year, horizon, quarter and title. Fields you omit keep their values. Status and Todoist links have their own tools. Returns the goal and whether it was created.",
			input: input.upsertGoal,
			run: (args, { db }) => asTool(() => db((client) => upsertGoal(client, args))),
		}),
		defineMcpTool({
			name: "bulk_import",
			description:
				"Import goals and each year's north star in one transaction: all or nothing. A goal matching an existing year, horizon, quarter and title (any case) updates it, so sending the same body twice changes nothing. Send status only when the source states it.",
			input: input.bulkImport,
			run: (args, { db }) => asTool(() => db((client) => bulkImport(client, args))),
		}),
		defineMcpTool({
			name: "list_goals",
			description: "Goals with their latest check-in, filtered by year, area and status. An omitted filter matches everything.",
			input: input.listGoals,
			readOnly: true,
			run: (args, { db }) => db((client) => listGoals(client, args)),
		}),
		defineMcpTool({
			name: "set_status",
			description: "Set a goal's status and record the note as a check-in. The only way the bot changes a status. Never infer a status Matt didn't state.",
			input: input.setStatus,
			run: ({ id, status, note }, { db }) => asTool(() => db((client) => setStatus(client, id, status, note, "gtd-bot"))),
		}),
		defineMcpTool({
			name: "add_checkin",
			description: "Add a dated note to a goal, with progress as a percent when the goal has a measure. Never changes the status. A retry adds a second check-in.",
			input: input.addCheckin,
			run: (args, { db }) => asTool(() => db((client) => addCheckin(client, args, "gtd-bot"))),
		}),
		defineMcpTool({
			name: "link_todoist",
			description: "Set a goal's Todoist project and task ids. task_ids replaces the stored list. Todoist holds the next actions; the ids are not checked.",
			input: input.linkTodoist,
			run: (args, { db }) => asTool(() => db((client) => linkTodoist(client, args))),
		}),
		defineMcpTool({
			name: "set_north_star",
			description: "Set one year's north star, the sentence shown above that year's goals.",
			input: input.setNorthStar,
			run: ({ year, north_star }, { db }) => db((client) => setNorthStar(client, year, north_star)),
		}),
		defineMcpTool({
			name: "get_year",
			description: "One year's north star and every goal with its latest check-in. A year with nothing yet returns an empty north star and no goals.",
			input: input.getYear,
			readOnly: true,
			run: ({ year }, { db }) => db((client) => getYear(client, year)),
		}),
	],
});
