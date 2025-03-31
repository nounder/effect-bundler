import { FileSystem, HttpRouter, HttpServerResponse } from "@effect/platform"
import {
  Array,
  Context,
  Data,
  Effect,
  Iterable,
  Option,
  pipe,
  Record,
  Schema as S,
} from "effect"
import { importJsBlob } from "./esm.ts"

export type BundleTag<Key extends string, Config, Identifier = Key> =
  & Context.Tag<Identifier, BundleContext>
  & {
    key: `effect-bundler/tags/${Key}`
    bundleKey: Key
    // TODO: we should consider branding the config
    // so tag can only be passed between bundles of the same kind.
    bundleConfig: Config
  }

/**
 * Generic shape describing a bundle across multiple bundlers
 * (like bun, esbuild & vite)
 */
export const BundleManifestSchema = S.Struct({
  entrypoints: S.Record({
    key: S.String,
    value: S.String,
  }),
  artifacts: S.Record({
    key: S.String,
    value: S.Struct({
      type: S.String,
      size: S.Number,
      hash: S.Union(S.Null, S.String)
        .pipe(S.optional),
    }),
  }),
})

export type BundleManifest = typeof BundleManifestSchema.Type

/**
 * Passed to bundle effects and within bundle runtime.
 * Used to expose artifacts via HTTP server and properly resolve
 * imports within the bundle.
 */
export type BundleContext =
  & BundleManifest
  & {
    resolve: (url: string) => string
    getArtifact: (path: string) => Blob | null
  }

export class BundleError extends Data.TaggedError("BundleError")<{
  message: string
  cause?: unknown
}> {}

/**
 * Creates a tag that symbolicly identifies a bundle.
 *
 * Useful when you want to provide a bundle at the start of the script.
 */
export const Tag = <T extends string>(name: T) => <Identifier>() =>
  Context.Tag(
    `effect-bundler/tags/${name}`,
  )<Identifier, BundleContext>()

export const unsafeGetManifest = (key: `${string}Bundle`) => {
  return pipe(
    [
      pipe(
        Context.getOption(tagged(key)),
      ),
      Effect.tryPromise({
        try: () => {
          // @ts-ignore
          return import("./manifest.json", { type: "json" }).catch(e => {
            throw new Error("File doesn't exist")
          })
        },
        catch: (e) =>
          new BundleError({
            message: "Failed to unsafely manifest.json",
            cause: e,
          }),
      }),
    ],
    Effect.firstSuccessOf,
    Effect.orDie,
  )
}

export const tagged = <I extends `${string}Bundle`>(
  key: I,
) => {
  return Context.GenericTag<I, BundleContext>(key)
}

/**
 * Loads a Bundle under given key.
 * It first looks for the bundle in runtime context, and if not found,
 * tries to load it from an embedded bundle.
 *
 * Embeded bundle are found under `effect-bundler/embeds/` module
 * and are provided by a bundler during building process.
 * Hence, the bundle config must include appropriate plugins
 * that provide bundle modules.
 *
 * WARNING: This will fail when bundle is not properly configured.
 */
export const dynamic = <T extends string>(
  key: T,
): Effect.Effect<BundleContext, never, never> =>
  pipe(
    [
      // maybe get from runtime context
      Context.GenericTag<T, BundleContext>(
        `effect-bundler/tags/${key}` as const,
      ).pipe(
        Effect.serviceOption,
        Effect.andThen(Option.getOrThrow),
      ),

      // maybe import from bundled modules
      Effect.tryPromise({
        try: () => {
          // @ts-ignore
          return import(`effect-bundler/dynamic/${key}`)
        },
        catch: e =>
          new BundleError({
            message: "Failed to load dynamic bundle",
            cause: e,
          }),
      }),
    ],
    Effect.firstSuccessOf,
    Effect.orDie,
  )

/**
 * Lodas a bundle as a javascript module.
 * Bundle must have only one entrypoint.
 */
export const load = <M>(
  context: BundleContext,
): Effect.Effect<M, BundleError> => {
  const [artifact, ...rest] = Object.values(context.entrypoints)

  if (rest.length > 0) {
    return Effect.fail(
      new BundleError({
        message: "Multiple entrypoints are not supported in load()",
      }),
    )
  }

  return Effect.tryPromise({
    try: () => {
      const blob = context.getArtifact(artifact)

      return importJsBlob<M>(blob!)
    },
    catch: (e) =>
      new BundleError({
        message: "Failed to load entrypoint buffer",
        cause: e,
      }),
  })
}

/**
 * Converts a Bundle to a HTTP router.
 * Useful when you want to expose Bundle via web server,
 * like in case of client-side bundles.
 */
export const toHttpRouter = (
  bundle: BundleContext,
): HttpRouter.HttpRouter => {
  return Iterable.reduce(
    pipe(
      bundle.artifacts,
      Record.collect((k, v) => [k, bundle.getArtifact(k)!] as const),
    ),
    HttpRouter.empty.pipe(
      // handle manifest.json
      HttpRouter.get(
        "/manifest.json",
        HttpServerResponse.text(
          JSON.stringify(bundle, undefined, 2),
          {
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    ),
    (router, [path, artifact]) =>
      router.pipe(
        HttpRouter.get(
          `/${path}`,
          pipe(
            Effect.promise(() => artifact.arrayBuffer()),
            Effect.andThen(bytes =>
              HttpServerResponse.uint8Array(new Uint8Array(bytes), {
                headers: {
                  "Content-Type": artifact.type,
                  "Content-Length": String(artifact.size),
                },
              })
            ),
          ),
        ),
      ),
  )
}

/**
 * Exports a bundle to a file system under specified directory.
 */
export const toFiles = (
  context: BundleContext,
  outDir: string,
) => {
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const manifest: BundleManifest = {
      entrypoints: context.entrypoints,
      artifacts: context.artifacts,
    }

    const normalizedOutDir = outDir.replace(/\/$/, "")

    const bundleArtifacts = pipe(
      manifest.artifacts,
      Record.mapEntries((_, k) => [k, context.getArtifact(k)!]),
    )
    const extraArtifacts = {
      "manifest.json": new Blob([JSON.stringify(manifest, undefined, 2)], {
        type: "application/json",
      }),
    }

    const allArtifacts = {
      ...bundleArtifacts,
      ...extraArtifacts,
    }

    const existingOutDirFiles = yield* fs.readDirectory(normalizedOutDir).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )

    // check if the output directory is empty. if it contains previous build,
    // remove it. Otherwise fail.
    if (existingOutDirFiles && existingOutDirFiles.length > 0) {
      if (existingOutDirFiles.includes("manifest.json")) {
        yield* Effect.logWarning(
          "Output directory seems to contain previous build. Overwriting...",
        )

        yield* fs.remove(normalizedOutDir, {
          recursive: true,
        })
      } else {
        yield* Effect.fail(
          new BundleError({
            message: "Output directory is not empty",
          }),
        )
      }
    }

    yield* fs.makeDirectory(normalizedOutDir, {
      recursive: true,
    })

    // write all artifacts to files
    yield* Effect.all(
      pipe(
        allArtifacts,
        Record.toEntries,
        Array.map(([p, b]) =>
          pipe(
            Effect.tryPromise({
              try: () => b.arrayBuffer(),
              catch: e =>
                new BundleError({
                  message: "Failed to read an artifact as a buffer",
                  cause: e,
                }),
            }),
            Effect.andThen(b =>
              fs.writeFile(
                `${normalizedOutDir}/${p}`,
                new Uint8Array(b),
              )
            ),
          )
        ),
      ),
      { concurrency: 16 },
    )
  })
}

/**
 * Loads a bundle from a directory and returns a BundleContext.
 * Expects the directory to contain a manifest.json file and all the artifacts
 * referenced in the manifest.
 */
export const fromFiles = (
  directory: string,
): Effect.Effect<
  BundleContext,
  BundleError,
  FileSystem.FileSystem
> => {
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const normalizedDir = directory.replace(/\/$/, "")
    const manifest = yield* pipe(
      fs.readFileString(`${normalizedDir}/manifest.json`),
      Effect.andThen(v => JSON.parse(v) as unknown),
      Effect.andThen(S.decodeUnknownSync(BundleManifestSchema)),
      Effect.catchAll(e =>
        Effect.fail(
          new BundleError({
            message: `Failed to read manifest.json from ${normalizedDir}`,
            cause: e,
          }),
        )
      ),
    )
    const artifactsPairs = Record.toEntries(manifest.artifacts)
    const artifactBlobs = yield* pipe(
      artifactsPairs,
      Iterable.map(([k]) => fs.readFile(`${normalizedDir}/${k}`)),
      Effect.all,
      Effect.catchAll(e =>
        new BundleError({
          message: `Failed to read an artifact from ${normalizedDir}`,
          cause: e,
        })
      ),
      Effect.andThen(Iterable.map((v, i) =>
        new Blob([v], {
          type: artifactsPairs[i][0],
        })
      )),
    )
    const artifactsRecord = pipe(
      Iterable.zip(
        Iterable.map(artifactsPairs, v => v[0]),
        artifactBlobs,
      ),
      Record.fromEntries,
    )

    const bundleContext: BundleContext = {
      ...manifest,
      // TODO: support fullpath file:// urls
      // this will require having an access to base path of a build
      // and maybe problematic because bundlers transform urls on build
      resolve: (url: string) => {
        return manifest.entrypoints[url] ?? null
      },
      getArtifact: (path: string) => {
        return artifactsRecord[path] ?? null
      },
    }

    return bundleContext
  })
}
