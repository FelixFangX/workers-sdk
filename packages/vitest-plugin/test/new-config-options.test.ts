import fs from "node:fs/promises";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { beforeEach, describe, it, vi } from "vitest";
import type { RemoteProxyConnectionString } from "miniflare";
import type { TestProject } from "vitest/node";

const remoteProxyConnectionString = new URL(
	"http://localhost:8787"
) as RemoteProxyConnectionString;

const {
	maybeStartOrUpdateRemoteProxySession,
	requireAuth,
	resolveProfile,
	state,
} = vi.hoisted(() => ({
	maybeStartOrUpdateRemoteProxySession: vi.fn(),
	requireAuth: vi.fn(async () => "cf-account-id"),
	resolveProfile: vi.fn(() => ({ name: "cf-profile" })),
	state: { wranglerImported: false },
}));

vi.mock("@cloudflare/remote-bindings", () => ({
	maybeStartOrUpdateRemoteProxySession,
}));

vi.mock("@cloudflare/workers-auth/cf", () => ({
	createCfAuth: () => ({
		setProfile: vi.fn(),
		requireAuth,
		requireApiToken: () => ({ apiToken: "cf-token" }),
	}),
	createCfProfileStore: () => ({ resolve: resolveProfile }),
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
		requireAuth.mockClear();
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

	it("uses cf credentials for remote bindings, without Wrangler", async ({
		expect,
	}) => {
		// A config function, so the account follows the mode between parses
		await fs.writeFile(
			"cloudflare.config.ts",
			`export default ({ mode }) => ({
				accountId: mode + "-account",
				worker: {
					name: "test-worker",
					compatibilityDate: "2025-12-02",
					env: {
						KV: { type: "kv", id: "kv-id", dev: { remote: true } },
					},
				},
			});`
		);
		const { parseProjectOptions } = await import("../src/pool/config");
		const stagingProject = {
			config: project.config,
			vite: { config: { mode: "staging", envDir: process.cwd() } },
		} as unknown as TestProject;

		const options = await parseProjectOptions(project, { config: true });
		await parseProjectOptions(project, { config: true });
		await parseProjectOptions(stagingProject, { config: true });

		const [[details, , auth, context], [, , sameAuth], [, , stagingAuth]] =
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
		// The key identifies the credentials, so the session only restarts when
		// the account changes
		expect(sameAuth.key).toBe(auth.key);
		expect(stagingAuth.key).not.toBe(auth.key);
		await expect(auth.hook()).resolves.toEqual({
			accountId: "cf-account-id",
			apiToken: { apiToken: "cf-token" },
		});
		await stagingAuth.hook();
		expect(requireAuth.mock.calls).toEqual([
			[{ account_id: "test-account" }],
			[{ account_id: "staging-account" }],
		]);
		expect(resolveProfile).toHaveBeenCalledWith({ cwd: process.cwd() });
		expect(state.wranglerImported).toBe(false);
	});

	it("keeps Wrangler's credentials for Wrangler configs", async ({
		expect,
	}) => {
		const { parseProjectOptions } = await import("../src/pool/config");

		await parseProjectOptions(project, {
			wrangler: { configPath: "./wrangler.jsonc" },
		});

		const [[, , auth, context]] =
			maybeStartOrUpdateRemoteProxySession.mock.calls;
		expect(auth).toBeUndefined();
		expect(context).toMatchObject({ cliDisplayName: "Wrangler" });
		expect(state.wranglerImported).toBe(true);
	});
});
