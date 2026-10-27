import fs from "node:fs";
import path from "node:path";
import dedent from "ts-dedent";
import { test } from "./helpers";

test(
	"keeps test Workers out of the dev registry",
	{ timeout: 60_000 },
	async ({ expect, seed, tmpPath, vitestRun }) => {
		await seed({
			"vitest.config.mts": dedent /* javascript */ `
				import fs from "node:fs";
				import { fileURLToPath } from "node:url";
				import { cloudflareTest } from "@cloudflare/vitest-plugin";

				const registryPath = fileURLToPath(new URL("./dev-registry", import.meta.url));
				process.env.CLOUDFLARE_DEV_REGISTRY_PATH = registryPath;

				export default {
					test: {
						reporters: [
							"default",
							{
								// Workers are unregistered when Miniflare is disposed, so record
								// the registry while tests run
								onTestModuleEnd() {
									fs.writeFileSync(
										fileURLToPath(new URL("./registry.json", import.meta.url)),
										JSON.stringify(fs.existsSync(registryPath) ? fs.readdirSync(registryPath) : [])
									);
								},
							},
						],
					},
					plugins: [
						cloudflareTest({
							miniflare: {
								compatibilityDate: "2025-12-02",
								compatibilityFlags: ["nodejs_compat"],
								workers: [
									{
										name: "auxiliary",
										modules: true,
										script: "export default { fetch() { return new Response('ok'); } }",
									},
								],
							},
						}),
					],
				};
			`,
			"index.test.ts": dedent /* javascript */ `
				import { it } from "vitest";
				it("runs", ({ expect }) => {
					expect(true).toBe(true);
				});
			`,
		});

		const result = await vitestRun();

		expect(await result.exitCode).toBe(0);
		const registry = fs.readFileSync(
			path.join(tmpPath, "registry.json"),
			"utf8"
		);
		expect(JSON.parse(registry)).toEqual([]);
	}
);
