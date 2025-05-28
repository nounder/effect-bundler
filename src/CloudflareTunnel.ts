import {
  Command,
  HttpServer,
} from "@effect/platform"
import {
  Config,
  Effect,
  identity,
  Layer,
  LogLevel,
  Option,
  pipe,
  Stream,
  String,
} from "effect"

/**
 * Starts Cloudflare tunnel using cloudflared cli.
 */
export const start = (opts: {
  command?: string
  tunnelName: string
  tunnelUrl?: string
  cleanLogs?: false
  logLevel?: LogLevel.LogLevel
  logPrefix?: string
}) =>
  Effect.gen(function*() {
    const logPrefix = String.isString(opts.logPrefix)
      ? opts.logPrefix
      : "CloudflareTunnel: "
    const args: string[] = [
      "tunnel",
      "run",
      opts.tunnelUrl
        ? [
          "--url",
          opts.tunnelUrl,
        ]
        : [],
      opts.tunnelName,
    ]
      .flatMap(v => v)

    const process = yield* pipe(
      Command.make(opts.command ?? "cloudflared", ...args),
      Command.start,
    )

    yield* Effect.logInfo(
      `Cloudflare tunnel started name=${opts.tunnelName} pid=${process.pid} tunnelUrl=${
        opts.tunnelUrl ?? "<empty>"
      }`,
    )

    yield* pipe(
      Stream.merge(
        process.stdout,
        process.stderr,
      ),
      Stream.decodeText("utf-8"),
      Stream.splitLines,
      opts.cleanLogs ?? true
        ? Stream.map(v =>
          v.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s\w+\s/, "")
        )
        : identity,
      logPrefix
        ? Stream.map(v => logPrefix + v)
        : identity,
      Stream.runForEach(v =>
        Effect.logWithLevel(opts.logLevel ?? LogLevel.Debug, v)
      ),
    )
  })

export const layer = () =>
  Layer.scopedDiscard(Effect.gen(function*() {
    const tunnelName = yield* pipe(
      Config.string("CLOUDFLARE_TUNNEL_NAME"),
      Config.option,
      Effect.andThen(Option.getOrUndefined),
    )
    const tunnelUrl = yield* pipe(
      Config.string("CLOUDFLARE_TUNNEL_URL"),
      Config.option,
      Effect.andThen(Option.getOrUndefined),
    )

    if (!tunnelName) {
      yield* Effect.logWarning("CLOUDFLARE_TUNNEL_NAME not provided. Skipping.")

      return
    }

    yield* Effect
      .forkScoped(
        pipe(
          start({
            tunnelName,
            tunnelUrl,
          }),
        ),
      )
      .pipe(
        Effect.catchAll(err =>
          Effect.logError("Cloudflare tunnel failed", err)
        ),
      )
  }))
