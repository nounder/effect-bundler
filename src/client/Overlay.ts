const OVERLAY_ID = "_bundler_error_overlay"

export function getOverlay() {
  let overlay = document.getElementById(OVERLAY_ID) as HTMLPreElement | null
  if (!overlay) {
    overlay = document.createElement("pre")
    overlay.id = OVERLAY_ID
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      maxHeight: "40%",
      overflowY: "auto",
      margin: "0",
      padding: "4px",
      background: "black",
      color: "red",
      fontFamily: "monospace",
      zIndex: "2147483647",
      whiteSpace: "pre-wrap",
    })
    document.body.appendChild(overlay)
  }
  return overlay
}

export function showBuildError(message: string) {
  const overlay = getOverlay()
  const atBottom =
    overlay.scrollTop + overlay.clientHeight >= overlay.scrollHeight - 1
  overlay.textContent += message + "\n"
  if (atBottom) overlay.scrollTop = overlay.scrollHeight
}
