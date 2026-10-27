import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RelayT3ChatPlan } from "@t3tools/contracts/relay";

import * as RelayDb from "../db.ts";
import { relayManagedTunnelLimits } from "../persistence/schema.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const makeFakeDb = (input: { readonly override?: number; readonly activeTunnels: number }) =>
  ({
    select: () => ({
      from: (table: unknown) =>
        table === relayManagedTunnelLimits
          ? {
              where: () => ({
                limit: () =>
                  Effect.succeed(
                    input.override === undefined ? [] : [{ maxTunnels: input.override }],
                  ),
              }),
            }
          : {
              innerJoin: () => ({
                where: () => Effect.succeed([{ activeTunnels: input.activeTunnels }]),
              }),
            },
    }),
  }) as unknown as RelayDb.RelayDb["Service"];

const ensureCapacity = (input: {
  readonly override?: number;
  readonly activeTunnels: number;
  readonly plan: RelayT3ChatPlan | "lookup-fails";
  readonly lookups?: Array<string>;
}) =>
  Effect.gen(function* () {
    const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
    return yield* limits.ensureCapacity({ userId: "user-1", environmentId: "env-new" });
  }).pipe(
    Effect.provide(
      ManagedTunnelLimits.layer.pipe(
        Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb(input))),
        Layer.provide(
          Layer.mock(T3ChatAccounts.T3ChatAccounts, {
            available: true,
            getLink: ({ userId }) => {
              input.lookups?.push(userId);
              return input.plan === "lookup-fails"
                ? Effect.fail(
                    new T3ChatAccounts.T3ChatRequestFailed({
                      operation: "get-link",
                      cause: new Error("down"),
                    }),
                  )
                : Effect.succeed({ email: "theo@example.com", plan: input.plan });
            },
          }),
        ),
      ),
    ),
  );

describe("ManagedTunnelLimits", () => {
  it.effect("does not ask T3 Chat while the account is under its cap", () =>
    Effect.gen(function* () {
      const lookups: Array<string> = [];
      yield* ensureCapacity({ activeTunnels: 2, plan: "free", lookups });
      expect(lookups).toEqual([]);
    }),
  );

  it.effect("raises the cap for a linked T3 Chat Premier account", () =>
    Effect.gen(function* () {
      yield* ensureCapacity({ activeTunnels: 3, plan: "premier" });
      yield* ensureCapacity({ activeTunnels: 99, plan: "premier" });
      const error = yield* Effect.flip(ensureCapacity({ activeTunnels: 100, plan: "premier" }));
      expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: 100 });
    }),
  );

  it.effect("keeps the default cap for other plans and failed lookups", () =>
    Effect.gen(function* () {
      for (const plan of ["pro", "lookup-fails"] as const) {
        const error = yield* Effect.flip(ensureCapacity({ activeTunnels: 3, plan }));
        expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: 3 });
      }
    }),
  );

  it.effect("leaves larger manual overrides alone", () =>
    Effect.gen(function* () {
      const lookups: Array<string> = [];
      const error = yield* Effect.flip(
        ensureCapacity({ override: 200, activeTunnels: 200, plan: "premier", lookups }),
      );
      expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: 200 });
      expect(lookups).toEqual([]);
    }),
  );
});
