import { describe, it } from "vitest";
import { mergeCloudflareConfigWorker } from "../src/pool/new-config";
import type { LoadedNewConfig } from "../src/pool/new-config";
import type { RemoteProxyConnectionString, WorkerOptions } from "miniflare";

function userWorker(
	config: Partial<WorkerOptions["config"]>,
	dev?: WorkerOptions["dev"]
): WorkerOptions {
	return {
		config: { name: "runner", compatibilityDate: "2025-12-02", ...config },
		dev,
	};
}

function loadedConfig(
	worker: Partial<LoadedNewConfig["worker"]>
): LoadedNewConfig {
	return {
		settings: {},
		worker: {
			name: "test-worker",
			compatibilityDate: "2025-12-02",
			...worker,
		} as LoadedNewConfig["worker"],
		mode: "test",
		localEnv: {},
		devVars: undefined,
	};
}

describe("mergeCloudflareConfigWorker()", () => {
	it("lets `miniflare` supply a binding that has no local value", ({
		expect,
	}) => {
		const hyperdrive = {
			type: "hyperdrive",
			id: "hyperdrive-id",
			dev: { connectionString: "postgres://localhost/database" },
		} as const;

		const merged = mergeCloudflareConfigWorker(
			userWorker({ env: { DB: hyperdrive } }),
			loadedConfig({
				env: { DB: { type: "hyperdrive", id: "hyperdrive-id" } },
			}),
			{}
		);

		expect(merged.config.env?.DB).toEqual(hyperdrive);
	});

	it("keeps the config's declaration of a Durable Object class", ({
		expect,
	}) => {
		const merged = mergeCloudflareConfigWorker(
			userWorker({
				env: {
					COUNTER: {
						type: "durable-object",
						worker: "runner",
						exportName: "Counter",
					},
				},
				exports: { Counter: { type: "durable-object", storage: "legacy-kv" } },
			}),
			loadedConfig({
				exports: { Counter: { type: "durable-object", storage: "sqlite" } },
			}),
			{}
		);

		expect(merged.config.exports?.Counter).toEqual({
			type: "durable-object",
			storage: "sqlite",
		});
	});

	it("rejects remote bindings that use different proxy sessions", ({
		expect,
	}) => {
		const proxy = (port: number) =>
			new URL(`http://localhost:${port}`) as RemoteProxyConnectionString;

		expect(() =>
			mergeCloudflareConfigWorker(
				userWorker({}, { remoteProxyConnectionString: proxy(8787) }),
				loadedConfig({}),
				{ remoteProxyConnectionString: proxy(8788) }
			)
		).toThrow(
			"Remote bindings in `miniflare` options and in `cloudflare.config.ts` use different remote proxy sessions"
		);
	});
});
