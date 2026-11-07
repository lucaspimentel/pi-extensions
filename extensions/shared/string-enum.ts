/**
 * `StringEnum` for tool parameter schemas, built on TypeBox.
 *
 * pi resolves `@earendil-works/pi-ai` for extensions to a virtual view whose
 * `StringEnum` returns TypeBox's `TUnsafe<T[number]>`, but the published package
 * (1.5.0) exports a helper typed against `@earendil-works/pi-schema` instead. A
 * plain TypeScript build resolves the package, not pi's view, so using it inside
 * a TypeBox `Type.Object` collapses that parameter to `unknown`. This mirrors the
 * runtime helper exactly: providers that reject `anyOf`/`const` receive a plain
 * `{ type: "string", enum: [...] }`, while `Static` still infers the literal
 * union.
 */
import { Type, type TUnsafe } from "typebox";

export function stringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
