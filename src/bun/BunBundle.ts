import type { HttpRouter } from "@effect/platform"
import type {
  BuildConfig,
  BuildOutput,
} from "bun"
import {
  Array,
  Context,
  Effect,
  Iterable,
  Layer,
  Option,
  pipe,
  PubSub,
  Record,
  Stream,
  SynchronizedRef,
} from "effect"
import * as NPath from "node:path"
import { fileURLToPath } from "node:url"
import type {
  BundleContext,
  BundleManifest,
} from "../Bundle.ts"
import * as Bundle from "../Bundle.ts"
import { watchFileChanges } from "../files.ts"
import { BunImportTrackerPlugin } from "./index.ts"

// raw config passed to Bun.build
type BunBundleConfig = BuildConfig

// passable config for APIs
export type BunBuildOptions = Omit<BunBundleConfig, "outdir">

const BunBundleContextLoadRef = Symbol.for(
  "effect-bundler/BunBundleContextLoadRef",
)

export const bundle = <I extends `${string}Bundle`>(
  key: I,
  config: BunBundleConfig,
) =>
  Object.assign(
    Bundle.tagged(key),
    {
      config,
      load: <M>(): Effect.Effect<M, Bundle.BundleError, I> =>
        Effect.gen(function*() {
          const bundle = yield* Bundle.tagged(key)

          const loadRef = bundle[BunBundleContextLoadRef] as
            | SynchronizedRef.SynchronizedRef<M | null>
            | undefined

          if (!loadRef) {
            return yield* Bundle.load<M>(build(config))
          }

          const loadedBundle = yield* SynchronizedRef.updateAndGetEffect(
            loadRef,
            (current) =>
              current
                ? Effect.succeed(current)
                : Bundle.load<M>(build(config)),
          )

          // we need to cast it manually because updateAndGetEffect
          // doesn't properly infer return type.
          return loadedBundle as M
        }),
      layer: Layer.effect(
        Bundle.tagged(key),
        build(config),
      ),
      devLayer: Layer.scoped(
        Bundle.tagged(key),
        Effect.gen(function*() {
          const sharedBundle = yield* build(config)

          const loadRef = sharedBundle[BunBundleContextLoadRef] =
            yield* SynchronizedRef.make(null)

          sharedBundle.events = yield* PubSub.unbounded<Bundle.BundleEvent>()

          yield* Effect.fork(
            pipe(
              watchFileChanges(),
              Stream.onError(err =>
                Effect.logError("Error while watching files", err)
              ),
              Stream.runForEach((v) =>
                pipe(
                  Effect.gen(function*() {
                    yield* Effect.logDebug("Updating bundle: " + key)

                    const newBundle = yield* build(config)

                    Object.assign(sharedBundle, newBundle)

                    // Clean old loaded bundle
                    yield* SynchronizedRef.update(loadRef, () => null)

                    // publish event after the built
                    if (sharedBundle.events) {
                      yield* PubSub.publish(sharedBundle.events, v)
                    }
                  }),
                  Effect.catchAll(err =>
                    Effect.gen(function*() {
                      yield* Effect.logError(
                        "Error while updating bundle",
                        err,
                      )
                      if (sharedBundle.events) {
                        yield* PubSub.publish(sharedBundle.events, {
                          type: "BuildError",
                          error: String(err),
                        })
                      }
                    })
                  ),
                )
              ),
            ),
          )

          return sharedBundle
        }),
      ),
    },
  )

export const bundleClient = (
  config: BunBuildOptions | string,
) => {
  if (typeof config === "string") {
    config = {
      entrypoints: [config],
    }
  }

  const baseConfig: Partial<BunBuildOptions> = {
    sourcemap: "linked",
    naming: {
      entry: "[name]-[hash].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    packages: "bundle",
  } as const
  const resolvedConfig = {
    ...baseConfig,
    target: "browser" as const,
    ...config,
  }

  return bundle(Bundle.ClientKey, resolvedConfig)
}

export const bundleServer = (
  config: BunBuildOptions | string,
) => {
  if (typeof config === "string") {
    config = {
      entrypoints: [config],
    }
  }

  const baseConfig: Partial<BunBuildOptions> = {
    sourcemap: "linked",
    naming: {
      entry: "[dir]/[name]-[hash].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    packages: "bundle",
  } as const
  const resolvedConfig = {
    ...baseConfig,
    target: "bun" as const,
    ...config,
  }

  return bundle(Bundle.ServerKey, resolvedConfig)
}

/**
 * Given a config, build a bundle and returns every time when effect is executed.
 */
export function build(
  config: BunBundleConfig,
): Effect.Effect<BundleContext, Bundle.BundleError> {
  return Effect.gen(function*() {
    const output = yield* buildBun(config)
    const manifest = generateManifestfromBunBundle(
      config,
      output,
    )
    const artifactsMap = Record.fromIterableBy(
      output.outputs,
      (v) => v.path.replace(/^\.\//, ""),
    )

    const resolve = (path: string) => {
      return manifest.entrypoints[path] ?? null
    }

    const getArtifact = (path: string): Blob | null => {
      return artifactsMap[resolve(path)]
        ?? artifactsMap[path]
        ?? null
    }

    return {
      ...manifest,
      resolve,
      getArtifact,
    }
  })
}

export const layer = <T>(
  tag: Context.Tag<T, BundleContext>,
  config: BunBundleConfig,
) => Layer.effect(tag, build(config))

/**
 * Finds common path prefix across provided paths.
 */
function getBaseDir(paths: string[]) {
  const segmentsList = paths.map((path) => path.split("/").filter(Boolean))

  return segmentsList[0]
    .filter((segment, i) => segmentsList.every((segs) => segs[i] === segment))
    .reduce((path, seg) => `${path}/${seg}`, "") ?? ""
}

/**
 * Maps entrypoints to their respective build artifacts.
 * Entrypoint key is trimmed to remove common path prefix.
 */
function joinBuildEntrypoints(
  options: BunBuildOptions,
  output: BuildOutput,
) {
  const commonPathPrefix = getBaseDir(
    options.entrypoints.map((v) => NPath.dirname(v)),
  ) + "/"

  return pipe(
    Iterable.zip(
      options.entrypoints,
      pipe(
        output.outputs,
        // Filter out source maps to properly map artifacts to entrypoints.
        Iterable.filter((v) =>
          v.kind !== "sourcemap"
          && !(v.loader === "html" && v.path.endsWith(".js"))
        ),
      ),
    ),
    Iterable.map(([entrypoint, artifact]) => {
      return {
        shortPath: entrypoint.replace(commonPathPrefix, ""),
        fullPath: entrypoint,
        artifact,
      } as const
    }),
  )
}

/**
 * Generate manifest from a build.
 * Useful for SSR and providing source->artifact path mapping.
 */
function generateManifestfromBunBundle(
  options: BunBuildOptions,
  output: BuildOutput,
  imports?: BunImportTrackerPlugin.ImportMap,
): BundleManifest {
  const entrypointArtifacts = joinBuildEntrypoints(options, output)

  return {
    entrypoints: pipe(
      entrypointArtifacts,
      Iterable.map((v) =>
        [
          v.shortPath,
          v.artifact.path.replace(/^\.\//, ""),
        ] as const
      ),
      Record.fromEntries,
    ),

    artifacts: pipe(
      output.outputs,
      // This will mess up direct entrypoint-artifact record.
      // Will have to filter out sourcemap when mapping.
      // Iterable.flatMap((v) => v.sourcemap ? [v, v.sourcemap] : [v]),
      Iterable.map((v) => {
        // strip './' prefix
        const shortPath = v.path.replace(/^\.\//, "")

        return [
          shortPath,
          {
            hash: v.hash ?? undefined,
            size: v.size,
            type: v.type,
            imports: imports?.get(v.path),
          },
        ] as const
      }),
      Record.fromEntries,
    ),
  }
}

const extractBundleRoutes = (
  router: HttpRouter.HttpRouter<any, Bundle.BundleKey>,
): {
  entrypoints: Record<string, Bundle.BundleEntrypointMetaValue>
  outputs: Record<string, Bundle.BundleOutputMetaValue>
} => {
  const entrypoints = pipe(
    router.routes,
    Iterable.filterMap((route) => {
      const meta = route
        .handler[
          Bundle.BundleEntrypointMetaKey
        ] as Bundle.BundleEntrypointMetaValue

      return Option.fromNullable(meta ? [route.path, meta] as const : null)
    }),
    Record.fromEntries,
  )
  const outputs = pipe(
    router.mounts,
    Iterable.filterMap(([path, httpApp]) =>
      httpApp[Bundle.BundleOutputMetaKey]
        ? Option.some([path, httpApp[Bundle.BundleOutputMetaKey]] as const)
        : Option.none()
    ),
    Record.fromEntries,
  )

  return {
    entrypoints,
    outputs,
  }
}

export const configFromHttpRouter = (
  router: HttpRouter.HttpRouter<any, Bundle.BundleKey>,
): BuildConfig => {
  const bundleRoutes = extractBundleRoutes(router)
  const entrypoints = pipe(
    bundleRoutes.entrypoints,
    Record.values,
    Iterable.filterMap((meta) => Option.fromNullable(meta.uri)),
    Array.fromIterable,
  )
  const publicPath = pipe(
    bundleRoutes.outputs,
    Record.keys,
    Iterable.head,
    // bun requires public path to end with a slash
    Option.map(v => v + "/"),
    Option.getOrUndefined,
  )

  return {
    entrypoints,
    publicPath,
  }
}

function buildBun(
  config: BunBundleConfig,
): Effect.Effect<BuildOutput, Bundle.BundleError, never> {
  return Object.assign(
    Effect.gen(function*() {
      const buildOutput: BuildOutput = yield* Effect.tryPromise({
        try: () => Bun.build(config),
        catch: (err: AggregateError | unknown) => {
          const cause = err instanceof AggregateError
            ? err.errors?.[0] ?? err
            : err

          return new Bundle.BundleError({
            message: "Failed to Bun.build: " + cause,
            cause: cause,
          })
        },
      })

      return buildOutput
    }),
  )
}
