import { expect, it } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import * as BunBundle from "./bun/BunBundle.ts"
import * as Dev from "./dev.ts"
import * as TestHttpClient from "./effect/TestHttpClient.ts"
import * as SsrFile from "./ssr.tsx" with { type: "file" }
import { effectFn } from "./test.ts"

const effect = effectFn(Dev.layer)

const SsrBundle = BunBundle.load<typeof SsrFile>({
  ...Dev.ServerBundle.config,
  entrypoints: [
    SsrFile.default as unknown as string,
  ],
}).pipe(
  Effect.andThen((v) => v.SsrApp),
  Effect.cached,
  Effect.flatten,
)

const Client = TestHttpClient.make(SsrBundle)

it("ssr root", () =>
  effect(function*() {
    const res = yield* Client.get("/")

    expect(res.status)
      .toEqual(200)

    expect(yield* res.text)
      .toInclude(">Random<")
  }))

it("ssr random", () =>
  effect(function*() {
    const res = yield* Client.get("/random")

    expect(res.status)
      .toEqual(200)

    expect(yield* res.text)
      .toInclude("<h1 ")
  }))

it("ssr 404", () =>
  effect(function*() {
    const res = yield* Client.get("/not-found")

    expect(res.status)
      .toEqual(404)
  }))

it("ssr resolve", () =>
  effect(function*() {
    const res = yield* Client.get("/")

    expect(res.status)
      .toEqual(200)

    expect(yield* res.text)
      .toMatch(/\.bundle\/client-\w+\.js/)
  }))
