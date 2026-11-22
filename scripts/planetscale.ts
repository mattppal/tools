const ORG = "mattppalmer";
const DATABASE = "tools";

export type Branch = "main" | "preview";
export type Role = { id: string; username: string; password: string; access_host_url: string; database_name: string };

function credentials(): string {
	const id = process.env["PLANETSCALE_TOKEN_ID"];
	const token = process.env["PLANETSCALE_API_TOKEN"];
	if (!id || !token) throw new Error("Set PLANETSCALE_TOKEN_ID and PLANETSCALE_API_TOKEN to a PlanetScale service token that can manage roles on the tools database.");
	return `${id}:${token}`;
}

function rolesUrl(branch: Branch): string {
	return `https://api.planetscale.com/v1/organizations/${ORG}/databases/${DATABASE}/branches/${branch}/roles`;
}

export async function createRole(branch: Branch, name: string, ttlSeconds: number): Promise<Role> {
	const response = await fetch(rolesUrl(branch), {
		method: "POST",
		headers: { authorization: credentials(), "content-type": "application/json" },
		body: JSON.stringify({ name, inherited_roles: ["postgres"], ttl: ttlSeconds }),
	});
	if (!response.ok) throw new Error(`PlanetScale refused a role on ${branch} (${response.status}): ${await response.text()}`);
	return (await response.json()) as Role;
}

export async function deleteRole(branch: Branch, role: Role): Promise<void> {
	const response = await fetch(`${rolesUrl(branch)}/${role.id}`, { method: "DELETE", headers: { authorization: credentials() } });
	if (!response.ok && response.status !== 404) throw new Error(`PlanetScale could not delete role ${role.username} on ${branch} (${response.status}): ${await response.text()}. It expires on its own; delete it in the dashboard to be sure.`);
}

export function roleUrl(role: Role): string {
	return `postgres://${encodeURIComponent(role.username)}:${encodeURIComponent(role.password)}@${role.access_host_url}:5432/${role.database_name}?sslmode=verify-full`;
}
