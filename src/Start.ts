import { HttpServer } from "@effect/platform"
import {
  BunContext,
  BunHttpServer,
  BunRuntime,
} from "@effect/platform-bun"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpRouter from "@effect/platform/HttpRouter"
import {
  Effect,
  pipe,
} from "effect"
import * as Layer from "effect/Layer"
import * as BunBundle from "./bun/BunBundle.ts"
import * as Bundle from "./Bundle.ts"
import * as BundleHttp from "./BundleHttp.ts"
import * as FileRouter from "./FileRouter"
import * as HttpAppExtra from "./HttpAppExtra"
import * as Router from "./Router.ts"

export function router(
  load: () => Promise<Router.RouteManifest>,
) {
  return Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function*() {
        const httpRouter = yield* HttpRouter.Default
        const startRouter = yield* Router.Router

        yield* httpRouter.concat(startRouter.httpRouter)
      }),
    ),
    Layer.merge(
      Router.layer(load),
      FileRouter.layer(),
    ),
  )
}

export function bundleClient(config: BunBundle.BuildOptions | string) {
  const clientLayer = Layer.effect(
    Bundle.ClientBundle,
    BunBundle.buildClient(config),
  )
  const assetsLayer = Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.Default
    const app = BundleHttp.toHttpApp(Bundle.ClientBundle)

    yield* router.mountApp(
      "/_bundle",
      app.pipe(
        Effect.provide(clientLayer),
      ),
    )
  }))
  const entrypointsLayer = Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.Default

    yield* router.get(
      "*",
      BundleHttp.entrypoint().pipe(
        Effect.provide(clientLayer),
      ),
    )
  }))

  return Layer.mergeAll(
    clientLayer,
    assetsLayer,
    entrypointsLayer,
  )
}

export function make<
  Layers extends [
    Layer.Layer<never, any, any>,
    ...Array<Layer.Layer<never, any, any>>,
  ],
>(...layers: Layers): Layer.Layer<
  { [k in keyof Layers]: Layer.Layer.Success<Layers[k]> }[number],
  { [k in keyof Layers]: Layer.Layer.Error<Layers[k]> }[number],
  { [k in keyof Layers]: Layer.Layer.Context<Layers[k]> }[number]
> {
  return Layer.mergeAll(...layers)
}
Layer

export function serve<ROut, E>(
  load: () => Promise<{
    default: Layer.Layer<
      ROut,
      E,
      | HttpServer.HttpServer
      | HttpRouter.Default
      | HttpClient.HttpClient
      | BunContext.BunContext
    >
  }>,
) {
  const appLayer = pipe(
    Effect.tryPromise(load),
    Effect.map(v => v.default),
    Effect.orDie,
    Layer.unwrapEffect,
  )

  return pipe(
    HttpRouter.Default.serve(HttpAppExtra.handleErrors).pipe(
      HttpServer.withLogAddress,
    ),
    Layer.provide(appLayer),
    Layer.provide([
      FetchHttpClient.layer,
      HttpRouter.Default.Live,
      BunHttpServer.layer({
        port: 3000,
      }),
    ]),
    Layer.launch,
    BunRuntime.runMain,
  )
}
