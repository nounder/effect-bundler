import { FileSystem, PlatformError } from "@effect/platform";
import { HttpRouter } from "@effect/platform/HttpRouter";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { HttpServerResponse } from "@effect/platform/HttpServerResponse";
import { Effect } from "effect";
import * as NFS from "node:fs";
import * as NFSp from "node:fs/promises"
import * as NPath from "node:path"

type PathSegment =
  | {
    type: "Literal"
    text: string // eg. "users"
  }
  | {
    type: "DynamicParam"
    text: string // eg. "userId"
  }
  | {
    type: "OptionalParam"
    text: string // eg. "userId"
  }
  | {
    type: "RestParam"
    text: string // eg. "[...name]"
  }

type Extension = "tsx" | "jsx" | "ts" | "js"

type HandleSegment =
  | {
    // example: '+server.ts'
    type: "ServerHandle"
    extension: Extension
  }
  | {
    // example: '+page.tsx'
    type: "PageHandle"
    extension: Extension
  }

type Segment =
  | PathSegment
  | HandleSegment

type Route = [
  ...Segment[],
  HandleSegment[],
]

export function extractSegments(path: string): Segment[] | null {
  const trimmedPath = path.replace(/(^\/)|(\/$)/g, "") // trim leading/trailing slashes

  if (trimmedPath === "") {
    return [] // Handles "" and "/"
  }

  const segmentStrings = trimmedPath
    .split("/")
    .filter(s => s !== "") // Remove empty segments from multiple slashes, e.g. "foo//bar"

  if (segmentStrings.length === 0) {
    return []
  }

  const segments: (Segment | null)[] = segmentStrings.map(
    (s): Segment | null => {
      // 2. Handles: +server.ext, +page.ext
      if (s.startsWith("+")) {
        const parts = s.split(".")
        if (parts.length !== 2) {
          return null // e.g. /api/+server (missing ext) or +server.foo.bar
        }
        const [name, ext] = parts
        if (!["ts", "js", "tsx", "jsx"].includes(ext)) {
          return null // eg. +page.xyz
        }
        if (name === "+server") {
          return { type: "ServerHandle", extension: ext as Extension }
        }
        if (name === "+page") {
          return { type: "PageHandle", extension: ext as Extension }
        }
        return null // e.g. +invalid.ts
      }

      // [[name]]
      if (s.startsWith("[[") && s.endsWith("]]") && s.length >= 5) {
        const name = s.substring(2, s.length - 2)
        if (name !== "" && !name.startsWith("...")) {
          return { type: "OptionalParam", text: name }
        }
        // "[[...foo]]" falls through to Literal. Correctly formed "[[]]" already returned null.
      }

      // [...name]
      if (/^\[\.{3}\w+\]$/.test(s)) {
        const name = s.substring(4, s.length - 1)
        if (name !== "") {
          return { type: "RestParam", text: s }
        }
      }

      // [name]
      if (/^\[\w+\]$/.test(s)) {
        const name = s.substring(1, s.length - 1)
        if (name !== "") {
          return { type: "DynamicParam", text: name }
        }
      }

      if (/^\w+$/.test(s)) {
        return { type: "Literal", text: s }
      }

      return null
    },
  )

  if (segments.some((seg) => seg === null)) {
    return null
  }

  return segments as Segment[]
}

export function extractRoute(path: string): Route | null {
  const segs = extractSegments(path)

  const lastSegmentType = segs.at(-1)?.type;
  if (
    !segs
    || segs.length === 0
    || (lastSegmentType !== "ServerHandle" && lastSegmentType !== "PageHandle")
  ) {
    return null
  }

  return segs as Route
}

export function walkRotues(dir: string) {
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    fs.readDirectory(dir, { recursive: true })
  })
}

export class InvalidModuleError {
  readonly _tag = "InvalidModuleError";
  constructor(readonly message: string) {}
}

export class ImportError {
  readonly _tag = "ImportError";
  constructor(readonly error: unknown, readonly filePath: string) {}
}

function segmentsToPath(segments: PathSegment[]): string {
  if (segments.length === 0) return "/";
  const path = "/" + segments.map(segment => {
    switch (segment.type) {
      case "Literal":
        return segment.text;
      case "DynamicParam":
        return `:${segment.text}`;
      case "OptionalParam":
        return `:${segment.text}?`;
      case "RestParam":
        const paramName = segment.text.substring(4, segment.text.length - 1);
        return `:${paramName}*`;
    }
  }).join("/");
  return path.replace(/\/\//g, "/"); // In case of empty segments leading to double slashes
}

export function fromFiles(scanDir: string): Effect.Effect<
  HttpRouter.HttpRouter,
  PlatformError | InvalidModuleError | ImportError,
  FileSystem // Requires FileSystem in its context
> {
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem; // Changed
    let router = HttpRouter.empty();
    
    // Ensure scanDir is absolute for reliable readdir and import resolution
    const absoluteScanDir = NPath.resolve(scanDir);

    const files = yield* fs.readDirectory(absoluteScanDir, { recursive: true }); // Changed

    for (const relativePath of files) {
      // extractRoute expects path relative to a conceptual 'routes' root, 
      // which is what readDirectory provides here relative to absoluteScanDir.
      const routeSegments = extractRoute(relativePath);

      if (routeSegments && routeSegments.length > 0) {
        const handleSegment = routeSegments[routeSegments.length - 1] as HandleSegment; // extractRoute ensures last is HandleSegment
        const pathSegments = routeSegments.slice(0, -1) as PathSegment[];
        
        const httpPath = segmentsToPath(pathSegments);
        const absoluteFilePath = NPath.join(absoluteScanDir, relativePath);

        const moduleEffect = Effect.tryPromise({
          try: () => import(absoluteFilePath /* @vite-ignore */), // @vite-ignore might be needed if bundling with Vite
          catch: (error) => new ImportError(error, absoluteFilePath)
        });
        const module = yield* moduleEffect; // Changed

        if (!module.default && !Object.keys(module).some(key => ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].includes(key))) {
          // This broad check for PageHandle might be too early if PageHandle only expects default.
          // If it's a PageHandle, it strictly needs a default export.
          // If it's a ServerHandle, it needs either method exports or a default export.
          // The original code had a `!module.default` check before `handleSegment.type` switch,
          // which was then refined. Let's refine this initial check.
          if (handleSegment.type === "PageHandle" && !module.default) {
            yield* Effect.fail(new InvalidModuleError(`Missing default export in ${absoluteFilePath} for +page.tsx`)); // Changed
            return; // Stop processing this file
          }
          // For ServerHandle, the more detailed check is done below, so this initial check can be less strict or removed if redundant.
          // If we keep a check here for ServerHandle, it would be:
          // if (handleSegment.type === "ServerHandle" && !module.default && !Object.keys(module).some(key => httpMethods.includes(key)))
          // For now, let's rely on the detailed checks later.
        }
        
        // Specific check for PageHandle missing default export (if not caught above)
        if (handleSegment.type === "PageHandle" && !module.default) {
            yield* Effect.fail(new InvalidModuleError(`Missing default export in ${absoluteFilePath} for +page.tsx`)); // Changed
            return; // Stop processing this file
        }


        if (handleSegment.type === "ServerHandle") {
          const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];
          let foundMethodSpecificHandler = false;
          // Check for module.default first, as it can be undefined.
          const defaultExport = module.default;
          let hasPotentiallyValidDefaultExport = defaultExport && (typeof defaultExport === 'function' || (defaultExport && typeof (defaultExport as any).pipe === 'function'));

          for (const method of httpMethods) {
            const handlerCandidate = module[method];
            if (handlerCandidate && (typeof handlerCandidate === 'function' || (handlerCandidate && typeof (handlerCandidate as any).pipe === 'function'))) {
              const specificHandlerEffect = handlerCandidate as HttpRouter.Handler<any,any,any>;
              switch (method) {
                case "GET": router = HttpRouter.get(router, httpPath, specificHandlerEffect); break;
                case "POST": router = HttpRouter.post(router, httpPath, specificHandlerEffect); break;
                case "PUT": router = HttpRouter.put(router, httpPath, specificHandlerEffect); break;
                case "DELETE": router = HttpRouter.delete(router, httpPath, specificHandlerEffect); break;
                case "PATCH": router = HttpRouter.patch(router, httpPath, specificHandlerEffect); break;
                case "OPTIONS": router = HttpRouter.options(router, httpPath, specificHandlerEffect); break;
                case "HEAD": router = HttpRouter.head(router, httpPath, specificHandlerEffect); break;
              }
              foundMethodSpecificHandler = true;
            }
          }

          if (!foundMethodSpecificHandler) {
            if (hasPotentiallyValidDefaultExport) {
              const defaultHandlerEffect = defaultExport as HttpRouter.Handler<any,any,any>;
              router = HttpRouter.all(router, httpPath, defaultHandlerEffect);
            } else {
              // No method-specific handlers AND no valid default export
              yield* Effect.fail(new InvalidModuleError(`No valid route handlers (method-specific functions or default export) found in ${absoluteFilePath}`)); // Changed
              return; // Stop processing this file
            }
          }
          // If foundMethodSpecificHandler is true, any default export is ignored for routing.
        } else { // PageHandle
          // The check for !module.default for PageHandle is done above.
          let content: string;
          if (typeof module.default === "function") {
            // Call the function to get the string content
            try {
              content = module.default(); 
              if (typeof content !== 'string') {
                yield* Effect.fail(new InvalidModuleError(`Default export function in ${absoluteFilePath} for +page.tsx did not return a string.`)); // Changed
                return; // Stop processing this file
              }
            } catch (e) {
              yield* Effect.fail(new InvalidModuleError(`Error executing default export function in ${absoluteFilePath} for +page.tsx: ${e instanceof Error ? e.message : String(e)}`)); // Changed
              return; // Stop processing this file
            }
          } else if (typeof module.default === "string") {
            content = module.default;
          } else {
            // This case should ideally be caught by the !module.default check for PageHandle earlier,
            // or if module.default exists but is not a function or string.
            yield* Effect.fail(new InvalidModuleError(`Default export in ${absoluteFilePath} for +page.tsx is not a string or a function returning a string.`)); // Changed
            return; // Stop processing this file
          }
          const pageHandlerEffect = Effect.succeed(HttpServerResponse.text(content));
          // Page handles are always GET
          router = HttpRouter.get(router, httpPath, pageHandlerEffect as HttpRouter.Handler<any,any,any>);
        }
      }
    }
    return router;
  });
}

export async function* walkRoutesDirectory(
  dir: string,
): AsyncGenerator<Route> {
  for (
    const path of await NFSp.readdir(dir, {
      recursive: true,
    })
  ) {
    const segs = extractRoute(path)

    if (segs) {
      yield segs
    }
  }
}
