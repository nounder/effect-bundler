import { FileSystem } from "@effect/platform"
import {
  Array,
  Context,
  Data,
  Effect,
  Iterable,
  pipe,
  PubSub,
  Record,
  Schema as S,
} from "effect"
import { importJsBlob } from "./esm.ts"

export const BundleEntrypointMetaKey: unique symbol = Symbol.for(
  "effect-bundler/BundleEntrypointMetaKey",
)

export type BundleEntrypointMetaValue = {
  // if uri is null then artifact will be resolved based on request url
  uri: string | null
}

export const BundleOutputMetaKey: unique symbol = Symbol.for(
  "effect-bundler/BundleOutputMetaKey",
)

export type BundleOutputMetaValue = {}

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
      hash: pipe(
        S.String,
        S.optional,
      ),
      imports: pipe(
        S.Array(
          S.Struct({
            path: S.String,
            kind: S.Literal(
              "import-statement",
              "require-call",
              "require-resolve",
              "dynamic-import",
              "import-rule",
              "url-token",
              "internal",
              "entry-point-run",
              "entry-point-build",
            ),
          }),
        ),
        S.optional,
      ),
    }),
  }),
})

export type BundleManifest = typeof BundleManifestSchema.Type

export type BundleEvent =
  | {
    type: "Change"
    path: string
  }
  | {
    type: "BuildError"
    error: string
  }

export type BundleKey = `${string}Bundle`

/**
 * Passed to bundle effects and within bundle runtime.
 * Used to expose artifacts via HTTP server and properly resolve
 * imports within the bundle.
 */
export type BundleContext =
  & BundleManifest
  & {
    // TODO: consider removing resolve: way of resolving URL should be
    // the same regardless of underlying bundler since we have access
    // to all artifacts already.
    resolve: (url: string) => string
    getArtifact: (path: string) => Blob | null
    events?: PubSub.PubSub<BundleEvent>
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

export const tagged = <I extends BundleKey>(
  key: I,
) => {
  return Context.GenericTag<I, BundleContext>(key)
}

export const ClientKey = "ClientBundle" as const
export type ClientKey = typeof ClientKey

export const ServerKey = "ServerBundle" as const
export type ServerKey = typeof ServerKey

/**
 * Lodas a bundle as a javascript module.
 * Bundle must have only one entrypoint.
 */
export function load<M>(
  contextEffect: Effect.Effect<BundleContext, BundleError>,
): Effect.Effect<M, BundleError> {
  return Effect.gen(function*() {
    const context = yield* contextEffect
    const [artifact, ...rest] = Object.values(context.entrypoints)

    if (rest.length > 0) {
      return yield* Effect.fail(
        new BundleError({
          message: "Multiple entrypoints are not supported in load()",
        }),
      )
    }

    return yield* Effect.tryPromise({
      try: () => {
        const blob = context.getArtifact(artifact)

        return importJsBlob<M>(blob!)
      },
      catch: (e) =>
        new BundleError({
          message: "Failed to load entrypoint",
          cause: e,
        }),
    })
  })
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
              catch: (e) =>
                new BundleError({
                  message: "Failed to read an artifact as a buffer",
                  cause: e,
                }),
            }),
            Effect.andThen((b) =>
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
      Effect.andThen((v) => JSON.parse(v) as unknown),
      Effect.andThen(S.decodeUnknownSync(BundleManifestSchema)),
      Effect.catchAll((e) =>
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
      Effect.catchAll((e) =>
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
        Iterable.map(artifactsPairs, (v) => v[0]),
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
