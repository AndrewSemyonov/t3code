import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { RelayT3ChatLink } from "@t3tools/contracts/relay";

import * as RelayConfiguration from "../Config.ts";

const LINK_TOKEN_TTL_SECONDS = 10 * 60;
const T3CHAT_REQUEST_TIMEOUT = "5 seconds";

const T3ChatLinkResponse = Schema.Struct({ link: Schema.NullOr(RelayT3ChatLink) });

export class T3ChatNotConfigured extends Schema.TaggedError<T3ChatNotConfigured>()(
  "T3ChatNotConfigured",
  {},
) {
  override get message(): string {
    return "T3 Chat linking is not configured on this relay";
  }
}

export class T3ChatRequestFailed extends Schema.TaggedError<T3ChatRequestFailed>()(
  "T3ChatRequestFailed",
  {
    operation: Schema.Literals(["get-link", "unlink"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Chat '${this.operation}' request failed`;
  }
}

/**
 * Experimental bridge to T3 Chat. T3 Chat owns the account link; the relay
 * signs link requests and asks T3 Chat for the linked account's plan.
 */
export class T3ChatAccounts extends Context.Service<
  T3ChatAccounts,
  {
    readonly available: boolean;
    readonly createLinkUrl: (input: {
      readonly userId: string;
      readonly email: string;
    }) => Effect.Effect<string, T3ChatNotConfigured>;
    readonly getLink: (input: {
      readonly userId: string;
    }) => Effect.Effect<RelayT3ChatLink | null, T3ChatNotConfigured | T3ChatRequestFailed>;
    readonly unlink: (input: {
      readonly userId: string;
    }) => Effect.Effect<void, T3ChatNotConfigured | T3ChatRequestFailed>;
  }
>()("t3code-relay/t3chat/T3ChatAccounts") {}

/** Token format shared with T3 Chat: `<base64url JSON payload>.<base64url HMAC-SHA256>`. */
export const signLinkToken = (
  secret: string,
  payload: { readonly sub: string; readonly email: string; readonly exp: number },
) => {
  const encoded = Base64Url.encode(JSON.stringify({ v: 1, ...payload }));
  const signature = hmac(
    sha256,
    new TextEncoder().encode(secret),
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${Base64Url.encode(signature)}`;
};

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const client = yield* HttpClient.HttpClient;
  const settings = config.t3Chat;

  const requireSettings = settings
    ? Effect.succeed(settings)
    : Effect.fail(new T3ChatNotConfigured());

  const post = Effect.fn("relay.t3chat.post")(function* (
    operation: T3ChatRequestFailed["operation"],
    path: string,
    userId: string,
  ) {
    const { baseUrl, linkSecret } = yield* requireSettings;
    return yield* HttpClientRequest.post(new URL(path, baseUrl).toString()).pipe(
      HttpClientRequest.bearerToken(Redacted.value(linkSecret)),
      HttpClientRequest.bodyJsonUnsafe({ clerkUserId: userId }),
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(T3CHAT_REQUEST_TIMEOUT),
      Effect.mapError((cause) => new T3ChatRequestFailed({ operation, cause })),
    );
  });

  return T3ChatAccounts.of({
    available: settings !== undefined,
    createLinkUrl: Effect.fn("relay.t3chat.create_link_url")(function* (input) {
      const { baseUrl, linkSecret } = yield* requireSettings;
      const now = yield* DateTime.now;
      const token = signLinkToken(Redacted.value(linkSecret), {
        sub: input.userId,
        email: input.email,
        exp: Math.floor(now.epochMilliseconds / 1_000) + LINK_TOKEN_TTL_SECONDS,
      });
      const url = new URL("/link/t3code", baseUrl);
      url.searchParams.set("token", token);
      return url.toString();
    }),
    getLink: Effect.fn("relay.t3chat.get_link")(function* (input) {
      const response = yield* post("get-link", "/api/t3code/link", input.userId);
      const body = yield* HttpClientResponse.schemaBodyJson(T3ChatLinkResponse)(response).pipe(
        Effect.mapError((cause) => new T3ChatRequestFailed({ operation: "get-link", cause })),
      );
      return body.link;
    }),
    unlink: Effect.fn("relay.t3chat.unlink")(function* (input) {
      yield* post("unlink", "/api/t3code/unlink", input.userId);
    }),
  });
});

export const layer = Layer.effect(T3ChatAccounts, make);
