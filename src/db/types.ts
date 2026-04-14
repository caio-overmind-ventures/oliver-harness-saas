/**
 * Structural DB types for Oliver.
 *
 * Oliver doesn't depend on `@repo/database` directly — builders pass their
 * own Drizzle instance. These types describe the minimum shape Oliver
 * needs from that instance.
 *
 * Drizzle's fluent query builder is deeply chained and its generics aren't
 * meant to be preserved through structural typing, so intermediate returns
 * are `any`. That's intentional — real Drizzle instances will satisfy this
 * at runtime; type-safety lives in the callsites where Oliver passes known
 * table objects.
 */

// biome-ignore lint/suspicious/noExplicitAny: Drizzle's fluent builder — see docblock
type AnyRef = any;

export interface DrizzleDbLike {
  insert: (table: AnyRef) => {
    values: (values: AnyRef) => Promise<unknown> | unknown;
  };
  select: (fields?: AnyRef) => {
    from: (table: AnyRef) => AnyRef;
  };
  update: (table: AnyRef) => {
    set: (values: AnyRef) => {
      where: (cond: AnyRef) => Promise<unknown> | unknown;
    };
  };
}
