/**
 * Top-level arguments a tool's schema does not list. Models often pass an option of another tool
 * (maxResults on read_terminal, -A on grep_search); the call runs without them and its result says so,
 * instead of failing the call or dropping the argument silently.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The listed properties of a schema that forbids others; undefined when any argument is allowed. */
function knownProperties(schema: unknown): Record<string, unknown> | undefined {
	if (!isRecord(schema) || !isRecord(schema.properties)) {
		return undefined;
	}
	const extra = schema.additionalProperties;
	if (extra === true || isRecord(extra)) {
		return undefined;
	}
	// An empty schema without additionalProperties: false describes a tool that declared no
	// schema at all (the catalog fills one in), so it may take anything.
	if (Object.keys(schema.properties).length === 0 && extra !== false) {
		return undefined;
	}
	return schema.properties;
}

/** The arguments the schema lists, and the names of the others. */
export function splitUnknownArguments(schema: unknown, input: unknown): { input: unknown; ignored: string[] } {
	const properties = knownProperties(schema);
	if (!properties || !isRecord(input)) {
		return { input, ignored: [] };
	}
	const ignored = Object.keys(input).filter(name => !Object.prototype.hasOwnProperty.call(properties, name));
	if (ignored.length === 0) {
		return { input, ignored };
	}
	return { input: Object.fromEntries(Object.entries(input).filter(([name]) => !ignored.includes(name))), ignored };
}

/** The top-level arguments of a schema, with required ones marked. */
export function describeSchemaFields(schema: unknown): string[] {
	if (!isRecord(schema) || !isRecord(schema.properties)) {
		return [];
	}
	const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
	return Object.keys(schema.properties).map(name => required.includes(name) ? `${name} (required)` : name);
}

/** The line added to a result whose call carried arguments the tool does not take. */
export function ignoredArgumentsNote(toolName: string, ignored: readonly string[], schema: unknown): string {
	const names = ignored.map(name => `"${name}"`).join(", ");
	const fields = describeSchemaFields(schema);
	return `Note: ${toolName} ignored the unknown argument${ignored.length === 1 ? "" : "s"} ${names}; it takes ${fields.length > 0 ? fields.join(", ") : "no arguments"}.`;
}

const strictSchemas = new WeakMap<object, object>();

/**
 * The schema offered to models: a schema with properties and no additionalProperties gets
 * additionalProperties: false, so every built-in tool declares the arguments it takes. The same
 * object comes back for the same schema, which keeps the serialized catalog stable.
 */
export function strictToolSchema(schema: object): object {
	if (!isRecord(schema) || !isRecord(schema.properties) || Object.keys(schema.properties).length === 0 || "additionalProperties" in schema) {
		return schema;
	}
	let strict = strictSchemas.get(schema);
	if (!strict) {
		strict = { ...schema, additionalProperties: false };
		strictSchemas.set(schema, strict);
	}
	return strict;
}
