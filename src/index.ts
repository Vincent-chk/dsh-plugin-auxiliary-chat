/**
 * Host half of the sidebar auxiliary-chat plugin.
 *
 * OWNER: teammate `aux-host`. Real wiring lives in ./host/**; this file only
 * assembles the plugin face the Loader imports.
 * @module index
 */
export { apply, inject, Config, name } from './host/apply.ts'
