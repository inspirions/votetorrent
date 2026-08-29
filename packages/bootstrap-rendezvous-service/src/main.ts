import { pathToFileURL } from 'node:url'
import { ServiceConfigError, loadServiceConfig } from './config.js'
import { createServiceLogger, errorClass } from './logging.js'
import { startService } from './server.js'

/**
 * main.ts — the deployable entrypoint behind the package's `start` script.
 *
 * The logger is created **first**, in production mode, before anything can
 * fail. That ordering is the whole point: production logging is otherwise
 * silent, so a fatal startup error is the only thing an operator will ever see,
 * and it has to be emitted even when the configuration that would have chosen a
 * logging mode is the very thing that failed to parse.
 *
 * A `ServiceConfigError`'s message is service-authored — written in this
 * repository, naming an environment variable and what to do about it — so it is
 * both safe and actionable to print verbatim. Anything else is reduced to its
 * class name by `errorClass`, because a foreign error's message can carry a
 * filesystem path, a request body, or the operator bearer token.
 */
export async function runMain (
	env: Record<string, string | undefined>,
	sink?: (line: string) => void
): Promise<number> {
	const logger = createServiceLogger({ mode: 'production', sink })

	try {
		const config = loadServiceConfig(env)
		const service = await startService(config)

		const shutdown = (): void => {
			void service.close().catch(() => {
				// Nothing useful can be said about a failed close, and saying it
				// would risk describing paths. Exit quietly.
			})
		}
		process.once('SIGINT', shutdown)
		process.once('SIGTERM', shutdown)

		return 0
	} catch (err) {
		logger.fatal(
			err instanceof ServiceConfigError ? 'config-invalid' : 'startup-failed',
			err instanceof ServiceConfigError ? err.message : errorClass(err)
		)
		return 1
	}
}

// Self-start only when this module is the process entrypoint, so importing it
// from a test never launches a server.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exitCode = await runMain(process.env)
}
