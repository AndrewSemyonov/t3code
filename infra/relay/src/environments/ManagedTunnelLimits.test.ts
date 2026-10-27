import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

class FakeTransaction extends Context.Service<FakeTransaction, { holdsLock: boolean }>()(
  "t3code-relay/environments/ManagedTunnelLimits.test/FakeTransaction",
) {}

// Models Postgres just enough: the advisory lock only works inside a transaction and is held until it ends.
function makeFakeDb(reserved: Array<{ readonly userId: string; readonly environmentId: string }>) {
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
        where: (_condition: unknown) =>
          table === relayManagedEndpointAllocations
            ? Effect.yieldNow.pipe(
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
});
