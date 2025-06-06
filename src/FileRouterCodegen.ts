import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect } from "effect"
import * as NPath from "node:path"
import * as FileRouter from "./FileRouter.ts"

export function generateCode(
  handles: FileRouter.OrderedRouteHandles,
): string {
  const definitions: string[] = []
  const pageVariables: string[] = []

  let currentLayout: { routePath: string; varName: string } | null = null
  const processedLayouts: { routePath: string; varName: string }[] = []

  for (const handle of handles) {
    const prefix = handle.type === "LayoutHandle" ? "layout" : "page"
    const normalizedPath = handle
      .routePath
      // remove leading slash
      .slice(1)
      // convert slashes to underscores
      .replace(/\//g, "_")
    const varName = `${prefix}_${normalizedPath}`

    // Reset current layout if it's not an ancestor of current route
    if (
      currentLayout
      && !(
        currentLayout.routePath === "/"
        || handle.routePath === currentLayout.routePath
        || (currentLayout.routePath !== "/"
          && handle.routePath.startsWith(currentLayout.routePath + "/"))
      )
    ) {
      // Find the most specific layout that is still a valid parent
      currentLayout = processedLayouts
        .filter(layout =>
          layout.routePath === "/"
          || handle.routePath === layout.routePath
          || handle.routePath.startsWith(layout.routePath + "/")
        )
        .reduce(
          (best, layout) =>
            !best || layout.routePath.length > best.routePath.length
              ? layout
              : best,
          null as { routePath: string; varName: string } | null,
        )
    }

    switch (handle.type) {
      case "LayoutHandle": {
        const code = `const ${varName} = {
\tpath: "${handle.routePath}",
\tparent: ${currentLayout?.varName ?? "undefined"},
\tload: () => import("./${handle.modulePath}"),
}`

        definitions.push(code)

        // Set this layout as current and add to processed layouts
        currentLayout = { routePath: handle.routePath, varName }
        processedLayouts.push(currentLayout)

        break
      }
      case "PageHandle": {
        const code = `const ${varName} = {
\tpath: "${handle.routePath}",
\tparent: ${currentLayout?.varName ?? "undefined"},
\tload: () => import("./${handle.modulePath}"),
}`

        definitions.push(code)
        pageVariables.push(varName)

        break
      }
    }
  }

  return `${definitions.join("\n\n")}

export const Pages = [
\t${pageVariables.join(",\n\t")}
] as const
 `
    .replace(/\t/g, "  ")
}

export function dump(
  routesPath: string,
  manifestPath = ".routes.gen.ts",
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function*() {
    manifestPath = NPath.resolve(routesPath, manifestPath)

    const fs = yield* FileSystem.FileSystem
    const files = yield* fs.readDirectory(routesPath, { recursive: true })
    const handles = FileRouter.getRouteHandlesFromPaths(files)
    const code = generateCode(handles)

    yield* Effect.logDebug(`Generating file routes manifest: ${manifestPath}`)

    yield* fs.writeFileString(
      manifestPath,
      code,
    )
  })
}
