import {
  HttpApp,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Console, Context, Effect, Layer } from "effect"
import entry from "./entry-server.tsx"
import { renderToStringAsync, ssr } from "solid-js/web"
import { ViteDev, ViteDevHttpRouteHandler } from "./vite/effect.ts"
import { setTime } from "effect/TestClock"

const viteRoute = HttpRouter.all(
  "*",
  ViteDevHttpRouteHandler,
)

const ssrRoute = HttpRouter.get(
  "*",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const res = yield* render(req.url)

    return HttpServerResponse.raw(res.body, {
      status: res.status,
      // @ts-ignore it works
      headers: Headers.fromInput(res.headers),
    })
  }),
)

const render = (url) =>
  Effect.tryPromise(() =>
    renderToStringAsync(() =>
      entry({
        url,
      })
    )
      .then((body) => {
        if (body.includes("~*~ 404 Not Found ~*~")) {
          return new Response("", {
            status: 404,
          })
        }

        return new Response(body)
      })
  )

const HttpServerDeno = Layer.scoped(
  HttpServer.HttpServer,
  Effect.runtime().pipe(Effect.andThen((runtime) =>
    HttpServer.make({
      serve: (app) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const handler = HttpApp.toWebHandlerRuntime(runtime)(app)

            return Deno.serve({
              hostname: "0.0.0.0",
              port: 8000,
              onListen: () => {},
            }, handler)
          }),
          (server) =>
            Effect.promise(async () => {
              await server.shutdown()
            }),
        ),
      address: {
        _tag: "TcpAddress",
        hostname: "0.0.0.0",
        port: 8000,
      },
    })
  )),
)

export const Router = HttpRouter.empty.pipe(
  viteRoute,
  HttpRouter.use(HttpMiddleware.logger),
  HttpServer.serve(),
  HttpServer.withLogAddress,
  Layer.provide(HttpServerDeno),
)

await Effect.runPromise(
  Layer.launch(Router)
    .pipe(
      Effect.provide(ViteDev),
    ),
)
