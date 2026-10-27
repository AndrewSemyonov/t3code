import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

class FakeTransaction extends Context.Service<FakeTransaction, { holdsLock: boolean }>()(
  "t3code-relay/environments/ManagedTunnelLimits.test/FakeTransaction",
) {}

// Models Postgres just enough: the advisory lock only works inside a transaction and is held until it ends.
function makeFakeDb(
  reserved: Array<{ readonly userId: string; readonly environmentId: string }>,
  countConditions: Array<unknown> = [],
) {
  const userLock = Semaphore.makeUnsafe(1);
  return {
    $client: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const transaction = { holdsLock: false };
        return effect.pipe(
          Effect.provideService(FakeTransaction, transaction),
          Effect.ensuring(
            Effect.suspend(() => (transaction.holdsLock ? userLock.release(1) : Effect.void)),
          ),
        );
      },
    },
    execute: () =>
      Effect.gen(function* () {
        const transaction = yield* Effect.serviceOption(FakeTransaction);
        if (transaction._tag === "None") {
          return yield* Effect.die("advisory lock taken outside a transaction");
        }
        yield* userLock.take(1);
        transaction.value.holdsLock = true;
        return [];
      }),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) =>
          table === relayManagedEndpointAllocations
            ? Effect.yieldNow.pipe(
                Effect.tap(() => Effect.sync(() => countConditions.push(condition))),
                Effect.as([
                  { activeTunnels: reserved.filter((row) => row.userId === "user-1").length },
                ]),
              )
            : { limit: () => Effect.succeed([]) },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("ManagedTunnelLimits", () => {
  it.effect("rejects concurrent reservations past the limit", () => {
    const reserved: Array<{ readonly userId: string; readonly environmentId: string }> = [];
    const attempts = ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT + 2;

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const results = yield* Effect.forEach(
        Array.from({ length: attempts }, (_, index) => `environment-${index}`),
        (environmentId) => {
          const input = { userId: "user-1", environmentId };
          return limits
            .withCapacity(
              input,
              Effect.sync(() => reserved.push(input)),
            )
            .pipe(Effect.result);
        },
        { concurrency: "unbounded" },
      );

      expect(reserved).toHaveLength(ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT);
      expect(
        results.filter(
          (result) =>
            result._tag === "Failure" && result.failure._tag === "ManagedTunnelLimitExceeded",
        ),
      ).toHaveLength(2);
    }).pipe(
      Effect.provide(
        ManagedTunnelLimits.layer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb(reserved))),
        ),
      ),
    );
  });

  it.effect("stops counting tunnel-less reservations after the pending window", () => {
    const countConditions: Array<unknown> = [];
    const now = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");

    return Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      yield* limits.withCapacity({ userId: "user-1", environmentId: "environment-1" }, Effect.void);

      const query = new PgDialect().sqlToQuery(countConditions[0] as never);
      expect(query.sql).toContain(
        '("relay_managed_endpoint_allocations"."tunnel_id" is not null)) or ("relay_managed_endpoint_allocations"."updated_at" > $3)',
      );
      expect(query.params[2]).toBe("2026-10-27T11:45:00.000Z");
      expect(query.sql).toContain("not exists");
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is not null');
    }).pipe(
      Effect.provide(
        ManagedTunnelLimits.layer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb([], countConditions))),
        ),
      ),
    );
  });
});
