import dedent from "ts-dedent";
import { test } from "./helpers";

test(
	"points bindings that name the Wrangler config's own Worker at it",
	{ timeout: 60_000 },
	async ({ expect, seed, vitestRun }) => {
		await seed({
			"vitest.config.mts": dedent /* javascript */ `
				import { cloudflareTest } from "@cloudflare/vitest-plugin";

				export default {
					plugins: [
						cloudflareTest({
							wrangler: { configPath: "./wrangler.jsonc" },
							miniflare: { serviceBindings: { SELF_BY_NAME: "self-references" } },
						}),
					],
					test: { testTimeout: 90_000 },
				};
			`,
			"wrangler.jsonc": dedent`
				{
					"name": "self-references",
					"main": "./index.ts",
					"compatibility_date": "2026-08-28",
					"durable_objects": {
						"bindings": [
							{ "name": "COUNTER", "class_name": "Counter", "script_name": "self-references" }
						]
					},
					"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
				}
			`,
			"index.ts": dedent /* javascript */ `
				import { DurableObject } from "cloudflare:workers";
				export class Counter extends DurableObject {
					count = 0;
					increment() { return ++this.count; }
				}
				export default {
					async fetch() { return new Response("ok"); },
				};
			`,
			"index.test.ts": dedent /* javascript */ `
				import { env } from "cloudflare:workers";
				import { it } from "vitest";
				it("calls the Worker through a service binding written as its name", async ({ expect }) => {
					const response = await env.SELF_BY_NAME.fetch("http://example.com");
					expect(await response.text()).toBe("ok");
				});
				it("calls a Durable Object bound with the Worker's name as script_name", async ({ expect }) => {
					expect(await env.COUNTER.getByName("a").increment()).toBe(1);
				});
			`,
		});

		const result = await vitestRun();
		expect(await result.exitCode).toBe(0);
	}
);
