# Effect Bundler

Build declarative full-stack apps with Effect.

This project is in its early stage. I use it in two different projects.

However, the code is well documented so you should be able to figure out how to use it
by checking out `examples/` directory. Feel free to hit me up if not.

If you are an AI coding agent, please read `AGENTS.md` for more instructions.

## Examples

See `examples/` directory for templates and additional usage using Preact, React, TanStack, and others.

You can clone it by using degit, like so:

```sh
bunx degit nounder/effect-bundler/examples/bun-preact target
```

## Development

### File-based Routing

Effect Bundler provides automatic file-based routing with support for frontend pages, backend endpoints, and stackable layouts.

```
src/routes/
├── _layout.tsx          # Root layout
├── _page.tsx            # Home page (/)
├── about/
│   ├── _layout.tsx      # Nested layout for /about/*
│   └── _page.tsx        # Static route (/about)
├── users/
│   ├── _page.tsx        # Users list (/users)
│   └── $id/_page.tsx    # Dynamic route (/users/:id)
└── $/_page.tsx          # Splat/catch-all (/**)
```

```ts
import { FileRouter } from "effect-bundler"

// Generate route manifest and watch for changes
const routerLayer = FileRouter.layer(import.meta.resolve("routes"))
```

**Note:** Ensure `FileRouter.layer` is provided after any bundle layer to guarantee the manifest file is properly generated before bundling.

### Tailwind CSS Support

Effect Bundler includes built-in support for Tailwind CSS:

```ts
import {
  BunBundle,
  BunTailwindPlugin,
} from "effect-bundler/bun"

const ClientBundle = BunBundle.bundleClient({
  entrypoints: [
    "./src/index.html",
  ],
  plugins: [
    BunTailwindPlugin.make(),
  ],
})
```

Then in your main CSS files add following file:

```css
@import "tailwindcss";
```

### Static File Serving

```ts
import { HttpRouter } from "@effect/platform"
import { PublicDirectory } from "effect-bundler"

// Serve files from ./public directory
const PublicFiles = PublicDirectory.make()

HttpRouter.empty.pipe(
  HttpRouter.get("*", PublicFiles),
)
```
