import { HttpApp, HttpRouter, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { SsrApp } from "./ssr.tsx"

const Router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/yo",
    HttpServerResponse.text("yo"),
  ),
  HttpRouter.get(
    "/error",
    Effect.gen(function*() {
      yield* Effect.fail(new Error("custom error"))

      return HttpServerResponse.text("this will never be reached")
    }),
  ),
)

export default Effect.gen(function*() {
  const routerRes = yield* Router.pipe(
    Effect.catchTag("RouteNotFound", e =>
      HttpServerResponse.empty({
        status: 404,
      })),
  )

  if (routerRes.status !== 404) {
    return routerRes
  }

  const ssrRes = yield* SsrApp

  if (ssrRes.status !== 404) {
    return ssrRes
  }

  return HttpServerResponse.empty({
    status: 404,
  })
})
