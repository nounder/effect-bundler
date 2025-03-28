import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { handleHttpServerResponseError } from "./effect/http.ts"
import * as HttpAppExtra from "./effect/HttpAppExtra.ts"
import { SsrApp } from "./ssr.tsx"

const ApiApp = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/yo",
    HttpServerResponse.text("yo"),
  ),
  HttpRouter.get(
    "/error",
    Effect.gen(function*() {
      throw new Error("custom error")

      return HttpServerResponse.text("this will never be reached")
    }),
  ),
  HttpRouter.catchAllCause(handleHttpServerResponseError),
  Effect.catchTag(
    "RouteNotFound",
    e =>
      HttpServerResponse.empty({
        status: 404,
      }),
  ),
)

const App = HttpAppExtra.chain([
  ApiApp,
  SsrApp,
])

export default App

if (import.meta.main) {
  HttpServer.serve(App).pipe(
    HttpServer.withLogAddress,
    Layer.provide(
      BunHttpServer.layer({
        port: 3000,
      }),
    ),
    Layer.launch,
    BunRuntime.runMain,
  )
}
