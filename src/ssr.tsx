import {
  Hydration,
  HydrationScript,
  NoHydration,
  renderToStringAsync,
  ssr,
} from "solid-js/web"
import { App } from "./App.tsx"
import * as Bundle from "./Bundle.ts"
import * as BundleServer from "./BundleServer.ts"

export const SsrNotFoundMagicValue = `<!--ssr-not-found-->`

export const SsrApp = BundleServer.renderPromise(
  Bundle.tagged("ClientBundle"),
  async (req, resolve) => {
    const Component = () => (
      Document({
        url: req.url,
        resolve,
        children: App({
          serverUrl: req.url,
        }),
      })
    )

    const html = await renderToStringAsync(Component, {
      timeoutMs: 4000,
    })

    if (html.includes(SsrNotFoundMagicValue)) {
      return new Response(html, {
        status: 404,
        headers: {
          "Content-Type": "text/html",
        },
      })
    }

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
      },
    })
  }
)

export default SsrApp

function Document(props: {
  children: any
  url: string
  resolve: (url: string) => string
}) {
  const docType = ssr("<!DOCTYPE html>") as unknown as any
  const jsUrl = props.resolve("client.tsx")
  const cssUrl = props.resolve("app.css")

  return (
    <NoHydration>
      {docType}

      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          />
          <title>solid-deno</title>

          <link rel="stylesheet" href={cssUrl} />
        </head>

        <body>
          <Hydration>
            {props.children}
          </Hydration>
        </body>

        <HydrationScript />
        <script type="module" src={jsUrl}></script>
      </html>
    </NoHydration>
  )
}
