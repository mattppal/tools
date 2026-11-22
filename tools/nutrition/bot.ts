import { z } from "zod";
import { defineMcpTool, type McpScope, McpToolError, toolMcp } from "../../worker/mcp.ts";
import { today } from "./dates.ts";
import { dayUpdate, foodChanges, isoDate, targetsInput } from "./schemas.ts";
import { addTargets, changeFood, discardTestDay, getDay, getPhase, Rejected, TEST_DAYS_FROM, updateDay } from "./store.ts";

const date = isoDate.optional().describe("Defaults to today in Matt's time zone");

async function asTool<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof Rejected) throw new McpToolError(error.message);
		throw error;
	}
}

const testDaysOnly: McpScope = (bot, tool, args) => {
	if (bot !== "smoke") return null;
	if (!("date" in tool.input.shape)) return `The smoke identity can't call ${tool.name}: it changes more than one test day.`;
	const day = args["date"];
	if (typeof day !== "string" || day < TEST_DAYS_FROM) return `The smoke identity only works on test days, ${TEST_DAYS_FROM} or later. Send a date on or after ${TEST_DAYS_FROM}${typeof day === "string" ? `, not ${day}` : ""}.`;
	return null;
};

export const nutritionMcp = toolMcp({
	name: "nutrition",
	scope: testDaysOnly,
	tools: [
		defineMcpTool({
			name: "log_food",
			description:
				"Add, edit, or remove food entries on one day, then return the day with totals against targets. Send a client_key per add so a retry does not log twice. A closed day rejects changes until update_day reopens it.",
			input: foodChanges.extend({ date }),
			run: ({ date: day, ...changes }, { db }) => asTool(() => db((client) => changeFood(client, day ?? today(), changes, "bot"))),
		}),
		defineMcpTool({
			name: "update_day",
			description:
				"Read or update one day: bodyweight, steps, check-in scores, notes, estimated totals, and closed. Send only the date to read the day. Closing here never fires the day-closed webhook.",
			input: dayUpdate.extend({ date }),
			run: ({ date: day, ...update }, { db }) => asTool(() => db((client) => updateDay(client, day ?? today(), update))),
		}),
		defineMcpTool({
			name: "update_targets",
			description:
				"Start a new plan version with kcal and macro ranges from effective_from onward. Earlier versions stay as they were. Optionally set the phase tracker's current kcal target.",
			input: targetsInput,
			run: (input, { db }) => asTool(() => db((client) => addTargets(client, input, "bot"))),
		}),
		defineMcpTool({
			name: "get_phase_summary",
			description: "The open phase's weekly tracker: planned and actual weight, logged kcal, measured TDEE, verdict, and suggested kcal for next week. Also returns the day's totals.",
			input: z.strictObject({ date }),
			readOnly: true,
			run: ({ date: day }, { db }) =>
				db(async (client) => {
					const on = day ?? today();
					return { phase: await getPhase(client, on), day: await getDay(client, on) };
				}),
		}),
		defineMcpTool({
			name: "discard_test_day",
			description: `Delete everything on one test day (${TEST_DAYS_FROM} or later): its deliveries, food entries, weigh-ins, and the day itself. Only the smoke bot sees this tool.`,
			input: z.strictObject({ date: isoDate }),
			bots: ["smoke"],
			run: ({ date: day }, { db }) => asTool(() => db((client) => discardTestDay(client, day))),
		}),
	],
});
