import { z } from "npm:zod@4.3.6";
import { zipSync } from "npm:fflate@0.8.2";
import {
  appspaceApi,
  AppspaceGlobalArgsSchema,
  appspacePaged,
  sanitizeId,
} from "./_client.ts";

const CardTemplateTypeSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  category: z.string().optional(),
  developer: z.string().optional(),
  version: z.string().optional(),
}).passthrough();

const CardTemplateSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  cardTemplateType: CardTemplateTypeSchema.optional(),
  templateUrl: z.string().optional(),
  iconUrl: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

const CardProjectSchema = z.object({
  path: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  schemaValid: z.boolean(),
  modelValid: z.boolean(),
  warnings: z.array(z.string()),
}).passthrough();

const CardPackageSchema = z.object({
  zipPath: z.string(),
  sizeBytes: z.number(),
  fileCount: z.number(),
  manifestId: z.string(),
  manifestVersion: z.string(),
}).passthrough();

const CardPullSchema = z.object({
  templateId: z.string(),
  destDir: z.string(),
  templateUrl: z.string(),
  files: z.array(z.string()),
  totalBytes: z.number(),
}).passthrough();

const MANIFEST_TEMPLATE = (id: string, name: string, developer: string) => ({
  Id: id,
  Name: name,
  Description: `${name} card`,
  Category: "Custom",
  Developer: developer,
  Version: "1.0.0",
  Thumbnail: "thumbnail.svg",
  Startup: "index.html",
  Schema: "schema.json",
  Model: "model.json",
  DisplayFormats: [{ Type: "tv" }, { Type: "mobile" }],
  Network: { RequiresConnection: false },
  BaseCardTemplate: false,
});

const SCHEMA_TEMPLATE = {
  version: "1.0.0",
  inputs: [
    {
      name: "headline",
      label: "Headline",
      type: "textbox",
      placeholder: "Enter headline",
      validation: { required: true },
    },
    {
      name: "backgroundColor",
      label: "Background Color",
      type: "colorpicker",
    },
  ],
};

const MODEL_TEMPLATE = {
  inputs: {
    headline: { value: "Hello from Appspace" },
    backgroundColor: { value: "#0F4C81" },
  },
  customData: {},
};

const INDEX_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Card</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; }
    h1 { font-size: 5vw; color: #fff; text-align: center; padding: 0 5vw; }
  </style>
</head>
<body>
  <h1 id="headline">Loading...</h1>
  <script>
    (function () {
      function applyModel(model) {
        var inputs = (model && model.inputs) || {};
        document.body.style.backgroundColor =
          (inputs.backgroundColor && inputs.backgroundColor.value) || "#0F4C81";
        document.getElementById("headline").textContent =
          (inputs.headline && inputs.headline.value) || "Headline";
      }
      function init() {
        if (window.CardAPI) {
          var api = new window.CardAPI();
          api.subscribe(applyModel);
          api.notifyOnLoad();
        } else {
          // Local dev fallback (Chrome-Safe shortcut not in use)
          fetch("model.json").then(function (r) { return r.json(); }).then(applyModel);
        }
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
      } else {
        init();
      }
    })();
  </script>
</body>
</html>
`;

const THUMBNAIL_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#0F4C81"/>
  <text x="100" y="110" font-family="Arial,sans-serif" font-size="24" fill="#fff" text-anchor="middle">Card</text>
</svg>
`;

async function exec(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await proc.output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.code,
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

function validateBigThree(
  manifest: Record<string, unknown>,
  schema: Record<string, unknown>,
  model: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];

  const requiredManifest = [
    "Id",
    "Name",
    "Description",
    "Category",
    "Developer",
    "Version",
    "Thumbnail",
    "Startup",
    "Schema",
    "Model",
    "DisplayFormats",
    "Network",
    "BaseCardTemplate",
  ];
  for (const key of requiredManifest) {
    if (!(key in manifest)) {
      warnings.push(`manifest.json missing field: ${key}`);
    }
  }

  if (!schema.inputs || !Array.isArray(schema.inputs)) {
    warnings.push("schema.json must have an 'inputs' array");
  } else {
    const schemaNames = new Set<string>();
    for (const inp of schema.inputs as Array<Record<string, unknown>>) {
      const name = inp.name as string | undefined;
      if (!name) {
        warnings.push("schema.json input missing 'name' field");
        continue;
      }
      if (schemaNames.has(name)) {
        warnings.push(`schema.json has duplicate input name: ${name}`);
      }
      schemaNames.add(name);
      if (!inp.type) {
        warnings.push(`schema.json input '${name}' missing 'type' field`);
      }
    }

    // Golden Rule: every schema input must exist in model.inputs.
    // model.json supports two shapes for `inputs`:
    //   (a) array form  → [{name, type, value}, ...]   (used by Appspace's own cards)
    //   (b) object form → {<name>: {value}, ...}       (the simpler scaffolded form)
    const rawModelInputs = model.inputs;
    let modelInputNames: Set<string>;
    if (Array.isArray(rawModelInputs)) {
      modelInputNames = new Set(
        rawModelInputs
          .filter((it): it is Record<string, unknown> =>
            !!it && typeof it === "object"
          )
          .map((it) => (it.name as string) ?? "")
          .filter(Boolean),
      );
    } else if (rawModelInputs && typeof rawModelInputs === "object") {
      modelInputNames = new Set(Object.keys(rawModelInputs));
    } else {
      warnings.push(
        "model.json 'inputs' must be either an array of {name,type,value} or an object keyed by input name",
      );
      modelInputNames = new Set();
    }

    for (const name of schemaNames) {
      if (!modelInputNames.has(name)) {
        warnings.push(
          `model.json missing default for schema input '${name}' (Golden Rule violation)`,
        );
      }
    }
    for (const name of modelInputNames) {
      if (!schemaNames.has(name)) {
        warnings.push(
          `model.json has '${name}' but no matching schema input (orphan)`,
        );
      }
    }
  }

  return warnings;
}

export const model = {
  type: "@dougschaefer/appspace-card",
  version: "2026.04.27.1",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    cardTemplateType: {
      description:
        "Registered card template type — the developer-uploaded card 'class' that instances are created from",
      schema: CardTemplateTypeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cardTemplate: {
      description:
        "Configured card template instance — references a cardTemplateType and stores the per-instance schema/model overrides",
      schema: CardTemplateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cardProject: {
      description:
        "Local card project on disk — directory containing manifest.json, schema.json, model.json, and the card's web app",
      schema: CardProjectSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    cardPackage: {
      description: "Built and zipped card ready to upload to Appspace",
      schema: CardPackageSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    cardPull: {
      description:
        "Source files pulled from a card's templateUrl on the Appspace tenant — manifest, schema, model, index.html, and all referenced JS/CSS/asset bundles",
      schema: CardPullSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    scaffold: {
      description:
        "Create a new Appspace card project at the given path with manifest.json, schema.json, model.json, index.html, and a placeholder thumbnail. Defaults to a plain HTML/JS template (zero build step) — extend with React/Angular as needed.",
      arguments: z.object({
        path: z.string().describe(
          "Destination directory (created if missing). Should be empty.",
        ),
        id: z.string().describe(
          "Reverse-DNS card identifier (e.g., 'com.example.lobby.welcome')",
        ),
        name: z.string().describe("Human-readable card name"),
        developer: z.string().describe(
          "Developer/author name for the manifest (your company or org)",
        ),
      }),
      execute: async (args, context) => {
        await Deno.mkdir(args.path, { recursive: true });

        const manifest = MANIFEST_TEMPLATE(args.id, args.name, args.developer);
        await writeJson(`${args.path}/manifest.json`, manifest);
        await writeJson(`${args.path}/schema.json`, SCHEMA_TEMPLATE);
        await writeJson(`${args.path}/model.json`, MODEL_TEMPLATE);
        await Deno.writeTextFile(
          `${args.path}/index.html`,
          INDEX_HTML_TEMPLATE,
        );
        await Deno.writeTextFile(
          `${args.path}/thumbnail.svg`,
          THUMBNAIL_SVG,
        );

        context.logger.info("Scaffolded card {id} at {path}", {
          id: args.id,
          path: args.path,
        });

        const handle = await context.writeResource(
          "cardProject",
          sanitizeId(args.id),
          {
            path: args.path,
            manifest,
            schemaValid: true,
            modelValid: true,
            warnings: [],
          },
        );
        return { dataHandles: [handle] };
      },
    },

    validate: {
      description:
        "Validate a card project's Big Three (manifest.json, schema.json, model.json) for required fields and consistency. Returns warnings without modifying files.",
      arguments: z.object({
        path: z.string().describe("Path to card project directory"),
      }),
      execute: async (args, context) => {
        const manifest = await readJson(`${args.path}/manifest.json`);
        const schema = await readJson(`${args.path}/schema.json`);
        const modelJson = await readJson(`${args.path}/model.json`);

        const warnings = validateBigThree(manifest, schema, modelJson);

        if (warnings.length === 0) {
          context.logger.info("Card project at {path} validated cleanly", {
            path: args.path,
          });
        } else {
          context.logger.warn("Found {n} validation warnings", {
            n: warnings.length,
          });
          for (const w of warnings) context.logger.warn("  {w}", { w });
        }

        const handle = await context.writeResource(
          "cardProject",
          sanitizeId((manifest.Id as string) ?? args.path),
          {
            path: args.path,
            manifest,
            schemaValid: warnings.filter((w) => w.startsWith("schema.json"))
              .length === 0,
            modelValid: warnings.filter((w) => w.startsWith("model.json"))
              .length === 0,
            warnings,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    build: {
      description:
        "Run a build command in the card project directory (e.g., 'npm run build'). Skip for plain-HTML cards that need no build.",
      arguments: z.object({
        path: z.string().describe("Path to card project directory"),
        command: z.string().default("npm").describe("Build executable"),
        args: z.array(z.string()).default(["run", "build"]).describe(
          "Build command arguments",
        ),
      }),
      execute: async (args, context) => {
        const result = await exec(args.command, args.args, args.path);
        if (result.code !== 0) {
          throw new Error(
            `Build failed (exit ${result.code}):\n${result.stderr}\n${result.stdout}`,
          );
        }
        context.logger.info("Build succeeded in {path}", { path: args.path });
        return {
          data: {
            attributes: {
              path: args.path,
              command: `${args.command} ${args.args.join(" ")}`,
              stdout: result.stdout,
              stderr: result.stderr,
            },
            name: "build-output",
          },
        };
      },
    },

    package: {
      description:
        "Package a card project into a .zip ready for upload to Appspace. Handles the 'zip contents not folder' gotcha by archiving entries with paths relative to the source dir. Run validate first.",
      arguments: z.object({
        sourceDir: z.string().describe(
          "Directory whose contents to package (typically build/ or the project root for plain cards)",
        ),
        outputZip: z.string().describe(
          "Path where the .zip should be written (e.g., 'dist/my-card.zip')",
        ),
        excludeGlobs: z.array(z.string()).default([
          "node_modules",
          ".git",
          ".DS_Store",
          "dist",
        ]).describe(
          "Top-level entries to skip (matched against the entry name, not full path)",
        ),
      }),
      execute: async (args, context) => {
        const manifest = await readJson(`${args.sourceDir}/manifest.json`);

        const lastSlash = args.outputZip.lastIndexOf("/");
        if (lastSlash > 0) {
          await Deno.mkdir(args.outputZip.slice(0, lastSlash), {
            recursive: true,
          });
        }

        const excludeSet = new Set(args.excludeGlobs);
        const entries: Record<string, Uint8Array> = {};
        let fileCount = 0;

        async function walk(dir: string, relPrefix: string) {
          for await (const entry of Deno.readDir(dir)) {
            // Skip excluded top-level names (and never include the output zip itself)
            if (relPrefix === "" && excludeSet.has(entry.name)) continue;
            const absPath = `${dir}/${entry.name}`;
            if (absPath === args.outputZip) continue;

            const relPath = relPrefix
              ? `${relPrefix}/${entry.name}`
              : entry.name;

            if (entry.isDirectory) {
              await walk(absPath, relPath);
            } else if (entry.isFile) {
              entries[relPath] = await Deno.readFile(absPath);
              fileCount += 1;
            }
          }
        }

        await walk(args.sourceDir, "");

        if (!entries["manifest.json"]) {
          throw new Error(
            `No manifest.json found at ${args.sourceDir}/manifest.json — refusing to package.`,
          );
        }

        const zipped = zipSync(entries, { level: 6 });
        await Deno.writeFile(args.outputZip, zipped);

        const stat = await Deno.stat(args.outputZip);

        context.logger.info(
          "Packaged {fileCount} files into {zip} ({size} bytes)",
          {
            fileCount,
            zip: args.outputZip,
            size: stat.size,
          },
        );
        context.logger.info(
          "Next step: upload {zip} via the Appspace console — Library > Cards > Upload. The v3 API does not expose a card-template-type upload endpoint.",
          { zip: args.outputZip },
        );

        const handle = await context.writeResource(
          "cardPackage",
          sanitizeId(manifest.Id as string),
          {
            zipPath: args.outputZip,
            sizeBytes: stat.size,
            fileCount,
            manifestId: manifest.Id as string,
            manifestVersion: manifest.Version as string,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listTemplateTypes: {
      description:
        "List all card template types installed on the Appspace tenant. Use the returned 'id' as cardTemplateTypeId when creating new template instances.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const types = await appspacePaged(
          "/api/v3/libraries/cardtemplatetypes",
          context.globalArgs,
        );
        context.logger.info("Found {count} card template types", {
          count: types.length,
        });
        const handles = [];
        for (const t of types) {
          const handle = await context.writeResource(
            "cardTemplateType",
            sanitizeId((t.key as string) ?? (t.id as string)),
            t,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    listTemplates: {
      description:
        "List configured card template instances in the Appspace library.",
      arguments: z.object({
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const templates = await appspacePaged(
          "/api/v3/libraries/cardtemplates",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        context.logger.info("Found {count} card templates", {
          count: templates.length,
        });
        const handles = [];
        for (const t of templates) {
          const handle = await context.writeResource(
            "cardTemplate",
            sanitizeId((t.id as string) ?? "card"),
            t,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getTemplate: {
      description: "Get a single card template by ID.",
      arguments: z.object({
        id: z.string().describe("Card template ID"),
      }),
      execute: async (args, context) => {
        const t = await appspaceApi(
          `/api/v3/libraries/cardtemplates/${encodeURIComponent(args.id)}`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "cardTemplate",
          sanitizeId(args.id),
          t,
        );
        return { dataHandles: [handle] };
      },
    },

    createTemplate: {
      description:
        "Create a new configured card template instance from a registered template type. The 'model' and 'schema' fields override the template type's defaults for this instance.",
      arguments: z.object({
        cardTemplateTypeId: z.string().describe(
          "ID of the template type to instantiate (from listTemplateTypes)",
        ),
        name: z.string().describe("Display name for the instance"),
        model: z.record(z.string(), z.unknown()).optional().describe(
          "Per-instance model.json overrides",
        ),
        schema: z.record(z.string(), z.unknown()).optional().describe(
          "Per-instance schema.json overrides",
        ),
        permissions: z.array(z.unknown()).optional(),
        theme: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (args, context) => {
        const body: Record<string, unknown> = {
          cardTemplateTypeId: args.cardTemplateTypeId,
          name: args.name,
        };
        if (args.model) body.model = args.model;
        if (args.schema) body.schema = args.schema;
        if (args.permissions) body.permissions = args.permissions;
        if (args.theme) body.theme = args.theme;

        const result = await appspaceApi(
          "/api/v3/libraries/cardtemplates",
          context.globalArgs,
          { method: "POST", body },
        ) as Record<string, unknown>;

        const id = (result.id as string) ?? "new";
        context.logger.info("Created card template instance {id}: {name}", {
          id,
          name: args.name,
        });
        const handle = await context.writeResource(
          "cardTemplate",
          sanitizeId(id),
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    pullCard: {
      description:
        "Download a card's source files from its templateUrl on the Appspace tenant. Fetches manifest/schema/model/index.html plus every script and stylesheet referenced from index.html (preserving the relative directory structure). Use this to stage an existing card for customization.",
      arguments: z.object({
        templateId: z.string().describe(
          "Card template instance ID (UUID). Find via listTemplates.",
        ),
        destDir: z.string().describe(
          "Destination directory. Created if missing; existing files are overwritten.",
        ),
        includeAssets: z.boolean().default(true).describe(
          "When true (default), follow JS/CSS references from index.html and download those too. When false, only fetches root files (manifest, schema, model, index.html, thumbnail.svg).",
        ),
      }),
      execute: async (args, context) => {
        // Resolve the templateUrl by getting the template record
        const template = await appspaceApi(
          `/api/v3/libraries/cardtemplates/${
            encodeURIComponent(args.templateId)
          }`,
          context.globalArgs,
        ) as Record<string, unknown>;

        const rawUrl = template.templateUrl as string | undefined;
        if (!rawUrl) {
          throw new Error(
            `Card template ${args.templateId} has no templateUrl; cannot pull source.`,
          );
        }
        const templateUrl = rawUrl.endsWith("/") ? rawUrl : rawUrl + "/";

        await Deno.mkdir(args.destDir, { recursive: true });

        // Helper: fetch a file from templateUrl + relPath, write to destDir + relPath
        let totalBytes = 0;
        const fetchedFiles: string[] = [];

        async function pull(
          relPath: string,
          required: boolean,
        ): Promise<Uint8Array | null> {
          const url = templateUrl + relPath;
          const resp = await fetch(url);
          if (!resp.ok) {
            if (required) {
              throw new Error(
                `Failed to fetch ${relPath}: ${resp.status} ${resp.statusText}`,
              );
            }
            return null;
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          // Ensure parent dir exists
          const lastSlash = relPath.lastIndexOf("/");
          if (lastSlash > 0) {
            await Deno.mkdir(`${args.destDir}/${relPath.slice(0, lastSlash)}`, {
              recursive: true,
            });
          }
          await Deno.writeFile(`${args.destDir}/${relPath}`, buf);
          totalBytes += buf.length;
          fetchedFiles.push(relPath);
          return buf;
        }

        // Required root files
        for (const f of ["manifest.json", "schema.json", "model.json"]) {
          await pull(f, true);
        }
        const indexBytes = await pull("index.html", true);

        // Optional root files
        for (const f of ["thumbnail.svg", "thumbnail.png"]) {
          await pull(f, false);
        }

        if (args.includeAssets && indexBytes) {
          const indexHtml = new TextDecoder().decode(indexBytes);
          const refs = new Set<string>();

          // Match src="..." and href="..." (single or double quotes)
          const srcRe = /\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;
          let m: RegExpExecArray | null;
          while ((m = srcRe.exec(indexHtml)) !== null) {
            const ref = m[1];
            // Skip absolute URLs and data URIs
            if (
              /^(?:https?:|data:|mailto:|#|\/\/)/i.test(ref) ||
              ref.startsWith("/")
            ) continue;
            // Skip the manifest webmanifest URL refs (handled separately)
            refs.add(ref);
          }

          context.logger.info(
            "Pulling {n} asset(s) referenced from index.html",
            { n: refs.size },
          );
          for (const ref of refs) {
            try {
              await pull(ref, false);
            } catch (e) {
              context.logger.warn("Failed to fetch {ref}: {err}", {
                ref,
                err: (e as Error).message,
              });
            }
          }
        }

        context.logger.info(
          "Pulled {count} files ({size} bytes) into {dst}",
          { count: fetchedFiles.length, size: totalBytes, dst: args.destDir },
        );

        const handle = await context.writeResource(
          "cardPull",
          sanitizeId(args.templateId),
          {
            templateId: args.templateId,
            destDir: args.destDir,
            templateUrl,
            files: fetchedFiles,
            totalBytes,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    updateTemplate: {
      description:
        "Update a configured card template instance (name, model overrides, schema overrides, theme).",
      arguments: z.object({
        id: z.string().describe("Card template instance ID"),
        name: z.string().optional(),
        model: z.record(z.string(), z.unknown()).optional(),
        schema: z.record(z.string(), z.unknown()).optional(),
        theme: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (args, context) => {
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.model !== undefined) body.model = args.model;
        if (args.schema !== undefined) body.schema = args.schema;
        if (args.theme !== undefined) body.theme = args.theme;

        const result = await appspaceApi(
          `/api/v3/libraries/cardtemplates/${encodeURIComponent(args.id)}`,
          context.globalArgs,
          { method: "PUT", body },
        );
        return {
          data: {
            attributes: { id: args.id, patch: body, result },
            name: `update-${sanitizeId(args.id)}`,
          },
        };
      },
    },
  },
};
