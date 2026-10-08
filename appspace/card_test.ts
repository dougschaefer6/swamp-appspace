import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { model } from "./card.ts";

// Minimal stand-in for the swamp method context: records what a method writes.
function fakeContext() {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const noop = () => {};
  return {
    written,
    context: {
      globalArgs: {},
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

async function scaffoldInto(dir: string) {
  const { context } = fakeContext();
  await methods.scaffold.execute({
    path: dir,
    id: "com.example.test.card",
    name: "Test Card",
    developer: "Example",
  }, context);
}

async function validate(dir: string): Promise<string[]> {
  const { context, written } = fakeContext();
  await methods.validate.execute({ path: dir }, context);
  // deno-lint-ignore no-explicit-any
  return (written[0].data as any).warnings;
}

Deno.test("scaffold writes an array-form model matching the schema", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await scaffoldInto(dir);
    const model = JSON.parse(await Deno.readTextFile(`${dir}/model.json`));
    const schema = JSON.parse(await Deno.readTextFile(`${dir}/schema.json`));
    assert(Array.isArray(model.inputs), "model.inputs must be an array");
    assertEquals(
      model.inputs.map((i: { name: string }) => i.name),
      schema.inputs.map((i: { name: string }) => i.name),
    );
    for (const input of model.inputs) {
      assertEquals(input.name, input.name.toLowerCase());
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold output validates with no warnings", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await scaffoldInto(dir);
    assertEquals(await validate(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold wires index.html to the bundled CardAPI and documents it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await scaffoldInto(dir);
    const html = await Deno.readTextFile(`${dir}/index.html`);
    assert(html.includes('src="console/cardapi.js"'));
    assert(html.includes('src="console/jquery-3.7.1.min.js"'));
    assert(html.includes("subscribeModelUpdate"));
    assert(html.includes("notifyOnLoad"));
    assert(!html.includes("new window.CardAPI"), "stale CardAPI usage");
    const sources = await Deno.readTextFile(`${dir}/SOURCES.md`);
    assert(sources.includes("console/cardapi.js"));
    assert((await Deno.stat(`${dir}/console`)).isDirectory);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validate flags an object-form model", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await scaffoldInto(dir);
    await Deno.writeTextFile(
      `${dir}/model.json`,
      JSON.stringify({
        inputs: {
          headline: { value: "x" },
          backgroundcolor: { value: "#000" },
        },
      }),
    );
    const warnings = await validate(dir);
    assert(
      warnings.some((w) => w.includes("expect an array")),
      `expected an object-form warning, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
