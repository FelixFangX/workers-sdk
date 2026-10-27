import dedent from "ts-dedent";
import { test, vitestConfig } from "./helpers";

const worker = dedent`
	export default {
		async fetch(request, env, ctx) {
			return new Response(env.MY_TEXT);
		}
	}
`;

// A config function, so tests can check which mode it was called with
function modeConfig(entrypoint: string) {
	return dedent`
		export default (ctx) => ({
			worker: {
				name: "test-worker",
				compatibilityDate: "2025-12-02",
				entrypoint: "${entrypoint}",
				env: {
					MY_TEXT: { type: "text", value: ctx.mode },
				},
			},
		});
	`;
}

function modeTest(mode: string) {
	return dedent`
		import { env, SELF } from "cloudflare:test";
		import { it } from "vitest";

		it("provides bindings from cloudflare.config.ts", ({ expect }) => {
			expect(env.MY_TEXT).toBe("${mode}");
		});

		it("dispatches to the entrypoint declared in cloudflare.config.ts", async ({
			expect,
		}) => {
			const response = await SELF.fetch("http://example.com");
			expect(await response.text()).toBe("${mode}");
		});
	`;
}

test("loads cloudflare.config.ts from the project root in test mode", async ({
	expect,
	seed,
	vitestRun,
}) => {
	await seed({
		"vitest.config.mts": vitestConfig({ config: true }),
		"cloudflare.config.ts": modeConfig("./index.ts"),
		"index.ts": worker,
		"index.test.ts": modeTest("test"),
	});

	const result = await vitestRun();

	await expect(result.exitCode).resolves.toBe(0);
	expect(result.stdout).toMatch("2 passed");
});

test("resolves a custom config path, with the mode from --mode", async ({
	expect,
	seed,
	vitestRun,
}) => {
	await seed({
		"vitest.config.mts": vitestConfig({
			config: "./config/cloudflare.config.ts",
		}),
		// `entrypoint` is resolved relative to the config file, not the project root
		"config/cloudflare.config.ts": modeConfig("../index.ts"),
		"index.ts": worker,
		"index.test.ts": modeTest("staging"),
	});

	const result = await vitestRun({ flags: ["--mode=staging"] });

	await expect(result.exitCode).resolves.toBe(0);
	expect(result.stdout).toMatch("2 passed");
});

test("binds the config's own Durable Objects, Workflows, Worker, queues and secrets", async ({
	expect,
	seed,
	vitestRun,
}) => {
	await seed({
		"vitest.config.mts": vitestConfig({
			config: true,
		}),
		"cloudflare.config.ts": dedent`
			export default {
				worker: {
					name: "test-worker",
					compatibilityDate: "2025-12-02",
					entrypoint: "./index.ts",
					env: {
						COUNTER: { type: "durable-object", worker: "test-worker", exportName: "Counter" },
						MY_WORKFLOW: { type: "workflow", name: "my-workflow", worker: "test-worker", exportName: "MyWorkflow" },
						SELF_SERVICE: { type: "worker", worker: "test-worker" },
						API_KEY: { type: "secret" },
						QUEUE: { type: "queue", name: "my-queue" },
						RESULTS: { type: "kv" },
					},
					triggers: [{ type: "queue", name: "my-queue", maxBatchSize: 1 }],
					exports: {
						Counter: { type: "durable-object", storage: "sqlite" },
						Unbound: { type: "durable-object", storage: "sqlite" },
						MyWorkflow: { type: "workflow", name: "my-workflow" },
					},
				},
			};
		`,
		".dev.vars": "API_KEY=from-dev-vars",
		"index.ts": dedent`
			import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
			export class Counter extends DurableObject {
				count = 0;
				increment() { return ++this.count; }
			}
			export class Unbound extends Counter {}
			export class MyWorkflow extends WorkflowEntrypoint {
				async run(event, step) {
					return await step.do("greet", async () => "Hello, " + event.payload.name);
				}
			}
			export default {
				async fetch(request, env) {
					return new Response(String(await env.COUNTER.getByName("fetch").increment()));
				},
				async queue(batch, env) {
					for (const message of batch.messages) {
						await env.RESULTS.put(batch.queue, String(message.body));
					}
				},
			}
		`,
		"index.test.ts": dedent`
			import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
			import { exports } from "cloudflare:workers";
			import { it } from "vitest";

			it("calls a Durable Object bound to its own Worker", async ({ expect }) => {
				expect(await env.COUNTER.getByName("rpc").increment()).toBe(1);
			});

			it("runs code inside that Durable Object", async ({ expect }) => {
				const stub = env.COUNTER.getByName("inside");
				expect(await runInDurableObject(stub, (instance) => instance.increment())).toBe(1);
				const ids = await listDurableObjectIds(env.COUNTER);
				expect(ids.some((id) => id.equals(stub.id))).toBe(true);
			});

			it("runs code inside a Durable Object that is only exported", async ({ expect }) => {
				const stub = exports.Unbound.getByName("inside");
				expect(await runInDurableObject(stub, (instance) => instance.increment())).toBe(1);
			});

			it("runs a Workflow bound to its own Worker", async ({ expect }) => {
				const instance = await env.MY_WORKFLOW.create({ params: { name: "World" } });
				await expect
					.poll(() => instance.status())
					.toMatchObject({ status: "complete", output: "Hello, World" });
			});

			it("calls its own Worker through a service binding", async ({ expect }) => {
				const response = await env.SELF_SERVICE.fetch("http://example.com");
				expect(await response.text()).toBe("1");
			});

			it("fills declared secrets from .dev.vars", ({ expect }) => {
				expect(env.API_KEY).toBe("from-dev-vars");
			});

			it("delivers messages to the config's queue consumer", async ({ expect }) => {
				await env.QUEUE.send("hello");
				await expect
					.poll(() => env.RESULTS.get("my-queue"), { timeout: 10_000 })
					.toBe("hello");
			});
		`,
	});

	const result = await vitestRun();

	await expect(result.exitCode).resolves.toBe(0);
	expect(result.stdout).toMatch("7 passed");
});

test("wraps Workflows bound to the config's own Worker and ignores tail consumers", async ({
	expect,
	seed,
	vitestRun,
}) => {
	await seed({
		"vitest.config.mts": vitestConfig({ config: true }),
		"cloudflare.config.ts": dedent`
			export default {
				worker: {
					name: "test-worker",
					// Before 2025-11-17, unexported Workflows need a wrapper
					compatibilityDate: "2025-06-01",
					entrypoint: "./index.ts",
					env: {
						MY_WORKFLOW: { type: "workflow", name: "my-workflow", worker: "test-worker", exportName: "MyWorkflow" },
					},
					tailConsumers: [{ worker: "test-worker" }],
				},
			};
		`,
		"index.ts": dedent`
			import { WorkflowEntrypoint } from "cloudflare:workers";
			export class MyWorkflow extends WorkflowEntrypoint {
				async run(event, step) {
					return await step.do("greet", async () => "Hello, " + event.payload.name);
				}
			}
			export default {
				tail(events) {
					console.log("tail", events.length);
				},
			};
		`,
		"index.test.ts": dedent`
			import { env } from "cloudflare:test";
			import { it } from "vitest";

			it("runs a Workflow bound to its own Worker", async ({ expect }) => {
				const instance = await env.MY_WORKFLOW.create({ params: { name: "World" } });
				await expect
					.poll(() => instance.status())
					.toMatchObject({ status: "complete", output: "Hello, World" });
			});
		`,
	});

	const result = await vitestRun();

	await expect(result.exitCode).resolves.toBe(0);
	expect(result.stdout).toMatch("1 passed");
	expect(`${result.stdout}${result.stderr}`).toMatch(
		'Tail consumers aren\'t supported with `config` yet, so "test-worker" was ignored.'
	);
});

test("merges `miniflare` options over the config's Worker", async ({
	expect,
	seed,
	vitestRun,
}) => {
	await seed({
		"vitest.config.mts": vitestConfig({
			config: true,
			miniflare: {
				bindings: { MY_TEXT: "from miniflare" },
				// `other-queue` is consumed as well as the config's queues, and
				// `tuned-queue` replaces the config's consumer for that queue
				queueConsumers: {
					"other-queue": {},
					"tuned-queue": { maxBatchSize: 1 },
				},
				assets: { directory: "./public" },
				// Replaces the config's `VERSION`, as a Worker can only have one
				versionMetadata: "MF_VERSION",
				serviceBindings: { AUX: "aux", SELF_BY_NAME: "test-worker" },
				workers: [
					{
						name: "aux",
						modules: true,
						script:
							"export default { fetch() { return new Response('aux'); } }",
					},
				],
			},
		}),
		"cloudflare.config.ts": dedent`
			export default {
				worker: {
					name: "test-worker",
					compatibilityDate: "2025-12-02",
					entrypoint: "./index.ts",
					env: {
						MY_TEXT: { type: "text", value: "from config" },
						QUEUE: { type: "queue", name: "my-queue" },
						TUNED_QUEUE: { type: "queue", name: "tuned-queue" },
						RESULTS: { type: "kv" },
						ASSETS: { type: "assets" },
						VERSION: { type: "version-metadata" },
					},
					triggers: [
						{ type: "queue", name: "my-queue", maxBatchSize: 1 },
						{ type: "queue", name: "tuned-queue", maxBatchSize: 100, maxBatchTimeout: 60 },
					],
					assets: { notFoundHandling: "404-page" },
				},
			};
		`,
		"public/hello.txt": "hello from assets",
		"public/404.html": "not found page",
		"index.ts": dedent`
			export default {
				async fetch() {
					return new Response("ok");
				},
				async queue(batch, env) {
					for (const message of batch.messages) {
						await env.RESULTS.put(batch.queue, String(message.body));
					}
				},
			};
		`,
		"index.test.ts": dedent`
			import { env } from "cloudflare:test";
			import { it } from "vitest";

			it("lets a \`miniflare\` binding replace the config's with the same name", ({ expect }) => {
				expect(env.MY_TEXT).toBe("from miniflare");
			});

			it("delivers messages to the config's queue consumer", async ({ expect }) => {
				await env.QUEUE.send("hello");
				await expect
					.poll(() => env.RESULTS.get("my-queue"), { timeout: 10_000 })
					.toBe("hello");
			});

			it("applies \`miniflare\` settings for the same queue", async ({ expect }) => {
				await env.TUNED_QUEUE.send("tuned");
				await expect
					.poll(() => env.RESULTS.get("tuned-queue"), { timeout: 10_000 })
					.toBe("tuned");
			});

			it("serves \`miniflare.assets\` with the config's binding and settings", async ({ expect }) => {
				const response = await env.ASSETS.fetch("http://example.com/hello.txt");
				expect(await response.text()).toBe("hello from assets");
				const missing = await env.ASSETS.fetch("http://example.com/missing");
				expect(missing.status).toBe(404);
				expect(await missing.text()).toBe("not found page");
			});

			it("lets a \`miniflare\` binding replace a single-use config binding", ({ expect }) => {
				expect(env.MF_VERSION).toBeDefined();
				expect(env.VERSION).toBeUndefined();
			});

			it("calls an auxiliary Worker and the config's own Worker", async ({ expect }) => {
				expect(await (await env.AUX.fetch("http://example.com")).text()).toBe("aux");
				expect(await (await env.SELF_BY_NAME.fetch("http://example.com")).text()).toBe("ok");
			});
		`,
	});

	const result = await vitestRun();

	await expect(result.exitCode).resolves.toBe(0);
	expect(result.stdout).toMatch("6 passed");
});
