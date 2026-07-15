import { Ghostty } from 'ghostty-web'

let ghosttyPromise: Promise<Ghostty> | undefined

export function loadGhostty(): Promise<Ghostty> {
  ghosttyPromise ??= Ghostty.load(new URL('./ghostty-vt.wasm', window.location.href).href)
  return ghosttyPromise
}
