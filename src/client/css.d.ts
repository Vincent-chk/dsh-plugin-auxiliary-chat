/** Build-time inlined stylesheet text (`node scripts/build.mjs`). */
declare module '*.css?inline' {
  const css: string
  export default css
}
