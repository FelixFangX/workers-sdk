import fs from "node:fs/promises";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { beforeEach, describe, it, vi } from "vitest";
import type { RemoteProxyConnectionString } from "miniflare";
import type { TestProject } from "vitest/node";

const remoteProxyConnectionString = new URL(
	"http://localhost:8787"
) as RemoteProxyConnectionString;

const { maybeStartOrUpdateRemoteProxySession, state } = vi.hoisted(() => ({
	maybeStartOrUpdateRemoteProxySession: vi.fn(),
	state: { wranglerImported: false },
}));

vi.mock("@cloudflare/remote-bindings", () => ({
	maybeStartOrUpdateRemoteProxySession,
}));

// Records whether Wrangler was imported, and stands in for it. Registered
// with `vi.doMock()` after `vi.resetModules()` in each test, so it runs again on
// that test's first import (a hoisted `vi.mock()` factory would only run once).
function wranglerFactory() {
	state.wranglerImported = true;
	return {
		unstable_readConfig: () => ({
			name: "test-worker",
			topLevelName: "test-worker",
		}),
		unstable_convertConfigBindingsToStartWorkerBindings: () => ({
			KV: { type: "kv_namespace", id: "kv-id", remote: true },
		}),
		unstable_getMiniflareWorkerOptions: () => ({
			workerOptions: {},
			externalWorkers: [],
			define: {},
			main: undefined,
		}),
	};
}

interface InvalidOptionsCase {
	name: string;
	files?: Record<string, string>;
	options: Record<string, unknown>;
	message: string;
}

describe("parseProjectOptions()", () => {
	runInTempDir();

	let project: TestProject;

	beforeEach(() => {
		vi.resetModules();
		vi.doMock("wrangler", wranglerFactory);
		state.wranglerImported = false;
		project = {
			config: { root: process.cwd() },
			vite: { config: { mode: "test", envDir: process.cwd() } },
		} as unknown as TestProject;
		maybeStartOrUpdateRemoteProxySession.mockReset();
		maybeStartOrUpdateRemoteProxySession.mockResolvedValue({
			session: { remoteProxyConnectionString },
			remoteBindings: {},
		});
	});

	it.for<InvalidOptionsCase>([
		{
			name: "`wrangler` combined with `config`",
			options: { wrangler: { configPath: "./wrangler.jsonc" }, config: true },
			message:
				"`wrangler` can't be used with `config`. Set `config` to use `cloudflare.config.ts`, or `wrangler` to use a Wrangler configuration file.",
		},
		{
			name: "a missing cloudflare.config.ts",
			options: { config: true },
			message: "`config` is enabled but no `cloudflare.config.ts` was found at",
		},
		{
			name: "a config that doesn't define a Worker",
			files: {
				"cloudflare.config.ts": `export default { accountId: "abc123" };`,
			},
			options: { config: true },
			message:
				"`cloudflare.config.ts` must define a Worker using the `worker` property.",
		},
		{
			name: "an invalid config",
			// `compatibilityDate` is required
			files: {
				"cloudflare.config.ts": `export default { worker: { name: "test-worker" } };`,
			},
			options: { config: true },
			message: "→ at worker.compatibilityDate",
		},
	])("rejects $name", async ({ files = {}, options, message }, { expect }) => {
		for (const [name, contents] of Object.entries(files)) {
			await fs.writeFile(name, contents);
		}
		const { parseProjectOptions } = await import("../src/pool/config");

		await expect(parseProjectOptions(project, options)).rejects.toThrow(
			message
		);
	});

	it("puts `miniflare` module rules before the defaults", async ({
		expect,
	}) => {
		await fs.writeFile(
			"cloudflare.config.ts",
			`export default { worker: { name: "test-worker", compatibilityDate: "2025-12-02" } };`
		);
		const { parseProjectOptions } = await import("../src/pool/config");
		const rule = { type: "Text" as const, include: ["**/*.md"] };

		const options = await parseProjectOptions(project, {
			config: true,
			miniflare: { modulesRules: [rule] },
		});

		// After a default rule for the same type, the rule would be ignored
		expect(options.moduleRules?.[0]).toEqual(rule);
	});

	it("starts a remote bindings session without Wrangler", async ({
		expect,
	}) => {
		await fs.writeFile(
			"cloudflare.config.ts",
			`export default {
				worker: {
					name: "test-worker",
					compatibilityDate: "2025-12-02",
					env: {
						KV: { type: "kv", id: "kv-id", dev: { remote: true } },
					},
				},
			};`
		);
		const { parseProjectOptions } = await import("../src/pool/config");

		const options = await parseProjectOptions(project, { config: true });

		const [[details, , , context]] =
			maybeStartOrUpdateRemoteProxySession.mock.calls;
		expect(details).toMatchObject({
			name: "test-worker",
			target: "cf",
			env: { KV: { type: "kv", id: "kv-id", dev: { remote: true } } },
		});
		expect(context).toMatchObject({ cliDisplayName: "cf" });
		expect(options.remoteProxyConnectionString).toBe(
			remoteProxyConnectionString
		);
		expect(state.wranglerImported).toBe(false);
	});
});
