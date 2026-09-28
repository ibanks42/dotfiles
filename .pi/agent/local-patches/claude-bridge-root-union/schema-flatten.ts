// Flattens a root-level union of object schemas into one object schema.
//
// MCP and the Anthropic API both require a tool's input schema to be an object
// at the root, and reject a root anyOf/oneOf. Some pi tools declare parameters
// as a TypeBox union of object variants — pi-codex-conversion's `notebook` tool
// is one — which pi accepts but which cannot go on the wire as-is.
//
// The flattened schema is a superset of the union: every property from every
// variant, required only when all variants require it. That is looser than the
// original, which is safe here because the arguments MCP sees are discarded —
// pi validates each call against the tool's real schema before executing it.
//
// Anything that is not a union of objects is returned unchanged, so
// assertObjectSchema still reports genuinely unusable schemas.

type JsonSchema = Record<string, unknown>;

export function flattenRootUnion(schema: unknown): unknown {
	if (!isRecord(schema) || schema.type !== undefined) return schema;
	const variants = schema.anyOf ?? schema.oneOf;
	if (!Array.isArray(variants) || variants.length === 0) return schema;
	if (!variants.every((variant) => isRecord(variant) && variant.type === "object")) return schema;
	const objects = variants as JsonSchema[];

	const byName = new Map<string, unknown[]>();
	for (const variant of objects) {
		for (const [name, prop] of Object.entries((variant.properties ?? {}) as JsonSchema)) {
			byName.set(name, [...(byName.get(name) ?? []), prop]);
		}
	}
	const properties: JsonSchema = {};
	for (const [name, props] of byName) properties[name] = mergeProperty(props);

	const required = objects
		.map((variant) => (Array.isArray(variant.required) ? (variant.required as string[]) : []))
		.reduce((common, names) => common.filter((name) => names.includes(name)));

	const flat: JsonSchema = { type: "object", properties };
	if (required.length > 0) flat.required = required;
	if (objects.every((variant) => variant.additionalProperties === false)) flat.additionalProperties = false;
	if (typeof schema.description === "string") flat.description = schema.description;
	return flat;
}

// Identical definitions collapse to one. String enums and consts — the usual
// discriminator, like `action` — merge into a single enum. Anything else keeps
// its alternatives as a nested anyOf, which is valid below the root.
function mergeProperty(props: unknown[]): unknown {
	const unique = [...new Map(props.map((prop) => [JSON.stringify(prop), prop])).values()];
	if (unique.length === 1) return unique[0];
	const values = unique.map(stringValues);
	if (values.every((value) => value !== undefined)) {
		const merged: JsonSchema = { type: "string", enum: [...new Set(values.flat())] };
		const description = unique.map((prop) => (prop as JsonSchema).description).find((text) => typeof text === "string");
		if (description !== undefined) merged.description = description;
		return merged;
	}
	return { anyOf: unique };
}

function stringValues(prop: unknown): string[] | undefined {
	if (!isRecord(prop) || prop.type !== "string") return undefined;
	if (typeof prop.const === "string") return [prop.const];
	if (Array.isArray(prop.enum) && prop.enum.every((value) => typeof value === "string")) return prop.enum as string[];
	return undefined;
}

function isRecord(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
