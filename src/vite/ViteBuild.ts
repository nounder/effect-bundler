import {
  FileSystem,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import Effect from "effect/Effect"
import { pipe } from "effect/Function"
import Layer from "effect/Layer"
import * as nodeFs from "node:fs/promises"
import { Vite } from "./Vite.ts"

interface ViteManifest {
  [key: string]: {
    file: string
    name: string
    src: string
    isEntry: boolean
  }
}

class ViteBuildError extends Error {
  readonly _tag = "ViteBuildError"
}

export const make = (opts: {
  outDir?: string
}) =>
  Layer.scoped(
    Vite,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const outDir = opts.outDir ?? "dist"
      const viteManifestPath = `${outDir}/.vite/manifest.json`

      // TODO: use the manifest to map files
      // will probly need import tree so i can provide appropriate
      // modulepreload in Link header.
      // in production the app should be behind CDN that will cache
      // all assets so static content will never hit the server
      //
      // i might need to expose manifest file and use
      // external function to handle static file serving instead of
      // returning handlers here.
      const viteManifest: ViteManifest = yield* pipe(
        fs.readFileString(viteManifestPath),
        Effect.catchAll(
          () =>
            Effect.fail(
              new ViteBuildError(
                "vite manifest cannot be read: " + viteManifestPath,
              ),
            ),
        ),
        Effect.map((v) => JSON.parse(v)),
      )

      const effectHandler = Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const req = yield* HttpServerRequest.HttpServerRequest

        const path = outDir + req.url
        const stat = yield* fs.stat(path)

        return HttpServerResponse.stream(
          fs.stream(path),
          {
            headers: {
              "content-length": stat.size.toString(),
            },
          },
        )
      })

      const fetch = async (req: Request) => {
        const url = new URL(req.url)

        const path = outDir + url.pathname
        const blob = new Blob([await nodeFs.readFile(path)])

        return new Response(blob, {
          headers: {
            "content-length": blob.size.toString(),
            // "cache-control": "public, max-age=31536000",
          },
        })
      }

      return {
        fetch,
        effectHandler,
      }
    }),
  )
