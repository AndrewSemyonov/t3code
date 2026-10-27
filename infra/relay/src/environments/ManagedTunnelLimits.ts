import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";
import {
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["lock-user", "load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    /** Run `reserve` only while the user is under their limit, serialized per user so concurrent reservations cannot overshoot it. */
    readonly withCapacity: <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R>;
  }
>()("t3code-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedTunnelLimits.of({
    withCapacity: Effect.fn("relay.managed_tunnel_limits.with_capacity")(function* <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      reserve: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R> {
      const persistenceError =
        (operation: ManagedTunnelLimitPersistenceError["operation"]) => (cause: unknown) =>
          new ManagedTunnelLimitPersistenceError({ operation, userId: input.userId, cause });

      const checkAndReserve = Effect.gen(function* () {
        // Held until commit, so the count below includes every reservation that won the lock earlier.
        yield* db
          .execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`managed-tunnel-limit:${input.userId}`}, 0))`,
          )
          .pipe(Effect.mapError(persistenceError("lock-user")));

        const overrides = yield* db
          .select({ maxTunnels: relayManagedTunnelLimits.maxTunnels })
          .from(relayManagedTunnelLimits)
          .where(eq(relayManagedTunnelLimits.userId, input.userId))
          .limit(1)
          .pipe(Effect.mapError(persistenceError("load-limit")));
        const maxTunnels = overrides[0]?.maxTunnels ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

        // Count reservations, not links: links are written only after provisioning creates Cloudflare resources.
        // Exclude this environment so relinking remains idempotent at the account limit.
        const counted = yield* db
          .select({ activeTunnels: count() })
          .from(relayManagedEndpointAllocations)
          .where(
            and(
              eq(relayManagedEndpointAllocations.userId, input.userId),
              ne(relayManagedEndpointAllocations.environmentId, input.environmentId),
              isNull(relayManagedEndpointAllocations.tunnelReleasedAt),
            ),
          )
          .pipe(Effect.mapError(persistenceError("count-tunnels")));
        const activeTunnels = counted[0]?.activeTunnels ?? 0;

        if (activeTunnels >= maxTunnels) {
          return yield* new ManagedTunnelLimitExceeded({
            userId: input.userId,
            environmentId: input.environmentId,
            maxTunnels,
            activeTunnels,
          });
        }
        return yield* reserve;
      });

      return yield* db.$client
        .withTransaction(checkAndReserve)
        .pipe(
          Effect.mapError((cause) =>
            SqlError.isSqlError(cause) ? persistenceError("lock-user")(cause) : cause,
          ),
        );
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
